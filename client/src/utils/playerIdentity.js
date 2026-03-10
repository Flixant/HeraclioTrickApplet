export function resolveMyPlayerId(players, options = {}) {
  const list = Array.isArray(players) ? players : [];
  if (!list.length) return options.fallbackId || null;

  const socketId = options.socketId || null;
  const reconnectToken = options.reconnectToken || null;
  const playerName = (options.playerName || "").trim();
  const fallbackId = options.fallbackId || null;

  const meBySocket = socketId ? list.find((p) => p.id === socketId) : null;
  if (meBySocket?.id) return meBySocket.id;

  const meByToken = reconnectToken
    ? list.find((p) => p.reconnectToken === reconnectToken)
    : null;
  if (meByToken?.id) return meByToken.id;

  const meByName = playerName
    ? list.find((p) => String(p.name || "").trim() === playerName)
    : null;
  if (meByName?.id) return meByName.id;

  return fallbackId;
}
