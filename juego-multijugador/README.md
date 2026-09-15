# 100 Enfermeros Dicen

Juego multijugador para proyeccion, dos celulares y control privado.

## Ejecutar en una computadora

1. Instala Node.js 20 o superior.
2. En esta carpeta ejecuta `npm start`.
3. Abre `http://127.0.0.1:4173/` en la proyeccion.

## Publicar para una clase remota

Este proyecto necesita un servidor Node.js porque `server.js` mantiene sincronizados los celulares, el tablero, el temporizador y los puntos. GitHub Pages no es compatible con esa parte.

1. Sube todos los archivos de esta carpeta a un repositorio de GitHub.
2. En Render crea un `Web Service` desde ese repositorio.
3. Render detecta `render.yaml`. Confirma `npm start` como comando de inicio y crea el servicio.
4. Render entrega una direccion como `https://100-enfermeros-dicen.onrender.com`.

Con ese unico enlace:

- Proyeccion: `https://TU-ENLACE.onrender.com/`
- Celulares: el codigo QR abre `https://TU-ENLACE.onrender.com/player`
- Administrador: `https://TU-ENLACE.onrender.com/admin`

Abre el enlace principal antes de la clase y mantenlo abierto durante el juego. El servicio gratuito puede tardar aproximadamente un minuto en despertar despues de estar inactivo y sus datos se reinician si el servicio se reinicia.
