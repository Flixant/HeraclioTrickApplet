import { io } from "socket.io-client";

const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
const serverUrl = `http://${host}:3001`;

export const socket = io(serverUrl, {
  autoConnect: true,
});
