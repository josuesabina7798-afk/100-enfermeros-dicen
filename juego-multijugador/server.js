const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const root = __dirname;
const port = Number(process.env.PORT) || 4173;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
};

const state = {
  questions: [
    {
      question: "Menciona algo que una enfermera siempre trae en la bolsa",
      answers: [
        { text: "Pluma", points: 32 },
        { text: "Tijeras", points: 22 },
        { text: "Cinta", points: 16 },
        { text: "Termometro", points: 12 },
        { text: "Guantes", points: 10 },
        { text: "Alcohol", points: 8 },
      ],
    },
    {
      question: "Que frase escucha mucho el personal de enfermeria",
      answers: [
        { text: "Me duele", points: 31 },
        { text: "Ya me puedo ir", points: 24 },
        { text: "Tengo hambre", points: 17 },
        { text: "Me toca medicamento", points: 13 },
        { text: "No encuentro al doctor", points: 9 },
        { text: "Cuando me dan de alta", points: 6 },
      ],
    },
  ],
  game: {
    currentRound: 0,
    phase: "idle",
    revealed: [],
    answerOwners: {},
    strikes: [0, 0],
    turnTeam: null,
    scores: [0, 0],
    players: [],
    buzzerWinner: null,
    winner: null,
    timerEndsAt: null,
    buzzOpensAt: null,
    feedback: { id: 0, type: "idle" },
  },
};

const clients = new Set();
let answerTimer = null;
let buzzTimer = null;

function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const preferred = [];
  const fallback = [];

  for (const [name, values] of Object.entries(interfaces)) {
    const isVirtual = /vmware|virtual|vethernet|hyper-v|loopback|pseudo|bluetooth/i.test(name);
    for (const item of values || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      const entry = { name, address: item.address };
      if (isVirtual) fallback.push(entry);
      else preferred.push(entry);
    }
  }

  return [...preferred, ...fallback];
}

function getLanAddress() {
  return getNetworkAddresses()[0]?.address || "127.0.0.1";
}

function getBaseUrl(request) {
  const host = request.headers.host || `127.0.0.1:${port}`;
  const isLocal = host.startsWith("127.0.0.1") || host.startsWith("localhost");
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol || "http";
  return `${protocol}://${isLocal ? `${getLanAddress()}:${port}` : host}`;
}

function snapshot(requestOrBaseUrl) {
  const baseUrl = typeof requestOrBaseUrl === "string" ? requestOrBaseUrl : getBaseUrl(requestOrBaseUrl);
  return {
    questions: state.questions,
    game: state.game,
    urls: {
      screen: `${baseUrl}/`,
      player: `${baseUrl}/player`,
      admin: `${baseUrl}/admin`,
      candidates: getNetworkAddresses().map((item) => ({
        name: item.name,
        screen: `http://${item.address}:${port}/`,
        player: `http://${item.address}:${port}/player`,
        admin: `http://${item.address}:${port}/admin`,
      })),
    },
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("El cuerpo de la peticion es demasiado grande."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
    request.on("error", reject);
  });
}

function broadcast() {
  for (const client of clients) {
    client.response.write(`event: state\ndata: ${JSON.stringify(snapshot(client.baseUrl))}\n\n`);
  }
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) throw new Error("Agrega al menos una ronda.");
  return questions.map((round, roundIndex) => ({
    question: String(round.question || `Ronda ${roundIndex + 1}`).slice(0, 180),
    answers: Array.from({ length: 6 }, (_, index) => {
      const source = Array.isArray(round.answers) ? round.answers[index] : null;
      return {
        text: String(source?.text || `Respuesta ${index + 1}`).slice(0, 80),
        points: Math.max(0, Math.min(100, Number(source?.points) || 0)),
      };
    }),
  }));
}

function currentRound() {
  return state.questions[state.game.currentRound];
}

function resetRoundState(phase = "idle") {
  clearAnswerTimer();
  clearBuzzTimer();
  state.game.phase = phase;
  state.game.revealed = [];
  state.game.answerOwners = {};
  state.game.strikes = [0, 0];
  state.game.turnTeam = null;
  state.game.buzzerWinner = null;
  state.game.winner = null;
  state.game.timerEndsAt = null;
  state.game.buzzOpensAt = null;
}

function setFeedback(type, details = {}) {
  state.game.feedback = {
    id: (state.game.feedback?.id || 0) + 1,
    type,
    ...details,
  };
}

function teamIndexFromName(team) {
  return team === "Equipo 2" ? 1 : 0;
}

function otherTeam(team) {
  return team === 1 ? 0 : 1;
}

function clearAnswerTimer() {
  if (answerTimer) clearTimeout(answerTimer);
  answerTimer = null;
}

function clearBuzzTimer() {
  if (buzzTimer) clearTimeout(buzzTimer);
  buzzTimer = null;
}

function beginBuzzCountdown() {
  clearBuzzTimer();
  state.game.phase = "countdown";
  state.game.buzzOpensAt = Date.now() + 3_000;
  buzzTimer = setTimeout(() => {
    state.game.phase = "buzz";
    state.game.buzzOpensAt = null;
    setFeedback("buzz-open");
    broadcast();
  }, 3_000);
}

function resetAnswerTimer() {
  clearAnswerTimer();
  state.game.timerEndsAt = Date.now() + 60_000;
  answerTimer = setTimeout(() => {
    if (state.game.phase !== "answering" || state.game.timerEndsAt > Date.now()) return;
    addStrikeToActiveTeam("time-up");
    broadcast();
  }, 60_000);
}

function addStrikeToActiveTeam(feedbackType = "wrong") {
  if (state.game.phase !== "answering") throw new Error("Primero debe haber un equipo respondiendo.");
  if (state.game.turnTeam !== 0 && state.game.turnTeam !== 1) throw new Error("No hay equipo activo.");

  const team = state.game.turnTeam;
  state.game.strikes[team] = Math.min(3, state.game.strikes[team] + 1);
  if (state.game.strikes[team] >= 3) {
    state.game.turnTeam = otherTeam(team);
    state.game.strikes[state.game.turnTeam] = 0;
    state.game.buzzerWinner = {
      id: `turn-team-${state.game.turnTeam + 1}`,
      name: `Equipo ${state.game.turnTeam + 1}`,
      team: `Equipo ${state.game.turnTeam + 1}`,
      at: Date.now(),
    };
  }

  setFeedback(feedbackType, { turnChanged: state.game.strikes[team] >= 3 });
  resetAnswerTimer();
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/state") {
    sendJson(response, 200, snapshot(request));
    return;
  }

  if (request.method === "GET" && pathname === "/api/events") {
    const client = { response, baseUrl: getBaseUrl(request) };
    clients.add(client);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`event: state\ndata: ${JSON.stringify(snapshot(client.baseUrl))}\n\n`);
    request.on("close", () => clients.delete(client));
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Metodo no permitido." });
    return;
  }

  try {
    const body = await readBody(request);

    if (pathname === "/api/player") {
      const id = body.id || randomUUID();
      const player = {
        id,
        name: String(body.name || "Participante").slice(0, 24),
        team: body.team === "Equipo 2" ? "Equipo 2" : "Equipo 1",
      };
      const existing = state.game.players.findIndex((item) => item.id === id);
      if (existing >= 0) state.game.players[existing] = player;
      else state.game.players.push(player);
      sendJson(response, 200, player);
    } else if (pathname === "/api/buzz") {
      const player = state.game.players.find((item) => item.id === body.id);
      if (!player) throw new Error("Registra este celular antes de participar.");
      if (state.game.phase !== "buzz" || state.game.buzzerWinner) throw new Error("El boton no esta activo.");
      state.game.buzzerWinner = { ...player, at: Date.now() };
      state.game.turnTeam = teamIndexFromName(player.team);
      state.game.phase = "answering";
      resetAnswerTimer();
      setFeedback("buzz");
      sendJson(response, 200, state.game.buzzerWinner);
    } else if (pathname === "/api/buzz/reset") {
      resetRoundState("idle");
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/game/home") {
      resetRoundState("idle");
      setFeedback("home");
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/game/winner") {
      const [teamOneScore, teamTwoScore] = state.game.scores;
      const winningTeam = teamOneScore === teamTwoScore ? null : teamOneScore > teamTwoScore ? 0 : 1;
      state.game.winner = winningTeam === null
        ? { team: null, name: "Empate", score: teamOneScore }
        : { team: winningTeam, name: `Equipo ${winningTeam + 1}`, score: state.game.scores[winningTeam] };
      state.game.phase = "winner";
      state.game.turnTeam = null;
      state.game.buzzerWinner = null;
      clearAnswerTimer();
      state.game.timerEndsAt = null;
      clearBuzzTimer();
      state.game.buzzOpensAt = null;
      setFeedback("victory");
      sendJson(response, 200, { ok: true, winner: state.game.winner });
    } else if (pathname === "/api/config") {
      state.questions = normalizeQuestions(body.questions);
      state.game.currentRound = Math.min(state.game.currentRound, state.questions.length - 1);
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/round/select") {
      const index = Math.max(0, Math.min(state.questions.length - 1, Number(body.index) || 0));
      const gameWasRunning = state.game.phase !== "idle";
      state.game.currentRound = index;
      resetRoundState("idle");
      if (gameWasRunning) {
        setFeedback("round-change");
        beginBuzzCountdown();
      }
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/round/start") {
      const index = Math.max(0, Math.min(state.questions.length - 1, Number(body.index) || 0));
      state.game.currentRound = index;
      resetRoundState("idle");
      setFeedback("start");
      beginBuzzCountdown();
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/answer/reveal") {
      const index = Number(body.index);
      if (!currentRound()?.answers[index]) throw new Error("Respuesta invalida.");
      if (!state.game.revealed.includes(index)) {
        state.game.revealed.push(index);
        if (state.game.turnTeam === 0 || state.game.turnTeam === 1) {
          state.game.answerOwners[index] = state.game.turnTeam;
          state.game.scores[state.game.turnTeam] += Number(currentRound().answers[index].points) || 0;
          setFeedback("correct", { answerIndex: index });
          if (state.game.phase === "answering") resetAnswerTimer();
        }
      }
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/answer/wrong") {
      addStrikeToActiveTeam("wrong");
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/score/award") {
      const team = body.team === 1 ? 1 : 0;
      state.game.scores[team] += currentRound().answers.reduce((sum, answer, index) => {
        return sum + (state.game.revealed.includes(index) ? Number(answer.points) || 0 : 0);
      }, 0);
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/score") {
      state.game.scores = Array.isArray(body.scores)
        ? [Number(body.scores[0]) || 0, Number(body.scores[1]) || 0]
        : state.game.scores;
      sendJson(response, 200, { ok: true });
    } else {
      sendJson(response, 404, { message: "Ruta API no encontrada." });
      return;
    }

    broadcast();
  } catch (error) {
    sendJson(response, 400, { message: error.message });
  }
}

function serveFile(response, pathname) {
  const fileName = pathname === "/" || pathname === "/player" || pathname === "/admin" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = path.normalize(fileName).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safePath);

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Archivo no encontrado");
      return;
    }

    response.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store, max-age=0",
    });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname.startsWith("/api/")) {
    handleApi(request, response, pathname);
    return;
  }
  serveFile(response, decodeURIComponent(pathname));
});

server.listen(port, "0.0.0.0", () => {
  const local = `http://127.0.0.1:${port}`;
  const lan = `http://${getLanAddress()}:${port}`;
  console.log(`Proyeccion: ${local}`);
  console.log(`Celulares:  ${lan}/player`);
  console.log(`Admin:      ${local}/admin`);
  console.log("Redes detectadas:");
  for (const item of getNetworkAddresses()) {
    console.log(`- ${item.name}: http://${item.address}:${port}/player`);
  }
});
