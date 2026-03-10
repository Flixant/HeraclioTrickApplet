import { io } from "socket.io-client";

const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
const serverUrl = import.meta.env.VITE_SERVER_URL || `http://${host}:3001`;

export const socket = io(serverUrl, {
  autoConnect: true,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});
