const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const {
  rooms,
  getPublicRooms,
  getRoom,
  addPlayer,
  removePlayer,
} = require("./rooms/roomManager");
const startGame = require("./game/startGame");

function resolveHandRank(card, vira) {
  if (!card || typeof card.rank !== "number") {
    throw new Error("Carta sin rank en servidor");
  }
  if (card.rank === 0) return 0;

  if (!vira) return card.rank;

  const sameSuitAsVira = card.suit === vira.suit;
  if (!sameSuitAsVira) return card.rank;

  const viraValue = Number(vira.value);
  const cardValue = Number(card.value);

  const pericoValue = viraValue === 11 ? 12 : 11;
  const pericaValue = viraValue === 10 ? 12 : 10;

  if (cardValue === pericoValue) return 16;
  if (cardValue === pericaValue) return 15;
  return card.rank;
}

const app = express();
app.use(cors());

const server = http.createServer(app);

// TEMP (LAN testing): allow common private LAN ranges with any dev port (Vite may use 5173/5174/etc).
const LAN_DEV_ORIGIN =
  /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/;

const io = new Server(server, {
  cors: {
    // TEMP (remove after testing): relax CORS for LAN frontend testing from phone/tablet.
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (LAN_DEV_ORIGIN.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
  },
});

function emitRooms() {
  io.emit("rooms:update", getPublicRooms());
}

const MESSAGE_LOCK_MS = 1700;
const GAME_TARGET = 12;
const BOT_PREFIX = "bot:";
const BOT_TICK_MS = 1100;
const RECONNECT_GRACE_MS = 45000;
let botLoopStarted = false;
let botsDebugEnabled = false;
const botNextActionAt = new Map();
const disconnectedSeatTimeouts = new Map();

function getSeatTimeoutKey(roomId, playerId) {
  return `${roomId}:${playerId}`;
}

function clearSeatTimeout(roomId, playerId) {
  const key = getSeatTimeoutKey(roomId, playerId);
  const timeout = disconnectedSeatTimeouts.get(key);
  if (timeout) {
    clearTimeout(timeout);
    disconnectedSeatTimeouts.delete(key);
  }
}

function replacePlayerIdDeep(node, oldId, newId, seen = new WeakMap()) {
  if (node === null || typeof node === "undefined") return node;
  if (typeof node === "string") return node === oldId ? newId : node;
  if (typeof node !== "object") return node;
  if (seen.has(node)) return seen.get(node);

  if (Array.isArray(node)) {
    const nextArr = [];
    seen.set(node, nextArr);
    for (const item of node) {
      nextArr.push(replacePlayerIdDeep(item, oldId, newId, seen));
    }
    return nextArr;
  }

  const nextObj = {};
  seen.set(node, nextObj);
  for (const [key, value] of Object.entries(node)) {
    const nextKey = key === oldId ? newId : key;
    nextObj[nextKey] = replacePlayerIdDeep(value, oldId, newId, seen);
  }
  return nextObj;
}

function reclaimDisconnectedSeat(room, socket, nextPlayerName, reconnectToken) {
  if (!room || !room.gameState || !reconnectToken) return false;
  const disconnected = room.players.find(
    (p) => p.reconnectToken === reconnectToken && p.connected === false
  );
  if (!disconnected) return false;

  const oldId = disconnected.id;
  const newId = socket.id;
  disconnected.id = newId;
  disconnected.connected = true;
  disconnected.lastSeenAt = Date.now();
  disconnected.name = nextPlayerName || disconnected.name;
  disconnected.reconnectToken = reconnectToken;
  clearSeatTimeout(room.id, oldId);

  room.gameState = replacePlayerIdDeep(room.gameState, oldId, newId);
  return true;
}

function isBotPlayerId(playerId) {
  return String(playerId || "").startsWith(BOT_PREFIX);
}

function botLog(...args) {
  if (!botsDebugEnabled) return;
  console.log("[BOTS]", ...args);
}

function getBotActionKey(roomId, botId) {
  return `${roomId}:${botId}`;
}

function randomBotDelayMs() {
  return 400 + Math.floor(Math.random() * 1100);
}

function canBotActNow(roomId, botId) {
  const key = getBotActionKey(roomId, botId);
  const dueAt = botNextActionAt.get(key) || 0;
  return Date.now() >= dueAt;
}

function setBotCooldown(roomId, botId, delayMs = randomBotDelayMs()) {
  const key = getBotActionKey(roomId, botId);
  botNextActionAt.set(key, Date.now() + delayMs);
}

function getNextPlayerId(gameState, currentPlayerId) {
  const playerIds = (gameState?.players || []).map((p) => p.id);
  if (!playerIds.length) return null;
  const currentIndex = playerIds.indexOf(currentPlayerId);
  if (currentIndex < 0) return playerIds[0];
  const step = gameState?.mode === "2vs2" ? -1 : 1;
  const nextIndex = (currentIndex + step + playerIds.length) % playerIds.length;
  return playerIds[nextIndex];
}

function getNextRoundStarterId(gameState) {
  const players = gameState?.players || [];
  if (!players.length) return null;
  const currentStarter = gameState?.roundStarter || players[0]?.id;
  return getNextPlayerId(gameState, currentStarter);
}

function getPlayerTeamKey(gameState, playerId) {
  const teams = gameState?.teams || {};
  if (Array.isArray(teams.team1) && teams.team1.includes(playerId)) return "team1";
  if (Array.isArray(teams.team2) && teams.team2.includes(playerId)) return "team2";

  const players = gameState?.players || [];
  if (gameState?.mode === "2vs2" && players.length === 4) {
    const idx = players.findIndex((p) => p.id === playerId);
    if (idx < 0) return null;
    return idx % 2;
  }
  return playerId;
}

function isSameTeam(gameState, playerA, playerB) {
  const a = getPlayerTeamKey(gameState, playerA);
  const b = getPlayerTeamKey(gameState, playerB);
  return a !== null && b !== null && a === b;
}

function getTeamHandWins(gameState, playerId) {
  const results = gameState?.handResults || [];
  let wins = 0;
  for (const winnerId of results) {
    if (winnerId && isSameTeam(gameState, playerId, winnerId)) wins += 1;
  }
  return wins;
}

function pickRoundWinnerByTeam(gameState) {
  const playerIdsByOrder = (gameState?.players || []).map((p) => p.id);
  const results = gameState?.handResults || [];
  if (!playerIdsByOrder.length) return null;

  const teamWins = new Map();
  for (const winnerId of results) {
    if (!winnerId) continue;
    const teamKey = getPlayerTeamKey(gameState, winnerId);
    if (teamKey === null || typeof teamKey === "undefined") continue;
    teamWins.set(teamKey, (teamWins.get(teamKey) || 0) + 1);
  }

  if (!teamWins.size) {
    return gameState.roundStarter || playerIdsByOrder[0];
  }

  let winningTeamKey = null;
  let maxWins = -1;
  for (const [teamKey, wins] of teamWins.entries()) {
    if (wins > maxWins) {
      maxWins = wins;
      winningTeamKey = teamKey;
    }
  }

  const tiedTeams = [...teamWins.entries()]
    .filter(([, wins]) => wins === maxWins)
    .map(([teamKey]) => teamKey);

  if (tiedTeams.length > 1) {
    return (results.find((winnerId) => !!winnerId) || gameState.roundStarter || playerIdsByOrder[0]);
  }

  return (
    results.find((winnerId) => winnerId && getPlayerTeamKey(gameState, winnerId) === winningTeamKey) ||
    playerIdsByOrder.find((playerId) => getPlayerTeamKey(gameState, playerId) === winningTeamKey) ||
    gameState.roundStarter ||
    playerIdsByOrder[0]
  );
}

function resolveWinnerFromRankEntries(gameState, entries = []) {
  if (!Array.isArray(entries) || !entries.length) return null;
  if (gameState?.mode !== "2vs2") {
    return entries.length === 1 ? entries[0]?.card?.playerId || null : null;
  }

  const teamKeys = new Set(
    entries
      .map((entry) => getPlayerTeamKey(gameState, entry?.card?.playerId))
      .filter((key) => key !== null && typeof key !== "undefined")
  );

  // Si empatan solo miembros de una misma pareja, gana esa pareja (no es parda).
  if (teamKeys.size === 1) {
    return entries[0]?.card?.playerId || null;
  }

  // Parda real solo si el empate involucra parejas distintas.
  return null;
}

function getCurrentWinningInfo(gameState) {
  const currentCards = gameState?.currentHandCards || [];
  if (!currentCards.length) return { bestRank: -Infinity, winnerId: null, tied: false };
  const withRank = currentCards.map((card) => ({
    playerId: card.playerId,
    rank: resolveHandRank(card, gameState.vira),
  }));
  const bestRank = Math.max(...withRank.map((x) => x.rank));
  const winners = withRank.filter((x) => x.rank === bestRank);
  return {
    bestRank,
    winnerId: winners.length === 1 ? winners[0].playerId : null,
    tied: winners.length !== 1,
  };
}

function getTurnOrder(gameState, startId) {
  const players = gameState?.players || [];
  if (!players.length) return [];
  const fallback = players[0]?.id || null;
  const start = players.some((p) => p.id === startId) ? startId : fallback;
  if (!start) return [];
  const order = [start];
  let probe = start;
  for (let i = 1; i < players.length; i += 1) {
    probe = getNextPlayerId(gameState, probe);
    if (!probe) break;
    order.push(probe);
  }
  return order;
}

function getOrderIndexMap(gameState, startId) {
  const order = getTurnOrder(gameState, startId);
  const map = new Map();
  order.forEach((id, idx) => map.set(id, idx));
  return map;
}

function getTeamPlayerIds(gameState, playerId) {
  const players = gameState?.players || [];
  const myTeam = getPlayerTeamKey(gameState, playerId);
  if (myTeam === null || typeof myTeam === "undefined") return [];
  return players
    .map((p) => p.id)
    .filter((id) => getPlayerTeamKey(gameState, id) === myTeam);
}

function getOpposingPlayerIds(gameState, playerId) {
  const players = gameState?.players || [];
  return players
    .map((p) => p.id)
    .filter((id) => id !== playerId && !isSameTeam(gameState, id, playerId));
}

function resolveScoreWinnerByTeam(gameState, scoreByPlayer = {}, candidateIds = null) {
  const players = gameState?.players || [];
  const allIds = players.map((p) => p.id);
  const considered = Array.isArray(candidateIds) && candidateIds.length
    ? allIds.filter((id) => candidateIds.includes(id))
    : allIds;
  if (!considered.length) return null;

  const orderMap = getOrderIndexMap(
    gameState,
    gameState?.currentHandStarter || gameState?.roundStarter || considered[0]
  );
  const idxOf = (id) => orderMap.get(id) ?? Number.MAX_SAFE_INTEGER;

  const bestByTeam = new Map();
  for (const playerId of considered) {
    const teamKey = getPlayerTeamKey(gameState, playerId);
    if (teamKey === null || typeof teamKey === "undefined") continue;
    const score = Number(scoreByPlayer[playerId]) || 0;
    const current = bestByTeam.get(teamKey);
    if (!current) {
      bestByTeam.set(teamKey, { playerId, score });
      continue;
    }
    if (score > current.score || (score === current.score && idxOf(playerId) < idxOf(current.playerId))) {
      bestByTeam.set(teamKey, { playerId, score });
    }
  }

  if (!bestByTeam.size) return considered[0];

  let winner = null;
  for (const entry of bestByTeam.values()) {
    if (!winner) {
      winner = entry;
      continue;
    }
    if (entry.score > winner.score || (entry.score === winner.score && idxOf(entry.playerId) < idxOf(winner.playerId))) {
      winner = entry;
    }
  }
  return winner?.playerId || considered[0];
}

function resolveFlorWinnerId(gameState) {
  const flor = gameState?.flor || {};
  const snapshot = gameState?.roundHandsSnapshot || gameState?.hands || {};
  const players = gameState?.players || [];
  const sungIds = players
    .map((p) => p.id)
    .filter(
      (id) =>
        !!flor.hasFlorByPlayer?.[id] &&
        !!flor.sungByPlayer?.[id] &&
        !flor.burnedByPlayer?.[id]
    );
  if (!sungIds.length) return null;

  const scoreByPlayer = {};
  for (const id of sungIds) {
    scoreByPlayer[id] = computeFlorValue(snapshot[id] || [], gameState.vira);
  }
  return resolveScoreWinnerByTeam(gameState, scoreByPlayer, sungIds);
}

function didAllTeamsSingFlor(gameState) {
  const flor = gameState?.flor || {};
  const players = gameState?.players || [];
  const teams = new Map();
  for (const p of players) {
    const id = p.id;
    const teamKey = getPlayerTeamKey(gameState, id);
    if (teamKey === null || typeof teamKey === "undefined") continue;
    if (!teams.has(teamKey)) teams.set(teamKey, []);
    teams.get(teamKey).push(id);
  }
  if (teams.size < 2) return false;
  for (const ids of teams.values()) {
    const teamSang = ids.some((id) => !!flor.sungByPlayer?.[id]);
    if (!teamSang) return false;
  }
  return true;
}

function isTeamMarkedInFlorEnvidoWindow(gameState, playerId) {
  const flor = gameState?.flor || {};
  const teamIds = getTeamPlayerIds(gameState, playerId);
  if (!teamIds.length) return false;
  return teamIds.some((id) => !!flor.florEnvidoSkippedByPlayer?.[id]);
}

function markFlorEnvidoWindowForTeam(gameState, playerId) {
  const flor = gameState?.flor || {};
  const teamIds = getTeamPlayerIds(gameState, playerId);
  for (const id of teamIds) {
    flor.florEnvidoSkippedByPlayer[id] = true;
  }
}

function getWinnerLabel(gameState, playerId, fallback = "Jugador") {
  if (!playerId) return fallback;
  const player = (gameState?.players || []).find((p) => p.id === playerId);
  if (gameState?.mode !== "2vs2") return player?.name || fallback;
  const teamIds = getTeamPlayerIds(gameState, playerId);
  const teamNames = (gameState?.players || [])
    .filter((p) => teamIds.includes(p.id))
    .map((p) => p.name || "Jugador");
  const joined = teamNames.join(" / ");
  return joined || player?.name || fallback;
}

function getMatchWinnerId(gameState) {
  if (!gameState) return null;
  if (gameState.mode === "2vs2") {
    ensureScoreState(gameState);
    const t1 = Number(gameState.score?.team1) || 0;
    const t2 = Number(gameState.score?.team2) || 0;
    if (t1 < GAME_TARGET && t2 < GAME_TARGET) return null;
    const teamKey = t1 >= t2 ? "team1" : "team2";
    const ids = Array.isArray(gameState?.teams?.[teamKey]) ? gameState.teams[teamKey] : [];
    return ids[0] || null;
  }

  const players = gameState.players || [];
  let winnerId = null;
  let best = -1;
  for (const p of players) {
    const pts = Number(gameState.pointsByPlayer?.[p.id]) || 0;
    if (pts > best) {
      best = pts;
      winnerId = p.id;
    }
  }
  return best >= GAME_TARGET ? winnerId : null;
}

function buildRematchState(gameState) {
  const decisionsByPlayer = {};
  for (const player of gameState?.players || []) {
    decisionsByPlayer[player.id] = null;
  }
  return {
    status: "pending",
    decisionsByPlayer,
    resolved: false,
    result: null,
  };
}

function canPlayerOpenFlorEnvidoWindow(gameState, playerId) {
  const flor = gameState?.flor || {};
  if (!playerId) return false;
  if (!flor.hasFlorByPlayer?.[playerId] || !flor.sungByPlayer?.[playerId]) return false;
  if (isTeamMarkedInFlorEnvidoWindow(gameState, playerId)) return false;
  return true;
}

function getOpposingResponderId(gameState, callerId) {
  let probe = callerId;
  for (let i = 0; i < (gameState?.players || []).length; i += 1) {
    probe = getNextPlayerId(gameState, probe);
    if (!probe) break;
    if (!isSameTeam(gameState, callerId, probe)) return probe;
  }
  return null;
}

function isInputLocked(gameState) {
  return (gameState?.inputLockedUntil || 0) > Date.now();
}

function emitLockedMessage(roomId, gameState, message, lockMs = MESSAGE_LOCK_MS) {
  if (gameState) {
    const nextUnlock = Date.now() + lockMs;
    gameState.inputLockedUntil = Math.max(gameState.inputLockedUntil || 0, nextUnlock);
  }
  io.to(roomId).emit("server:message", message);
}

const CALL_LABELS = {
  truco: "Truco",
  retruco: "Retruco",
  vale9: "Vale 9",
  valejuego: "Vale Juego",
};

function resolveEnvidoValue(card, vira) {
  if (!card) return 0;

  const baseEnvValue = Number(card.envValue || 0);
  if (!vira || card.suit !== vira.suit) return baseEnvValue;

  const viraValue = Number(vira.value);
  const cardValue = Number(card.value);
  const pericoValue = viraValue === 11 ? 12 : 11;
  const pericaValue = viraValue === 10 ? 12 : 10;

  if (cardValue === pericoValue) return 30;
  if (cardValue === pericaValue) return 29;
  return baseEnvValue;
}

function computeEnvido(cards, vira) {
  if (!Array.isArray(cards) || cards.length === 0) return 0;

  const bySuit = {};
  const envValues = [];
  let bestSingle = 0;
  for (const card of cards) {
    const suit = card.suit;
    const envValue = resolveEnvidoValue(card, vira);
    envValues.push(envValue);
    bestSingle = Math.max(bestSingle, envValue);
    bySuit[suit] = bySuit[suit] || [];
    bySuit[suit].push(envValue);
  }

  let bestPair = 0;
  for (const values of Object.values(bySuit)) {
    if (values.length >= 2) {
      const topTwo = [...values].sort((a, b) => b - a).slice(0, 2);
      const hasPericoOrPerica = topTwo.some((value) => value >= 29);
      const pairScore = topTwo[0] + topTwo[1] + (hasPericoOrPerica ? 0 : 20);
      bestPair = Math.max(bestPair, pairScore);
    }
  }

  // Perico/Perica en envite pueden combinar con cualquier otra carta.
  const specialValues = envValues.filter((value) => value >= 29);
  const nonSpecialValues = envValues.filter((value) => value < 29);
  if (specialValues.length > 0 && nonSpecialValues.length > 0) {
    const bestSpecial = Math.max(...specialValues);
    const bestOther = Math.max(...nonSpecialValues);
    bestPair = Math.max(bestPair, bestSpecial + bestOther);
  }

  return Math.max(bestPair, bestSingle);
}

function computeFaltaEnvidoPoints(gameState = {}) {
  const isTeams = gameState?.mode === "2vs2";
  const sourceScores = isTeams
    ? [Number(gameState?.score?.team1) || 0, Number(gameState?.score?.team2) || 0]
    : Object.values(gameState?.pointsByPlayer || {}).map((v) => Number(v) || 0);
  const currentBestScore = Math.max(...sourceScores, 0);
  return Math.max(1, GAME_TARGET - currentBestScore);
}

function ensureScoreState(gameState) {
  if (!gameState) return;
  gameState.score = gameState.score || { team1: 0, team2: 0 };
  if (typeof gameState.score.team1 !== "number") gameState.score.team1 = 0;
  if (typeof gameState.score.team2 !== "number") gameState.score.team2 = 0;
}

function getScoreTeamField(gameState, playerId) {
  const key = getPlayerTeamKey(gameState, playerId);
  if (key === "team1" || key === 0) return "team1";
  if (key === "team2" || key === 1) return "team2";
  return null;
}

function addPoints(gameState, playerId, points) {
  const safePoints = Number(points) || 0;
  if (!gameState || !playerId || safePoints <= 0) return;
  if (gameState.mode === "2vs2") {
    ensureScoreState(gameState);
    const teamField = getScoreTeamField(gameState, playerId);
    if (teamField) {
      gameState.score[teamField] += safePoints;
      return;
    }
  }
  gameState.pointsByPlayer[playerId] = (gameState.pointsByPlayer[playerId] || 0) + safePoints;
}

function getTotalPoints(gameState, playerId) {
  if (!gameState || !playerId) return 0;
  if (gameState.mode === "2vs2") {
    ensureScoreState(gameState);
    const teamField = getScoreTeamField(gameState, playerId);
    if (teamField) return Number(gameState.score?.[teamField]) || 0;
  }
  return Number(gameState.pointsByPlayer?.[playerId]) || 0;
}

function hasAvailableFlor(gameState, playerId) {
  const flor = gameState?.flor;
  if (!flor || !playerId) return false;
  const mustConfirmInThird = !!flor.requireThirdByPlayer?.[playerId];
  return (
    !!flor.hasFlorByPlayer?.[playerId] &&
    (!flor.sungByPlayer?.[playerId] || mustConfirmInThird) &&
    !flor.burnedByPlayer?.[playerId]
  );
}

function markFlorBurned(gameState, playerId, options = {}) {
  if (!gameState?.flor || !playerId) return;
  const { force = false, reason = null } = options;
  if (!force && gameState.flor?.reservadaByPlayer?.[playerId]) return;
  gameState.flor.burnedByPlayer[playerId] = true;
  if (reason) {
    gameState.flor.burnedReasonByPlayer = gameState.flor.burnedReasonByPlayer || {};
    gameState.flor.burnedReasonByPlayer[playerId] = reason;
  }

  const envido = gameState.envido || {};
  if (
    (envido.status === "cancelled" || envido.status === "cancelled_by_flor") &&
    !envido.resolved &&
    envido.responderId === playerId &&
    envido.callerId
  ) {
    gameState.envido = {
      ...envido,
      status: "rejected",
      winnerId: envido.callerId,
      points: 1,
      acceptedPoints: 1,
      resolved: false,
    };
  }
}

function getFirstHandPieId(gameState) {
  if (!gameState || gameState.handNumber !== 1) return null;
  const playerIds = (gameState.players || []).map((p) => p.id);
  if (playerIds.length < 2) return null;
  const starterId = gameState.currentHandStarter || gameState.roundStarter || playerIds[0];
  const starterIndex = playerIds.indexOf(starterId);
  if (starterIndex < 0) return null;
  const pieIndex = (starterIndex - 1 + playerIds.length) % playerIds.length;
  return playerIds[pieIndex];
}

function isFirstHandOpen(gameState) {
  const playerIds = gameState.players.map((p) => p.id);
  return (
    Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
    (gameState.tableCards?.length || 0) < playerIds.length
  );
}

function computeFlorValue(cards, vira) {
  return computeEnvido(cards, vira);
}

function burnFlorOnRespondWithoutConFlor(gameState, playerId) {
  if (!hasAvailableFlor(gameState, playerId)) return;
  if (gameState?.flor?.sungByPlayer?.[playerId]) return;
  markFlorBurned(gameState, playerId);
}

function canSingFlorNow(gameState, playerId) {
  if (!hasAvailableFlor(gameState, playerId)) return false;
  if (isFirstHandOpen(gameState)) return true;
  if (gameState?.handNumber === 3 && !!gameState?.flor?.requireThirdByPlayer?.[playerId]) return true;
  return gameState?.handNumber === 2 && !!gameState?.flor?.leyByPlayer?.[playerId];
}

function canCallFlorEnvido(gameState, playerId) {
  const flor = gameState?.flor;
  if (!flor || !playerId) return false;
  return (
    didAllTeamsSingFlor(gameState) &&
    !flor.florEnvidoCalled &&
    !flor.resolved &&
    (flor.florEnvidoStatus || "idle") === "idle" &&
    !!flor.florEnvidoWindowOpen &&
    flor.florEnvidoWindowTurnId === playerId &&
    gameState.turn === playerId
  );
}

function isFlorEnvidoPending(gameState) {
  return (gameState?.flor?.florEnvidoStatus || "idle") === "pending";
}

function isFlorAlreadySung(gameState) {
  const sung = gameState?.flor?.sungByPlayer || {};
  return Object.values(sung).some(Boolean);
}

function getFlorReservadaOwnerId(gameState) {
  const ownerId = gameState?.flor?.reservadaOwnerId;
  if (!ownerId) return null;
  const stillSeated = (gameState?.players || []).some((p) => p.id === ownerId);
  return stillSeated ? ownerId : null;
}

function refreshFlorEnvidoWindow(gameState) {
  const flor = gameState?.flor;
  if (!flor || flor.florEnvidoCalled || flor.resolved) return;
  if (!didAllTeamsSingFlor(gameState)) return;
  const currentTurn = gameState.turn || null;
  const players = gameState.players || [];
  const playerIds = players.map((p) => p.id);
  if (!flor.florEnvidoWindowOpen) {
    if (currentTurn && canPlayerOpenFlorEnvidoWindow(gameState, currentTurn)) {
      flor.florEnvidoWindowOpen = true;
      flor.florEnvidoWindowTurnId = currentTurn;
      return;
    }
    const order = getTurnOrder(gameState, currentTurn || playerIds[0]);
    const alt = order.find((id) => canPlayerOpenFlorEnvidoWindow(gameState, id));
    if (alt) {
      flor.florEnvidoWindowOpen = true;
      flor.florEnvidoWindowTurnId = alt;
    }
  }
}

function closeFlorEnvidoWindow(gameState) {
  if (!gameState?.flor) return;
  gameState.flor.florEnvidoWindowOpen = false;
  gameState.flor.florEnvidoWindowTurnId = null;
}

function advanceFlorEnvidoWindowAfterPass(gameState, playerId) {
  const flor = gameState?.flor;
  if (!flor || flor.florEnvidoCalled || flor.resolved) return;
  if (!flor.florEnvidoWindowOpen || flor.florEnvidoWindowTurnId !== playerId) return;
  markFlorEnvidoWindowForTeam(gameState, playerId);
  const order = getTurnOrder(gameState, playerId);
  const nextId = order.find((id) => id !== playerId && canPlayerOpenFlorEnvidoWindow(gameState, id));
  if (nextId) {
    flor.florEnvidoWindowOpen = true;
    flor.florEnvidoWindowTurnId = nextId;
    return;
  }
  closeFlorEnvidoWindow(gameState);
}

function forceFlorHandForPlayer(gameState, playerId) {
  const hand = gameState?.hands?.[playerId];
  if (!Array.isArray(hand) || hand.length !== 3) return false;

  const cardKey = (card) => `${card?.suit}-${card?.value}`;
  const targetSuit = hand[0]?.suit || "bastos";
  const usedKeys = new Set(hand.map(cardKey));
  const bySuit = hand.filter((card) => card.suit === targetSuit);

  const replacementFromDeck = (gameState.deck || []).filter(
    (card) => card.suit === targetSuit && !usedKeys.has(cardKey(card))
  );

  const needed = 3 - bySuit.length;
  if (needed > replacementFromDeck.length) {
    return false;
  }

  const nextHand = [...bySuit];
  for (let i = 0; i < needed; i += 1) {
    const picked = replacementFromDeck[i];
    nextHand.push({ ...picked });
    const deckIdx = gameState.deck.findIndex((c) => cardKey(c) === cardKey(picked));
    if (deckIdx >= 0) {
      gameState.deck.splice(deckIdx, 1);
    }
  }

  gameState.hands[playerId] = nextHand.slice(0, 3);
  gameState.roundHandsSnapshot[playerId] = nextHand.slice(0, 3).map((card) => ({ ...card }));

  if (gameState.flor) {
    gameState.flor.hasFlorByPlayer[playerId] = true;
    gameState.flor.sungByPlayer[playerId] = false;
    gameState.flor.burnedByPlayer[playerId] = false;
    gameState.flor.leyByPlayer[playerId] = false;
  }

  return true;
}

function getPericoPericaValues(viraValue) {
  const pericoValue = viraValue === 11 ? 12 : 11;
  const pericaValue = viraValue === 10 ? 12 : 10;
  return { pericoValue, pericaValue };
}

function forceFlorReservadaForPlayer(gameState, playerId) {
  const hand = gameState?.hands?.[playerId];
  const vira = gameState?.vira;
  if (!Array.isArray(hand) || hand.length !== 3 || !vira) return false;

  const viraSuit = vira.suit;
  const viraValue = Number(vira.value);
  const { pericoValue, pericaValue } = getPericoPericaValues(viraValue);
  const valueSet = new Set([pericoValue, pericaValue]);
  if (valueSet.size < 2) return false;

  const cardKey = (card) => `${card?.suit}-${card?.value}`;
  const neededKeys = new Set([
    `${viraSuit}-${pericoValue}`,
    `${viraSuit}-${pericaValue}`,
  ]);

  const pool = [...(gameState.deck || []), ...hand];
  const used = new Set();
  const selected = [];

  for (const key of neededKeys) {
    const idx = pool.findIndex((c, i) => !used.has(i) && cardKey(c) === key);
    if (idx < 0) return false;
    used.add(idx);
    selected.push({ ...pool[idx] });
  }

  const fillerIdx = pool.findIndex((c, i) => !used.has(i));
  if (fillerIdx < 0) return false;
  used.add(fillerIdx);
  selected.push({ ...pool[fillerIdx] });

  const selectedKeys = new Set(selected.map(cardKey));
  gameState.hands[playerId] = selected;
  gameState.roundHandsSnapshot[playerId] = selected.map((c) => ({ ...c }));
  gameState.deck = pool
    .filter((c) => !selectedKeys.has(cardKey(c)))
    .map((c) => ({ ...c }));

  if (gameState.flor) {
    gameState.flor.hasFlorByPlayer[playerId] = true;
    gameState.flor.reservadaByPlayer[playerId] = true;
    gameState.flor.reservadaOwnerId = playerId;
    gameState.flor.sungByPlayer[playerId] = false;
    gameState.flor.burnedByPlayer[playerId] = false;
    gameState.flor.leyByPlayer[playerId] = false;
    gameState.flor.requireThirdByPlayer[playerId] = false;
  }

  return true;
}

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  socket.emit("rooms:update", getPublicRooms());

  socket.on("rooms:list", () => {
    socket.emit("rooms:update", getPublicRooms());
  });

  socket.on("debug:bots", ({ enabled }) => {
    botsDebugEnabled = !!enabled;
    socket.emit("server:message", `Bots debug ${botsDebugEnabled ? "activado" : "desactivado"}`);
  });

  function tryCallRaise(roomId, callType) {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const truco = gameState.truco || {};
    const currentValue = gameState.roundPointValue || 1;
    if (gameState.roundEnding) {
      socket.emit("server:message", "Esperando nuevo reparto...");
      return;
    }
    if (isInputLocked(gameState)) return;

    if (gameState.turn !== socket.id) {
      socket.emit("server:message", `Solo puede cantar ${CALL_LABELS[callType]} el jugador en turno`);
      return;
    }

    if (truco.status === "pending") {
      socket.emit("server:message", "Ya hay un canto pendiente de respuesta");
      return;
    }
    if (gameState.envido?.status === "pending") {
      socket.emit("server:message", "Primero debe resolverse el Envido pendiente");
      return;
    }
    if (isFlorEnvidoPending(gameState)) {
      socket.emit("server:message", "Primero debe resolverse el Flor Envido pendiente");
      return;
    }

    const callConfig = {
      truco: { requiredValue: 1, proposedValue: 3, requiresAcceptedBy: false },
      retruco: { requiredValue: 3, proposedValue: 6, requiresAcceptedBy: true },
      vale9: { requiredValue: 6, proposedValue: 9, requiresAcceptedBy: true },
      valejuego: { requiredValue: 9, proposedValue: 12, requiresAcceptedBy: true },
    }[callType];

    if (!callConfig) return;

    if (currentValue !== callConfig.requiredValue) {
      socket.emit(
        "server:message",
        `${CALL_LABELS[callType]} solo aplica cuando la ronda vale ${callConfig.requiredValue}`
      );
      return;
    }

    const acceptedByThisSide =
      !!truco.acceptedById &&
      (truco.acceptedById === socket.id || isSameTeam(gameState, truco.acceptedById, socket.id));
    if (callConfig.requiresAcceptedBy && !acceptedByThisSide) {
      socket.emit(
        "server:message",
        `Solo puede cantar ${CALL_LABELS[callType]} quien acepto el canto anterior`
      );
      return;
    }

    const responderId = getOpposingResponderId(gameState, socket.id);
    const responder = gameState.players.find((player) => player.id === responderId);
    if (!responder) return;

    gameState.truco = {
      status: "pending",
      callerId: socket.id,
      responderId: responder.id,
      callType,
      proposedValue: callConfig.proposedValue,
      acceptedById: truco.acceptedById || null,
    };

    const caller = gameState.players.find((player) => player.id === socket.id);
    if (caller?.name) {
      emitLockedMessage(roomId, gameState, `${caller.name} canto ${CALL_LABELS[callType]}`);
    }

    io.to(roomId).emit("game:update", gameState);
  }

  function scheduleRedeal(roomId, delayMs = 1800) {
    setTimeout(() => {
      const currentRoom = getRoom(roomId);
      if (!currentRoom || !currentRoom.gameState) return;
      if (!currentRoom.gameState.roundEnding) return;

      const starterId = getNextRoundStarterId(currentRoom.gameState);
      startGame.redealRound(currentRoom, starterId);
      io.to(roomId).emit("game:update", currentRoom.gameState);
    }, delayMs);
  }

  function emitMessageSequence(roomId, messages, stepMs = 2400) {
    messages.forEach((message, index) => {
      setTimeout(() => {
        io.to(roomId).emit("server:message", message);
      }, index * stepMs);
    });
    return messages.length * stepMs;
  }

  function resolveRound(room, winnerId, roomId) {
    const gameState = room.gameState;
    const winnerLabel = getWinnerLabel(gameState, winnerId);
    const roundPoints = gameState.roundPointValue || 1;
    const reservadaOwnerId = getFlorReservadaOwnerId(gameState);
    const messageQueue = [];

    if (winnerLabel) {
      messageQueue.push(`${winnerLabel} gana el truco`);
    }

    const flor = gameState.flor || {};
    const reachedThirdHand = (gameState.handNumber || 1) >= 3;
    const pendingThirdFlorIds = reachedThirdHand
      ? gameState.players
          .map((p) => p.id)
          .filter((playerId) => !!flor.requireThirdByPlayer?.[playerId] && !flor.burnedByPlayer?.[playerId])
      : [];
    if (reachedThirdHand) {
      for (const playerId of pendingThirdFlorIds) {
        markFlorBurned(gameState, playerId);
        if (gameState.flor?.requireThirdByPlayer) {
          gameState.flor.requireThirdByPlayer[playerId] = false;
        }
      }
      if (pendingThirdFlorIds.length > 0) {
        const pendingNames = gameState.players
          .filter((p) => pendingThirdFlorIds.includes(p.id))
          .map((p) => p.name || "Jugador");
        messageQueue.push(
          `${pendingNames.join(" y ")} perdio${pendingNames.length > 1 ? "eron" : ""} la Flor por no confirmarla en tercera`
        );
      }
    }

    const burnedByLeyPieIds = gameState.players
      .map((p) => p.id)
      .filter((playerId) => gameState.flor?.burnedReasonByPlayer?.[playerId] === "ley_pie");
    if (burnedByLeyPieIds.length > 0) {
      const burnedNames = gameState.players
        .filter((p) => burnedByLeyPieIds.includes(p.id))
        .map((p) => p.name || "Jugador");
      messageQueue.push(
        `${burnedNames.join(" y ")} quemo${burnedNames.length > 1 ? "n" : ""} la flor por jugar a ley siendo pie`
      );
    }

    const florWinnerBurned = !!flor.winnerId && !!gameState.flor?.burnedByPlayer?.[flor.winnerId];
    if (!flor.resolved) {
      const florWinnerId = reservadaOwnerId || flor.winnerId || null;
      const validFlorWinner =
        !!florWinnerId && !(florWinnerBurned && florWinnerId === flor.winnerId);

        if (validFlorWinner) {
          const florPoints = Math.max(3, flor.points || 3);
          addPoints(gameState, florWinnerId, florPoints);
          const florTotal = getTotalPoints(gameState, florWinnerId);
          const florWinnerLabel = getWinnerLabel(gameState, florWinnerId);
          messageQueue.push(`${florWinnerLabel} gana la flor`);
          messageQueue.push(
            `${florWinnerLabel} suma ${florPoints} punto${florPoints > 1 ? "s" : ""} de Flor (total ${florTotal})`
          );
          gameState.flor = { ...flor, resolved: true, winnerId: florWinnerId };
      } else {
        gameState.flor = { ...flor, resolved: true, winnerId: null, points: 0 };
      }
    }

    const envido = gameState.envido || {};
    const hasFlorWinner = !!gameState.flor?.winnerId;
    const skipEnvidoPointsByFlor = hasFlorWinner && !reservadaOwnerId;
    if (reservadaOwnerId) {
      const reservadaOwnerLabel = getWinnerLabel(gameState, reservadaOwnerId);
      const envidoPoints =
        envido.status === "accepted" ? Math.max(1, envido.points || 0) : 1;
      addPoints(gameState, reservadaOwnerId, envidoPoints);
      const envidoTotal = getTotalPoints(gameState, reservadaOwnerId);
      messageQueue.push(
        `${reservadaOwnerLabel} suma ${envidoPoints} punto${envidoPoints > 1 ? "s" : ""} de Envido (total ${envidoTotal})`
      );
      gameState.envido = {
        ...envido,
        status: envido.status === "accepted" ? "accepted" : "reserved",
        winnerId: reservadaOwnerId,
        points: envidoPoints,
        acceptedPoints: envidoPoints,
        resolved: true,
      };

      const trucoPoints = gameState.truco?.status === "accepted" ? roundPoints : 1;
      addPoints(gameState, reservadaOwnerId, trucoPoints);
      const trucoTotal = getTotalPoints(gameState, reservadaOwnerId);
      messageQueue.push(
        `${reservadaOwnerLabel} suma ${trucoPoints} punto${trucoPoints > 1 ? "s" : ""} de Truco (total ${trucoTotal})`
      );
    } else {
      if (
        !skipEnvidoPointsByFlor &&
        !envido.resolved &&
        (envido.status === "accepted" || envido.status === "rejected")
      ) {
        const envidoWinnerId = envido.winnerId;
        const envidoPoints = envido.points || 0;
        if (envidoWinnerId && envidoPoints > 0) {
          addPoints(gameState, envidoWinnerId, envidoPoints);
          const envidoWinnerLabel = getWinnerLabel(gameState, envidoWinnerId);
          const envidoTotal = getTotalPoints(gameState, envidoWinnerId);
          messageQueue.push(`${envidoWinnerLabel} gana el envido`);
          messageQueue.push(
            `${envidoWinnerLabel} suma ${envidoPoints} punto${envidoPoints > 1 ? "s" : ""} de Envido (total ${envidoTotal})`
          );
        }
        gameState.envido = { ...envido, resolved: true };
      } else if (skipEnvidoPointsByFlor && !envido.resolved) {
        gameState.envido = { ...envido, resolved: true };
      }

      addPoints(gameState, winnerId, roundPoints);
      const trucoTotal = getTotalPoints(gameState, winnerId);
      messageQueue.push(
        `${winnerLabel} suma ${roundPoints} punto${roundPoints > 1 ? "s" : ""} de Truco (total ${trucoTotal})`
      );
    }

    const matchWinnerId = getMatchWinnerId(gameState);
    if (matchWinnerId) {
      const championLabel = getWinnerLabel(gameState, matchWinnerId);
      messageQueue.push(`${championLabel} gana la partida`);
      gameState.matchEnded = true;
      gameState.matchWinnerId = matchWinnerId;
      gameState.rematch = buildRematchState(gameState);
      room.status = "finished";
      emitRooms();
    }

    gameState.roundEnding = true;
    io.to(roomId).emit("game:update", gameState);
    const sequenceDuration = emitMessageSequence(roomId, messageQueue);
    if (!matchWinnerId) {
      scheduleRedeal(roomId, Math.max(1800, sequenceDuration + 400));
    }
  }

  function resolvePardaRound(room, roomId) {
    const gameState = room.gameState;
    const playerIds = gameState.players.map((p) => p.id);
    const selections = gameState.pardaSelections || {};
    const topPlays = [];
    const bottomPlays = [];

    for (const playerId of playerIds) {
      const selected = selections[playerId];
      if (!selected) return false;
      const bottomCard = selected.bottomCard;
      const topCard = selected.topCard;
      if (!bottomCard || !topCard) return false;
      bottomPlays.push({ ...bottomCard, playerId });
      topPlays.push({ ...topCard, playerId });
    }

    const topWithRank = topPlays.map((card) => ({ card, rank: resolveHandRank(card, gameState.vira) }));
    const bestTop = Math.max(...topWithRank.map((item) => item.rank));
    const topWinners = topWithRank.filter((item) => item.rank === bestTop);

    let finalWinnerId = null;
    const topWinnerId = resolveWinnerFromRankEntries(gameState, topWinners);
    if (topWinnerId) {
      finalWinnerId = topWinnerId;
      io.to(roomId).emit("server:message", "Se revelaron cartas: decide la carta de arriba");
    } else {
      const bottomWithRank = bottomPlays.map((card) => ({ card, rank: resolveHandRank(card, gameState.vira) }));
      const bestBottom = Math.max(...bottomWithRank.map((item) => item.rank));
      const bottomWinners = bottomWithRank.filter((item) => item.rank === bestBottom);

      const bottomWinnerId = resolveWinnerFromRankEntries(gameState, bottomWinners);
      if (bottomWinnerId) {
        finalWinnerId = bottomWinnerId;
        io.to(roomId).emit("server:message", "Cartas de arriba pardas: decide la carta de abajo");
      } else {
        finalWinnerId = gameState.roundStarter || playerIds[0];
        const mano = gameState.players.find((p) => p.id === finalWinnerId);
        io.to(roomId).emit(
          "server:message",
          `Arriba y abajo pardas: gana ${mano?.name || "Jugador"} por ser mano`
        );
      }
    }

    resolveRound(room, finalWinnerId, roomId);
    return true;
  }

  function ensureBotRoomPlayers(room) {
    if (!room?.allowBots) return;
    const hasHuman = room.players.some((p) => !isBotPlayerId(p.id));
    if (!hasHuman) return;

    const existingBotCount = room.players.filter((p) => isBotPlayerId(p.id)).length;
    const needed = Math.max(0, room.maxPlayers - room.players.length);
    for (let i = 0; i < needed; i += 1) {
      const n = existingBotCount + i + 1;
      room.players.push({
        id: `${BOT_PREFIX}${room.id}:${n}`,
        name: `${n}B`,
      });
    }
    room.status = room.players.length === room.maxPlayers ? "full" : "waiting";
  }

  function applyBotPlay(room, roomId, botId, cardIndex = 0) {
    const gameState = room?.gameState;
    if (!gameState || gameState.turn !== botId) return false;
    const hand = gameState.hands?.[botId];
    if (!Array.isArray(hand) || hand.length === 0) return false;

    const safeCardIndex = Math.max(0, Math.min(cardIndex, hand.length - 1));
    const [playedCard] = hand.splice(safeCardIndex, 1);
    const playedCardWithPlayer = { ...playedCard, playerId: botId };

    gameState.tableCards.push(playedCardWithPlayer);
    gameState.currentHandCards.push(playedCardWithPlayer);

    const playerIds = gameState.players.map((player) => player.id);
    if (gameState.currentHandCards.length < playerIds.length) {
      gameState.turn = getNextPlayerId(gameState, botId);
      io.to(roomId).emit("game:update", gameState);
      return true;
    }

    const handStarterId = gameState.currentHandStarter;
    const currentHandNumber = gameState.handNumber || 1;
    const playedWithRank = gameState.currentHandCards.map((card) => ({
      card,
      rank: resolveHandRank(card, gameState.vira),
    }));
    const bestRank = Math.max(...playedWithRank.map((entry) => entry.rank));
    const winners = playedWithRank.filter((entry) => entry.rank === bestRank);
    const winnerId = resolveWinnerFromRankEntries(gameState, winners);

    gameState.currentHandCards = [];
    gameState.handResults = gameState.handResults || [];
    gameState.handResults.push(winnerId);

    if (winnerId) {
      gameState.handWinsByPlayer[winnerId] = (gameState.handWinsByPlayer[winnerId] || 0) + 1;
      const winner = gameState.players.find((player) => player.id === winnerId);
      if (winner?.name) {
        const handLabelByNumber = { 1: "primera", 2: "segunda", 3: "tercera" };
        const handLabel = handLabelByNumber[currentHandNumber] || `${currentHandNumber}a`;
        emitLockedMessage(roomId, gameState, `${winner.name} mata ${handLabel}`);
      }
    } else {
      emitLockedMessage(roomId, gameState, "La mano fue parda");
    }

    if (gameState.handNumber === 1 && !winnerId) {
      gameState.firstHandTie = true;
      gameState.pardaPhase = "selecting";
      gameState.pardaSelections = {};
      gameState.turn = handStarterId;
      emitLockedMessage(roomId, gameState, "Primera mano parda: el que salio primero elige debajo y arriba");
      io.to(roomId).emit("game:update", gameState);
      return true;
    }

    if (!gameState.firstHandTie && !winnerId && currentHandNumber >= 2) {
      const firstHandWinnerId = gameState.handResults?.[0] || gameState.roundStarter || handStarterId;
      resolveRound(room, firstHandWinnerId, roomId);
      io.to(roomId).emit("game:update", room.gameState);
      return true;
    }

    if (winnerId) {
      gameState.turn = winnerId;
      gameState.currentHandStarter = winnerId;
      const roundWins =
        gameState.mode === "2vs2"
          ? getTeamHandWins(gameState, winnerId)
          : (gameState.handWinsByPlayer[winnerId] || 0);
      if (roundWins >= 2) {
        resolveRound(room, winnerId, roomId);
        io.to(roomId).emit("game:update", room.gameState);
        return true;
      }
    } else {
      gameState.turn = handStarterId;
      gameState.currentHandStarter = handStarterId;
    }

    if (gameState.handNumber >= 3) {
      let finalWinnerId;
      if (gameState.mode === "2vs2") {
        finalWinnerId = pickRoundWinnerByTeam(gameState);
      } else {
        const playerIdsByOrder = gameState.players.map((p) => p.id);
        finalWinnerId = playerIdsByOrder[0];
        let maxWins = -1;

        for (const playerId of playerIdsByOrder) {
          const wins = gameState.handWinsByPlayer[playerId] || 0;
          if (wins > maxWins) {
            maxWins = wins;
            finalWinnerId = playerId;
          }
        }

        const tiedLeaders = playerIdsByOrder.filter(
          (playerId) => (gameState.handWinsByPlayer[playerId] || 0) === maxWins
        );
        if (tiedLeaders.length > 1) {
          const firstNonTieWinner = (gameState.handResults || []).find((result) => !!result);
          finalWinnerId = firstNonTieWinner || gameState.roundStarter || finalWinnerId;
        }
      }
      resolveRound(room, finalWinnerId, roomId);
      io.to(roomId).emit("game:update", room.gameState);
      return true;
    }

    gameState.handNumber += 1;
    io.to(roomId).emit("game:update", gameState);
    return true;
  }

  function chooseBotCardIndex(gameState, botId, hand) {
    const ranked = hand
      .map((card, index) => ({ index, rank: resolveHandRank(card, gameState.vira) }))
      .sort((a, b) => a.rank - b.rank);
    const lowest = ranked[0]?.index ?? 0;
    const highest = ranked[ranked.length - 1]?.index ?? 0;

    const winning = getCurrentWinningInfo(gameState);
    if ((gameState.currentHandCards || []).length) {
      if (winning.winnerId && isSameTeam(gameState, botId, winning.winnerId)) {
        return lowest;
      }
      const beatCard = ranked.find((item) => item.rank > winning.bestRank);
      return beatCard ? beatCard.index : lowest;
    }

    const myTeamWins = getTeamHandWins(gameState, botId);
    const enemyTeamWins = (gameState.handResults || []).filter(
      (winnerId) => winnerId && !isSameTeam(gameState, botId, winnerId)
    ).length;
    if (enemyTeamWins > myTeamWins) return highest;
    if ((gameState.handNumber || 1) === 1 && ranked.length >= 3) return ranked[1].index;
    return lowest;
  }

  function processBotRoom(room) {
    if (!room?.allowBots || !room.gameState) return;
    const gameState = room.gameState;
    const roomId = room.id;
    if (gameState.roundEnding || isInputLocked(gameState)) return;

    const pendingFlorEnvido = isFlorEnvidoPending(gameState);
    if (pendingFlorEnvido && isBotPlayerId(gameState.flor?.florEnvidoResponderId)) {
      const botId = gameState.flor.florEnvidoResponderId;
      if (!canBotActNow(roomId, botId)) return;
      gameState.flor.florEnvidoStatus = "accepted";
      gameState.flor.florEnvidoCalled = true;
      gameState.flor.points = gameState.flor.florEnvidoPoints || 5;
      const responder = gameState.players.find((p) => p.id === botId);
      emitLockedMessage(roomId, gameState, `${responder?.name || "Bot"} respondio Quiero al Flor Envido`);
      setBotCooldown(roomId, botId);
      botLog(roomId, responder?.name, "accept flor-envido");
      io.to(roomId).emit("game:update", gameState);
      return;
    }

    const pendingEnvido = gameState.envido?.status === "pending";
    if (pendingEnvido && isBotPlayerId(gameState.envido?.responderId)) {
      const botId = gameState.envido.responderId;
      if (!canBotActNow(roomId, botId)) return;
      const envido = gameState.envido || {};
      const snapshot = gameState.roundHandsSnapshot || gameState.hands || {};
      const myEnvido = computeEnvido(snapshot[botId] || [], gameState.vira);
      const wantsAccept = myEnvido >= 25 || (envido.points || 2) <= 2;
      const responder = gameState.players.find((p) => p.id === botId);

      if (!wantsAccept) {
        gameState.envido = {
          status: "rejected",
          callerId: envido.callerId,
          responderId: envido.responderId,
          callType: envido.callType || "envido",
          winnerId: envido.callerId,
          points: Math.max(1, envido.acceptedPoints || 1),
          acceptedPoints: Math.max(1, envido.acceptedPoints || 1),
          envidoByPlayer: {},
          resolved: false,
        };
        emitLockedMessage(roomId, gameState, `${responder?.name || "Bot"} respondio No Quiero al Envido.`);
      } else {
        const envidoByPlayer = {};
        const playerIds = gameState.players.map((p) => p.id);
        for (const player of gameState.players) {
          envidoByPlayer[player.id] = computeEnvido(snapshot[player.id] || [], gameState.vira);
        }
        const winnerId = resolveScoreWinnerByTeam(gameState, envidoByPlayer, playerIds);
        gameState.envido = {
          status: "accepted",
          callerId: envido.callerId,
          responderId: envido.responderId,
          callType: envido.callType || "envido",
          winnerId,
          points: envido.points || 2,
          acceptedPoints: envido.points || 2,
          envidoByPlayer,
          resolved: false,
        };
        emitLockedMessage(roomId, gameState, `${responder?.name || "Bot"} respondio Quiero al Envido.`);
      }
      setBotCooldown(roomId, botId);
      botLog(roomId, responder?.name, "envido response", wantsAccept ? "quiero" : "no quiero", myEnvido);
      io.to(roomId).emit("game:update", gameState);
      return;
    }

    const pendingTruco = gameState.truco?.status === "pending";
    if (pendingTruco && isBotPlayerId(gameState.truco?.responderId)) {
      const botId = gameState.truco.responderId;
      if (!canBotActNow(roomId, botId)) return;
      const truco = gameState.truco || {};
      const hand = gameState.hands?.[botId] || [];
      const maxRank = hand.length
        ? Math.max(...hand.map((card) => resolveHandRank(card, gameState.vira)))
        : 0;
      const proposed = truco.proposedValue || 3;
      const wantsAccept = maxRank >= 10 || proposed <= 3;

      if (!wantsAccept) {
        const callerId = truco.callerId;
        const reservadaOwnerId = getFlorReservadaOwnerId(gameState);
        const pointWinnerId = reservadaOwnerId || callerId;
        const responder = gameState.players.find((player) => player.id === botId);
        emitLockedMessage(
          roomId,
          gameState,
          `${responder?.name || "Bot"} respondio No Quiero al ${CALL_LABELS[truco.callType || "truco"]}.`
        );
        resolveRound(room, pointWinnerId, roomId);
      } else {
        gameState.roundPointValue = proposed;
        gameState.truco = {
          status: "accepted",
          callerId: truco.callerId,
          responderId: truco.responderId,
          callType: truco.callType || "truco",
          proposedValue: truco.proposedValue,
          acceptedById: botId,
        };
        const responder = gameState.players.find((player) => player.id === botId);
        emitLockedMessage(
          roomId,
          gameState,
          `${responder?.name || "Bot"} respondio Quiero al ${CALL_LABELS[truco.callType || "truco"]}`
        );
      }
      setBotCooldown(roomId, botId);
      botLog(roomId, botId, "truco response", wantsAccept ? "quiero" : "no quiero", maxRank, proposed);
      io.to(roomId).emit("game:update", gameState);
      return;
    }

    if (gameState.firstHandTie && gameState.pardaPhase === "selecting" && isBotPlayerId(gameState.turn)) {
      const botId = gameState.turn;
      if (!canBotActNow(roomId, botId)) return;
      const hand = gameState.hands?.[botId] || [];
      if (hand.length >= 2) {
        const gameTurn = botId;
        gameState.pardaSelections = gameState.pardaSelections || {};
        const ranked = hand
          .map((card, index) => ({ index, rank: resolveHandRank(card, gameState.vira) }))
          .sort((a, b) => a.rank - b.rank);
        const bottomIdx = ranked[0].index;
        const topIdx = ranked[ranked.length - 1].index;
        const pickedBottom = { ...hand[bottomIdx], playerId: gameTurn };
        const pickedTop = { ...hand[topIdx], playerId: gameTurn };
        gameState.hands[gameTurn] = hand.filter((_, idx) => idx !== bottomIdx && idx !== topIdx);
        gameState.tableCards.push(pickedBottom, pickedTop);
        gameState.pardaSelections[gameTurn] = { bottomCard: pickedBottom, topCard: pickedTop };
        const playerIds = gameState.players.map((p) => p.id);
        const allSelected = playerIds.every((playerId) => !!gameState.pardaSelections[playerId]);
        if (!allSelected) {
          const me = gameState.players.find((p) => p.id === gameTurn);
          gameState.turn = getNextPlayerId(gameState, gameTurn);
          emitLockedMessage(
            roomId,
            gameState,
            `${me?.name || "Bot"} eligio debajo y arriba. Turno del rival para elegir.`
          );
          setBotCooldown(roomId, botId);
          io.to(roomId).emit("game:update", gameState);
          return;
        }
        resolvePardaRound(room, roomId);
        setBotCooldown(roomId, botId);
        io.to(roomId).emit("game:update", room.gameState);
      }
      return;
    }

    if (!isBotPlayerId(gameState.turn)) return;
    const botId = gameState.turn;
    if (!canBotActNow(roomId, botId)) return;
    const hand = gameState.hands?.[botId] || [];
    if (!Array.isArray(hand) || hand.length === 0) return;

    const inFirstHandOpen =
      Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
      (gameState.tableCards?.length || 0) < gameState.players.length;

    if (canSingFlorNow(gameState, botId) && Math.random() < 0.85) {
      gameState.flor.sungByPlayer[botId] = true;
      if (gameState.flor.requireThirdByPlayer?.[botId]) {
        gameState.flor.requireThirdByPlayer[botId] = false;
      }
      const contenders = gameState.players
        .map((p) => p.id)
        .filter((id) => !!gameState.flor.hasFlorByPlayer?.[id] && !!gameState.flor.sungByPlayer?.[id]);
      if (contenders.length === 1) {
        gameState.flor.status = "accepted";
        gameState.flor.winnerId = contenders[0];
        gameState.flor.points = gameState.flor.florEnvidoCalled ? 5 : 3;
      } else if (didAllTeamsSingFlor(gameState)) {
        const winnerId = resolveFlorWinnerId(gameState);
        gameState.flor.status = "accepted";
        gameState.flor.winnerId = winnerId;
        gameState.flor.points = gameState.flor.florEnvidoCalled ? 5 : 3;
      }
      const me = gameState.players.find((p) => p.id === botId);
      emitLockedMessage(roomId, gameState, `${me?.name || "Bot"} canto Flor`);
      setBotCooldown(roomId, botId);
      botLog(roomId, botId, "call flor");
      io.to(roomId).emit("game:update", gameState);
      return;
    }

    if (
      inFirstHandOpen &&
      !isFlorAlreadySung(gameState) &&
      gameState.envido?.status === "idle" &&
      gameState.truco?.status !== "pending" &&
      !isFlorEnvidoPending(gameState) &&
      !hasAvailableFlor(gameState, botId)
    ) {
      const myEnvido = computeEnvido(gameState.roundHandsSnapshot?.[botId] || hand, gameState.vira);
      if (myEnvido >= 28 && Math.random() < 0.45) {
        const responderId = getOpposingResponderId(gameState, botId);
        gameState.envido = {
          status: "pending",
          callerId: botId,
          responderId,
          callType: "envido",
          winnerId: null,
          points: 2,
          acceptedPoints: 0,
          envidoByPlayer: {},
          resolved: false,
        };
        const me = gameState.players.find((p) => p.id === botId);
        emitLockedMessage(roomId, gameState, `${me?.name || "Bot"} canto Envido`);
        setBotCooldown(roomId, botId);
        botLog(roomId, botId, "call envido", myEnvido);
        io.to(roomId).emit("game:update", gameState);
        return;
      }
    }

    if (
      gameState.roundPointValue === 1 &&
      gameState.truco?.status !== "pending" &&
      gameState.envido?.status !== "pending" &&
      !isFlorEnvidoPending(gameState)
    ) {
      const maxRank = Math.max(...hand.map((card) => resolveHandRank(card, gameState.vira)));
      if (maxRank >= 13 && Math.random() < 0.35) {
        const responderId = getOpposingResponderId(gameState, botId);
        gameState.truco = {
          status: "pending",
          callerId: botId,
          responderId,
          callType: "truco",
          proposedValue: 3,
          acceptedById: gameState.truco?.acceptedById || null,
        };
        const me = gameState.players.find((p) => p.id === botId);
        emitLockedMessage(roomId, gameState, `${me?.name || "Bot"} canto Truco`);
        setBotCooldown(roomId, botId);
        botLog(roomId, botId, "call truco", maxRank);
        io.to(roomId).emit("game:update", gameState);
        return;
      }
    }

    const chosenIndex = chooseBotCardIndex(gameState, botId, hand);
    botLog(roomId, botId, "play card index", chosenIndex);
    applyBotPlay(room, roomId, botId, chosenIndex);
    setBotCooldown(roomId, botId);
  }

  function startBotLoopOnce() {
    if (botLoopStarted) return;
    botLoopStarted = true;
    setInterval(() => {
      for (const room of Object.values(rooms)) {
        processBotRoom(room);
      }
    }, BOT_TICK_MS);
  }

  startBotLoopOnce();

  socket.on("room:join", ({ roomId, playerName, reconnectToken }) => {
    const currentRoom = socket.data.roomId;
    const nextName = (playerName || "Jugador").trim() || "Jugador";

    if (currentRoom && currentRoom !== roomId) {
      const oldRoom = removePlayer(currentRoom, socket.id);
      socket.leave(currentRoom);

      if (oldRoom) {
        io.to(currentRoom).emit("room:update", oldRoom);
      }
    }

    const targetRoom = getRoom(roomId);
    if (!targetRoom) {
      socket.emit("server:message", "Room no existe");
      return;
    }

    const reclaimed = reclaimDisconnectedSeat(
      targetRoom,
      socket,
      nextName,
      reconnectToken
    );
    if (reclaimed) {
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.reconnectToken = reconnectToken || null;
      socket.emit("game:start", {
        roomId,
        gameState: targetRoom.gameState,
      });
      io.to(roomId).emit("room:update", targetRoom);
      emitRooms();
      return;
    }

    const result = addPlayer(roomId, {
      id: socket.id,
      name: nextName,
      reconnectToken: reconnectToken || null,
      connected: true,
      lastSeenAt: Date.now(),
    });

    if (!result.ok) {
      socket.emit("server:message", result.error);
      return;
    }

    ensureBotRoomPlayers(result.room);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.reconnectToken = reconnectToken || null;

    io.to(roomId).emit("room:update", result.room);
    emitRooms();

    if (result.room.players.length === result.room.maxPlayers) {
      console.log("Mesa llena, iniciando partida:", roomId);
      startGame(result.room);

      io.to(roomId).emit("game:start", {
        roomId,
        gameState: result.room.gameState,
      });

      emitRooms();
    }
  });

  socket.on("room:leave", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    clearSeatTimeout(roomId, socket.id);
    const room = removePlayer(roomId, socket.id);

    socket.leave(roomId);
    socket.data.roomId = null;

    if (room) {
      io.to(roomId).emit("room:update", room);
    }

    emitRooms();
  });

  socket.on("debug:set-deck-mode", ({ roomId, onlyBastosEspadas }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const allowedSuits = onlyBastosEspadas ? ["bastos", "espadas"] : null;

    room.deckConfig = { allowedSuits };
    gameState.deckConfig = { allowedSuits };

    const starterId = gameState.roundStarter || gameState.turn || gameState.players[0]?.id;
    startGame.redealRound(room, starterId);

    io.to(roomId).emit(
      "server:message",
      onlyBastosEspadas
        ? "Modo prueba activo: mazo solo de bastos y espadas"
        : "Modo prueba desactivado: mazo completo"
    );
    io.to(roomId).emit("game:update", room.gameState);
  });

  socket.on("debug:redeal-round", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const starterId = gameState.roundStarter || gameState.turn || gameState.players[0]?.id;
    startGame.redealRound(room, starterId);

    io.to(roomId).emit("server:message", "Repartiendo nueva ronda (modo prueba)");
    io.to(roomId).emit("game:update", room.gameState);
  });

  socket.on("debug:force-flor", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;

    const ok = forceFlorHandForPlayer(gameState, socket.id);
    if (!ok) {
      socket.emit("server:message", "No se pudo forzar Flor en esta ronda");
      return;
    }

    const me = gameState.players.find((p) => p.id === socket.id);
    io.to(roomId).emit("server:message", `${me?.name || "Jugador"} activo test de Flor`);
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("debug:force-flor-reservada", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;

    const ok = forceFlorReservadaForPlayer(gameState, socket.id);
    if (!ok) {
      socket.emit("server:message", "No se pudo forzar Flor Reservada en esta ronda");
      return;
    }

    const me = gameState.players.find((p) => p.id === socket.id);
    io.to(roomId).emit("server:message", `${me?.name || "Jugador"} activo test de Flor Reservada`);
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("call:flor", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    const isThirdConfirm = gameState.handNumber === 3 && !!gameState.flor?.requireThirdByPlayer?.[socket.id];
    if (!isThirdConfirm && gameState.turn !== socket.id) {
      socket.emit("server:message", "Solo puede cantar Flor el jugador en turno");
      return;
    }
    if (!canSingFlorNow(gameState, socket.id)) {
      socket.emit("server:message", "No puedes cantar Flor en este momento");
      return;
    }
    if (gameState.envido?.status === "pending" || gameState.truco?.status === "pending" || isFlorEnvidoPending(gameState)) {
      socket.emit("server:message", "No se puede cantar Flor con un canto pendiente");
      return;
    }

    const flor = gameState.flor || {};
    const opposingIds = getOpposingPlayerIds(gameState, socket.id);
    const opposingHasFlor = opposingIds.some((id) => !!flor.hasFlorByPlayer?.[id] && !flor.burnedByPlayer?.[id]);
    const nextSungByPlayer = {
      ...(flor.sungByPlayer || {}),
      [socket.id]: true,
    };

    let winnerId = null;
    if (!opposingHasFlor) {
      winnerId = socket.id;
    } else {
      const tempFlorState = {
        ...gameState.flor,
        sungByPlayer: nextSungByPlayer,
      };
      const tempGameState = { ...gameState, flor: tempFlorState };
      if (didAllTeamsSingFlor(tempGameState)) {
        winnerId = resolveFlorWinnerId(tempGameState);
      }
    }

    gameState.flor = {
      ...flor,
      status: winnerId ? "accepted" : "idle",
      callerId: socket.id,
      responderId: getOpposingResponderId(gameState, socket.id),
      sungByPlayer: nextSungByPlayer,
      winnerId,
      points: 3,
      resolved: false,
    };
    if (gameState.handNumber === 2 && flor.leyByPlayer?.[socket.id]) {
      gameState.flor.requireThirdByPlayer[socket.id] = true;
    }
    if (gameState.handNumber === 3) {
      gameState.flor.requireThirdByPlayer[socket.id] = false;
    }
    gameState.flor.leyByPlayer[socket.id] = false;
    refreshFlorEnvidoWindow(gameState);

    const caller = gameState.players.find((p) => p.id === socket.id);
    const msg = !opposingHasFlor
      ? `${caller?.name || "Jugador"} canto Flor y el rival no tiene Flor`
      : `${caller?.name || "Jugador"} canto Flor`;
    emitLockedMessage(roomId, gameState, msg);
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("flor:jugar-ley", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!isFirstHandOpen(gameState)) {
      socket.emit("server:message", "Jugar a ley solo se marca en primera mano");
      return;
    }
    const pieId = getFirstHandPieId(gameState);
    if (
      pieId === socket.id &&
      gameState.flor?.hasFlorByPlayer?.[socket.id] &&
      !gameState.flor?.reservadaByPlayer?.[socket.id]
    ) {
      markFlorBurned(gameState, socket.id, { force: true, reason: "ley_pie" });
    }
    if (isFlorEnvidoPending(gameState)) {
      socket.emit("server:message", "Primero resuelve el Flor Envido pendiente");
      return;
    }

    gameState.flor.leyByPlayer[socket.id] = true;
    const me = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"} juega a ley`);
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("flor:con-flor", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!hasAvailableFlor(gameState, socket.id)) {
      socket.emit("server:message", "No tienes Flor disponible para responder con Flor");
      return;
    }

    const flor = gameState.flor || {};
    const envido = gameState.envido || {};
    const truco = gameState.truco || {};
    const isRespondingEnvido =
      envido.status === "pending" &&
      (envido.responderId === socket.id || isSameTeam(gameState, envido.responderId, socket.id));
    const isRespondingTruco =
      truco.status === "pending" &&
      (truco.responderId === socket.id || isSameTeam(gameState, truco.responderId, socket.id));

    if (!isRespondingEnvido && !isRespondingTruco) {
      socket.emit("server:message", "Con Flor solo aplica al responder un canto");
      return;
    }

    const otherId = isRespondingTruco ? truco.callerId : envido.callerId;

    if (isRespondingEnvido) {
      gameState.envido = {
        status: "cancelled",
        callerId: envido.callerId || null,
        responderId: envido.responderId || null,
        callType: envido.callType || null,
        winnerId: null,
        points: 0,
        acceptedPoints: 0,
        envidoByPlayer: {},
        resolved: true,
      };
    }

    gameState.flor = {
      ...flor,
      status: flor.status || "idle",
      callerId: socket.id,
      responderId: getOpposingResponderId(gameState, socket.id) || otherId,
      sungByPlayer: {
        ...(flor.sungByPlayer || {}),
        [socket.id]: true,
      },
      resolved: false,
    };
    if (gameState.handNumber === 2 && flor.leyByPlayer?.[socket.id]) {
      gameState.flor.requireThirdByPlayer[socket.id] = true;
    }
    if (gameState.handNumber === 3) {
      gameState.flor.requireThirdByPlayer[socket.id] = false;
    }
    gameState.flor.leyByPlayer[socket.id] = false;

    const opposingIds = getOpposingPlayerIds(gameState, socket.id);
    const otherHasFlor = opposingIds.some((id) => !!gameState.flor?.hasFlorByPlayer?.[id] && !gameState.flor?.burnedByPlayer?.[id]);
    if (!otherHasFlor) {
      gameState.flor.status = "accepted";
      gameState.flor.winnerId = socket.id;
      gameState.flor.points = gameState.flor.florEnvidoCalled ? 5 : 3;
    } else if (didAllTeamsSingFlor(gameState)) {
      gameState.flor.status = "accepted";
      gameState.flor.winnerId = resolveFlorWinnerId(gameState);
      gameState.flor.points = gameState.flor.florEnvidoCalled ? 5 : 3;
    }
    refreshFlorEnvidoWindow(gameState);

    const responder = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(
      roomId,
      gameState,
      isRespondingEnvido
        ? `${responder?.name || "Jugador"} respondio Con Flor. El Envido queda anulado en esta ronda`
        : `${responder?.name || "Jugador"} respondio Con Flor`
    );
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("call:flor-envido", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (gameState.turn !== socket.id) {
      socket.emit("server:message", "Solo puede cantar Flor Envido el jugador en turno");
      return;
    }
    if (gameState.truco?.status === "pending" || gameState.envido?.status === "pending" || isFlorEnvidoPending(gameState)) {
      socket.emit("server:message", "No puedes cantar Flor Envido con un canto pendiente");
      return;
    }
    if (!canCallFlorEnvido(gameState, socket.id)) {
      socket.emit("server:message", "Flor Envido no esta disponible");
      return;
    }

    const responderId = getOpposingResponderId(gameState, socket.id);
    gameState.flor.florEnvidoStatus = "pending";
    gameState.flor.florEnvidoCallerId = socket.id;
    gameState.flor.florEnvidoResponderId = responderId;
    gameState.flor.florEnvidoPoints = Math.max(5, gameState.flor.points || 3);
    gameState.flor.florEnvidoAcceptedPoints = 3;
    gameState.flor.points = gameState.flor.florEnvidoPoints;
    markFlorEnvidoWindowForTeam(gameState, socket.id);
    closeFlorEnvidoWindow(gameState);

    const me = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"} canto Flor Envido`);
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("flor-envido:accept", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!isFlorEnvidoPending(gameState)) return;
    if (
      gameState.flor?.florEnvidoResponderId !== socket.id &&
      !isSameTeam(gameState, gameState.flor?.florEnvidoResponderId, socket.id)
    ) {
      socket.emit("server:message", "No te corresponde responder el Flor Envido");
      return;
    }

    gameState.flor.florEnvidoStatus = "accepted";
    gameState.flor.florEnvidoCalled = true;
    gameState.flor.points = gameState.flor.florEnvidoPoints || 5;

    const responder = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${responder?.name || "Jugador"} respondio Quiero al Flor Envido`);
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("flor-envido:reject", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!isFlorEnvidoPending(gameState)) return;
    if (
      gameState.flor?.florEnvidoResponderId !== socket.id &&
      !isSameTeam(gameState, gameState.flor?.florEnvidoResponderId, socket.id)
    ) {
      socket.emit("server:message", "No te corresponde responder el Flor Envido");
      return;
    }

    gameState.flor.florEnvidoStatus = "rejected";
    gameState.flor.florEnvidoCalled = true;
    gameState.flor.points = Math.max(3, gameState.flor.florEnvidoAcceptedPoints || 3);
    gameState.flor.winnerId = gameState.flor.florEnvidoCallerId || gameState.flor.winnerId;

    const responder = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${responder?.name || "Jugador"} respondio No Quiero al Flor Envido`);
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("flor-envido:raise", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!isFlorEnvidoPending(gameState)) return;

    const flor = gameState.flor || {};
    if (
      flor.florEnvidoResponderId !== socket.id &&
      !isSameTeam(gameState, flor.florEnvidoResponderId, socket.id)
    ) {
      socket.emit("server:message", "No te corresponde responder el Flor Envido");
      return;
    }

    const nextCaller = socket.id;
    const nextResponder = getOpposingResponderId(gameState, nextCaller) || flor.florEnvidoCallerId;
    const currentProposed = flor.florEnvidoPoints || 5;
    const nextPoints = currentProposed + 2;

    gameState.flor.florEnvidoCallerId = nextCaller;
    gameState.flor.florEnvidoResponderId = nextResponder;
    gameState.flor.florEnvidoAcceptedPoints = currentProposed;
    gameState.flor.florEnvidoPoints = nextPoints;
    gameState.flor.points = nextPoints;

    const caller = gameState.players.find((p) => p.id === nextCaller);
    emitLockedMessage(
      roomId,
      gameState,
      `${caller?.name || "Jugador"} respondio Quiero y Envido al Flor Envido. Ahora vale ${nextPoints}`
    );
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("call:envido", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:message", "La Flor ya fue cantada en esta ronda");
      return;
    }
    if (hasAvailableFlor(gameState, socket.id)) {
      socket.emit("server:message", "Con Flor disponible debes cantar Flor");
      return;
    }
    if (gameState.turn !== socket.id) {
      socket.emit("server:message", "Solo puede cantar Envido el jugador en turno");
      return;
    }
    const envidoState = gameState.envido || { status: "idle" };

    if (envidoState.status !== "idle") {
      socket.emit("server:message", "El envido ya fue cantado en esta ronda");
      return;
    }
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:message", "La Flor ya fue cantada en esta ronda");
      return;
    }

    const playerIds = gameState.players.map((p) => p.id);
    const isInFirstHand =
      Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
      (gameState.tableCards?.length || 0) < playerIds.length;

    if (!isInFirstHand) {
      socket.emit("server:message", "El envido solo se puede cantar en la primera mano");
      return;
    }

    if (gameState.truco?.status === "pending") {
      socket.emit("server:message", "No se puede cantar envido con un canto pendiente");
      return;
    }

    const responderId = getOpposingResponderId(gameState, socket.id);

    gameState.envido = {
      status: "pending",
      callerId: socket.id,
      responderId,
      callType: "envido",
      winnerId: null,
      points: 2,
      acceptedPoints: 1,
      envidoByPlayer: {},
      resolved: false,
    };

    const caller = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${caller?.name || "Jugador"} canto Envido`);

    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("call:falta-envido", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:message", "La Flor ya fue cantada en esta ronda");
      return;
    }
    const hasFlorReservada = !!gameState.flor?.reservadaByPlayer?.[socket.id];
    if (hasAvailableFlor(gameState, socket.id) && !hasFlorReservada) {
      socket.emit("server:message", "Con Flor disponible debes cantar Flor");
      return;
    }
    if (gameState.turn !== socket.id) {
      socket.emit("server:message", "Solo puede cantar Falta Envido el jugador en turno");
      return;
    }
    const envidoState = gameState.envido || { status: "idle" };

    if (envidoState.status !== "idle") {
      socket.emit("server:message", "El envido ya fue cantado en esta ronda");
      return;
    }

    const playerIds = gameState.players.map((p) => p.id);
    const isInFirstHand =
      Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
      (gameState.tableCards?.length || 0) < playerIds.length;

    if (!isInFirstHand) {
      socket.emit("server:message", "La falta envido solo se puede cantar en la primera mano");
      return;
    }

    if (gameState.truco?.status === "pending") {
      socket.emit("server:message", "No se puede cantar falta envido con un canto pendiente");
      return;
    }

    const responderId = getOpposingResponderId(gameState, socket.id);
    const faltaPoints = computeFaltaEnvidoPoints(gameState);

    gameState.envido = {
      status: "pending",
      callerId: socket.id,
      responderId,
      callType: "falta",
      winnerId: null,
      points: faltaPoints,
      acceptedPoints: 1,
      envidoByPlayer: {},
      resolved: false,
    };

    const caller = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(
      roomId,
      gameState,
      `${caller?.name || "Jugador"} canto Falta Envido (vale ${faltaPoints})`
    );

    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("call:primero-envido", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:message", "La Flor ya fue cantada en esta ronda");
      return;
    }
    const truco = gameState.truco || {};
    const envidoState = gameState.envido || { status: "idle" };

    if (truco.status !== "pending") {
      socket.emit("server:message", "Primero Envido solo aplica con Truco pendiente");
      return;
    }
    if (socket.id !== truco.responderId && !isSameTeam(gameState, truco.responderId, socket.id)) {
      socket.emit("server:message", "Solo quien responde el Truco puede cantar Primero Envido");
      return;
    }
    if (envidoState.status !== "idle") {
      socket.emit("server:message", "El envido ya fue cantado en esta ronda");
      return;
    }

    const playerIds = gameState.players.map((p) => p.id);
    const isInFirstHand =
      Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
      (gameState.tableCards?.length || 0) < playerIds.length;
    if (!isInFirstHand) {
      socket.emit("server:message", "Primero Envido solo se puede cantar en la primera mano");
      return;
    }

    burnFlorOnRespondWithoutConFlor(gameState, socket.id);

    gameState.truco = {
      status: "idle",
      callerId: null,
      responderId: null,
      callType: null,
      proposedValue: null,
      acceptedById: null,
    };

    gameState.envido = {
      status: "pending",
      callerId: socket.id,
      responderId: truco.callerId,
      callType: "envido",
      winnerId: null,
      points: 2,
      acceptedPoints: 1,
      envidoByPlayer: {},
      resolved: false,
    };

    const caller = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(
      roomId,
      gameState,
      `${caller?.name || "Jugador"} respondio Primero Envido. Se pausa el Truco y se responde el Envido.`
    );
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("envido:accept", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    const envido = gameState.envido || {};
    if (envido.status !== "pending") return;
    const canRespondEnvido =
      envido.responderId === socket.id ||
      isSameTeam(gameState, envido.responderId, socket.id);
    if (!canRespondEnvido) {
      socket.emit("server:message", "No te corresponde responder el envido");
      return;
    }
    burnFlorOnRespondWithoutConFlor(gameState, socket.id);

    const snapshot = gameState.roundHandsSnapshot || gameState.hands || {};
    const envidoByPlayer = {};
    const playerIds = gameState.players.map((p) => p.id);
    for (const player of gameState.players) {
      envidoByPlayer[player.id] = computeEnvido(snapshot[player.id] || [], gameState.vira);
    }

    const winnerId = resolveScoreWinnerByTeam(gameState, envidoByPlayer, playerIds);

    gameState.envido = {
      status: "accepted",
      callerId: envido.callerId,
      responderId: envido.responderId,
      callType: envido.callType || "envido",
      winnerId,
      points: envido.points || 2,
      acceptedPoints: envido.points || 2,
      envidoByPlayer,
      resolved: false,
    };

    const responder = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${responder?.name || "Jugador"} respondio Quiero al Envido.`);

    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("envido:reject", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    const envido = gameState.envido || {};
    if (envido.status !== "pending") return;
    const canRespondEnvido =
      envido.responderId === socket.id ||
      isSameTeam(gameState, envido.responderId, socket.id);
    if (!canRespondEnvido) {
      socket.emit("server:message", "No te corresponde responder el envido");
      return;
    }
    burnFlorOnRespondWithoutConFlor(gameState, socket.id);

    const callerId = envido.callerId;
    const rejectPoints = Math.max(1, envido.acceptedPoints || 1);
    gameState.envido = {
      status: "rejected",
      callerId,
      responderId: envido.responderId,
      callType: envido.callType || "envido",
      winnerId: callerId,
      points: rejectPoints,
      acceptedPoints: rejectPoints,
      envidoByPlayer: {},
      resolved: false,
    };

    const caller = gameState.players.find((p) => p.id === callerId);
    const responder = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(
      roomId,
      gameState,
      `${responder?.name || "Jugador"} respondio No Quiero al Envido. ${caller?.name || "Jugador"} queda con ${rejectPoints} de envido pendiente (se cobra al final de la ronda).`
    );

    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("envido:raise", ({ roomId, kind }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:message", "La Flor ya fue cantada en esta ronda");
      return;
    }
    const envido = gameState.envido || {};
    if (envido.status !== "pending") return;
    const canRespondEnvido =
      envido.responderId === socket.id ||
      isSameTeam(gameState, envido.responderId, socket.id);
    if (!canRespondEnvido) {
      socket.emit("server:message", "No te corresponde responder el envido");
      return;
    }
    burnFlorOnRespondWithoutConFlor(gameState, socket.id);
    if (envido.callType === "falta") {
      socket.emit("server:message", "A Falta Envido solo se responde Quiero o No Quiero");
      return;
    }

    const nextCallerId = socket.id;
    const nextResponderId = getOpposingResponderId(gameState, nextCallerId) || envido.callerId;
    const safeKind = kind === "falta" ? "falta" : "envido";
    const currentPoints = envido.points || 2;
    let nextPoints = currentPoints + 2;
    if (safeKind === "falta") {
      nextPoints = computeFaltaEnvidoPoints(gameState);
    }

    gameState.envido = {
      ...envido,
      callType: safeKind === "falta" ? "falta" : envido.callType || "envido",
      callerId: nextCallerId,
      responderId: nextResponderId,
      acceptedPoints: currentPoints,
      points: nextPoints,
    };

    const nextCaller = gameState.players.find((p) => p.id === nextCallerId);
    emitLockedMessage(
      roomId,
      gameState,
      safeKind === "falta"
        ? `${nextCaller?.name || "Jugador"} respondio Falta Envido. Ahora vale ${nextPoints}.`
        : `${nextCaller?.name || "Jugador"} respondio Quiero y Envido. Ahora vale ${nextPoints}.`
    );
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("call:truco", ({ roomId }) => {
    tryCallRaise(roomId, "truco");
  });

  socket.on("call:retruco", ({ roomId }) => {
    tryCallRaise(roomId, "retruco");
  });

  socket.on("call:vale9", ({ roomId }) => {
    tryCallRaise(roomId, "vale9");
  });

  socket.on("call:valejuego", ({ roomId }) => {
    tryCallRaise(roomId, "valejuego");
  });

  socket.on("truco:accept", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    const truco = gameState.truco || {};
    if (truco.status !== "pending") return;
    if (truco.responderId !== socket.id && !isSameTeam(gameState, truco.responderId, socket.id)) {
      socket.emit("server:message", "No te corresponde responder ese canto");
      return;
    }
    burnFlorOnRespondWithoutConFlor(gameState, socket.id);

    gameState.roundPointValue = truco.proposedValue || 3;
    gameState.truco = {
      status: "accepted",
      callerId: truco.callerId,
      responderId: truco.responderId,
      callType: truco.callType || "truco",
      proposedValue: truco.proposedValue,
      acceptedById: socket.id,
    };

    const responder = gameState.players.find((player) => player.id === socket.id);
    emitLockedMessage(
      roomId,
      gameState,
      `${responder?.name || "Jugador"} respondio Quiero al ${CALL_LABELS[truco.callType || "truco"]}`
    );

    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("truco:reject", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    const truco = gameState.truco || {};
    if (truco.status !== "pending") return;
    if (truco.responderId !== socket.id && !isSameTeam(gameState, truco.responderId, socket.id)) {
      socket.emit("server:message", "No te corresponde responder ese canto");
      return;
    }
    burnFlorOnRespondWithoutConFlor(gameState, socket.id);

    const callerId = truco.callerId;
    if (!callerId) return;
    const reservadaOwnerId = getFlorReservadaOwnerId(gameState);
    const trucoPointWinnerId = reservadaOwnerId || callerId;
    const responder = gameState.players.find((player) => player.id === socket.id);
    emitLockedMessage(
      roomId,
      gameState,
      `${responder?.name || "Jugador"} respondio No Quiero al ${CALL_LABELS[truco.callType || "truco"]}.`
    );
    resolveRound(room, trucoPointWinnerId, roomId);
    io.to(roomId).emit("game:update", room.gameState);
  });

  socket.on("parda:select", ({ roomId, bottomIndex, topIndex }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!(gameState.firstHandTie && gameState.pardaPhase === "selecting")) return;
    if (gameState.turn !== socket.id) {
      socket.emit("server:message", "No es tu turno de elegir en la parda");
      return;
    }
    if (gameState.envido?.status === "pending" || gameState.truco?.status === "pending") return;
    if (
      gameState.flor?.florEnvidoWindowOpen &&
      gameState.flor?.florEnvidoWindowTurnId === socket.id &&
      !gameState.flor?.florEnvidoCalled
    ) {
      advanceFlorEnvidoWindowAfterPass(gameState, socket.id);
    }

    const hand = gameState.hands[socket.id] || [];
    if (
      typeof bottomIndex !== "number" ||
      typeof topIndex !== "number" ||
      bottomIndex === topIndex ||
      bottomIndex < 0 ||
      topIndex < 0 ||
      bottomIndex >= hand.length ||
      topIndex >= hand.length
    ) {
      socket.emit("server:message", "Seleccion parda invalida");
      return;
    }

    gameState.pardaSelections = gameState.pardaSelections || {};
    const pickedBottom = { ...hand[bottomIndex], playerId: socket.id };
    const pickedTop = { ...hand[topIndex], playerId: socket.id };

    const remaining = hand.filter((_, idx) => idx !== bottomIndex && idx !== topIndex);
    gameState.hands[socket.id] = remaining;
    gameState.tableCards.push(pickedBottom, pickedTop);

    gameState.pardaSelections[socket.id] = {
      bottomCard: pickedBottom,
      topCard: pickedTop,
    };

    const playerIds = gameState.players.map((p) => p.id);
    const allSelected = playerIds.every((playerId) => !!gameState.pardaSelections[playerId]);

    if (!allSelected) {
      const me = gameState.players.find((p) => p.id === socket.id);
      gameState.turn = getNextPlayerId(gameState, socket.id);
      emitLockedMessage(
        roomId,
        gameState,
        `${me?.name || "Jugador"} eligio debajo y arriba. Turno del rival para elegir.`
      );
      io.to(roomId).emit("game:update", gameState);
      return;
    }

    if (!resolvePardaRound(room, roomId)) {
      socket.emit("server:message", "No se pudo resolver la parda");
      return;
    }

    io.to(roomId).emit("game:update", room.gameState);
  });

  socket.on("play:card", ({ roomId, cardIndex, faceDown }) => {
    if (!roomId || typeof cardIndex !== "number") return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) {
      socket.emit("server:message", "Esperando nuevo reparto...");
      return;
    }
    if (isInputLocked(gameState)) return;
    if (gameState.truco?.status === "pending") {
      socket.emit("server:message", "Esperando respuesta de Truco");
      return;
    }
    if (gameState.envido?.status === "pending") {
      socket.emit("server:message", "Esperando respuesta de Envido");
      return;
    }
    if (isFlorEnvidoPending(gameState)) {
      socket.emit("server:message", "Esperando respuesta de Flor Envido");
      return;
    }
    if (gameState.firstHandTie && gameState.pardaPhase === "selecting") {
      socket.emit("server:message", "Debes seleccionar carta debajo y arriba para la parda");
      return;
    }

    if (gameState.turn !== socket.id) {
      socket.emit("server:message", "No es tu turno");
      return;
    }
    if (
      gameState.flor?.florEnvidoWindowOpen &&
      gameState.flor?.florEnvidoWindowTurnId === socket.id &&
      !gameState.flor?.florEnvidoCalled
    ) {
      advanceFlorEnvidoWindowAfterPass(gameState, socket.id);
    }

    const isSecondHand = gameState.handNumber === 2;
    const keptLeyFlor = !!gameState.flor?.leyByPlayer?.[socket.id];
    if (isSecondHand && keptLeyFlor && hasAvailableFlor(gameState, socket.id)) {
      markFlorBurned(gameState, socket.id);
      const me = gameState.players.find((p) => p.id === socket.id);
      emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"} quemo la Flor por jugar sin cantarla`);
    }

    const hand = gameState.hands[socket.id];
    if (!Array.isArray(hand) || cardIndex < 0 || cardIndex >= hand.length) {
      socket.emit("server:message", "Carta invalida");
      return;
    }

    const [playedCard] = hand.splice(cardIndex, 1);
    const cardToPlay = faceDown
      ? {
          ...playedCard,
          rank: 0,
        }
      : playedCard;
    const playedCardWithPlayer = {
      ...cardToPlay,
      playerId: socket.id,
    };

    gameState.tableCards.push(playedCardWithPlayer);
    gameState.currentHandCards.push(playedCardWithPlayer);

    const playerIds = gameState.players.map((player) => player.id);

    if (gameState.currentHandCards.length < playerIds.length) {
      gameState.turn = getNextPlayerId(gameState, socket.id);
      io.to(roomId).emit("game:update", gameState);
      return;
    }

    const handStarterId = gameState.currentHandStarter;
    const currentHandNumber = gameState.handNumber || 1;
    const playedWithRank = gameState.currentHandCards.map((card) => ({
      card,
      rank: resolveHandRank(card, gameState.vira),
    }));
    const bestRank = Math.max(...playedWithRank.map((entry) => entry.rank));
    const winners = playedWithRank.filter((entry) => entry.rank === bestRank);
    const winnerId = resolveWinnerFromRankEntries(gameState, winners);

    gameState.currentHandCards = [];
    gameState.handResults = gameState.handResults || [];
    gameState.handResults.push(winnerId);

    if (winnerId) {
      gameState.handWinsByPlayer[winnerId] = (gameState.handWinsByPlayer[winnerId] || 0) + 1;
      const winner = gameState.players.find((player) => player.id === winnerId);
      if (winner?.name) {
        const handLabelByNumber = {
          1: "primera",
          2: "segunda",
          3: "tercera",
        };
        const handLabel = handLabelByNumber[currentHandNumber] || `${currentHandNumber}a`;
        emitLockedMessage(roomId, gameState, `${winner.name} mata ${handLabel}`);
      }
    } else {
      emitLockedMessage(roomId, gameState, "La mano fue parda");
    }

    if (gameState.handNumber === 1 && !winnerId) {
      gameState.firstHandTie = true;
      gameState.pardaPhase = "selecting";
      gameState.pardaSelections = {};
      gameState.turn = handStarterId;
      emitLockedMessage(roomId, gameState, "Primera mano parda: el que salio primero elige debajo y arriba");
      io.to(roomId).emit("game:update", gameState);
      return;
    }

    if (gameState.handNumber === 1) {
      for (const player of gameState.players) {
        if (!hasAvailableFlor(gameState, player.id)) continue;
        const playedLey = !!gameState.flor?.leyByPlayer?.[player.id];
        if (!playedLey) {
          markFlorBurned(gameState, player.id);
        }
      }
    }

    if (!gameState.firstHandTie && !winnerId && currentHandNumber >= 2) {
      const firstHandWinnerId = gameState.handResults?.[0] || gameState.roundStarter || handStarterId;
      resolveRound(room, firstHandWinnerId, roomId);
      io.to(roomId).emit("game:update", room.gameState);
      return;
    }

    if (winnerId) {
      gameState.turn = winnerId;
      gameState.currentHandStarter = winnerId;
      const roundWins =
        gameState.mode === "2vs2"
          ? getTeamHandWins(gameState, winnerId)
          : (gameState.handWinsByPlayer[winnerId] || 0);
      if (roundWins >= 2) {
        resolveRound(room, winnerId, roomId);
        io.to(roomId).emit("game:update", room.gameState);
        return;
      }
    } else {
      gameState.turn = handStarterId;
      gameState.currentHandStarter = handStarterId;
    }

    if (gameState.handNumber >= 3) {
      let finalWinnerId;
      if (gameState.mode === "2vs2") {
        finalWinnerId = pickRoundWinnerByTeam(gameState);
      } else {
        const playerIdsByOrder = gameState.players.map((p) => p.id);
        finalWinnerId = playerIdsByOrder[0];
        let maxWins = -1;

        for (const playerId of playerIdsByOrder) {
          const wins = gameState.handWinsByPlayer[playerId] || 0;
          if (wins > maxWins) {
            maxWins = wins;
            finalWinnerId = playerId;
          }
        }

        const tiedLeaders = playerIdsByOrder.filter(
          (playerId) => (gameState.handWinsByPlayer[playerId] || 0) === maxWins
        );
        if (tiedLeaders.length > 1) {
          const firstNonTieWinner = (gameState.handResults || []).find((result) => !!result);
          finalWinnerId = firstNonTieWinner || gameState.roundStarter || finalWinnerId;
        }
      }
      resolveRound(room, finalWinnerId, roomId);
      io.to(roomId).emit("game:update", room.gameState);
      return;
    }

    if (currentHandNumber === 2) {
      const playersWhoBurnLeyFlor = [];
      for (const player of gameState.players) {
        const playerId = player.id;
        const keptLey = !!gameState.flor?.leyByPlayer?.[playerId];
        if (keptLey && hasAvailableFlor(gameState, playerId)) {
          markFlorBurned(gameState, playerId);
          gameState.flor.leyByPlayer[playerId] = false;
          playersWhoBurnLeyFlor.push(player.name || "Jugador");
        }
      }

      if (playersWhoBurnLeyFlor.length > 0) {
        emitLockedMessage(
          roomId,
          gameState,
          `${playersWhoBurnLeyFlor.join(" y ")} quemo${playersWhoBurnLeyFlor.length > 1 ? "n" : ""} la Flor por no cantarla en segunda`
        );
      }
    }

    gameState.handNumber += 1;
    io.to(roomId).emit("game:update", gameState);
  });

  socket.on("match:decision", ({ roomId, decision }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (!gameState.matchEnded || !gameState.rematch || gameState.rematch.resolved) return;

    const safeDecision =
      decision === "replay" ? "replay" : decision === "exit" ? "exit" : decision === "pending" ? null : undefined;
    if (typeof safeDecision === "undefined") return;

    const seatedIds = (gameState.players || []).map((p) => p.id);
    if (!seatedIds.includes(socket.id)) return;

    gameState.rematch.decisionsByPlayer[socket.id] = safeDecision;
    io.to(roomId).emit("game:update", gameState);

    const decisions = Object.values(gameState.rematch.decisionsByPlayer || {});
    const everyoneAnswered = decisions.length > 0 && decisions.every((v) => v === "replay" || v === "exit");
    if (!everyoneAnswered) return;

    const everyoneReplay = decisions.every((v) => v === "replay");
    if (everyoneReplay) {
      gameState.rematch = {
        ...gameState.rematch,
        status: "accepted",
        resolved: true,
        result: "replay",
      };
      const starterId = getNextRoundStarterId(gameState) || gameState.roundStarter || seatedIds[0];
      startGame.redealRound(room, starterId);
      room.status = room.players.length === room.maxPlayers ? "full" : "waiting";
      io.to(roomId).emit("server:message", "Todos confirmaron: comienza una nueva partida");
      io.to(roomId).emit("game:update", room.gameState);
      emitRooms();
      return;
    }

    gameState.rematch = {
      ...gameState.rematch,
      status: "declined",
      resolved: true,
      result: "exit",
    };

    const idsToReturn = [...seatedIds];
    for (const playerId of idsToReturn) {
      const client = io.sockets.sockets.get(playerId);
      if (client) {
        client.leave(roomId);
        client.data.roomId = null;
        client.emit("match:return-roomlist");
      }
    }
    room.players = [];
    room.status = "waiting";
    room.gameState = null;
    io.to(roomId).emit("room:update", room);
    emitRooms();
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);

    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (player && room.gameState) {
      player.connected = false;
      player.lastSeenAt = Date.now();
      const timeoutKey = getSeatTimeoutKey(roomId, socket.id);
      clearSeatTimeout(roomId, socket.id);
      const timeout = setTimeout(() => {
        const liveRoom = getRoom(roomId);
        if (!liveRoom) return;
        const stillMissing = liveRoom.players.find(
          (p) => p.id === socket.id && p.connected === false
        );
        if (!stillMissing) return;
        clearSeatTimeout(roomId, socket.id);
        const updated = removePlayer(roomId, socket.id);
        if (updated) {
          io.to(roomId).emit("room:update", updated);
        }
        emitRooms();
      }, RECONNECT_GRACE_MS);
      disconnectedSeatTimeouts.set(timeoutKey, timeout);

      io.to(roomId).emit("room:update", room);
      emitRooms();
      return;
    }

    const updatedRoom = removePlayer(roomId, socket.id);

    if (updatedRoom) {
      io.to(roomId).emit("room:update", updatedRoom);
    }

    emitRooms();
  });
});

// TEMP (remove after testing): bind to all interfaces so phones on same WiFi can connect.
server.listen(3001, "0.0.0.0", () => {
  console.log("Servidor LAN en http://0.0.0.0:3001");
});
