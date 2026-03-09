# Truco Venezolano — reinicio con Socket.IO

## Qué cambió
- Firebase fue removido del cliente.
- Se añadió conexión Socket.IO en `client/src/socket.js`.
- `client/src/App.jsx` ahora permite:
  - conectarse al servidor
  - crear sala
  - unirse a sala
  - ver jugadores conectados
  - ver mensajes del servidor
- `server/index.js` ahora maneja eventos reales de salas.
- Se añadió `server/rooms/roomManager.js` para separar la lógica básica de rooms.

## Cómo levantar el proyecto

### Servidor
```bash
cd server
npm install
npm run dev
```

### Cliente
```bash
cd client
npm install
npm run dev
```

## URLs
- Cliente Vite: `http://localhost:5173`
- Servidor Socket.IO: `http://localhost:3001`

## Siguiente paso recomendado
Crear una capa `server/game/` con:
- `createGameState.js`
- `deck.js`
- `gameEngine.js`

Y luego añadir eventos:
- `game:start`
- `game:state`
- `game:play-card`
- `game:call-truco`
