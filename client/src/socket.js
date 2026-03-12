import { io } from "socket.io-client";

const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
const serverUrl = import.meta.env.DEV
  ? undefined
  : import.meta.env.VITE_SERVER_URL || `http://${host}:3001`;
const configuredTransports = String(import.meta.env.VITE_SOCKET_TRANSPORTS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const transports = configuredTransports.length ? configuredTransports : ["polling"];
const allowUpgrade = String(import.meta.env.VITE_SOCKET_UPGRADE || "0") === "1";

export const socket = io(serverUrl, {
  autoConnect: false,
  path: "/socket.io",
  transports,
  upgrade: allowUpgrade,
  rememberUpgrade: false,
  forceNew: false,
  withCredentials: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});
