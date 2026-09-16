const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

let currentState = null;
let playerId = localStorage.getItem("family-player-id") || "";
let showAdminShortcut = false;
let soundEnabled = localStorage.getItem("family-sound-enabled") === "true";
let lastFeedbackId = null;
let lastVisualFeedbackId = null;
let audioContext = null;
let timerClock = null;

const view = window.location.pathname.startsWith("/player")
  ? "player"
  : window.location.pathname.startsWith("/admin")
    ? "admin"
    : "screen";

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "No se pudo completar la accion." }));
    throw new Error(error.message || "No se pudo completar la accion.");
  }

  return response.json().catch(() => ({}));
}

function post(path, body = {}) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function esc(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function copyState(value) {
  return JSON.parse(JSON.stringify(value));
}

function showFatalError(message) {
  app.className = "app player-app";
  app.innerHTML = `
    <section class="phone-card error-card">
      <p class="eyebrow">Conexion</p>
      <h1>No se pudo abrir el juego</h1>
      <p class="muted">${esc(message)}</p>
      <div class="phone-question">
        <span>Revisa esto</span>
        <strong>El celular debe estar en el mismo Wi-Fi que la computadora y entrar a la IP Wi-Fi, no a una IP de VMware.</strong>
      </div>
      <button class="primary-button" type="button" onclick="location.reload()">Reintentar</button>
    </section>
  `;
}

function activeRound(state = currentState) {
  if (!state || !state.questions.length) return null;
  return state.questions[state.game.currentRound] || null;
}

function totalRoundPoints(round, revealed) {
  if (!round) return 0;
  return round.answers.reduce((sum, answer, index) => sum + (revealed.includes(index) ? Number(answer.points) || 0 : 0), 0);
}

function teamPlayers(team) {
  return currentState.game.players.filter((player) => player.team === team);
}

function activeTeamLabel(game = currentState.game) {
  if (game.turnTeam === 0) return "Equipo 1";
  if (game.turnTeam === 1) return "Equipo 2";
  return "";
}

function strikeMarks(count) {
  return [0, 1, 2].map((index) => `<span class="${index < count ? "filled" : ""}">X</span>`).join("");
}

function remainingSeconds(timerEndsAt) {
  if (!timerEndsAt) return 60;
  return Math.max(0, Math.ceil((timerEndsAt - Date.now()) / 1000));
}

function formatTimer(timerEndsAt) {
  const seconds = remainingSeconds(timerEndsAt);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatCountdown(buzzOpensAt) {
  return String(Math.max(0, Math.ceil((buzzOpensAt - Date.now()) / 1000)));
}

function syncTimerClock() {
  window.clearInterval(timerClock);
  if (!currentState) return;

  if (currentState.game.phase === "countdown" && currentState.game.buzzOpensAt) {
    const updateCountdown = () => {
      document.querySelectorAll("[data-buzz-countdown]").forEach((countdown) => {
        countdown.textContent = formatCountdown(currentState.game.buzzOpensAt);
      });
    };
    updateCountdown();
    timerClock = window.setInterval(updateCountdown, 150);
    return;
  }

  if (currentState.game.phase !== "answering" || !currentState.game.timerEndsAt) return;

  const update = () => {
    const seconds = remainingSeconds(currentState.game.timerEndsAt);
    document.querySelectorAll("[data-timer]").forEach((timer) => {
      timer.textContent = formatTimer(currentState.game.timerEndsAt);
      timer.classList.toggle("urgent", seconds <= 10);
    });
  };

  update();
  timerClock = window.setInterval(update, 250);
}

function unlockSound() {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  if (!audioContext) {
    const AudioConstructor = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioConstructor();
  }
  audioContext.resume();
}

function playTone(frequency, duration, delay = 0, waveform = "sine") {
  if (!soundEnabled || !audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const startAt = audioContext.currentTime + delay;
  oscillator.type = waveform;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

function speak(message) {
  if (view !== "screen" || !soundEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const announcement = new SpeechSynthesisUtterance(message);
  announcement.lang = "es-MX";
  announcement.rate = 1;
  announcement.pitch = 1.05;
  window.speechSynthesis.speak(announcement);
}

function playFeedback(type) {
  if (view !== "screen" || !soundEnabled || !audioContext) return;
  if (type === "start") {
    playTone(523, 0.12);
    playTone(784, 0.2, 0.14);
  } else if (type === "buzz") {
    playTone(660, 0.22, 0, "square");
  } else if (type === "buzz-open") {
    playTone(523, 0.1);
    playTone(784, 0.2, 0.12);
  } else if (type === "correct") {
    playTone(660, 0.12);
    playTone(880, 0.24, 0.12);
  } else if (type === "wrong") {
    playTone(180, 0.28, 0, "sawtooth");
  } else if (type === "turn-change") {
    playTone(330, 0.13);
    playTone(440, 0.13, 0.14);
    playTone(660, 0.24, 0.28);
  } else if (type === "round-change") {
    playTone(392, 0.12);
    playTone(523, 0.12, 0.14);
    playTone(659, 0.3, 0.28);
  } else if (type === "victory") {
    playTone(523, 0.16);
    playTone(659, 0.16, 0.16);
    playTone(784, 0.16, 0.32);
    playTone(1047, 0.52, 0.48);
  } else if (type === "time-up") {
    playTone(220, 0.18, 0, "square");
    playTone(180, 0.18, 0.2, "square");
    playTone(140, 0.32, 0.4, "sawtooth");
    speak("Tiempo terminado");
  }
}

function handleFeedback() {
  const feedback = currentState && currentState.game.feedback;
  if (!feedback || feedback.id === lastFeedbackId) return;
  const hadPreviousFeedback = lastFeedbackId !== null;
  lastFeedbackId = feedback.id;
  if (hadPreviousFeedback) playFeedback(feedback.type);
}

function render() {
  if (!currentState) return;
  handleFeedback();
  if (view === "player") renderPlayer();
  if (view === "admin") renderAdmin();
  if (view === "screen") renderScreen();
  syncTimerClock();
}

function renderScreen() {
  const round = activeRound();
  const game = currentState.game;
  const winner = game.buzzerWinner;
  const gameWinner = game.winner;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=12&data=${encodeURIComponent(currentState.urls.player)}`;
  const candidates = currentState.urls.candidates || [];
  const waiting = game.phase === "idle";

  if (waiting) {
    app.className = "app screen-app lobby-app";
    app.innerHTML = `
      <section class="lobby-hero">
        <div class="lobby-copy">
          <h1>100 Enfermeros Dijeron</h1>
          <p>Escaneen el codigo para registrar los celulares. Cuando el admin inicie la ronda, esta pantalla desaparece y comienza el tablero.</p>
        </div>

        <div class="qr-card">
          <img src="${qrUrl}" alt="Codigo QR para celulares" />
          <div>
            <span>Celulares</span>
            <code>${esc(currentState.urls.player)}</code>
          </div>
        </div>
      </section>

      <section class="lobby-teams">
        <article>
          <span>Equipo 1</span>
          <strong>${game.scores[0]}</strong>
          <div class="team-names">
            ${teamPlayers("Equipo 1").length ? teamPlayers("Equipo 1").map((player) => `<b>${esc(player.name)}</b>`).join("") : "<b>Esperando participante</b>"}
          </div>
        </article>
        <article>
          <span>Equipo 2</span>
          <strong>${game.scores[1]}</strong>
          <div class="team-names">
            ${teamPlayers("Equipo 2").length ? teamPlayers("Equipo 2").map((player) => `<b>${esc(player.name)}</b>`).join("") : "<b>Esperando participante</b>"}
          </div>
        </article>
      </section>

      <section class="next-round">
        <span>Proxima ronda</span>
        <strong>${esc((round && round.question) || "Configura una pregunta en el control privado")}</strong>
      </section>

      <section class="admin-shortcut ${showAdminShortcut ? "open" : ""}">
        <button id="toggleAdminShortcut" class="secondary-button" type="button">${showAdminShortcut ? "Ocultar boton de admin" : "Mostrar boton de admin"}</button>
        ${showAdminShortcut ? `<a class="primary-button" href="/admin" target="_blank" rel="noreferrer">Abrir admin</a>` : ""}
        <button id="soundToggle" class="secondary-button" type="button">${soundEnabled ? "Sonidos activados" : "Activar sonidos"}</button>
      </section>

      <div class="connection-options">
        ${candidates.map((item) => `
          <div class="${item.player === currentState.urls.player ? "active" : ""}">
            <span>${esc(item.name)}</span>
            <code>${esc(item.player)}</code>
          </div>
        `).join("")}
      </div>
    `;
    document.querySelector("#toggleAdminShortcut").addEventListener("click", () => {
      showAdminShortcut = !showAdminShortcut;
      renderScreen();
    });
    document.querySelector("#soundToggle").addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem("family-sound-enabled", soundEnabled);
      if (soundEnabled) {
        unlockSound();
        playTone(660, 0.12);
        playTone(880, 0.2, 0.12);
      }
      renderScreen();
    });
    return;
  }

  const feedback = game.feedback || { id: 0, type: "idle" };
  const feedbackType = feedback.id !== lastVisualFeedbackId ? feedback.type : "idle";
  lastVisualFeedbackId = feedback.id;
  const revealedCount = game.revealed.length;
  const totalAnswers = (round && round.answers.length) || 0;
  const progress = totalAnswers ? Math.round((revealedCount / totalAnswers) * 100) : 0;
  app.className = `app screen-app board-app effect-${feedbackType}`;
  app.innerHTML = `
    <div class="board-flash" aria-hidden="true"></div>
    <div class="round-transition" aria-hidden="true">
      <span>Siguiente ronda</span>
      <strong>Ronda ${game.currentRound + 1}</strong>
    </div>
    ${gameWinner ? `
      <section class="winner-reveal ${feedbackType === "victory" ? "celebrate" : ""}">
        <span>${gameWinner.team === null ? "Resultado final" : "Equipo ganador"}</span>
        <strong>${esc(gameWinner.name)}</strong>
        <b>${gameWinner.team === null ? "Los dos equipos terminaron con el mismo puntaje" : `${gameWinner.score} puntos`}</b>
        <button class="winner-close" id="closeWinner" type="button">Cerrar anuncio y volver al inicio</button>
      </section>
    ` : ""}
    ${feedbackType === "time-up" ? `<div class="time-up-alert" role="status">Tiempo terminado</div>` : ""}
    <section class="scorebar">
      <article class="team-score team-one">
        <span>Equipo 1</span>
        <strong>${game.scores[0]}</strong>
        <small>Puntos</small>
      </article>
      <div class="round-pill"><span>Ronda ${game.currentRound + 1} de ${currentState.questions.length || 1}</span><strong>Tablero</strong></div>
      <article class="team-score team-two">
        <span>Equipo 2</span>
        <strong>${game.scores[1]}</strong>
        <small>Puntos</small>
      </article>
    </section>

    <section class="stage">
      <div class="question-block">
        <p class="eyebrow">100 Enfermeros Dijeron</p>
        <h1>${esc((round && round.question) || "Configura la primera ronda en el panel de admin")}</h1>
        <div class="status-stack">
          <div class="buzz-status ${winner ? "is-winner" : ""}">
            ${activeTeamLabel(game) ? `Responde ${esc(activeTeamLabel(game))}` : game.phase === "countdown" ? `Prepárense: <b data-buzz-countdown>${formatCountdown(game.buzzOpensAt)}</b>` : game.phase === "buzz" ? "Boton activo en celulares" : "Esperando inicio de ronda"}
          </div>
          <div class="answer-progress" aria-label="${revealedCount} de ${totalAnswers} respuestas reveladas">
            <span>${revealedCount} de ${totalAnswers} respuestas</span>
            <i><b style="width: ${progress}%"></b></i>
          </div>
          <div class="round-timer">
            <span>Tiempo para responder</span>
            <strong data-timer>${formatTimer(game.timerEndsAt)}</strong>
          </div>
        </div>
      </div>

      <div class="strike-board">
        <article class="${game.turnTeam === 0 ? "active" : ""}">
          <strong>Equipo 1</strong>
          <div>${strikeMarks(game.strikes[0])}</div>
        </article>
        <article class="${game.turnTeam === 1 ? "active" : ""}">
          <strong>Equipo 2</strong>
          <div>${strikeMarks(game.strikes[1])}</div>
        </article>
      </div>

      <div class="answers-board">
        ${((round && round.answers) || []).map((answer, index) => `
          <div class="answer-row ${game.revealed.includes(index) ? "revealed" : ""} ${feedbackType === "correct" && feedback.answerIndex === index ? "newly-revealed" : ""}">
            <span class="answer-number">${index + 1}</span>
            <span class="answer-text">${game.revealed.includes(index) ? esc(answer.text) : ""}</span>
            <strong>${game.revealed.includes(index) ? esc(answer.points) : ""}</strong>
          </div>
        `).join("")}
      </div>
    </section>
  `;

  const closeWinner = document.querySelector("#closeWinner");
  if (closeWinner) {
    closeWinner.addEventListener("click", async () => {
      await post("/api/game/home");
    });
  }
}

function renderPlayer() {
  const round = activeRound();
  const game = currentState.game;
  const registered = game.players.find((player) => player.id === playerId);
  const winner = game.buzzerWinner;
  const gameWinner = game.winner;
  const isWinner = winner && winner.id === playerId;
  const canBuzz = registered && game.phase === "buzz" && !winner;

  app.className = "app player-app";
  app.innerHTML = `
    <section class="phone-card">
      <p class="eyebrow">Control de participante</p>
      <h1>${registered ? esc(registered.name) : "Entra al juego"}</h1>
      <p class="muted">${registered ? esc(registered.team) : "Registra este celular antes de empezar."}</p>

      ${gameWinner ? `
        <section class="phone-winner ${gameWinner.team === null ? "tie" : ""}">
          <span>${gameWinner.team === null ? "Resultado final" : "Ganador"}</span>
          <strong>${esc(gameWinner.name)}</strong>
          <b>${gameWinner.team === null ? "Fue un empate" : `${gameWinner.score} puntos`}</b>
        </section>
      ` : ""}

      <form class="player-form" id="playerForm">
        <label>
          Nombre
          <input name="name" required maxlength="24" value="${esc((registered && registered.name) || "")}" placeholder="Ej. Equipo Azul" />
        </label>
        <label>
          Equipo
          <select name="team">
            <option value="Equipo 1" ${registered && registered.team === "Equipo 1" ? "selected" : ""}>Equipo 1</option>
            <option value="Equipo 2" ${registered && registered.team === "Equipo 2" ? "selected" : ""}>Equipo 2</option>
          </select>
        </label>
        <button class="secondary-button" type="submit">${registered ? "Actualizar" : "Guardar"}</button>
      </form>

      <div class="phone-question">
        <span>Ronda ${game.currentRound + 1}</span>
        <strong>${esc((round && round.question) || "La ronda aun no esta configurada")}</strong>
      </div>

      <div class="phone-timer ${game.phase === "answering" ? "active" : ""}">
        <span>Tiempo para responder</span>
        <strong data-timer>${formatTimer(game.timerEndsAt)}</strong>
      </div>

      <button id="buzzButton" class="buzz-button" type="button" ${canBuzz ? "" : "disabled"}>
        ${isWinner ? "Tu respondes" : winner ? `${esc(winner.name)} gano el turno` : game.phase === "countdown" ? `Prepárate: ${formatCountdown(game.buzzOpensAt)}` : game.phase === "buzz" ? "Presiona primero" : "Espera la ronda"}
      </button>

      <p class="status-note">${gameWinner ? "La partida termino. Felicidades al equipo ganador." : game.phase === "countdown" ? "Los dos botones se activaran al mismo tiempo." : game.phase === "buzz" ? "El primer boton que llegue al servidor gana el turno." : "El admin activara el boton al comenzar cada pregunta."}</p>
    </section>
  `;

  document.querySelector("#playerForm").addEventListener("submit", onPlayerSubmit);
  document.querySelector("#buzzButton").addEventListener("click", onBuzz);
}

function renderAdmin() {
  const round = activeRound();
  const game = currentState.game;
  const answers = (round && round.answers) || [];

  app.className = "app admin-app";
  app.innerHTML = `
    <section class="admin-layout">
      <header class="admin-header">
        <div>
          <p class="eyebrow">Control privado</p>
          <h1>Configuracion del juego</h1>
          <p class="muted">Prepara preguntas, inicia rondas, marca correctas e incorrectas desde aqui.</p>
        </div>
        <a class="secondary-link" href="/" target="_blank" rel="noreferrer">Abrir proyeccion</a>
      </header>

      <div class="admin-grid">
        <article class="admin-panel">
          <div class="panel-title">
            <h2>Rondas</h2>
            <button class="secondary-button" id="addRound" type="button">Agregar ronda</button>
          </div>
          <div class="round-list">
            ${currentState.questions.map((item, index) => `
              <button class="round-item ${index === game.currentRound ? "active" : ""}" data-round="${index}" type="button">
                <strong>Ronda ${index + 1}</strong>
                <span>${esc(item.question)}</span>
              </button>
            `).join("")}
          </div>
        </article>

        <article class="admin-panel">
          <div class="panel-title">
            <h2>Pregunta activa</h2>
            <span>${game.phase === "countdown" ? "Preparense" : game.phase === "buzz" ? "Boton activo" : game.phase === "answering" ? "Respondiendo" : "En espera"}</span>
          </div>
          <label>
            Pregunta
            <textarea id="questionText" rows="3">${esc((round && round.question) || "")}</textarea>
          </label>
          <div class="answers-editor">
            ${answers.map((answer, index) => `
              <div class="answer-editor">
                <input value="${esc(answer.text)}" data-answer-text="${index}" placeholder="Respuesta ${index + 1}" />
                <input value="${esc(answer.points)}" data-answer-points="${index}" type="number" min="0" max="100" />
                <button class="icon-text ${game.revealed.includes(index) ? "active" : ""}" data-reveal="${index}" type="button">${game.revealed.includes(index) ? "Lista" : "Revelar"}</button>
              </div>
            `).join("")}
          </div>
          <div class="admin-actions">
            <button class="primary-button" id="saveConfig" type="button">Guardar configuracion</button>
            <button class="secondary-button" id="startRound" type="button">Iniciar ronda</button>
            <button class="danger-button" id="resetBuzz" type="button">Volver al inicio (QR)</button>
          </div>
        </article>

        <article class="admin-panel turn-panel">
          <h2>Turno y errores</h2>
          <div class="winner-box active-turn">
            <span>Equipo respondiendo</span>
            <strong>${activeTeamLabel(game) || "Esperando boton"}</strong>
          </div>
          <div class="admin-timer ${game.phase === "answering" ? "active" : ""}">
            <span>Tiempo para responder</span>
            <strong data-timer>${formatTimer(game.timerEndsAt)}</strong>
          </div>
          <div class="admin-strikes">
            <article class="${game.turnTeam === 0 ? "active" : ""}">
              <span>Equipo 1</span>
              <div>${strikeMarks(game.strikes[0])}</div>
            </article>
            <article class="${game.turnTeam === 1 ? "active" : ""}">
              <span>Equipo 2</span>
              <div>${strikeMarks(game.strikes[1])}</div>
            </article>
          </div>
          <button class="danger-button big-action" id="wrongAnswer" type="button" ${game.phase === "answering" ? "" : "disabled"}>Marcar error</button>
          <p class="muted">Al tercer error el turno pasa automaticamente al otro equipo. Los puntos ya ganados se quedan con su equipo.</p>
        </article>

        <article class="admin-panel">
          <h2>Marcador</h2>
          <div class="score-controls">
            <label>Equipo 1 <input id="score0" type="number" value="${game.scores[0]}" /></label>
            <label>Equipo 2 <input id="score1" type="number" value="${game.scores[1]}" /></label>
          </div>
          <div class="round-points">
            <span>Puntos revelados</span>
            <strong>${totalRoundPoints(round, game.revealed)}</strong>
          </div>
          <div class="admin-actions">
            <button class="secondary-button" id="saveScores" type="button">Guardar marcador</button>
          </div>
        </article>

        <article class="admin-panel winner-panel">
          <h2>Final de la partida</h2>
          <div class="winner-box final-result">
            <span>${game.winner ? "Equipo ganador" : "Se calcula con el marcador"}</span>
            <strong>${game.winner ? esc(game.winner.name) : game.scores[0] === game.scores[1] ? "Empate por ahora" : game.scores[0] > game.scores[1] ? "Va ganando Equipo 1" : "Va ganando Equipo 2"}</strong>
          </div>
          <button class="primary-button big-action" id="revealWinner" type="button">Revelar equipo ganador</button>
        </article>

        <article class="admin-panel">
          <h2>Celulares conectados</h2>
          <div class="players-list">
            ${game.players.length ? game.players.map((player) => `
              <div><strong>${esc(player.name)}</strong><span>${esc(player.team)}</span></div>
            `).join("") : "<p class='muted'>Aun no hay celulares registrados.</p>"}
          </div>
          <div class="winner-box">
            <span>Turno actual</span>
            <strong>${game.buzzerWinner ? `${esc(game.buzzerWinner.name)} - ${esc(game.buzzerWinner.team)}` : "Sin ganador"}</strong>
          </div>
        </article>
      </div>
    </section>
  `;

  bindAdminEvents();
}

async function onPlayerSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const name = form.get("name").trim();
  const team = form.get("team");
  if (!name) return;

  try {
    const result = await post("/api/player", { id: playerId, name, team });
    playerId = result.id;
    localStorage.setItem("family-player-id", playerId);
    showToast("Celular registrado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function onBuzz() {
  try {
    await post("/api/buzz", { id: playerId });
  } catch (error) {
    showToast(error.message);
  }
}

function readEditedQuestions() {
  const questions = copyState(currentState.questions);
  const round = questions[currentState.game.currentRound];
  round.question = document.querySelector("#questionText").value.trim() || "Pregunta sin titulo";
  round.answers = round.answers.map((answer, index) => ({
    text: document.querySelector(`[data-answer-text="${index}"]`).value.trim() || `Respuesta ${index + 1}`,
    points: Number(document.querySelector(`[data-answer-points="${index}"]`).value) || 0,
  }));
  return questions;
}

function bindAdminEvents() {
  document.querySelectorAll("[data-round]").forEach((button) => {
    button.addEventListener("click", async () => {
      await post("/api/round/select", { index: Number(button.dataset.round) });
    });
  });

  document.querySelector("#addRound").addEventListener("click", async () => {
    const questions = copyState(currentState.questions);
    questions.push({
      question: "Nueva pregunta",
      answers: Array.from({ length: 6 }, (_, index) => ({ text: `Respuesta ${index + 1}`, points: 0 })),
    });
    await post("/api/config", { questions });
  });

  document.querySelector("#saveConfig").addEventListener("click", async () => {
    await post("/api/config", { questions: readEditedQuestions() });
    showToast("Configuracion guardada.");
  });

  document.querySelector("#startRound").addEventListener("click", async () => {
    await post("/api/round/start", { index: currentState.game.currentRound });
  });

  document.querySelector("#resetBuzz").addEventListener("click", async () => {
    await post("/api/game/home");
  });

  document.querySelector("#wrongAnswer").addEventListener("click", async () => {
    await post("/api/answer/wrong");
  });

  document.querySelector("#revealWinner").addEventListener("click", async () => {
    await post("/api/game/winner");
  });

  document.querySelectorAll("[data-reveal]").forEach((button) => {
    button.addEventListener("click", async () => {
      await post("/api/answer/reveal", { index: Number(button.dataset.reveal) });
    });
  });

  document.querySelector("#saveScores").addEventListener("click", async () => {
    await post("/api/score", {
      scores: [Number(document.querySelector("#score0").value) || 0, Number(document.querySelector("#score1").value) || 0],
    });
  });
}

async function loadInitialState() {
  currentState = await api("/api/state");
  render();
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("state", (event) => {
    currentState = JSON.parse(event.data);
    render();
  });
  events.addEventListener("error", () => {
    window.setTimeout(loadInitialState, 1200);
  });
}

window.addEventListener("pointerdown", unlockSound, { once: true });

loadInitialState().then(connectEvents).catch((error) => {
  showFatalError(error.message);
});

window.addEventListener("error", (event) => {
  showFatalError(event.message || "El navegador del celular no pudo ejecutar la app.");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason && event.reason.message ? event.reason.message : "No se pudo completar la conexion.";
  showFatalError(reason);
});
