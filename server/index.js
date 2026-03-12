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
const { resolveHandRank, computeEnvido, computeFlorValue } = require("./game/rules");
const MSG = require("./game/messages");
const { firstError, guardTurn } = require("./game/guards");

const app = express();
app.use(cors());
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "truco-server", ts: Date.now() });
});

const server = http.createServer(app);

// TEMP (LAN testing): allow common private LAN ranges with any dev port (Vite may use 5173/5174/etc).
const LAN_DEV_ORIGIN =
  /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/;
const VERCEL_ORIGIN = /^https:\/\/([a-zA-Z0-9-]+\.)*vercel\.app$/;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "";
const CORS_ALLOW_ALL = String(process.env.CORS_ALLOW_ALL || "") === "1";

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (CORS_ALLOW_ALL) return callback(null, true);
      if (!origin) return callback(null, true);
      if (
        LAN_DEV_ORIGIN.test(origin) ||
        VERCEL_ORIGIN.test(origin) ||
        (FRONTEND_ORIGIN && origin === FRONTEND_ORIGIN)
      ) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  },
  // Keep mobile clients connected longer while app/browser is briefly backgrounded.
  pingInterval: 25000,
  pingTimeout: 120000,
  connectTimeout: 45000,
});

function emitRooms() {
  io.emit("rooms:update", getPublicRooms());
}

function emitGameUpdate(roomId, gameState) {
  if (!roomId || !gameState) return;
  gameState.stateVersion = (Number(gameState.stateVersion) || 0) + 1;
  scheduleRoomTurnPlayTimeout(roomId, gameState);
  io.to(roomId).emit("game:update", { roomId, gameState });
}

function emitServerEvent(roomId, message, kind = "info") {
  if (!roomId || typeof message !== "string" || !message.trim()) return;
  io.to(roomId).emit("server:event", {
    roomId,
    kind,
    message,
    timestamp: Date.now(),
  });
}

const MESSAGE_LOCK_MS = 1700;
const GAME_TARGET = 12;
const TRUCO_RAISE_WINDOW_MS = 2000;
const BOT_PREFIX = "bot:";
const BOT_NAMES = ["Leonardo", "Donatello", "Raphael", "Michelangelo"];
const BOT_TICK_MS = 1100;
const BOT_PENDING_RESPONSE_MIN_MS = 2800;
const BOT_PENDING_RESPONSE_JITTER_MS = 2400;
const TURN_PLAY_TIMEOUT_MS = 45000;
let botLoopStarted = false;
let botsDebugEnabled = false;
const PERF_LOG_ENABLED = String(process.env.PERF_LOG || "") === "1";
const TURN_TIMER_DEBUG = String(process.env.TURN_TIMER_DEBUG || "") === "1";
const botNextActionAt = new Map();
const botPendingReadyAt = new Map();
const botRematchVoteTimers = new Map();
const roomMessageTimers = new Map();
const disconnectedSeatTimeouts = new Map();
const roomTurnPlayTimers = new Map();
const voiceParticipantsByRoom = new Map();

function turnTimerLog(...args) {
  if (!TURN_TIMER_DEBUG) return;
  console.log("[TURN-TIMER]", ...args);
}

function clearTurnTimerState(gameState) {
  if (!gameState) return;
  gameState.turnTimer = {
    playerId: null,
    startedAt: 0,
    endsAt: 0,
    durationMs: TURN_PLAY_TIMEOUT_MS,
  };
}

function clearRoomTurnPlayTimer(roomId) {
  const existing = roomTurnPlayTimers.get(roomId);
  if (!existing) return;
  clearTimeout(existing.timeoutId);
  roomTurnPlayTimers.delete(roomId);
}

function ensureAwayByPlayer(gameState) {
  if (!gameState) return;
  if (!gameState.awayByPlayer || typeof gameState.awayByPlayer !== "object") {
    gameState.awayByPlayer = {};
  }
  const players = Array.isArray(gameState.players) ? gameState.players : [];
  for (const player of players) {
    const id = player?.id;
    if (!id) continue;
    if (typeof gameState.awayByPlayer[id] !== "boolean") {
      gameState.awayByPlayer[id] = false;
    }
  }
}

function getVoiceParticipants(roomId) {
  if (!roomId) return null;
  let participants = voiceParticipantsByRoom.get(roomId);
  if (!participants) {
    participants = new Set();
    voiceParticipantsByRoom.set(roomId, participants);
  }
  return participants;
}

function removeFromVoiceRoom(socket, reason = "leave", explicitRoomId = null) {
  const roomId = explicitRoomId || socket.data?.voiceRoomId;
  if (!roomId) return;
  const participants = voiceParticipantsByRoom.get(roomId);
  if (!participants) {
    if (socket.data?.voiceRoomId === roomId) socket.data.voiceRoomId = null;
    return;
  }
  const existed = participants.delete(socket.id);
  if (existed) {
    socket.to(roomId).emit("voice:peer-left", {
      roomId,
      peerId: socket.id,
      reason,
    });
  }
  if (participants.size === 0) {
    voiceParticipantsByRoom.delete(roomId);
  }
  if (socket.data?.voiceRoomId === roomId) socket.data.voiceRoomId = null;
}

function unsubscribePlayerSeat(roomId, playerId, reason = "manual") {
  if (!roomId || !playerId) return false;
  const room = getRoom(roomId);
  if (!room) return false;

  const hadSeat = room.players.some((p) => p.id === playerId);
  if (!hadSeat) return false;

  room.players = room.players.filter((p) => p.id !== playerId);

  if (room.gameState) {
    ensureAwayByPlayer(room.gameState);
    delete room.gameState.awayByPlayer[playerId];
    if (room.gameState.rematch?.decisionsByPlayer) {
      delete room.gameState.rematch.decisionsByPlayer[playerId];
    }
  }

  const client = io.sockets.sockets.get(playerId);
  if (client) {
    client.leave(roomId);
    if (client.data?.roomId === roomId) {
      client.data.roomId = null;
    }
  }

  if (!room.gameState && room.players.length === 0) {
    room.status = "waiting";
  }

  turnTimerLog("seat-unsubscribe", {
    roomId,
    playerId,
    reason,
    remainingSeats: room.players.length,
    hasGameState: !!room.gameState,
  });

  io.to(roomId).emit("room:update", room);
  emitRooms();
  return true;
}

function resolveAwayForfeit(roomId, absentPlayerId, reason = "ausencia") {
  const room = getRoom(roomId);
  const gameState = room?.gameState;
  if (!room || !gameState || gameState.matchEnded || !absentPlayerId) return false;
  const loser = gameState.players.find((p) => p.id === absentPlayerId);
  if (!loser) return false;

  const opponentId =
    getOpposingResponderId(gameState, absentPlayerId) ||
    getOpposingPlayerIds(gameState, absentPlayerId)?.[0] ||
    null;
  if (!opponentId) return false;

  if (gameState.mode === "2vs2") {
    ensureScoreState(gameState);
    const loserTeam = getScoreTeamField(gameState, absentPlayerId);
    if (loserTeam === "team1") {
      gameState.score.team2 = Math.max(Number(gameState.score.team2 || 0), GAME_TARGET);
    } else {
      gameState.score.team1 = Math.max(Number(gameState.score.team1 || 0), GAME_TARGET);
    }
  } else {
    gameState.pointsByPlayer[opponentId] = Math.max(
      Number(gameState.pointsByPlayer[opponentId] || 0),
      GAME_TARGET
    );
  }

  const winnerLabel = getWinnerLabel(gameState, opponentId);
  emitLockedMessage(
    roomId,
    gameState,
    `${loser?.name || "Jugador"}: abandono la mesa por 45s (${reason}). ${winnerLabel} gana la partida`
  );
  gameState.matchEnded = true;
  gameState.matchWinnerId = opponentId;
  gameState.matchEndedAt = Date.now();
  gameState.rematch = buildRematchState(gameState);
  room.status = "finished";
  clearRoomTurnPlayTimer(roomId);
  emitRooms();
  emitGameUpdate(roomId, gameState);
  unsubscribePlayerSeat(roomId, absentPlayerId, "away-timeout");
  return true;
}

function findAwayPlayerForTimerForfeit(gameState) {
  ensureAwayByPlayer(gameState);
  const players = Array.isArray(gameState?.players) ? gameState.players : [];
  const currentTurnId = gameState?.turn || null;
  if (currentTurnId && !isBotPlayerId(currentTurnId)) {
    const currentTurnPlayer = players.find((p) => p.id === currentTurnId);
    if (gameState.awayByPlayer[currentTurnId] || currentTurnPlayer?.connected === false) {
      return currentTurnId;
    }
  }
  const firstAway = players.find(
    (p) =>
      p?.id &&
      !isBotPlayerId(p.id) &&
      (gameState.awayByPlayer[p.id] || p.connected === false)
  );
  return firstAway?.id || null;
}

function getPendingResponseForTimeout(gameState) {
  if (!gameState) return null;
  if (isFlorEnvidoPending(gameState)) {
    return {
      type: "flor-envido",
      responderId: gameState?.flor?.florEnvidoResponderId || null,
    };
  }
  if (gameState.envido?.status === "pending") {
    return {
      type: "envido",
      responderId: gameState?.envido?.responderId || null,
    };
  }
  if (gameState.truco?.status === "pending") {
    return {
      type: "truco",
      responderId: gameState?.truco?.responderId || null,
    };
  }
  return null;
}

function getTurnTimeoutArmState(room, gameState) {
  if (!room || !gameState) return { canArm: false, retryMs: null };
  const pendingResponse = getPendingResponseForTimeout(gameState);
  const turnId = pendingResponse?.responderId || gameState.turn;
  if (!turnId || isBotPlayerId(turnId)) return { canArm: false, retryMs: null };
  if (gameState.matchEnded || gameState.roundEnding) return { canArm: false, retryMs: null };
  if (isCanto11Active(gameState)) return { canArm: false, retryMs: null };
  if (isInputLocked(gameState)) {
    const unlockAt = Number(gameState.inputLockedUntil || 0);
    const wait = Math.max(80, unlockAt - Date.now() + 30);
    return { canArm: false, retryMs: wait };
  }
  if (gameState.pendingMazo?.callerId) return { canArm: false, retryMs: null };
  if (isTrucoRaiseWindowOpen(gameState)) {
    const until = Number(gameState.truco?.raiseWindowUntil || 0);
    const wait = Math.max(80, until - Date.now() + 30);
    return { canArm: false, retryMs: wait };
  }
  if (
    !pendingResponse &&
    gameState.firstHandTie &&
    (gameState.pardaPhase === "selecting" || gameState.pardaPhase === "reveal")
  ) {
    return { canArm: false, retryMs: null };
  }
  if (!pendingResponse) {
    const hand = gameState.hands?.[turnId];
    if (!Array.isArray(hand) || hand.length === 0) return { canArm: false, retryMs: null };
  }
  return {
    canArm: true,
    retryMs: null,
    turnId,
    pendingType: pendingResponse?.type || null,
  };
}

function getLowestRankCardIndex(hand, vira) {
  if (!Array.isArray(hand) || hand.length === 0) return -1;
  let bestIndex = 0;
  let bestRank = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hand.length; i += 1) {
    const rank = resolveHandRank(hand[i], vira);
    if (rank < bestRank) {
      bestRank = rank;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function scheduleRoomTurnPlayTimeout(roomId, gameState) {
  const room = getRoom(roomId);
  const armState = getTurnTimeoutArmState(room, gameState);
  const timeoutTurnId = armState.turnId || gameState?.turn || null;
  if (!armState.canArm) {
    clearRoomTurnPlayTimer(roomId);
    turnTimerLog("skip-arm", {
      roomId,
      turn: timeoutTurnId,
      retryMs: armState.retryMs || 0,
      matchEnded: !!gameState?.matchEnded,
      roundEnding: !!gameState?.roundEnding,
      canto11: !!isCanto11Active(gameState),
      inputLocked: !!isInputLocked(gameState),
      trucoPending: gameState?.truco?.status === "pending",
      envidoPending: gameState?.envido?.status === "pending",
      florEnvidoPending: !!isFlorEnvidoPending(gameState),
    });
    clearTurnTimerState(gameState);
    if (armState.retryMs) {
      const retryId = setTimeout(() => {
        const retryRoom = getRoom(roomId);
        const retryGame = retryRoom?.gameState;
        if (!retryGame) return;
        const retryArmState = getTurnTimeoutArmState(retryRoom, retryGame);
        turnTimerLog("retry-arm", {
          roomId,
          turn: retryArmState.turnId || retryGame?.turn || null,
        });
        scheduleRoomTurnPlayTimeout(roomId, retryGame);
        if (
          retryGame.turnTimer?.playerId &&
          Number(retryGame.turnTimer?.endsAt || 0) > Date.now()
        ) {
          io.to(roomId).emit("game:update", { roomId, gameState: retryGame });
        }
      }, armState.retryMs);
      roomTurnPlayTimers.set(roomId, {
        timeoutId: retryId,
        turnId: timeoutTurnId,
      });
    }
    return;
  }

  const existing = roomTurnPlayTimers.get(roomId);
  const existingEndsAt = Number(gameState?.turnTimer?.endsAt || 0);
  if (
    existing &&
    existing.turnId === timeoutTurnId &&
    existingEndsAt > Date.now()
  ) {
    turnTimerLog("keep-existing", {
      roomId,
      turn: timeoutTurnId,
      endsAt: existingEndsAt,
      pendingType: armState.pendingType || null,
    });
    return;
  }

  clearRoomTurnPlayTimer(roomId);

  const armedTurnId = timeoutTurnId;
  const startedAt = Date.now();
  const endsAt = startedAt + TURN_PLAY_TIMEOUT_MS;
  turnTimerLog("armed", {
    roomId,
    turn: armedTurnId,
    startedAt,
    endsAt,
    durationMs: TURN_PLAY_TIMEOUT_MS,
    pendingType: armState.pendingType || null,
  });
  gameState.turnTimer = {
    playerId: armedTurnId,
    startedAt,
    endsAt,
    durationMs: TURN_PLAY_TIMEOUT_MS,
  };
  const armedVersion = Number(gameState.stateVersion || 0);
  const timeoutId = setTimeout(() => {
    const liveRoom = getRoom(roomId);
    const liveGame = liveRoom?.gameState;
    turnTimerLog("expired", {
      roomId,
      armedTurnId,
      currentTurn: liveGame?.turn || null,
      stateVersion: Number(liveGame?.stateVersion || 0),
      armedVersion,
    });
    const liveArmState = getTurnTimeoutArmState(liveRoom, liveGame);
    if (!liveArmState.canArm) return;
    if ((liveArmState.turnId || liveGame.turn) !== armedTurnId) return;
    if (Number(liveGame.turnTimer?.endsAt || 0) !== endsAt) return;
    if (Number(liveGame.stateVersion || 0) < armedVersion) return;

    const awayForfeitPlayerId = findAwayPlayerForTimerForfeit(liveGame);
    if (awayForfeitPlayerId) {
      turnTimerLog("forfeit-away", {
        roomId,
        awayForfeitPlayerId,
        turn: liveGame.turn,
      });
      resolveAwayForfeit(roomId, awayForfeitPlayerId, "ausente al vencer timer");
      return;
    }

    if (liveArmState.pendingType === "envido" && liveGame.envido?.status === "pending") {
      turnTimerLog("auto-reject", { roomId, armedTurnId, pendingType: "envido" });
      applyEnvidoRejectAction(roomId, liveGame, armedTurnId, "Jugador", true);
      emitGameUpdate(roomId, liveGame);
      return;
    }

    if (liveArmState.pendingType === "truco" && liveGame.truco?.status === "pending") {
      turnTimerLog("auto-reject", { roomId, armedTurnId, pendingType: "truco" });
      applyTrucoRejectAction(liveRoom, roomId, liveGame, armedTurnId, "Jugador");
      emitGameUpdate(roomId, liveRoom.gameState);
      return;
    }

    if (liveArmState.pendingType === "flor-envido" && isFlorEnvidoPending(liveGame)) {
      turnTimerLog("auto-reject", { roomId, armedTurnId, pendingType: "flor-envido" });
      applyFlorEnvidoRejectAction(roomId, liveGame, armedTurnId, "Jugador");
      emitGameUpdate(roomId, liveGame);
      return;
    }

    const hand = liveGame.hands?.[armedTurnId];
    const cardIndex = getLowestRankCardIndex(hand, liveGame.vira);
    if (cardIndex < 0) return;

    const playedCount = Math.max(0, 3 - hand.length);
    const faceDown = playedCount >= 1;
    const playerSocket = io.sockets.sockets.get(armedTurnId);
    if (!playerSocket) {
      turnTimerLog("no-socket", { roomId, armedTurnId });
      ensureAwayByPlayer(liveGame);
      liveGame.awayByPlayer[armedTurnId] = true;
      resolveAwayForfeit(roomId, armedTurnId, "sin conexion al vencer timer");
      return;
    }
    const handlers = playerSocket.listeners("play:card");
    if (!Array.isArray(handlers) || handlers.length === 0) {
      turnTimerLog("no-handler", { roomId, armedTurnId });
      ensureAwayByPlayer(liveGame);
      liveGame.awayByPlayer[armedTurnId] = true;
      resolveAwayForfeit(roomId, armedTurnId, "sin handler al vencer timer");
      return;
    }

    try {
      turnTimerLog("auto-play", { roomId, armedTurnId, cardIndex, faceDown });
      handlers[0].call(playerSocket, { roomId, cardIndex, faceDown });
    } catch (error) {
      console.error("Error en auto-jugada por timeout:", error?.message || error);
    }

    setTimeout(() => {
      const verifyRoom = getRoom(roomId);
      const verifyGame = verifyRoom?.gameState;
      if (!verifyGame) return;
      if (verifyGame.turn === armedTurnId) {
        scheduleRoomTurnPlayTimeout(roomId, verifyGame);
      }
    }, 150);
  }, TURN_PLAY_TIMEOUT_MS);

  roomTurnPlayTimers.set(roomId, {
    timeoutId,
    turnId: armedTurnId,
  });
}

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

function reclaimDisconnectedSeat(
  room,
  socket,
  nextPlayerName,
  reconnectToken,
  nextAvatarUrl = "",
  nextProfileId = null,
  nextPlayerUid = null
) {
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
  disconnected.avatarUrl = nextAvatarUrl || disconnected.avatarUrl || "";
  disconnected.profileId = nextProfileId || disconnected.profileId || null;
  disconnected.playerUid = nextPlayerUid || disconnected.playerUid || null;
  clearSeatTimeout(room.id, oldId);

  room.gameState = replacePlayerIdDeep(room.gameState, oldId, newId);
  ensureAwayByPlayer(room.gameState);
  room.gameState.awayByPlayer[newId] = false;
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

function getBotRematchVoteKey(roomId, botId) {
  return `${roomId}:${botId}`;
}

function clearRoomBotRematchVoteTimers(roomId) {
  const prefix = `${roomId}:`;
  for (const key of botRematchVoteTimers.keys()) {
    if (key.startsWith(prefix)) {
      clearTimeout(botRematchVoteTimers.get(key));
      botRematchVoteTimers.delete(key);
    }
  }
}

function clearRoomMessageTimers(roomId) {
  const timers = roomMessageTimers.get(roomId) || [];
  for (const timer of timers) {
    clearTimeout(timer);
  }
  roomMessageTimers.delete(roomId);
}

function ensurePendingSince(pendingState) {
  if (!pendingState) return Date.now();
  if (!pendingState.pendingSince) pendingState.pendingSince = Date.now();
  return pendingState.pendingSince;
}

function getBotPendingKey(roomId, botId, pendingType, pendingSince) {
  return `${roomId}:${pendingType}:${botId}:${pendingSince}`;
}

function canBotResolvePending(roomId, botId, pendingType, pendingSince) {
  const key = getBotPendingKey(roomId, botId, pendingType, pendingSince);
  const existingDueAt = botPendingReadyAt.get(key);
  if (existingDueAt) return Date.now() >= existingDueAt;
  const dueAt =
    pendingSince +
    BOT_PENDING_RESPONSE_MIN_MS +
    Math.floor(Math.random() * BOT_PENDING_RESPONSE_JITTER_MS);
  botPendingReadyAt.set(key, dueAt);
  return Date.now() >= dueAt;
}

function clearBotPendingSchedule(roomId, botId, pendingType) {
  const prefix = `${roomId}:${pendingType}:${botId}:`;
  for (const key of botPendingReadyAt.keys()) {
    if (key.startsWith(prefix)) {
      botPendingReadyAt.delete(key);
    }
  }
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

function isCurrentTurnLastToPlay(gameState, playerId) {
  if (!gameState || !playerId || gameState.turn !== playerId) return false;
  const players = gameState.players || [];
  if (!players.length) return false;
  const startId = gameState.currentHandStarter || gameState.roundStarter || players[0]?.id;
  const order = getTurnOrder(gameState, startId);
  if (!order.length) return false;
  const isLastSeat = order[order.length - 1] === playerId;
  const playedCount = (gameState.currentHandCards || []).length;
  return isLastSeat && playedCount === order.length - 1;
}

function hasOpposingTeamCalledEnvido(gameState, playerId) {
  const envido = gameState?.envido || {};
  const callerId = envido.callerId || null;
  if (!callerId) return false;
  return !isSameTeam(gameState, playerId, callerId);
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

function isTrucoRaiseWindowOpen(gameState) {
  return Number(gameState?.truco?.raiseWindowUntil || 0) > Date.now();
}

function normalizePlayerActionMessage(message) {
  if (typeof message !== "string") return message;
  const trimmed = message.trim();
  if (!trimmed) return message;

  const verbPattern = "(canto|canta|respondio|responde|juega|jugo|activo|activa)";
  const withColon = trimmed.match(new RegExp(`^([^:]+):\\s*${verbPattern}\\s*:?\\s*(.+)$`, "i"));
  if (withColon) {
    const [, rawPlayer, rest] = withColon;
    const player = rawPlayer.trim();
    if (player && rest?.trim()) return `${player}: ${rest.trim()}`;
  }

  const withoutColon = trimmed.match(new RegExp(`^([^:]+?)\\s+${verbPattern}\\s*:?\\s*(.+)$`, "i"));
  if (withoutColon) {
    const [, rawPlayer, rest] = withoutColon;
    const player = rawPlayer.trim();
    if (player && rest?.trim()) return `${player}: ${rest.trim()}`;
  }

  const seFueWithColon = trimmed.match(/^([^:]+):\s*se fue\s*:?\s*(.+)$/i);
  if (seFueWithColon) {
    const [, rawPlayer, rest] = seFueWithColon;
    const player = rawPlayer.trim();
    if (player && rest?.trim()) return `${player}: ${rest.trim()}`;
  }

  const seFueWithoutColon = trimmed.match(/^([^:]+?)\s+se fue\s*:?\s*(.+)$/i);
  if (seFueWithoutColon) {
    const [, rawPlayer, rest] = seFueWithoutColon;
    const player = rawPlayer.trim();
    if (player && rest?.trim()) return `${player}: ${rest.trim()}`;
  }

  return message;
}

function emitLockedMessage(roomId, gameState, message, lockMs = MESSAGE_LOCK_MS) {
  if (!gameState) return;
  const normalized = normalizePlayerActionMessage(message);
  const nextUnlock = Date.now() + lockMs;
  gameState.inputLockedUntil = Math.max(gameState.inputLockedUntil || 0, nextUnlock);
  gameState.uiMessage = normalized;
  gameState.uiMessageUntil = nextUnlock;
  emitServerEvent(roomId, normalized, "game");
}

function clearLockedMessage(gameState) {
  if (!gameState) return;
  gameState.uiMessage = "";
  gameState.uiMessageUntil = 0;
}

const CALL_LABELS = {
  truco: "Truco",
  retruco: "Retruco",
  vale9: "Vale 9",
  valejuego: "Vale Juego",
};

const TEAM_SIGNAL_LABELS = {
  ven_a_mi: "Ven a mi",
  voy_para_alla: "Voy para alla",
  mata: "Mata",
  puyalo: "Puyalo",
  pegaselo: "Pegaselo",
  no_venga: "No venga",
  llevo: "Llevo",
  tiene_algo: "Tiene algo",
};
const TEAM_SIGNAL_COOLDOWN_MS = 1200;
const teamSignalCooldownByPlayer = new Map();


function computeFaltaEnvidoPoints(gameState = {}) {
  const isTeams = gameState?.mode === "2vs2";
  const sourceScores = isTeams
    ? [Number(gameState?.score?.team1) || 0, Number(gameState?.score?.team2) || 0]
    : Object.values(gameState?.pointsByPlayer || {}).map((v) => Number(v) || 0);
  const currentBestScore = Math.max(...sourceScores, 0);
  return Math.max(1, GAME_TARGET - currentBestScore);
}

function isCanto11Active(gameState) {
  const status = gameState?.canto11?.status || "idle";
  return (
    status === "declaring" ||
    status === "responding" ||
    status === "duel_declaring" ||
    status === "duel_resolving"
  );
}

function getTeamIdsByKey(gameState, teamKey) {
  const players = gameState?.players || [];
  return players
    .map((p) => p.id)
    .filter((id) => getPlayerTeamKey(gameState, id) === teamKey);
}

function getTeamScoreByKey(gameState, teamKey) {
  const teamIds = getTeamIdsByKey(gameState, teamKey);
  if (!teamIds.length) return 0;
  const sampleId = teamIds[0];
  return getTotalPoints(gameState, sampleId);
}

function resolveCanto11ByFlorIfNeeded(roomId, room, gameState) {
  const canto11 = gameState?.canto11 || {};
  const flor = gameState?.flor || {};
  const snapshot = gameState?.roundHandsSnapshot || gameState?.hands || {};
  const singingIds = getTeamIdsByKey(gameState, canto11.singingTeamKey);
  const responderIds = getTeamIdsByKey(gameState, canto11.responderTeamKey);
  if (!singingIds.length || !responderIds.length) return false;

  const hasSingingFlor = singingIds.some(
    (id) => !!flor.hasFlorByPlayer?.[id] && !flor.burnedByPlayer?.[id]
  );
  if (!hasSingingFlor) return false;

  const hasResponderFlor = responderIds.some(
    (id) => !!flor.hasFlorByPlayer?.[id] && !flor.burnedByPlayer?.[id]
  );

  let winnerId = null;
  let reasonMessage = "";
  if (!hasResponderFlor) {
    winnerId = singingIds[0];
    reasonMessage = "gana la partida (flor, rival sin flor)";
  } else {
    const candidateIds = [...singingIds, ...responderIds].filter(
      (id) => !!flor.hasFlorByPlayer?.[id] && !flor.burnedByPlayer?.[id]
    );
    const scoreByPlayer = {};
    for (const id of candidateIds) {
      scoreByPlayer[id] = computeFlorValue(snapshot[id] || [], gameState.vira);
    }
    winnerId = resolveScoreWinnerByTeam(gameState, scoreByPlayer, candidateIds);
    reasonMessage = "gana la partida por flor mas alta";
  }

  if (!winnerId) return false;

  gameState.canto11 = { ...canto11, status: "resolved" };
  const winnerLabel = getWinnerLabel(gameState, winnerId);
  emitLockedMessage(roomId, gameState, `${winnerLabel} ${reasonMessage}`);
  gameState.matchEnded = true;
  gameState.matchWinnerId = winnerId;
  gameState.matchEndedAt = Date.now();
  gameState.rematch = buildRematchState(gameState);
  if (room) {
    room.status = "finished";
    emitRooms();
  }
  emitGameUpdate(roomId, gameState);
  return true;
}

function resolveCanto11Duel(roomId, room, gameState) {
  const canto11 = gameState?.canto11 || {};
  if (canto11.duelResolutionPending) return true;
  const flor = gameState?.flor || {};
  const snapshot = gameState?.roundHandsSnapshot || gameState?.hands || {};
  const declareOrder = Array.isArray(canto11.declareOrder) ? canto11.declareOrder : [];
  if (!declareOrder.length) return false;

  const florCandidateIds = declareOrder.filter(
    (id) => !!flor.hasFlorByPlayer?.[id] && !flor.burnedByPlayer?.[id]
  );

  let winnerId = null;
  let reason = "";
  let winningValue = 0;
  if (florCandidateIds.length > 0) {
    const scoreByPlayer = {};
    for (const id of florCandidateIds) {
      scoreByPlayer[id] = computeFlorValue(snapshot[id] || [], gameState.vira);
    }
    winnerId = resolveScoreWinnerByTeam(gameState, scoreByPlayer, florCandidateIds);
    winningValue = Number(scoreByPlayer[winnerId]) || 0;
    reason = "por flor";
  } else {
    const declared = canto11.declaredByPlayer || {};
    const scoreByPlayer = {};
    for (const id of declareOrder) {
      scoreByPlayer[id] = Number(declared[id]) || 0;
    }
    winnerId = resolveScoreWinnerByTeam(gameState, scoreByPlayer, declareOrder);
    winningValue = Number(scoreByPlayer[winnerId]) || 0;
    reason = "por envido";
  }

  if (!winnerId) return false;

  gameState.canto11 = {
    ...canto11,
    status: "duel_resolving",
    duelResolutionPending: true,
    duelWinnerId: winnerId,
    duelWinningValue: winningValue,
    duelReason: reason,
  };
  gameState.inputLockedUntil = Math.max(Number(gameState.inputLockedUntil || 0), Date.now() + 4000);
  emitGameUpdate(roomId, gameState);

  setTimeout(() => {
    const liveRoom = getRoom(roomId);
    if (!liveRoom || !liveRoom.gameState) return;
    const liveGame = liveRoom.gameState;
    const liveCanto11 = liveGame.canto11 || {};
    if (liveCanto11.status !== "duel_resolving" || !liveCanto11.duelResolutionPending) return;

    const finalWinnerId = liveCanto11.duelWinnerId;
    if (!finalWinnerId) return;

    const finalReason = liveCanto11.duelReason || "por envido";
    const finalWinningValue = Number(liveCanto11.duelWinningValue || 0);
    const winnerLabel = getWinnerLabel(liveGame, finalWinnerId);
    emitLockedMessage(
      roomId,
      liveGame,
      `${winnerLabel} gana cantando a cantando ${finalReason} con ${finalWinningValue} puntos`
    );

    addPoints(liveGame, finalWinnerId, 1);
    const total = getTotalPoints(liveGame, finalWinnerId);
    emitLockedMessage(roomId, liveGame, `${winnerLabel} suma 1 punto (total ${total})`);

    liveGame.canto11 = {
      ...liveCanto11,
      status: "resolved",
      duelResolutionPending: false,
    };

    const matchWinnerId = getMatchWinnerId(liveGame);
    if (matchWinnerId) {
      const championLabel = getWinnerLabel(liveGame, matchWinnerId);
      emitLockedMessage(roomId, liveGame, `${championLabel} gana la partida`);
      liveGame.matchEnded = true;
      liveGame.matchWinnerId = matchWinnerId;
      liveGame.matchEndedAt = Date.now();
      liveGame.rematch = buildRematchState(liveGame);
      liveRoom.status = "finished";
      emitRooms();
    }

    emitGameUpdate(roomId, liveGame);
  }, 4000);
  return true;
}

function activateCanto11IfNeeded(gameState) {
  if (!gameState || gameState.matchEnded) return false;
  if ((gameState.tableCards || []).length > 0) return false;
  if ((gameState.handNumber || 1) !== 1) return false;

  const teams = ["team1", "team2"];
  const t1 = getTeamScoreByKey(gameState, teams[0]);
  const t2 = getTeamScoreByKey(gameState, teams[1]);
  let singingTeamKey = null;
  let responderTeamKey = null;
  if (t1 === 11 && t2 !== 11) {
    singingTeamKey = "team1";
    responderTeamKey = "team2";
  } else if (t2 === 11 && t1 !== 11) {
    singingTeamKey = "team2";
    responderTeamKey = "team1";
  } else if (t1 === 11 && t2 === 11) {
    const declareOrder = getTurnOrder(
      gameState,
      gameState.roundStarter || gameState.turn || gameState.players?.[0]?.id
    );
    if (!declareOrder.length) return false;
    gameState.canto11 = {
      status: "duel_declaring",
      singingTeamKey: null,
      responderTeamKey: null,
      declareOrder,
      declareIndex: 0,
      declaredByPlayer: {},
      singingMaxEnvite: 0,
      responderMaxEnvite: 0,
      responderEligible: false,
      responderTurnId: null,
    };
    gameState.turn = declareOrder[0];
    return true;
  } else {
    gameState.canto11 = {
      status: "idle",
      singingTeamKey: null,
      responderTeamKey: null,
      declareOrder: [],
      declareIndex: 0,
      declaredByPlayer: {},
      singingMaxEnvite: 0,
      responderMaxEnvite: 0,
      responderEligible: false,
      responderTurnId: null,
    };
    return false;
  }

  const order = getTurnOrder(gameState, gameState.roundStarter || gameState.turn || gameState.players?.[0]?.id);
  const declareOrder = order.filter((id) => getPlayerTeamKey(gameState, id) === singingTeamKey);
  if (!declareOrder.length) return false;

  gameState.canto11 = {
    status: "declaring",
    singingTeamKey,
    responderTeamKey,
    declareOrder,
    declareIndex: 0,
    declaredByPlayer: {},
    singingMaxEnvite: 0,
    responderMaxEnvite: 0,
    responderEligible: false,
    responderTurnId: null,
  };
  gameState.turn = declareOrder[0];
  return true;
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

function burnFlorOnRespondWithoutConFlor(gameState, playerId) {
  if (!hasAvailableFlor(gameState, playerId)) return;
  if (gameState?.flor?.sungByPlayer?.[playerId]) return;
  markFlorBurned(gameState, playerId);
}

function burnFlorOnEnvidoResponse(gameState, playerId) {
  if (!gameState || !playerId) return;
  const teamIds = getTeamPlayerIds(gameState, playerId);
  for (const teammateId of teamIds) {
    if (!hasAvailableFlor(gameState, teammateId)) continue;
    if (gameState?.flor?.sungByPlayer?.[teammateId]) continue;
    markFlorBurned(gameState, teammateId);
  }
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
  socket.use((packet, next) => {
    if (!PERF_LOG_ENABLED) return next();
    const eventName = Array.isArray(packet) ? packet[0] : "unknown";
    const startedAt = Date.now();
    next();
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 20) {
      console.log(`[PERF] socket:${eventName} ${elapsed}ms room=${socket.data?.roomId || "-"}`);
    }
  });

  console.log("Jugador conectado:", socket.id);

  socket.emit("rooms:update", getPublicRooms());

  socket.on("rooms:list", () => {
    socket.emit("rooms:update", getPublicRooms());
  });

  socket.on("voice:join", ({ roomId } = {}) => {
    const targetRoomId = roomId || socket.data.roomId;
    if (!targetRoomId) return;
    if (socket.data.roomId !== targetRoomId) return;

    if (socket.data.voiceRoomId && socket.data.voiceRoomId !== targetRoomId) {
      removeFromVoiceRoom(socket, "switch-room", socket.data.voiceRoomId);
    }

    const participants = getVoiceParticipants(targetRoomId);
    if (!participants) return;
    const alreadyInVoice = participants.has(socket.id);
    participants.add(socket.id);
    socket.data.voiceRoomId = targetRoomId;

    const peerIds = [...participants].filter((id) => id !== socket.id);
    socket.emit("voice:peers", { roomId: targetRoomId, peerIds });

    if (!alreadyInVoice) {
      socket.to(targetRoomId).emit("voice:peer-joined", {
        roomId: targetRoomId,
        peerId: socket.id,
      });
    }
  });

  socket.on("voice:signal", ({ roomId, toId, description, candidate } = {}) => {
    const targetRoomId = roomId || socket.data.voiceRoomId || socket.data.roomId;
    if (!targetRoomId || !toId || toId === socket.id) return;
    const participants = voiceParticipantsByRoom.get(targetRoomId);
    if (!participants || !participants.has(socket.id) || !participants.has(toId)) return;
    const targetSocket = io.sockets.sockets.get(toId);
    if (!targetSocket) return;
    if (targetSocket.data?.roomId !== targetRoomId) return;
    targetSocket.emit("voice:signal", {
      roomId: targetRoomId,
      fromId: socket.id,
      description: description || null,
      candidate: candidate || null,
    });
  });

  socket.on("voice:leave", ({ roomId } = {}) => {
    const targetRoomId = roomId || socket.data.voiceRoomId;
    if (!targetRoomId) return;
    removeFromVoiceRoom(socket, "leave", targetRoomId);
  });

  socket.on("debug:bots", ({ enabled }) => {
    botsDebugEnabled = !!enabled;
    socket.emit("server:error", `Bots debug ${botsDebugEnabled ? "activado" : "desactivado"}`);
  });

  function tryCallRaise(roomId, callType) {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const truco = gameState.truco || {};
    const currentValue = gameState.roundPointValue || 1;
    const canRaiseInWindow =
      isTrucoRaiseWindowOpen(gameState) &&
      !!truco.raiseWindowById &&
      (truco.raiseWindowById === socket.id || isSameTeam(gameState, truco.raiseWindowById, socket.id));
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", "Resuelve primero el estado de Estoy Cantando");
      return;
    }
    if (gameState.roundEnding) {
      socket.emit("server:error", "Esperando nuevo reparto...");
      return;
    }
    if (isInputLocked(gameState) && !canRaiseInWindow) return;

    if (!canRaiseInWindow && gameState.turn !== socket.id) {
      socket.emit("server:error", `Solo puede cantar ${CALL_LABELS[callType]} el jugador en turno`);
      return;
    }

    if (truco.status === "pending") {
      socket.emit("server:error", "Ya hay un canto pendiente de respuesta");
      return;
    }
    if (gameState.envido?.status === "pending") {
      socket.emit("server:error", "Primero debe resolverse el Envido pendiente");
      return;
    }
    if (isFlorEnvidoPending(gameState)) {
      socket.emit("server:error", "Primero debe resolverse el Flor Envido pendiente");
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
        "server:error",
        `${CALL_LABELS[callType]} solo aplica cuando la ronda vale ${callConfig.requiredValue}`
      );
      return;
    }

    const acceptedByThisSide =
      !!truco.acceptedById &&
      (truco.acceptedById === socket.id || isSameTeam(gameState, truco.acceptedById, socket.id));
    if (callConfig.requiresAcceptedBy && !acceptedByThisSide) {
      socket.emit(
        "server:error",
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
      raiseWindowUntil: 0,
      raiseWindowById: null,
    };

    const caller = gameState.players.find((player) => player.id === socket.id);
    if (caller?.name) {
      emitLockedMessage(roomId, gameState, `${caller.name}: ${CALL_LABELS[callType]}`);
    }

    emitGameUpdate(roomId, gameState);
  }

  function canRespondForPendingByTeam(gameState, expectedResponderId, actorId) {
    return expectedResponderId === actorId || isSameTeam(gameState, expectedResponderId, actorId);
  }

  function applyPrimeroEnvidoAction(roomId, gameState, callerId, actorFallback = "Jugador") {
    const truco = gameState.truco || {};
    burnFlorOnRespondWithoutConFlor(gameState, callerId);

    gameState.truco = {
      status: "idle",
      callerId: null,
      responderId: null,
      callType: null,
      proposedValue: null,
      acceptedById: null,
      raiseWindowUntil: 0,
      raiseWindowById: null,
    };

    gameState.envido = {
      status: "pending",
      callerId,
      responderId: truco.callerId,
      callType: "envido",
      winnerId: null,
      points: 2,
      acceptedPoints: 1,
      envidoByPlayer: {},
      resolved: false,
      pendingSince: Date.now(),
    };

    const caller = gameState.players.find((p) => p.id === callerId);
    emitLockedMessage(
      roomId,
      gameState,
      `${caller?.name || actorFallback}: Primero Envido. Se pausa el Truco y se responde el Envido.`
    );
  }

  function applyEnvidoAcceptAction(roomId, gameState, responderId, actorFallback = "Jugador") {
    burnFlorOnEnvidoResponse(gameState, responderId);
    const envido = gameState.envido || {};
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
    const responder = gameState.players.find((p) => p.id === responderId);
    emitLockedMessage(roomId, gameState, `${responder?.name || actorFallback}: Quiero al Envido.`);
  }

  function applyEnvidoRejectAction(roomId, gameState, responderId, actorFallback = "Jugador", verbose = true) {
    burnFlorOnEnvidoResponse(gameState, responderId);
    const envido = gameState.envido || {};
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
    const responder = gameState.players.find((p) => p.id === responderId);
    const base = `${responder?.name || actorFallback}: No Quiero al Envido.`;
    emitLockedMessage(
      roomId,
      gameState,
      verbose
        ? `${base}`
        : base
    );
  }

  function applyEnvidoRaiseAction(roomId, gameState, responderId, kind, stones, actorFallback = "Jugador") {
    burnFlorOnEnvidoResponse(gameState, responderId);
    const envido = gameState.envido || {};
    if (envido.callType === "falta") {
      return { ok: false, error: "A Falta Envido solo se responde Quiero o No Quiero" };
    }

    const nextCallerId = responderId;
    const nextResponderId = getOpposingResponderId(gameState, nextCallerId) || envido.callerId;
    const safeKind = kind === "falta" ? "falta" : "envido";
    const currentPoints = envido.points || 2;
    let nextPoints = currentPoints + 2;
    if (safeKind === "falta") {
      nextPoints = computeFaltaEnvidoPoints(gameState);
    } else {
      const safeStones = Number.isFinite(Number(stones))
        ? Math.max(1, Math.min(12, Math.floor(Number(stones))))
        : null;
      if (safeStones !== null) {
        nextPoints = currentPoints + safeStones;
      }
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
        ? `${nextCaller?.name || actorFallback}: Falta Envido. Ahora vale ${nextPoints}.`
        : `${nextCaller?.name || actorFallback} envido ${nextPoints - currentPoints} piedra${
            nextPoints - currentPoints === 1 ? "" : "s"
          }. Ahora vale ${nextPoints}.`
    );
    return { ok: true };
  }

  function applyTrucoAcceptAction(roomId, gameState, responderId, actorFallback = "Jugador") {
    burnFlorOnRespondWithoutConFlor(gameState, responderId);
    const truco = gameState.truco || {};
    gameState.roundPointValue = truco.proposedValue || 3;
    gameState.truco = {
      status: "accepted",
      callerId: truco.callerId,
      responderId: truco.responderId,
      callType: truco.callType || "truco",
      proposedValue: truco.proposedValue,
      acceptedById: responderId,
      raiseWindowUntil: Date.now() + TRUCO_RAISE_WINDOW_MS,
      raiseWindowById: responderId,
    };
    const responder = gameState.players.find((player) => player.id === responderId);
    emitLockedMessage(
      roomId,
      gameState,
      `${responder?.name || actorFallback}: Quiero al ${CALL_LABELS[truco.callType || "truco"]}`
    );
  }

  function applyTrucoRejectAction(room, roomId, gameState, responderId, actorFallback = "Jugador") {
    burnFlorOnRespondWithoutConFlor(gameState, responderId);
    const truco = gameState.truco || {};
    const callerId = truco.callerId;
    if (!callerId) return;
    gameState.truco = {
      ...truco,
      lastResolution: "rejected",
    };
    const reservadaOwnerId = getFlorReservadaOwnerId(gameState);
    const trucoPointWinnerId = reservadaOwnerId || callerId;
    const responder = gameState.players.find((player) => player.id === responderId);
    emitLockedMessage(
      roomId,
      gameState,
      `${responder?.name || actorFallback}: No Quiero al ${CALL_LABELS[truco.callType || "truco"]}.`
    );
    resolveRound(room, trucoPointWinnerId, roomId);
  }

  function applyFlorEnvidoAcceptAction(roomId, gameState, responderId, actorFallback = "Jugador") {
    gameState.flor.florEnvidoStatus = "accepted";
    gameState.flor.florEnvidoCalled = true;
    gameState.flor.points = gameState.flor.florEnvidoPoints || 5;

    const responder = gameState.players.find((p) => p.id === responderId);
    emitLockedMessage(roomId, gameState, `${responder?.name || actorFallback}: Quiero al Flor Envido`);
    return { ok: true };
  }

  function applyFlorEnvidoRejectAction(roomId, gameState, responderId, actorFallback = "Jugador") {
    gameState.flor.florEnvidoStatus = "rejected";
    gameState.flor.florEnvidoCalled = true;
    gameState.flor.points = Math.max(3, gameState.flor.florEnvidoAcceptedPoints || 3);
    gameState.flor.winnerId = gameState.flor.florEnvidoCallerId || gameState.flor.winnerId;

    const responder = gameState.players.find((p) => p.id === responderId);
    emitLockedMessage(roomId, gameState, `${responder?.name || actorFallback}: No Quiero al Flor Envido`);
    return { ok: true };
  }

  function applyFlorEnvidoRaiseAction(roomId, gameState, responderId, actorFallback = "Jugador") {
    const flor = gameState.flor || {};
    const nextCaller = responderId;
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
      `${caller?.name || actorFallback}: Quiero y Envido al Flor Envido. Ahora vale ${nextPoints}`
    );
    return { ok: true };
  }

  function applyCanto11PrivoAction(roomId, gameState, actorId, actorFallback = "Jugador") {
    const canto11 = gameState.canto11 || {};
    gameState.canto11 = {
      ...canto11,
      status: "resolved",
      resolution: "privo_truco",
    };

    addPoints(gameState, actorId, 1);
    const privoWinnerLabel = getWinnerLabel(gameState, actorId);
    const privoTotal = getTotalPoints(gameState, actorId);
    emitLockedMessage(roomId, gameState, `${privoWinnerLabel} suma 1 punto de envite por Privo (total ${privoTotal})`);

    const responderId = getOpposingResponderId(gameState, actorId);
    const responder = gameState.players.find((p) => p.id === responderId);
    if (!responder) {
      return { ok: false, error: "No se encontro rival para responder el Truco" };
    }

    gameState.truco = {
      status: "pending",
      callerId: actorId,
      responderId: responder.id,
      callType: "truco",
      proposedValue: 3,
      acceptedById: null,
      raiseWindowUntil: 0,
      raiseWindowById: null,
    };

    const caller = gameState.players.find((p) => p.id === actorId);
    emitLockedMessage(roomId, gameState, `${caller?.name || actorFallback}: Privo y Truco`);
    return { ok: true };
  }

  function applyCanto11NoPrivoAction(room, roomId, gameState, actorId, actorFallback = "Jugador") {
    const canto11 = gameState.canto11 || {};
    const singingIds = getTeamIdsByKey(gameState, canto11.singingTeamKey);
    const winnerId = singingIds[0] || null;
    if (!winnerId) {
      return { ok: false, error: "No se pudo determinar equipo ganador de canto11" };
    }

    gameState.canto11 = {
      ...canto11,
      status: "resolved",
      resolution: "no_privo",
    };

    const me = gameState.players.find((p) => p.id === actorId);
    emitLockedMessage(roomId, gameState, `${me?.name || actorFallback}: No Privo`);

    addPoints(gameState, winnerId, 1);
    const winnerLabel = getWinnerLabel(gameState, winnerId);
    const total = getTotalPoints(gameState, winnerId);
    emitLockedMessage(roomId, gameState, `${winnerLabel} suma 1 punto por estar cantando (total ${total})`);

    const matchWinnerId = getMatchWinnerId(gameState);
    if (matchWinnerId) {
      const championLabel = getWinnerLabel(gameState, matchWinnerId);
      emitLockedMessage(roomId, gameState, `${championLabel} gana la partida`);
      gameState.matchEnded = true;
      gameState.matchWinnerId = matchWinnerId;
      gameState.matchEndedAt = Date.now();
      gameState.rematch = buildRematchState(gameState);
      room.status = "finished";
      emitRooms();
    }

    return { ok: true };
  }

  function scheduleRedeal(roomId, delayMs = 1800) {
    setTimeout(() => {
      const currentRoom = getRoom(roomId);
      if (!currentRoom || !currentRoom.gameState) return;
      if (!currentRoom.gameState.roundEnding) return;

      const starterId = getNextRoundStarterId(currentRoom.gameState);
      startGame.redealRound(currentRoom, starterId);
      activateCanto11IfNeeded(currentRoom.gameState);
      emitGameUpdate(roomId, currentRoom.gameState);
    }, delayMs);
  }

  function emitMessageSequence(roomId, messages, stepMs = 2400) {
    clearRoomMessageTimers(roomId);
    const timers = [];
    messages.forEach((message, index) => {
      const timer = setTimeout(() => {
        const liveRoom = getRoom(roomId);
        const liveState = liveRoom?.gameState;
        if (!liveState) return;
        emitLockedMessage(roomId, liveState, message);
        emitGameUpdate(roomId, liveState);
      }, index * stepMs);
      timers.push(timer);
    });
    roomMessageTimers.set(roomId, timers);
    return messages.length * stepMs;
  }

  function resolveMazoForPlayer(room, roomId, playerId) {
    const gameState = room?.gameState;
    if (!gameState || !playerId) return false;
    const opponentId = getOpposingResponderId(gameState, playerId);
    if (!opponentId) return false;

    const me = gameState.players.find((p) => p.id === playerId);
    const opponentLabel = getWinnerLabel(gameState, opponentId);
    const trucoPointsInPlay = Math.max(
      1,
      Number(
        gameState.truco?.status === "pending"
          ? gameState.truco?.proposedValue || gameState.roundPointValue || 1
          : gameState.roundPointValue || 1
      ) || 1
    );

    const isLastToPlay = isCurrentTurnLastToPlay(gameState, playerId);
    const envidoWasNeverCalled = (gameState.envido?.status || "idle") === "idle";
    const florWasSung = isFlorAlreadySung(gameState);
    const concedeExtraEnvido =
      !isLastToPlay &&
      envidoWasNeverCalled &&
      !florWasSung &&
      !hasOpposingTeamCalledEnvido(gameState, playerId);
    const envidoBonus = concedeExtraEnvido ? 1 : 0;

    const messageQueue = [];
    messageQueue.push(`${me?.name || "Jugador"}: al mazo`);

    const resolveEnvidoOnMazo = () => {
      const envido = gameState.envido || {};
      if (envido.resolved) return;
      if (envido.status !== "accepted" && envido.status !== "rejected") return;

      let envidoWinnerId = envido.winnerId || null;
      let envidoPoints = Number(envido.points || 0);

      if (envido.status === "accepted") {
        const snapshot = gameState.roundHandsSnapshot || gameState.hands || {};
        const envidoByPlayer = {};
        const playerIds = (gameState.players || []).map((p) => p.id);
        for (const eachPlayerId of playerIds) {
          envidoByPlayer[eachPlayerId] = computeEnvido(snapshot[eachPlayerId] || [], gameState.vira);
        }
        envidoWinnerId =
          envidoWinnerId || resolveScoreWinnerByTeam(gameState, envidoByPlayer, playerIds);
        envidoPoints = Math.max(1, envidoPoints || Number(envido.acceptedPoints || 0));
        gameState.envido = {
          ...envido,
          winnerId: envidoWinnerId,
          points: envidoPoints,
          acceptedPoints: Math.max(1, Number(envido.acceptedPoints || envidoPoints || 1)),
          envidoByPlayer,
          resolved: false,
        };
      } else {
        envidoWinnerId = envidoWinnerId || envido.callerId || null;
        envidoPoints = Math.max(1, envidoPoints || Number(envido.acceptedPoints || 1));
        gameState.envido = {
          ...envido,
          winnerId: envidoWinnerId,
          points: envidoPoints,
          acceptedPoints: Math.max(1, Number(envido.acceptedPoints || envidoPoints || 1)),
          resolved: false,
        };
      }

      if (envidoWinnerId && envidoPoints > 0) {
        addPoints(gameState, envidoWinnerId, envidoPoints);
        const envidoWinnerLabel = getWinnerLabel(gameState, envidoWinnerId);
        const envidoTotal = getTotalPoints(gameState, envidoWinnerId);
        messageQueue.push(`${envidoWinnerLabel} gana el envido`);
        messageQueue.push(
          `${envidoWinnerLabel} suma ${envidoPoints} punto${envidoPoints > 1 ? "s" : ""} de Envido (total ${envidoTotal})`
        );
      }

      gameState.envido = { ...(gameState.envido || envido), resolved: true };
    };

    const reservadaOwnerId = getFlorReservadaOwnerId(gameState);
    const opposingReservadaOwnerId =
      reservadaOwnerId && !isSameTeam(gameState, playerId, reservadaOwnerId)
        ? reservadaOwnerId
        : null;

    if (opposingReservadaOwnerId) {
      const reservadaWinnerLabel = getWinnerLabel(gameState, opposingReservadaOwnerId);
      const reservadaPoints = 5;
      addPoints(gameState, opposingReservadaOwnerId, reservadaPoints);
      const totalAfterReservada = getTotalPoints(gameState, opposingReservadaOwnerId);
      messageQueue.push(
        `${reservadaWinnerLabel} suma ${reservadaPoints} puntos de Flor Reservada (total ${totalAfterReservada})`
      );

      const teammateHasFlor = getTeamPlayerIds(gameState, opposingReservadaOwnerId).some(
        (eachPlayerId) =>
          eachPlayerId !== opposingReservadaOwnerId &&
          !!gameState.flor?.hasFlorByPlayer?.[eachPlayerId] &&
          !gameState.flor?.burnedByPlayer?.[eachPlayerId]
      );
      if (teammateHasFlor) {
        const teammateFlorPoints = 3;
        addPoints(gameState, opposingReservadaOwnerId, teammateFlorPoints);
        const totalAfterTeammateFlor = getTotalPoints(gameState, opposingReservadaOwnerId);
        messageQueue.push(
          `${reservadaWinnerLabel} suma ${teammateFlorPoints} puntos por la Flor del companero (total ${totalAfterTeammateFlor})`
        );
      }

      resolveEnvidoOnMazo();
      gameState.flor = {
        ...(gameState.flor || {}),
        resolved: true,
        winnerId: opposingReservadaOwnerId,
      };
    } else {
      const florState = gameState.flor || {};
      let florResolvedByContest = false;

      if (didAllTeamsSingFlor(gameState)) {
        const contestedFlorWinnerId = florState.winnerId || resolveFlorWinnerId(gameState) || null;
        const contestedFlorPoints = Math.max(3, Number(florState.points || 3));
        if (contestedFlorWinnerId && !florState.burnedByPlayer?.[contestedFlorWinnerId]) {
          addPoints(gameState, contestedFlorWinnerId, contestedFlorPoints);
          const florWinnerLabel = getWinnerLabel(gameState, contestedFlorWinnerId);
          const totalAfterFlorContest = getTotalPoints(gameState, contestedFlorWinnerId);
          messageQueue.push(`${florWinnerLabel} gana la flor`);
          messageQueue.push(
            `${florWinnerLabel} suma ${contestedFlorPoints} punto${contestedFlorPoints > 1 ? "s" : ""} de Flor (total ${totalAfterFlorContest})`
          );
        }
        gameState.flor = {
          ...florState,
          resolved: true,
          winnerId: contestedFlorWinnerId,
          points: contestedFlorPoints,
        };
        florResolvedByContest = true;
      }

      if (!florResolvedByContest) {
      const myTeamIds = getTeamPlayerIds(gameState, playerId);
      const opposingTeamIds = (gameState.players || [])
        .map((p) => p.id)
        .filter((eachPlayerId) => !isSameTeam(gameState, playerId, eachPlayerId));
      const opposingHasAnyFlor = opposingTeamIds.some(
        (eachPlayerId) => !!florState.hasFlorByPlayer?.[eachPlayerId] && !florState.burnedByPlayer?.[eachPlayerId]
      );
      const myTeamSungFlorIds = myTeamIds.filter(
        (eachPlayerId) =>
          !!florState.sungByPlayer?.[eachPlayerId] &&
          !!florState.hasFlorByPlayer?.[eachPlayerId] &&
          !florState.burnedByPlayer?.[eachPlayerId]
      );
      const myFlorPoints = !opposingHasAnyFlor ? myTeamSungFlorIds.length * 3 : 0;
      if (myFlorPoints > 0) {
        addPoints(gameState, playerId, myFlorPoints);
        const myLabel = getWinnerLabel(gameState, playerId);
        const totalAfterOwnFlor = getTotalPoints(gameState, playerId);
        messageQueue.push(
          `${myLabel} suma ${myFlorPoints} punto${myFlorPoints > 1 ? "s" : ""} de Flor (total ${totalAfterOwnFlor})`
        );
      }

      const opposingFlorIds = (gameState.players || [])
        .map((p) => p.id)
        .filter(
          (eachPlayerId) =>
            !isSameTeam(gameState, playerId, eachPlayerId) &&
            !!gameState.flor?.hasFlorByPlayer?.[eachPlayerId] &&
            !gameState.flor?.burnedByPlayer?.[eachPlayerId]
        );
      const florPointsByMazo =
        opposingFlorIds.length >= 2 ? 6 : opposingFlorIds.length === 1 ? 3 : 0;
      if (florPointsByMazo > 0) {
        addPoints(gameState, opponentId, florPointsByMazo);
        const totalAfterFlor = getTotalPoints(gameState, opponentId);
        messageQueue.push(
          `${opponentLabel} suma ${florPointsByMazo} punto${florPointsByMazo > 1 ? "s" : ""} de Flor por irse al mazo (total ${totalAfterFlor})`
        );
      }

      resolveEnvidoOnMazo();

      addPoints(gameState, opponentId, trucoPointsInPlay);
      const totalAfterTruco = getTotalPoints(gameState, opponentId);
      messageQueue.push(
        `${opponentLabel} suma ${trucoPointsInPlay} punto${trucoPointsInPlay > 1 ? "s" : ""} de Truco (total ${totalAfterTruco})`
      );

      if (envidoBonus > 0) {
        addPoints(gameState, opponentId, envidoBonus);
        const totalAfterEnvido = getTotalPoints(gameState, opponentId);
        messageQueue.push(
          `${opponentLabel} suma ${envidoBonus} punto de Envido por irse al mazo (total ${totalAfterEnvido})`
        );
      }

      gameState.envido = { ...(gameState.envido || {}), resolved: true };
      gameState.flor = {
        ...(gameState.flor || {}),
        resolved: true,
        winnerId: myFlorPoints > 0 ? playerId : gameState.flor?.winnerId || null,
      };
      } else {
        gameState.envido = { ...(gameState.envido || {}), resolved: true };
      }
    }

    const matchWinnerId = getMatchWinnerId(gameState);
    if (matchWinnerId) {
      const championLabel = getWinnerLabel(gameState, matchWinnerId);
      messageQueue.push(`${championLabel} gana la partida`);
      gameState.matchEnded = true;
      gameState.matchWinnerId = matchWinnerId;
      gameState.matchEndedAt = Date.now();
      gameState.rematch = buildRematchState(gameState);
      room.status = "finished";
      emitRooms();
    }

    gameState.roundEnding = true;
    emitGameUpdate(roomId, gameState);
    const sequenceDuration = emitMessageSequence(roomId, messageQueue);
    if (!matchWinnerId) {
      scheduleRedeal(roomId, Math.max(1800, sequenceDuration + 400));
    } else {
      scheduleBotRematchVotes(room, roomId);
    }
    return true;
  }

  function maybeResolvePendingMazo(room, roomId) {
    const gameState = room?.gameState;
    const pending = gameState?.pendingMazo;
    if (!gameState || !pending?.callerId) return false;
    if (gameState.roundEnding) return false;
    if (gameState.truco?.status === "pending" || gameState.envido?.status === "pending" || isFlorEnvidoPending(gameState)) {
      return false;
    }

    const remainingOppFlorIds = (pending.awaitingOppFlorIds || []).filter(
      (playerId) =>
        !!gameState.flor?.hasFlorByPlayer?.[playerId] &&
        !gameState.flor?.burnedByPlayer?.[playerId] &&
        !gameState.flor?.sungByPlayer?.[playerId]
    );
    gameState.pendingMazo.awaitingOppFlorIds = remainingOppFlorIds;

    if (remainingOppFlorIds.length > 0) {
      gameState.turn = remainingOppFlorIds[0];
      emitGameUpdate(roomId, gameState);
      return false;
    }

    if (gameState.flor?.florEnvidoWindowOpen && !gameState.flor?.florEnvidoCalled) {
      return false;
    }

    const callerId = pending.callerId;
    gameState.pendingMazo = null;
    return resolveMazoForPlayer(room, roomId, callerId);
  }

  function finalizeRematchIfReady(room, roomId) {
    const gameState = room?.gameState;
    if (!gameState?.matchEnded || !gameState?.rematch || gameState.rematch.resolved) return false;

    const seatedIds = (gameState.players || []).map((p) => p.id);
    const decisions = Object.values(gameState.rematch.decisionsByPlayer || {});
    const everyoneAnswered = decisions.length > 0 && decisions.every((v) => v === "replay" || v === "exit");
    if (!everyoneAnswered) return false;

    const everyoneReplay = decisions.every((v) => v === "replay");
    if (everyoneReplay) {
      gameState.rematch = {
        ...gameState.rematch,
        status: "accepted",
        resolved: true,
        result: "replay",
      };
      clearRoomMessageTimers(roomId);
      clearLockedMessage(gameState);
      clearRoomBotRematchVoteTimers(roomId);
      const starterId = getNextRoundStarterId(gameState) || gameState.roundStarter || seatedIds[0];
      startGame.redealRound(room, starterId);

      // Nueva partida: reiniciar marcador global a 0 (1v1 y 2v2).
      if (room.gameState) {
        room.gameState.pointsByPlayer = room.gameState.pointsByPlayer || {};
        for (const playerId of seatedIds) {
          room.gameState.pointsByPlayer[playerId] = 0;
        }
        room.gameState.score = { team1: 0, team2: 0 };
        activateCanto11IfNeeded(room.gameState);
      }

      room.status = room.players.length === room.maxPlayers ? "full" : "waiting";
      emitLockedMessage(roomId, room.gameState, "Todos confirmaron: comienza una nueva partida");
      emitGameUpdate(roomId, room.gameState);
      emitRooms();
      return true;
    }

    gameState.rematch = {
      ...gameState.rematch,
      status: "declined",
      resolved: true,
      result: "exit",
    };
    clearRoomMessageTimers(roomId);
    clearLockedMessage(gameState);
    clearRoomBotRematchVoteTimers(roomId);
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
    return true;
  }

  function scheduleBotRematchVotes(room, roomId) {
    if (!room?.allowBots || !room?.gameState) return;
    const gameState = room.gameState;
    if (!gameState.matchEnded || !gameState.rematch || gameState.rematch.resolved) return;

    const botIds = (gameState.players || [])
      .map((p) => p.id)
      .filter((id) => isBotPlayerId(id));

    for (const botId of botIds) {
      const alreadyDecided = gameState.rematch?.decisionsByPlayer?.[botId];
      if (alreadyDecided === "replay" || alreadyDecided === "exit") continue;

      const timerKey = getBotRematchVoteKey(roomId, botId);
      if (botRematchVoteTimers.has(timerKey)) continue;

      const delayMs = 1800 + Math.floor(Math.random() * 2600);
      const timer = setTimeout(() => {
        botRematchVoteTimers.delete(timerKey);
        const liveRoom = getRoom(roomId);
        if (!liveRoom?.gameState) return;
        const liveState = liveRoom.gameState;
        if (!liveState.matchEnded || !liveState.rematch || liveState.rematch.resolved) return;

        const stillSeated = (liveState.players || []).some((p) => p.id === botId);
        if (!stillSeated) return;

        const currentDecision = liveState.rematch?.decisionsByPlayer?.[botId];
        if (currentDecision === "replay" || currentDecision === "exit") return;

        // Bot de testing vota replay por defecto para acelerar pruebas.
        liveState.rematch.decisionsByPlayer[botId] = "replay";
        emitGameUpdate(roomId, liveState);
        finalizeRematchIfReady(liveRoom, roomId);
      }, delayMs);

      botRematchVoteTimers.set(timerKey, timer);
    }
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
      const florPointsPerWinner = Math.max(3, flor.points || 3);
      const validFlorPlayerIds = (gameState.players || [])
        .map((p) => p.id)
        .filter(
          (playerId) =>
            !!flor.hasFlorByPlayer?.[playerId] &&
            !flor.burnedByPlayer?.[playerId] &&
            (!!flor.sungByPlayer?.[playerId] || !!flor.reservadaByPlayer?.[playerId])
        );

      if (!reservadaOwnerId && gameState.mode === "2vs2" && validFlorPlayerIds.length > 0) {
        const teamsWithFlor = new Map();
        for (const playerId of validFlorPlayerIds) {
          const teamKey = getPlayerTeamKey(gameState, playerId);
          if (teamKey === null || typeof teamKey === "undefined") continue;
          if (!teamsWithFlor.has(teamKey)) teamsWithFlor.set(teamKey, []);
          teamsWithFlor.get(teamKey).push(playerId);
        }

        // Regla solicitada:
        // - Si solo una pareja tiene flor y son ambos jugadores, cobran ambas flores.
        // - Si la pareja contraria tiene una o mas flores, solo se cobra la flor mas alta.
        if (teamsWithFlor.size === 1) {
          const [, sameTeamFlorIds] = [...teamsWithFlor.entries()][0] || [];
          if (Array.isArray(sameTeamFlorIds) && sameTeamFlorIds.length >= 2) {
            const teamLabel = getWinnerLabel(gameState, sameTeamFlorIds[0]);
            messageQueue.push(`${teamLabel} cobra ambas flores`);

            let teamWinnerId = sameTeamFlorIds[0];
            let bestScore = -1;
            for (const playerId of sameTeamFlorIds) {
              const score = computeFlorValue(gameState.roundHandsSnapshot?.[playerId] || [], gameState.vira);
              if (score > bestScore) {
                bestScore = score;
                teamWinnerId = playerId;
              }

              addPoints(gameState, playerId, florPointsPerWinner);
              const playerLabel = getWinnerLabel(gameState, playerId, "Jugador");
              const florTotal = getTotalPoints(gameState, playerId);
              messageQueue.push(
                `${playerLabel} suma ${florPointsPerWinner} punto${florPointsPerWinner > 1 ? "s" : ""} de Flor (total ${florTotal})`
              );
            }

            gameState.flor = {
              ...flor,
              resolved: true,
              winnerId: teamWinnerId,
              points: florPointsPerWinner * sameTeamFlorIds.length,
            };
          } else {
            const florWinnerId = flor.winnerId || resolveFlorWinnerId(gameState) || sameTeamFlorIds?.[0] || null;
            if (florWinnerId) {
              addPoints(gameState, florWinnerId, florPointsPerWinner);
              const florTotal = getTotalPoints(gameState, florWinnerId);
              const florWinnerLabel = getWinnerLabel(gameState, florWinnerId);
              messageQueue.push(`${florWinnerLabel} gana la flor`);
              messageQueue.push(
                `${florWinnerLabel} suma ${florPointsPerWinner} punto${florPointsPerWinner > 1 ? "s" : ""} de Flor (total ${florTotal})`
              );
              gameState.flor = { ...flor, resolved: true, winnerId: florWinnerId, points: florPointsPerWinner };
            } else {
              gameState.flor = { ...flor, resolved: true, winnerId: null, points: 0 };
            }
          }
        } else {
          const florWinnerId = flor.winnerId || resolveFlorWinnerId(gameState) || null;
          const validFlorWinner =
            !!florWinnerId &&
            !flor.burnedByPlayer?.[florWinnerId] &&
            validFlorPlayerIds.includes(florWinnerId);
          if (validFlorWinner) {
            addPoints(gameState, florWinnerId, florPointsPerWinner);
            const florTotal = getTotalPoints(gameState, florWinnerId);
            const florWinnerLabel = getWinnerLabel(gameState, florWinnerId);
            messageQueue.push(`${florWinnerLabel} gana la flor`);
            messageQueue.push(
              `${florWinnerLabel} suma ${florPointsPerWinner} punto${florPointsPerWinner > 1 ? "s" : ""} de Flor (total ${florTotal})`
            );
            gameState.flor = { ...flor, resolved: true, winnerId: florWinnerId, points: florPointsPerWinner };
          } else {
            gameState.flor = { ...flor, resolved: true, winnerId: null, points: 0 };
          }
        }
      } else {
        const florWinnerId = reservadaOwnerId || flor.winnerId || null;
        const validFlorWinner =
          !!florWinnerId && !(florWinnerBurned && florWinnerId === flor.winnerId);

        if (validFlorWinner) {
          addPoints(gameState, florWinnerId, florPointsPerWinner);
          const florTotal = getTotalPoints(gameState, florWinnerId);
          const florWinnerLabel = getWinnerLabel(gameState, florWinnerId);
          messageQueue.push(`${florWinnerLabel} gana la flor`);
          messageQueue.push(
            `${florWinnerLabel} suma ${florPointsPerWinner} punto${florPointsPerWinner > 1 ? "s" : ""} de Flor (total ${florTotal})`
          );
          gameState.flor = { ...flor, resolved: true, winnerId: florWinnerId, points: florPointsPerWinner };
        } else {
          gameState.flor = { ...flor, resolved: true, winnerId: null, points: 0 };
        }
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
      gameState.matchEndedAt = Date.now();
      gameState.rematch = buildRematchState(gameState);
      room.status = "finished";
      emitRooms();
    }

    gameState.roundEnding = true;
    emitGameUpdate(roomId, gameState);
    const sequenceDuration = emitMessageSequence(roomId, messageQueue);
    if (!matchWinnerId) {
      scheduleRedeal(roomId, Math.max(1800, sequenceDuration + 400));
    } else {
      scheduleBotRematchVotes(room, roomId);
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

    const topWinnerId = resolveWinnerFromRankEntries(gameState, topWinners);
    if (topWinnerId) {
      emitLockedMessage(roomId, gameState, "Se revelaron cartas: decide la carta de arriba");
      resolveRound(room, topWinnerId, roomId);
      return true;
    }

    const revealOrder = getTurnOrder(
      gameState,
      gameState.currentHandStarter || gameState.roundStarter || playerIds[0]
    );
    gameState.pardaPhase = "reveal";
    gameState.pardaRevealOrder = revealOrder;
    gameState.pardaRevealIndex = 0;
    gameState.pardaRevealedByPlayer = {};
    gameState.pardaTopWinnerId = topWinnerId || null;
    gameState.turn = revealOrder[0] || playerIds[0];
    emitLockedMessage(roomId, gameState, "Cartas de arriba pardas: descubran la carta de abajo");
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
        name: BOT_NAMES[(n - 1) % BOT_NAMES.length],
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
    const forceFaceDown =
      !!gameState.forcedFaceDownByPlayer?.[botId] &&
      Number(gameState.handNumber || 1) >= 2;
    const cardToPlay = forceFaceDown
      ? {
          ...playedCard,
          rank: 0,
        }
      : playedCard;
    const playedCardWithPlayer = { ...cardToPlay, playerId: botId };

    gameState.tableCards.push(playedCardWithPlayer);
    gameState.currentHandCards.push(playedCardWithPlayer);

    const playerIds = gameState.players.map((player) => player.id);
    if (gameState.currentHandCards.length < playerIds.length) {
      gameState.turn = getNextPlayerId(gameState, botId);
      emitGameUpdate(roomId, gameState);
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
      emitGameUpdate(roomId, gameState);
      return true;
    }

    if (!gameState.firstHandTie && !winnerId && currentHandNumber >= 2) {
      const firstHandWinnerId = gameState.handResults?.[0] || gameState.roundStarter || handStarterId;
      resolveRound(room, firstHandWinnerId, roomId);
      emitGameUpdate(roomId, room.gameState);
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
        emitGameUpdate(roomId, room.gameState);
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
      emitGameUpdate(roomId, room.gameState);
      return true;
    }

    gameState.handNumber += 1;
    emitGameUpdate(roomId, gameState);
    return true;
  }

  function getRankedHandInfo(hand, vira) {
    return hand
      .map((card, index) => ({
        index,
        rank: resolveHandRank(card, vira),
        card,
      }))
      .sort((a, b) => a.rank - b.rank);
  }

  function getCurrentHandOrder(gameState) {
    const starter = gameState.currentHandStarter || gameState.roundStarter || gameState.players?.[0]?.id;
    return getTurnOrder(gameState, starter);
  }

  function getRemainingOpponentsInThisHand(gameState, botId) {
    const order = getCurrentHandOrder(gameState);
    const myIdx = order.indexOf(botId);
    if (myIdx < 0) return [];
    return order.slice(myIdx + 1).filter((id) => !isSameTeam(gameState, id, botId));
  }

  function getBotRoundContext(gameState, botId) {
    const myTeamWins = getTeamHandWins(gameState, botId);
    const enemyTeamWins = (gameState.handResults || []).filter(
      (winnerId) => winnerId && !isSameTeam(gameState, botId, winnerId)
    ).length;
    const handNumber = gameState.handNumber || 1;
    const roundPointValue = Number(gameState.roundPointValue || 1);
    return {
      myTeamWins,
      enemyTeamWins,
      handNumber,
      roundPointValue,
      mustWinNow: enemyTeamWins >= 1 && myTeamWins === 0,
      ahead: myTeamWins > enemyTeamWins,
      behind: enemyTeamWins > myTeamWins,
    };
  }

  function estimateBotTrucoStrength(gameState, botId, hand = []) {
    const ranked = getRankedHandInfo(hand, gameState.vira);
    if (!ranked.length) return 0;
    const highest = ranked[ranked.length - 1]?.rank || 0;
    const secondHighest = ranked[ranked.length - 2]?.rank || 0;
    const average = ranked.reduce((sum, item) => sum + item.rank, 0) / ranked.length;
    const round = getBotRoundContext(gameState, botId);
    let score = highest * 0.55 + secondHighest * 0.25 + average * 0.2;
    if (round.mustWinNow) score += 2.5;
    if (round.ahead) score -= 0.8;
    return score;
  }

function getBotEnvidoAcceptThreshold(pointsInDispute) {
  if (pointsInDispute <= 2) return 23;
  if (pointsInDispute <= 4) return 27;
  if (pointsInDispute <= 6) return 30;
  if (pointsInDispute <= 9) return 32;
  return 34;
}

function getBotMatchContext(gameState, botId) {
  const myTeamKey = getPlayerTeamKey(gameState, botId);
  const oppTeamKey = myTeamKey === "team1" ? "team2" : "team1";
  const myPoints = getTeamScoreByKey(gameState, myTeamKey);
  const oppPoints = getTeamScoreByKey(gameState, oppTeamKey);
  return {
    myPoints,
    oppPoints,
    lead: myPoints - oppPoints,
    behind: myPoints < oppPoints,
    ahead: myPoints > oppPoints,
    nearFinish: myPoints >= GAME_TARGET - 2 || oppPoints >= GAME_TARGET - 2,
  };
}

function shouldBotRaiseEnvido(gameState, botId, myEnvido, envido) {
  if (!envido || envido.status !== "pending") return false;
  if (envido.callType === "falta") return false;
  if (isFlorAlreadySung(gameState) || isFlorEnvidoPending(gameState)) return false;
  if (gameState.handNumber !== 1) return false;
  if (myEnvido < 31) return false;

  const points = Number(envido.points || 2);
  const maxRaise = points < 10 ? 0.45 : 0.2;
  const round = getBotRoundContext(gameState, botId);
  const match = getBotMatchContext(gameState, botId);
  const extraAggro = round.behind ? 0.15 : 0;
  const matchAggro = match.behind ? 0.08 : 0;
  return Math.random() < maxRaise + extraAggro + matchAggro;
}

  function shouldBotCallPrimeroEnvido(gameState, botId, truco) {
    if (!gameState || !truco) return false;
    if ((gameState.envido?.status || "idle") !== "idle") return false;
    if (isFlorAlreadySung(gameState)) return false;
    if (hasAvailableFlor(gameState, botId)) return false;

    const playerIds = gameState.players.map((p) => p.id);
    const isInFirstHand =
      Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
      (gameState.tableCards?.length || 0) < playerIds.length;
    if (!isInFirstHand) return false;

    const snapshot = gameState.roundHandsSnapshot || gameState.hands || {};
    const myEnvido = computeEnvido(snapshot[botId] || [], gameState.vira);
    if (myEnvido < 27) return false;

    const proposed = Number(truco.proposedValue || 3);
    const round = getBotRoundContext(gameState, botId);
    let chance = myEnvido >= 33 ? 0.75 : myEnvido >= 30 ? 0.55 : 0.35;
    if (proposed >= 6) chance += 0.12;
    if (round.behind) chance += 0.08;
    return Math.random() < Math.min(0.9, chance);
  }

  function getBotBluffChance(gameState, botId, kind = "generic") {
    const round = getBotRoundContext(gameState, botId);
    let base = 0.05;
    if (round.behind) base += 0.03;
    if ((round.handNumber || 1) === 1) base += 0.02;
    if (kind === "call-truco" || kind === "accept-truco") base += 0.02;
    if (kind === "call-envido" || kind === "accept-envido") base += 0.01;
    return Math.min(0.16, Math.max(0, base));
  }

function botWillBluff(gameState, botId, kind = "generic") {
  return Math.random() < getBotBluffChance(gameState, botId, kind);
}

function getNextTrucoCallTypeByValue(roundPointValue) {
  const value = Number(roundPointValue || 1);
  if (value === 3) return "retruco";
  if (value === 6) return "vale9";
  if (value === 9) return "valejuego";
  return null;
}

function applyBotTrucoRaiseFromWindow(roomId, gameState, botId, callType, actorFallback = "Bot") {
  const truco = gameState.truco || {};
  const canRaiseInWindow =
    isTrucoRaiseWindowOpen(gameState) &&
    !!truco.raiseWindowById &&
    (truco.raiseWindowById === botId || isSameTeam(gameState, truco.raiseWindowById, botId));
  if (!canRaiseInWindow) return false;
  if (truco.status === "pending") return false;
  if (gameState.envido?.status === "pending" || isFlorEnvidoPending(gameState)) return false;

  const callConfig = {
    retruco: { requiredValue: 3, proposedValue: 6 },
    vale9: { requiredValue: 6, proposedValue: 9 },
    valejuego: { requiredValue: 9, proposedValue: 12 },
  }[callType];
  if (!callConfig) return false;

  if (Number(gameState.roundPointValue || 1) !== callConfig.requiredValue) return false;

  const acceptedByThisSide =
    !!truco.acceptedById &&
    (truco.acceptedById === botId || isSameTeam(gameState, truco.acceptedById, botId));
  if (!acceptedByThisSide) return false;

  const responderId = getOpposingResponderId(gameState, botId);
  const responder = gameState.players.find((player) => player.id === responderId);
  if (!responder) return false;

  gameState.truco = {
    status: "pending",
    callerId: botId,
    responderId: responder.id,
    callType,
    proposedValue: callConfig.proposedValue,
    acceptedById: truco.acceptedById || null,
    raiseWindowUntil: 0,
    raiseWindowById: null,
  };

  const caller = gameState.players.find((player) => player.id === botId);
  if (caller?.name) {
    emitLockedMessage(roomId, gameState, `${caller.name}: ${CALL_LABELS[callType] || actorFallback}`);
  }
  return true;
}

function shouldBotRaiseTrucoFromWindow(gameState, botId, hand = []) {
  const nextCallType = getNextTrucoCallTypeByValue(gameState.roundPointValue);
  if (!nextCallType) return { raise: false, callType: null };

  const strength = estimateBotTrucoStrength(gameState, botId, hand);
  const round = getBotRoundContext(gameState, botId);
  const match = getBotMatchContext(gameState, botId);
  const thresholdByCall = {
    retruco: 11.0,
    vale9: 12.8,
    valejuego: 14.0,
  };
  const baseThreshold = thresholdByCall[nextCallType] || 99;
  const adjustment = (round.behind ? -0.6 : 0) + (match.behind ? -0.4 : 0) + (match.ahead ? 0.3 : 0);
  const threshold = baseThreshold + adjustment;
  const likelyRaise = strength >= threshold;
  const bluffRaise =
    !likelyRaise &&
    strength >= threshold - 1.2 &&
    botWillBluff(gameState, botId, "raise-truco");

  return {
    raise: likelyRaise || bluffRaise,
    callType: nextCallType,
    strength,
  };
}

function shouldBotAcceptFlorEnvido(gameState, botId) {
  const flor = gameState?.flor || {};
  const pointsInDispute = Number(flor.florEnvidoPoints || flor.points || 5);
  const snapshot = gameState.roundHandsSnapshot || gameState.hands || {};
  const myFlor = computeFlorValue(snapshot[botId] || [], gameState.vira);
  const round = getBotRoundContext(gameState, botId);
  const match = getBotMatchContext(gameState, botId);

  let threshold = 29;
  if (pointsInDispute >= 7) threshold += 2;
  if (pointsInDispute >= 9) threshold += 1;
  if (round.behind) threshold -= 1;
  if (match.behind) threshold -= 1;
  if (match.ahead && pointsInDispute >= 7) threshold += 1;
  threshold = Math.max(26, Math.min(34, threshold));

  let wantsAccept = myFlor >= threshold;
  if (!wantsAccept && myFlor >= threshold - 2 && botWillBluff(gameState, botId, "accept-flor-envido")) {
    wantsAccept = true;
  }
  return { wantsAccept, myFlor, threshold, pointsInDispute };
}

function chooseBotCardIndex(gameState, botId, hand) {
  const ranked = getRankedHandInfo(hand, gameState.vira);
  const lowest = ranked[0]?.index ?? 0;
  const highest = ranked[ranked.length - 1]?.index ?? 0;
  const medium = ranked[Math.floor(ranked.length / 2)]?.index ?? lowest;
  const passedCard = ranked.find((item) => item.rank === 0)?.index;

  const winning = getCurrentWinningInfo(gameState);
  const round = getBotRoundContext(gameState, botId);

  if ((gameState.currentHandCards || []).length) {
    const remainingOpponents = getRemainingOpponentsInThisHand(gameState, botId);
    const hasOpponentsAfterMe = remainingOpponents.length > 0;
    const teamAlreadyWinning = !!winning.winnerId && isSameTeam(gameState, botId, winning.winnerId);
    const beaterCards = ranked.filter((item) => item.rank > winning.bestRank);
    const lowestBeater = beaterCards[0] || null;
    const highestBeater = beaterCards[beaterCards.length - 1] || null;

    // If partner is already winning, don't waste power cards.
    if (teamAlreadyWinning) {
      return typeof passedCard === "number" ? passedCard : lowest;
    }

    // Can't win this hand anymore: discard the cheapest card.
    if (!lowestBeater) {
      return typeof passedCard === "number" ? passedCard : lowest;
    }

    // Critical rounds: secure with highest beater.
    if (round.mustWinNow || (round.roundPointValue >= 6 && round.handNumber >= 2)) {
      return highestBeater?.index ?? lowestBeater.index;
    }

    // If opponents still play after us, keep margin without burning the top card.
    if (hasOpponentsAfterMe && beaterCards.length > 1) {
      const saferBeater = beaterCards[Math.max(0, Math.floor(beaterCards.length / 2) - 1)];
      return saferBeater?.index ?? lowestBeater.index;
    }

    // If no opponents after us, lowest beater is enough to close the hand.
    return lowestBeater.index;
  }

  // Leading the hand.
  if (round.mustWinNow) return highest;
  if (round.roundPointValue >= 6) return highest;
  if (round.handNumber >= 2 && round.behind) return highest;
  if (round.ahead) return typeof passedCard === "number" ? passedCard : lowest;
  if (round.handNumber === 1 && ranked.length >= 3) return medium;
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
      const pendingSince = ensurePendingSince(gameState.flor);
      if (!canBotResolvePending(roomId, botId, "flor-envido", pendingSince)) return;
      if (!canBotActNow(roomId, botId)) return;
      const decision = shouldBotAcceptFlorEnvido(gameState, botId);
      if (decision.wantsAccept) {
        applyFlorEnvidoAcceptAction(roomId, gameState, botId, "Bot");
      } else {
        applyFlorEnvidoRejectAction(roomId, gameState, botId, "Bot");
      }
      clearBotPendingSchedule(roomId, botId, "flor-envido");
      setBotCooldown(roomId, botId);
      const responder = gameState.players.find((p) => p.id === botId);
      botLog(
        roomId,
        responder?.name,
        "flor-envido response",
        decision.wantsAccept ? "quiero" : "no quiero",
        decision.myFlor,
        decision.threshold
      );
      emitGameUpdate(roomId, gameState);
      return;
    }
    if (pendingFlorEnvido) return;

    const canto11 = gameState.canto11 || {};
    if ((canto11.status === "declaring" || canto11.status === "duel_declaring") && isBotPlayerId(gameState.turn)) {
      const botId = gameState.turn;
      if (!canBotActNow(roomId, botId)) return;
      const isDuelDeclaring = canto11.status === "duel_declaring";
      if (isDuelDeclaring || getPlayerTeamKey(gameState, botId) === canto11.singingTeamKey) {
        const snapshot = gameState.roundHandsSnapshot || gameState.hands || {};
        const envite = computeEnvido(snapshot[botId] || [], gameState.vira);
        const declaredByPlayer = { ...(canto11.declaredByPlayer || {}), [botId]: envite };
        const declareOrder = Array.isArray(canto11.declareOrder) ? canto11.declareOrder : [];
        const nextDeclareIndex = declareOrder.findIndex((playerId) => typeof declaredByPlayer[playerId] !== "number");
        gameState.canto11 = {
          ...canto11,
          declaredByPlayer,
          declareIndex: nextDeclareIndex >= 0 ? nextDeclareIndex : declareOrder.length,
        };
        const me = gameState.players.find((p) => p.id === botId);
        const singerHasFlor =
          !!gameState.flor?.hasFlorByPlayer?.[botId] && !gameState.flor?.burnedByPlayer?.[botId];
        emitLockedMessage(
          roomId,
          gameState,
          singerHasFlor
            ? `${me?.name || "Bot"}: Tengo Flor`
            : `${me?.name || "Bot"}: Tengo ${envite} puntos de envite`
        );
        if (isDuelDeclaring) {
          const cardsToReveal = gameState.hands?.[botId] || snapshot[botId] || [];
          const now = Date.now();
          gameState.hands[botId] = [];
          gameState.tableCards = [
            ...(gameState.tableCards || []),
            ...cardsToReveal.map((card, index) => ({
              ...card,
              playerId: botId,
              handNumber: 1,
              isParda: false,
              rank: resolveHandRank(card, gameState.vira),
              playedAt: now + index,
            })),
          ];
        }
        if (nextDeclareIndex >= 0) {
          gameState.turn = declareOrder[nextDeclareIndex];
          setBotCooldown(roomId, botId);
          emitGameUpdate(roomId, gameState);
          return;
        }

        if (isDuelDeclaring) {
          resolveCanto11Duel(roomId, room, gameState);
          setBotCooldown(roomId, botId);
          return;
        }

        if (resolveCanto11ByFlorIfNeeded(roomId, room, gameState)) {
          setBotCooldown(roomId, botId);
          return;
        }

        const singingMaxEnvite = Math.max(...Object.values(declaredByPlayer).map((v) => Number(v) || 0), 0);
        const order = getTurnOrder(gameState, gameState.roundStarter || gameState.turn || gameState.players?.[0]?.id);
        const responderIds = order.filter((id) => getPlayerTeamKey(gameState, id) === canto11.responderTeamKey);
        const responderTurnId = responderIds[0] || null;
        const responderValues = responderIds.map((id) => computeEnvido(snapshot[id] || [], gameState.vira));
        const responderMaxEnvite = Math.max(...responderValues, 0);
        const responderEligible = responderMaxEnvite > singingMaxEnvite;
        gameState.canto11 = {
          ...gameState.canto11,
          status: "responding",
          singingMaxEnvite,
          responderMaxEnvite,
          responderEligible,
          responderTurnId,
        };
        if (responderTurnId) gameState.turn = responderTurnId;
        setBotCooldown(roomId, botId);
        emitGameUpdate(roomId, gameState);
      }
      return;
    }

    if (
      canto11.status === "responding" &&
      isBotPlayerId(canto11.responderTurnId) &&
      isBotPlayerId(gameState.turn)
    ) {
      const botId = gameState.turn;
      if (!canBotActNow(roomId, botId)) return;
      const canPrivo = !!canto11.responderEligible;
      const wantsPrivo = canPrivo && Math.random() < 0.8;
      if (wantsPrivo) {
        const action = applyCanto11PrivoAction(roomId, gameState, botId, "Bot");
        if (action.ok) {
          setBotCooldown(roomId, botId);
          emitGameUpdate(roomId, gameState);
        }
        return;
      }
      const action = applyCanto11NoPrivoAction(room, roomId, gameState, botId, "Bot");
      if (action.ok) {
        setBotCooldown(roomId, botId);
        emitGameUpdate(roomId, gameState);
      }
      return;
    }

    const pendingEnvido = gameState.envido?.status === "pending";
    if (pendingEnvido && isBotPlayerId(gameState.envido?.responderId)) {
      const botId = gameState.envido.responderId;
      const pendingSince = ensurePendingSince(gameState.envido);
      if (!canBotResolvePending(roomId, botId, "envido", pendingSince)) return;
      if (!canBotActNow(roomId, botId)) return;
      burnFlorOnEnvidoResponse(gameState, botId);
      const envido = gameState.envido || {};
      const snapshot = gameState.roundHandsSnapshot || gameState.hands || {};
      const myEnvido = computeEnvido(snapshot[botId] || [], gameState.vira);
      const threshold = getBotEnvidoAcceptThreshold(envido.points || 2);
      const round = getBotRoundContext(gameState, botId);
      const match = getBotMatchContext(gameState, botId);
      const effectiveThreshold = threshold + (match.ahead ? 1 : 0) - (round.behind || match.behind ? 1 : 0);
      let wantsAccept = myEnvido >= effectiveThreshold;
      if (!wantsAccept && myEnvido >= threshold - 3 && botWillBluff(gameState, botId, "accept-envido")) {
        wantsAccept = true;
      }
      const responder = gameState.players.find((p) => p.id === botId);

      if (wantsAccept && shouldBotRaiseEnvido(gameState, botId, myEnvido, envido)) {
        const current = Number(envido.points || 2);
        const canFalta = current < computeFaltaEnvidoPoints(gameState);
        const nextCallType = canFalta && current >= 8 ? "falta" : "envido";
        applyEnvidoRaiseAction(roomId, gameState, botId, nextCallType, null, "Bot");
      } else if (!wantsAccept) {
        applyEnvidoRejectAction(roomId, gameState, botId, "Bot", false);
      } else {
        applyEnvidoAcceptAction(roomId, gameState, botId, "Bot");
      }
      clearBotPendingSchedule(roomId, botId, "envido");
      setBotCooldown(roomId, botId);
      botLog(roomId, responder?.name, "envido response", wantsAccept ? "quiero" : "no quiero", myEnvido);
      emitGameUpdate(roomId, gameState);
      return;
    }
    if (pendingEnvido) return;

    const pendingTruco = gameState.truco?.status === "pending";
    if (pendingTruco && isBotPlayerId(gameState.truco?.responderId)) {
      const botId = gameState.truco.responderId;
      const pendingSince = ensurePendingSince(gameState.truco);
      if (!canBotResolvePending(roomId, botId, "truco", pendingSince)) return;
      if (!canBotActNow(roomId, botId)) return;
      const truco = gameState.truco || {};

      if (shouldBotCallPrimeroEnvido(gameState, botId, truco)) {
        applyPrimeroEnvidoAction(roomId, gameState, botId, "Bot");
        clearBotPendingSchedule(roomId, botId, "truco");
        setBotCooldown(roomId, botId);
        botLog(roomId, botId, "call primero envido");
        emitGameUpdate(roomId, gameState);
        return;
      }

      const hand = gameState.hands?.[botId] || [];
      const strength = estimateBotTrucoStrength(gameState, botId, hand);
      const proposed = truco.proposedValue || 3;
      const minStrengthByValue = proposed <= 3 ? 8.5 : proposed <= 6 ? 10.8 : proposed <= 9 ? 12.5 : 13.6;
      const match = getBotMatchContext(gameState, botId);
      const adjustedThreshold = minStrengthByValue + (match.ahead ? 0.4 : 0) - (match.behind ? 0.6 : 0);
      let wantsAccept = strength >= adjustedThreshold;
      if (!wantsAccept && strength >= minStrengthByValue - 1.5 && botWillBluff(gameState, botId, "accept-truco")) {
        wantsAccept = true;
      }

      if (!wantsAccept) {
        applyTrucoRejectAction(room, roomId, gameState, botId, "Bot");
      } else {
        applyTrucoAcceptAction(roomId, gameState, botId, "Bot");
        const raiseDecision = shouldBotRaiseTrucoFromWindow(gameState, botId, hand);
        if (raiseDecision.raise && raiseDecision.callType) {
          applyBotTrucoRaiseFromWindow(roomId, gameState, botId, raiseDecision.callType, "Bot");
        }
      }
      clearBotPendingSchedule(roomId, botId, "truco");
      setBotCooldown(roomId, botId);
      botLog(roomId, botId, "truco response", wantsAccept ? "quiero" : "no quiero", strength, proposed);
      emitGameUpdate(roomId, gameState);
      return;
    }
    if (pendingTruco) return;
    if (isTrucoRaiseWindowOpen(gameState)) {
      const windowOwnerId = gameState.truco?.raiseWindowById;
      if (isBotPlayerId(windowOwnerId) && (windowOwnerId === gameState.turn || isSameTeam(gameState, windowOwnerId, gameState.turn))) {
        const botId = windowOwnerId;
        if (!canBotActNow(roomId, botId)) return;
        const hand = gameState.hands?.[botId] || [];
        const raiseDecision = shouldBotRaiseTrucoFromWindow(gameState, botId, hand);
        if (raiseDecision.raise && raiseDecision.callType) {
          const didRaise = applyBotTrucoRaiseFromWindow(roomId, gameState, botId, raiseDecision.callType, "Bot");
          if (didRaise) {
            setBotCooldown(roomId, botId);
            botLog(roomId, botId, "raise truco", raiseDecision.callType, raiseDecision.strength);
            emitGameUpdate(roomId, gameState);
            return;
          }
        }
      }
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
        const pickedBottom = {
          ...hand[bottomIdx],
          playerId: gameTurn,
          pardaPair: true,
          pardaLayer: "bottom",
          pardaNoGap: true,
          pardaRevealGap: false,
          hiddenInParda: true,
        };
        const pickedTop = {
          ...hand[topIdx],
          playerId: gameTurn,
          pardaPair: true,
          pardaLayer: "top",
          pardaNoGap: true,
          pardaRevealGap: false,
          hiddenInParda: false,
        };
        gameState.hands[gameTurn] = hand.filter((_, idx) => idx !== bottomIdx && idx !== topIdx);
        gameState.tableCards.push(pickedBottom, pickedTop);
        gameState.pardaSelections[gameTurn] = {
          bottomCard: pickedBottom,
          topCard: pickedTop,
          revealedBottom: false,
        };
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
          emitGameUpdate(roomId, gameState);
          return;
        }
        resolvePardaRound(room, roomId);
        setBotCooldown(roomId, botId);
        emitGameUpdate(roomId, room.gameState);
      }
      return;
    }

    if (gameState.firstHandTie && gameState.pardaPhase === "reveal" && isBotPlayerId(gameState.turn)) {
      const botId = gameState.turn;
      if (!canBotActNow(roomId, botId)) return;
      if (gameState.truco?.status === "pending" || gameState.envido?.status === "pending" || isFlorEnvidoPending(gameState)) {
        return;
      }
      gameState.pardaSelections = gameState.pardaSelections || {};
      const selected = gameState.pardaSelections[botId];
        if (selected?.bottomCard && !selected.revealedBottom) {
          selected.revealedBottom = true;
          if (selected.topCard) {
            selected.topCard = { ...selected.topCard, pardaRevealGap: true };
          }
          for (let i = gameState.tableCards.length - 1; i >= 0; i -= 1) {
            const c = gameState.tableCards[i];
            if (c.playerId === botId && c.pardaPair && c.pardaLayer === "bottom" && c.hiddenInParda) {
              gameState.tableCards[i] = { ...selected.bottomCard, hiddenInParda: false };
              break;
            }
          }
          for (let i = gameState.tableCards.length - 1; i >= 0; i -= 1) {
            const c = gameState.tableCards[i];
            if (c.playerId === botId && c.pardaPair && c.pardaLayer === "top") {
              gameState.tableCards[i] = { ...gameState.tableCards[i], pardaRevealGap: true };
              break;
            }
          }
          const me = gameState.players.find((p) => p.id === botId);
          emitLockedMessage(roomId, gameState, `${me?.name || "Bot"}: descubre carta`);
        }
      const order = Array.isArray(gameState.pardaRevealOrder) ? gameState.pardaRevealOrder : [];
      const nextIndex = order.findIndex((id) => !gameState.pardaSelections?.[id]?.revealedBottom);
      if (nextIndex >= 0) {
        gameState.pardaRevealIndex = nextIndex;
        gameState.turn = order[nextIndex];
        setBotCooldown(roomId, botId);
        emitGameUpdate(roomId, gameState);
        return;
      }
      const playerIds = gameState.players.map((p) => p.id);
      const selections = gameState.pardaSelections || {};
      const bottomPlays = [];
      for (const playerId of playerIds) {
        const entry = selections[playerId];
        if (!entry?.bottomCard) continue;
        bottomPlays.push({ ...entry.bottomCard, playerId, hiddenInParda: false });
      }
      const bottomWithRank = bottomPlays.map((card) => ({ card, rank: resolveHandRank(card, gameState.vira) }));
      const bestBottom = Math.max(...bottomWithRank.map((item) => item.rank));
      const bottomWinners = bottomWithRank.filter((item) => item.rank === bestBottom);
      const bottomWinnerId = resolveWinnerFromRankEntries(gameState, bottomWinners);
      const finalWinnerId = bottomWinnerId || gameState.pardaTopWinnerId || gameState.roundStarter || playerIds[0];
      resolveRound(room, finalWinnerId, roomId);
      setBotCooldown(roomId, botId);
      emitGameUpdate(roomId, room.gameState);
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
      emitLockedMessage(roomId, gameState, `${me?.name || "Bot"}: Flor`);
      setBotCooldown(roomId, botId);
      botLog(roomId, botId, "call flor");
      emitGameUpdate(roomId, gameState);
      return;
    }

    if (
      inFirstHandOpen &&
      !isFlorAlreadySung(gameState) &&
      gameState.envido?.status === "idle" &&
      (gameState.truco?.status || "idle") === "idle" &&
      !isFlorEnvidoPending(gameState) &&
      !hasAvailableFlor(gameState, botId)
    ) {
      const myEnvido = computeEnvido(gameState.roundHandsSnapshot?.[botId] || hand, gameState.vira);
      const round = getBotRoundContext(gameState, botId);
      const callChance = myEnvido >= 33 ? 0.8 : myEnvido >= 30 ? 0.55 : myEnvido >= 28 ? 0.3 : 0;
      const bluffChance = myEnvido >= 24 && myEnvido <= 27 ? getBotBluffChance(gameState, botId, "call-envido") : 0;
      const shouldCallStrong = callChance > 0 && Math.random() < callChance + (round.behind ? 0.1 : 0);
      const shouldCallBluff = bluffChance > 0 && Math.random() < bluffChance;
      if (shouldCallStrong || shouldCallBluff) {
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
        emitLockedMessage(roomId, gameState, `${me?.name || "Bot"}: Envido`);
        setBotCooldown(roomId, botId);
        botLog(roomId, botId, shouldCallBluff ? "bluff envido" : "call envido", myEnvido);
        emitGameUpdate(roomId, gameState);
        return;
      }
    }

    if (
      gameState.roundPointValue === 1 &&
      gameState.truco?.status !== "pending" &&
      gameState.envido?.status !== "pending" &&
      !isFlorEnvidoPending(gameState)
    ) {
      const strength = estimateBotTrucoStrength(gameState, botId, hand);
      const round = getBotRoundContext(gameState, botId);
      const baseChance = strength >= 13 ? 0.55 : strength >= 11.5 ? 0.35 : 0;
      const chance = baseChance + (round.behind ? 0.15 : 0);
      const bluffChance = strength >= 9.8 && strength < 11.5 ? getBotBluffChance(gameState, botId, "call-truco") : 0;
      const shouldCallStrong = chance > 0 && Math.random() < chance;
      const shouldCallBluff = bluffChance > 0 && Math.random() < bluffChance;
      if (shouldCallStrong || shouldCallBluff) {
        const responderId = getOpposingResponderId(gameState, botId);
        gameState.truco = {
          status: "pending",
          callerId: botId,
          responderId,
          callType: "truco",
          proposedValue: 3,
          acceptedById: gameState.truco?.acceptedById || null,
          raiseWindowUntil: 0,
          raiseWindowById: null,
        };
        const me = gameState.players.find((p) => p.id === botId);
        emitLockedMessage(roomId, gameState, `${me?.name || "Bot"}: Truco`);
        setBotCooldown(roomId, botId);
        botLog(roomId, botId, shouldCallBluff ? "bluff truco" : "call truco", strength);
        emitGameUpdate(roomId, gameState);
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
      const botRooms = Object.values(rooms).filter((room) =>
        (room?.gameState?.players || []).some((p) => isBotPlayerId(p.id))
      );
      for (const room of botRooms) {
        processBotRoom(room);
      }
    }, BOT_TICK_MS);
  }

  startBotLoopOnce();

  socket.on("room:join", ({ roomId, playerName, reconnectToken, avatarUrl, profileId, playerUid }) => {
    const currentRoom = socket.data.roomId;
    const nextName = (playerName || "Jugador").trim() || "Jugador";
    const nextAvatarUrl =
      typeof avatarUrl === "string" && /^https?:\/\//i.test(avatarUrl.trim())
        ? avatarUrl.trim()
        : "";
    const nextProfileId =
      typeof profileId === "string" && profileId.trim() ? profileId.trim() : null;
    const nextPlayerUid =
      typeof playerUid === "string" && playerUid.trim() ? playerUid.trim() : null;

    if (currentRoom && currentRoom !== roomId) {
      removeFromVoiceRoom(socket, "switch-room", socket.data.voiceRoomId);
      const oldRoom = removePlayer(currentRoom, socket.id);
      socket.leave(currentRoom);

      if (oldRoom) {
        io.to(currentRoom).emit("room:update", oldRoom);
      }
    }

    const targetRoom = getRoom(roomId);
    if (!targetRoom) {
      socket.emit("server:error", "Room no existe");
      return;
    }

    const reclaimed = reclaimDisconnectedSeat(
      targetRoom,
      socket,
      nextName,
      reconnectToken,
      nextAvatarUrl,
      nextProfileId,
      nextPlayerUid
    );
    if (reclaimed) {
      ensureAwayByPlayer(targetRoom.gameState);
      targetRoom.gameState.awayByPlayer[socket.id] = false;
      if (targetRoom.allowBots && targetRoom.gameState?.matchEnded) {
        startGame(targetRoom);
        activateCanto11IfNeeded(targetRoom.gameState);
      }
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.reconnectToken = reconnectToken || null;
      scheduleRoomTurnPlayTimeout(roomId, targetRoom.gameState);
      socket.emit("game:start", {
        roomId,
        gameState: targetRoom.gameState,
      });
      socket.emit("game:update", {
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
      avatarUrl: nextAvatarUrl,
      profileId: nextProfileId,
      playerUid: nextPlayerUid,
      connected: true,
      lastSeenAt: Date.now(),
    });

    if (!result.ok) {
      socket.emit("server:error", result.error);
      return;
    }

    ensureBotRoomPlayers(result.room);
    if (result.room.allowBots && result.room.gameState?.matchEnded) {
      startGame(result.room);
      activateCanto11IfNeeded(result.room.gameState);
    }
    if (result.room.gameState) {
      ensureAwayByPlayer(result.room.gameState);
      result.room.gameState.awayByPlayer[socket.id] = false;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.reconnectToken = reconnectToken || null;

    io.to(roomId).emit("room:update", result.room);
    emitRooms();

    if (result.room.gameState) {
      scheduleRoomTurnPlayTimeout(roomId, result.room.gameState);
      socket.emit("game:start", {
        roomId,
        gameState: result.room.gameState,
      });
      socket.emit("game:update", {
        roomId,
        gameState: result.room.gameState,
      });
      return;
    }

    if (result.room.players.length === result.room.maxPlayers && !result.room.gameState) {
      console.log("Mesa llena, iniciando partida:", roomId);
      startGame(result.room);
      activateCanto11IfNeeded(result.room.gameState);
      scheduleRoomTurnPlayTimeout(roomId, result.room.gameState);
      io.to(roomId).emit("game:start", {
        roomId,
        gameState: result.room.gameState,
      });
      io.to(roomId).emit("game:update", {
        roomId,
        gameState: result.room.gameState,
      });

      emitRooms();
    }
  });

  socket.on("room:leave", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    removeFromVoiceRoom(socket, "room-leave", socket.data.voiceRoomId);

    clearSeatTimeout(roomId, socket.id);
    const room = getRoom(roomId);
    if (room?.gameState?.matchEnded) {
      unsubscribePlayerSeat(roomId, socket.id, "room-leave-match-ended");
      return;
    }

    const updatedRoom = removePlayer(roomId, socket.id);
    socket.leave(roomId);
    socket.data.roomId = null;

    if (updatedRoom) {
      io.to(roomId).emit("room:update", updatedRoom);
    }

    emitRooms();
  });

  socket.on("room:away", ({ roomId, away }) => {
    const effectiveRoomId = roomId || socket.data.roomId;
    if (!effectiveRoomId) return;
    const room = getRoom(effectiveRoomId);
    const gameState = room?.gameState;
    if (!room || !gameState || gameState.matchEnded) return;
    const me = gameState.players.find((p) => p.id === socket.id);
    if (!me) return;
    ensureAwayByPlayer(gameState);
    const nextAway = !!away;
    if (gameState.awayByPlayer[socket.id] === nextAway) {
      return;
    }
    gameState.awayByPlayer[socket.id] = nextAway;
    turnTimerLog("away-flag", {
      roomId: effectiveRoomId,
      playerId: socket.id,
      away: nextAway,
      turn: gameState.turn,
    });
    emitGameUpdate(effectiveRoomId, gameState);
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
    activateCanto11IfNeeded(room.gameState);

    io.to(roomId).emit(
      "server:error",
      onlyBastosEspadas
        ? "Modo prueba activo: mazo solo de bastos y espadas"
        : "Modo prueba desactivado: mazo completo"
    );
    emitGameUpdate(roomId, room.gameState);
  });

  socket.on("debug:redeal-round", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const starterId = gameState.roundStarter || gameState.turn || gameState.players[0]?.id;
    startGame.redealRound(room, starterId);
    activateCanto11IfNeeded(room.gameState);

    emitLockedMessage(roomId, room.gameState, "Repartiendo nueva ronda (modo prueba)");
    emitGameUpdate(roomId, room.gameState);
  });

  socket.on("debug:force-flor", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;

    const ok = forceFlorHandForPlayer(gameState, socket.id);
    if (!ok) {
      socket.emit("server:error", "No se pudo forzar Flor en esta ronda");
      return;
    }

    const me = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"} activo test de Flor`);
    emitGameUpdate(roomId, gameState);
  });

  socket.on("debug:force-flor-reservada", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;

    const ok = forceFlorReservadaForPlayer(gameState, socket.id);
    if (!ok) {
      socket.emit("server:error", "No se pudo forzar Flor Reservada en esta ronda");
      return;
    }

    const me = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"} activo test de Flor Reservada`);
    emitGameUpdate(roomId, gameState);
  });

  socket.on("debug:set-my-score-11", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.mode === "2vs2") {
      ensureScoreState(gameState);
      const teamField = getScoreTeamField(gameState, socket.id);
      if (!teamField) return;
      gameState.score[teamField] = 11;
    } else {
      gameState.pointsByPlayer[socket.id] = 11;
    }

    activateCanto11IfNeeded(gameState);
    const me = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"} activo test: me pongo en 11`);
    emitGameUpdate(roomId, gameState);
  });

  socket.on("debug:set-my-team-score-11", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.mode === "2vs2") {
      ensureScoreState(gameState);
      gameState.score.team1 = 11;
      gameState.score.team2 = 11;
    } else {
      for (const player of gameState.players || []) {
        gameState.pointsByPlayer[player.id] = 11;
      }
    }

    activateCanto11IfNeeded(gameState);
    const me = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"} activo test: ambos en 11`);
    emitGameUpdate(roomId, gameState);
  });

  socket.on("debug:force-parda-first", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const starterId = gameState.roundStarter || gameState.turn || gameState.players[0]?.id;
    startGame.redealRound(room, starterId);
    const live = room.gameState;
    const meId = socket.id;
    const me = live.players.find((p) => p.id === meId);
    if (!me) return;

    const opponentIds = getOpposingPlayerIds(live, meId);
    const opponentId = opponentIds[0];
    if (!opponentId) {
      socket.emit("server:error", "No hay contrario disponible para preparar parda");
      return;
    }

    const myHand = live.hands[meId] || [];
    const oppHand = live.hands[opponentId] || [];
    if (!myHand.length || !oppHand.length) {
      socket.emit("server:error", "No se pudo preparar la mano de prueba");
      return;
    }

    const rankOf = (card) => resolveHandRank(card, live.vira);
    const hasDirectTie = myHand.some((a) => oppHand.some((b) => rankOf(a) === rankOf(b)));

    if (!hasDirectTie) {
      let swapped = false;
      for (let myIdx = 0; myIdx < myHand.length && !swapped; myIdx += 1) {
        const targetRank = rankOf(myHand[myIdx]);

        // 1) Busca una carta de misma jerarquia en otras manos y la intercambia al contrario.
        for (const pid of Object.keys(live.hands)) {
          if (pid === meId || pid === opponentId) continue;
          const sourceHand = live.hands[pid] || [];
          const sourceIdx = sourceHand.findIndex((card) => rankOf(card) === targetRank);
          if (sourceIdx >= 0) {
            const giveToOpp = sourceHand[sourceIdx];
            const replaceCard = oppHand[0];
            sourceHand[sourceIdx] = replaceCard;
            oppHand[0] = giveToOpp;
            swapped = true;
            break;
          }
        }

        // 2) Si no existe en manos, usa mazo restante.
        if (!swapped && Array.isArray(live.deck)) {
          const deckIdx = live.deck.findIndex((card) => rankOf(card) === targetRank);
          if (deckIdx >= 0) {
            const giveToOpp = live.deck.splice(deckIdx, 1)[0];
            const replaceCard = oppHand[0];
            oppHand[0] = giveToOpp;
            live.deck.push(replaceCard);
            swapped = true;
          }
        }
      }

      const nowTie = myHand.some((a) => oppHand.some((b) => rankOf(a) === rankOf(b)));
      if (!nowTie) {
        socket.emit("server:error", "No se pudo preparar una parda posible en primera");
        return;
      }
    }

    live.firstHandTie = false;
    live.pardaPhase = null;
    live.pardaSelections = {};
    live.pardaRevealOrder = [];
    live.pardaRevealIndex = 0;
    live.pardaRevealedByPlayer = {};
    live.pardaTopWinnerId = null;
    live.handNumber = 1;
    live.currentHandCards = [];
    live.handResults = [];
    live.tableCards = [];
    live.turn = live.currentHandStarter || starterId;
    live.roundHandsSnapshot = Object.fromEntries(
      Object.entries(live.hands || {}).map(([pid, cards]) => [pid, (cards || []).map((c) => ({ ...c }))])
    );

    emitLockedMessage(
      roomId,
      live,
      `${me?.name || "Jugador"} activo test: parda posible en primera (sin forzar)`
    );
    emitGameUpdate(roomId, live);
  });

  socket.on("debug:force-parda-tiebreak2", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const starterId = gameState.roundStarter || gameState.turn || gameState.players[0]?.id;
    startGame.redealRound(room, starterId);
    const live = room.gameState;

    const meId = socket.id;
    const me = live.players.find((p) => p.id === meId);
    if (!me) return;

    const opponentIds = getOpposingPlayerIds(live, meId);
    const opponentId = opponentIds[0];
    if (!opponentId) {
      socket.emit("server:error", "No hay contrario disponible para preparar desempate de parda");
      return;
    }

    const myHand = live.hands[meId] || [];
    const oppHand = live.hands[opponentId] || [];
    if (myHand.length < 2 || oppHand.length < 2) {
      socket.emit("server:error", "No se pudo preparar la mano de prueba");
      return;
    }

    const rankOf = (card) => resolveHandRank(card, live.vira);
    const targetRanks = [rankOf(myHand[0]), rankOf(myHand[1])];

    const assignMatchingRankToOpponentSlot = (targetRank, oppSlot) => {
      if (rankOf(oppHand[oppSlot]) === targetRank) return true;

      // 1) Buscar en otras manos (distintas de yo/oponente).
      for (const pid of Object.keys(live.hands)) {
        if (pid === meId || pid === opponentId) continue;
        const sourceHand = live.hands[pid] || [];
        const sourceIdx = sourceHand.findIndex((card) => rankOf(card) === targetRank);
        if (sourceIdx >= 0) {
          const matchingCard = sourceHand[sourceIdx];
          const replacedOpp = oppHand[oppSlot];
          sourceHand[sourceIdx] = replacedOpp;
          oppHand[oppSlot] = matchingCard;
          return true;
        }
      }

      // 2) Buscar en mazo restante.
      if (Array.isArray(live.deck)) {
        const deckIdx = live.deck.findIndex((card) => rankOf(card) === targetRank);
        if (deckIdx >= 0) {
          const matchingCard = live.deck.splice(deckIdx, 1)[0];
          const replacedOpp = oppHand[oppSlot];
          oppHand[oppSlot] = matchingCard;
          live.deck.push(replacedOpp);
          return true;
        }
      }

      return false;
    };

    const okFirst = assignMatchingRankToOpponentSlot(targetRanks[0], 0);
    const okSecond = assignMatchingRankToOpponentSlot(targetRanks[1], 1);
    if (!okFirst || !okSecond) {
      socket.emit("server:error", "No se pudo preparar doble desempate de parda");
      return;
    }

    const myRanks = myHand.map((c) => rankOf(c));
    const oppRanks = oppHand.map((c) => rankOf(c));
    const commonCount = myRanks.reduce((acc, r) => acc + (oppRanks.includes(r) ? 1 : 0), 0);
    if (commonCount < 2) {
      socket.emit("server:error", "No se logro garantizar dos cartas de parda");
      return;
    }

    live.firstHandTie = false;
    live.pardaPhase = null;
    live.pardaSelections = {};
    live.pardaRevealOrder = [];
    live.pardaRevealIndex = 0;
    live.pardaRevealedByPlayer = {};
    live.pardaTopWinnerId = null;
    live.handNumber = 1;
    live.currentHandCards = [];
    live.handResults = [];
    live.tableCards = [];
    live.turn = live.currentHandStarter || starterId;
    live.roundHandsSnapshot = Object.fromEntries(
      Object.entries(live.hands || {}).map(([pid, cards]) => [pid, (cards || []).map((c) => ({ ...c }))])
    );

    emitLockedMessage(
      roomId,
      live,
      `${me?.name || "Jugador"} activo test: parda desempate 2 (dos cartas iguales al contrario)`
    );
    emitGameUpdate(roomId, live);
  });

  socket.on("call:team-signal", ({ roomId, signal }) => {
    if (!roomId || !signal) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;
    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (gameState.mode !== "2vs2" || (gameState.players || []).length !== 4) return;

    const me = (gameState.players || []).find((p) => p.id === socket.id);
    if (!me) return;

    const safeSignal = String(signal);
    const label = TEAM_SIGNAL_LABELS[safeSignal];
    if (!label) return;

    const cooldownKey = `${roomId}:${socket.id}`;
    const lastAt = teamSignalCooldownByPlayer.get(cooldownKey) || 0;
    if (Date.now() - lastAt < TEAM_SIGNAL_COOLDOWN_MS) return;
    teamSignalCooldownByPlayer.set(cooldownKey, Date.now());

    emitLockedMessage(roomId, gameState, `${me.name || "Jugador"}: ${label}`);
    emitGameUpdate(roomId, gameState);
  });

  socket.on("call:flor", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", "Debes resolver Estoy Cantando antes de cantar Flor");
      return;
    }
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) {
      socket.emit("server:error", "Espera a que termine el mensaje actual");
      return;
    }
    const isThirdConfirm = gameState.handNumber === 3 && !!gameState.flor?.requireThirdByPlayer?.[socket.id];
    if (!isThirdConfirm && gameState.turn !== socket.id) {
      socket.emit("server:error", "Solo puede cantar Flor el jugador en turno");
      return;
    }
    if (!canSingFlorNow(gameState, socket.id)) {
      socket.emit("server:error", "No puedes cantar Flor en este momento");
      return;
    }
    if (gameState.envido?.status === "pending" || gameState.truco?.status === "pending" || isFlorEnvidoPending(gameState)) {
      socket.emit("server:error", "No se puede cantar Flor con un canto pendiente");
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
    const msg = `${caller?.name || "Jugador"}: Flor`;
    emitLockedMessage(roomId, gameState, msg);
    if (maybeResolvePendingMazo(room, roomId)) return;
    emitGameUpdate(roomId, gameState);
  });

  socket.on("flor:jugar-ley", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", "Debes resolver Estoy Cantando antes de jugar a ley");
      return;
    }
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!isFirstHandOpen(gameState)) {
      socket.emit("server:error", "Jugar a ley solo se marca en primera mano");
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
      socket.emit("server:error", "Primero resuelve el Flor Envido pendiente");
      return;
    }

    gameState.flor.leyByPlayer[socket.id] = true;
    const me = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"}: a ley`);
    emitGameUpdate(roomId, gameState);
  });

  socket.on("flor:con-flor", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", "Debes resolver Estoy Cantando antes de responder con Flor");
      return;
    }
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!hasAvailableFlor(gameState, socket.id)) {
      socket.emit("server:error", "No tienes Flor disponible para responder con Flor");
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
      socket.emit("server:error", "Con Flor solo aplica al responder un canto");
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
        ? `${responder?.name || "Jugador"}: Con Flor. El Envido queda anulado en esta ronda`
        : `${responder?.name || "Jugador"}: Con Flor`
    );
    if (maybeResolvePendingMazo(room, roomId)) return;
    emitGameUpdate(roomId, gameState);
  });

  socket.on("call:flor-envido", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (gameState.turn !== socket.id) {
      socket.emit("server:error", "Solo puede cantar Flor Envido el jugador en turno");
      return;
    }
    if (gameState.truco?.status === "pending" || gameState.envido?.status === "pending" || isFlorEnvidoPending(gameState)) {
      socket.emit("server:error", "No puedes cantar Flor Envido con un canto pendiente");
      return;
    }
    if (!canCallFlorEnvido(gameState, socket.id)) {
      socket.emit("server:error", "Flor Envido no esta disponible");
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
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"}: Flor Envido`);
    if (maybeResolvePendingMazo(room, roomId)) return;
    emitGameUpdate(roomId, gameState);
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
      socket.emit("server:error", "No te corresponde responder el Flor Envido");
      return;
    }

    applyFlorEnvidoAcceptAction(roomId, gameState, socket.id, "Jugador");
    if (maybeResolvePendingMazo(room, roomId)) return;
    emitGameUpdate(roomId, gameState);
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
      socket.emit("server:error", "No te corresponde responder el Flor Envido");
      return;
    }

    applyFlorEnvidoRejectAction(roomId, gameState, socket.id, "Jugador");
    if (maybeResolvePendingMazo(room, roomId)) return;
    emitGameUpdate(roomId, gameState);
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
      socket.emit("server:error", "No te corresponde responder el Flor Envido");
      return;
    }

    applyFlorEnvidoRaiseAction(roomId, gameState, socket.id, "Jugador");
    if (maybeResolvePendingMazo(room, roomId)) return;
    emitGameUpdate(roomId, gameState);
  });

  socket.on("call:envido", ({ roomId, stones }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", MSG.CANTO11_BEFORE_ENVIDO);
      return;
    }
    if (gameState.roundEnding) return;
    const commonError = firstError(guardTurn(gameState, socket.id, MSG.ENVIDO_TURN_ONLY));
    if (commonError) {
      socket.emit("server:error", commonError);
      return;
    }
    if (isInputLocked(gameState)) return;
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:error", MSG.FLOR_ALREADY_SUNG);
      return;
    }
    if (hasAvailableFlor(gameState, socket.id)) {
      socket.emit("server:error", MSG.MUST_SING_FLOR_FIRST);
      return;
    }
    if (gameState.truco?.callerId === socket.id) {
      socket.emit("server:error", MSG.ENVIDO_BLOCKED_BY_OWN_TRUCO);
      return;
    }
    const envidoState = gameState.envido || { status: "idle" };

    if (envidoState.status !== "idle") {
      socket.emit("server:error", MSG.ENVIDO_ALREADY_CALLED);
      return;
    }
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:error", MSG.FLOR_ALREADY_SUNG);
      return;
    }

    const playerIds = gameState.players.map((p) => p.id);
    const isInFirstHand =
      Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
      (gameState.tableCards?.length || 0) < playerIds.length;

    if (!isInFirstHand) {
      socket.emit("server:error", MSG.ENVIDO_FIRST_HAND_ONLY);
      return;
    }

    if (gameState.truco?.status === "pending") {
      socket.emit("server:error", MSG.ENVIDO_BLOCKED_BY_PENDING);
      return;
    }
    if (gameState.truco?.status === "accepted") {
      socket.emit("server:error", MSG.ENVIDO_BLOCKED_BY_ACCEPTED_TRUCO);
      return;
    }

    const responderId = getOpposingResponderId(gameState, socket.id);

    const safeStones = Number.isFinite(Number(stones))
      ? Math.max(1, Math.min(12, Math.floor(Number(stones))))
      : 2;

    gameState.envido = {
      status: "pending",
      callerId: socket.id,
      responderId,
      callType: "envido",
      winnerId: null,
      points: safeStones,
      acceptedPoints: 1,
      envidoByPlayer: {},
      resolved: false,
    };

    const caller = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(
      roomId,
      gameState,
      safeStones > 2
        ? `${caller?.name || "Jugador"}: Envido ${safeStones} piedras`
        : `${caller?.name || "Jugador"}: Envido`
    );

    emitGameUpdate(roomId, gameState);
  });

  socket.on("call:falta-envido", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", "Debes resolver Estoy Cantando antes de Envidar");
      return;
    }
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:error", "La Flor ya fue cantada en esta ronda");
      return;
    }
    const hasFlorReservada = !!gameState.flor?.reservadaByPlayer?.[socket.id];
    if (hasAvailableFlor(gameState, socket.id) && !hasFlorReservada) {
      socket.emit("server:error", "Con Flor disponible debes cantar Flor");
      return;
    }
    if (gameState.turn !== socket.id) {
      socket.emit("server:error", "Solo puede cantar Falta Envido el jugador en turno");
      return;
    }
    if (gameState.truco?.callerId === socket.id) {
      socket.emit("server:error", "Si ya cantaste Truco no puedes cantar Falta Envido");
      return;
    }
    const envidoState = gameState.envido || { status: "idle" };

    if (envidoState.status !== "idle") {
      socket.emit("server:error", "El envido ya fue cantado en esta ronda");
      return;
    }

    const playerIds = gameState.players.map((p) => p.id);
    const isInFirstHand =
      Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
      (gameState.tableCards?.length || 0) < playerIds.length;

    if (!isInFirstHand) {
      socket.emit("server:error", "La falta envido solo se puede cantar en la primera mano");
      return;
    }

    if (gameState.truco?.status === "pending") {
      socket.emit("server:error", "No se puede cantar falta envido con un canto pendiente");
      return;
    }
    if (gameState.truco?.status === "accepted") {
      socket.emit("server:error", "No se puede cantar falta envido despues de aceptar Truco");
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
      `${caller?.name || "Jugador"}: Falta Envido (vale ${faltaPoints})`
    );

    emitGameUpdate(roomId, gameState);
  });

  socket.on("call:primero-envido", ({ roomId }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", "Debes resolver Estoy Cantando antes de Envidar");
      return;
    }
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:error", "La Flor ya fue cantada en esta ronda");
      return;
    }
    const truco = gameState.truco || {};
    const envidoState = gameState.envido || { status: "idle" };

    if (truco.status !== "pending") {
      socket.emit("server:error", "Primero Envido solo aplica con Truco pendiente");
      return;
    }
    if (socket.id !== truco.responderId && !isSameTeam(gameState, truco.responderId, socket.id)) {
      socket.emit("server:error", "Solo quien responde el Truco puede cantar Primero Envido");
      return;
    }
    if (envidoState.status !== "idle") {
      socket.emit("server:error", "El envido ya fue cantado en esta ronda");
      return;
    }

    const playerIds = gameState.players.map((p) => p.id);
    const isInFirstHand =
      Object.values(gameState.handWinsByPlayer || {}).every((wins) => wins === 0) &&
      (gameState.tableCards?.length || 0) < playerIds.length;
    if (!isInFirstHand) {
      socket.emit("server:error", "Primero Envido solo se puede cantar en la primera mano");
      return;
    }

    applyPrimeroEnvidoAction(roomId, gameState, socket.id, "Jugador");
    emitGameUpdate(roomId, gameState);
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
      socket.emit("server:error", "No te corresponde responder el envido");
      return;
    }
    applyEnvidoAcceptAction(roomId, gameState, socket.id, "Jugador");
    emitGameUpdate(roomId, gameState);
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
      socket.emit("server:error", "No te corresponde responder el envido");
      return;
    }
    applyEnvidoRejectAction(roomId, gameState, socket.id, "Jugador", true);
    emitGameUpdate(roomId, gameState);
  });

  socket.on("envido:raise", ({ roomId, kind, stones }) => {
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (isFlorAlreadySung(gameState)) {
      socket.emit("server:error", "La Flor ya fue cantada en esta ronda");
      return;
    }
    const envido = gameState.envido || {};
    if (envido.status !== "pending") return;
    const canRespondEnvido =
      envido.responderId === socket.id ||
      isSameTeam(gameState, envido.responderId, socket.id);
    if (!canRespondEnvido) {
      socket.emit("server:error", "No te corresponde responder el envido");
      return;
    }
    const raiseResult = applyEnvidoRaiseAction(roomId, gameState, socket.id, kind, stones, "Jugador");
    if (!raiseResult.ok) {
      socket.emit("server:error", raiseResult.error);
      return;
    }
    emitGameUpdate(roomId, gameState);
  });

  socket.on("canto11:declare-envite", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const canto11 = gameState.canto11 || {};
    const isDuelDeclaring = canto11.status === "duel_declaring";
    if (canto11.status !== "declaring" && !isDuelDeclaring) return;

    if (!isDuelDeclaring) {
      const singingTeamKey = canto11.singingTeamKey;
      if (!singingTeamKey) return;
      if (getPlayerTeamKey(gameState, socket.id) !== singingTeamKey) {
        socket.emit("server:error", "No te corresponde declarar envite");
        return;
      }
    }
    if (gameState.turn !== socket.id) {
      socket.emit("server:error", "Debe declararse en orden");
      return;
    }

    const snapshot = gameState.roundHandsSnapshot || gameState.hands || {};
    const envite = computeEnvido(snapshot[socket.id] || [], gameState.vira);
    const declaredByPlayer = { ...(canto11.declaredByPlayer || {}), [socket.id]: envite };
    const declareOrder = Array.isArray(canto11.declareOrder) ? canto11.declareOrder : [];
    const nextDeclareIndex = declareOrder.findIndex((playerId) => typeof declaredByPlayer[playerId] !== "number");

    gameState.canto11 = {
      ...canto11,
      declaredByPlayer,
      declareIndex: nextDeclareIndex >= 0 ? nextDeclareIndex : declareOrder.length,
    };

    if (isDuelDeclaring) {
      const cardsToReveal = gameState.hands?.[socket.id] || snapshot[socket.id] || [];
      const now = Date.now();
      gameState.hands[socket.id] = [];
      gameState.tableCards = [
        ...(gameState.tableCards || []),
        ...cardsToReveal.map((card, index) => ({
          ...card,
          playerId: socket.id,
          handNumber: 1,
          isParda: false,
          rank: resolveHandRank(card, gameState.vira),
          playedAt: now + index,
        })),
      ];
    }

    const me = gameState.players.find((p) => p.id === socket.id);
    const singerHasFlor =
      !!gameState.flor?.hasFlorByPlayer?.[socket.id] && !gameState.flor?.burnedByPlayer?.[socket.id];
    emitLockedMessage(
      roomId,
      gameState,
      singerHasFlor
        ? `${me?.name || "Jugador"}: Tengo Flor`
        : `${me?.name || "Jugador"}: Tengo ${envite} puntos de envite`
    );

    if (nextDeclareIndex >= 0) {
      gameState.turn = declareOrder[nextDeclareIndex];
      emitGameUpdate(roomId, gameState);
      return;
    }

    if (isDuelDeclaring) {
      resolveCanto11Duel(roomId, room, gameState);
      return;
    }

    if (resolveCanto11ByFlorIfNeeded(roomId, room, gameState)) {
      return;
    }

    const singingMaxEnvite = Math.max(...Object.values(declaredByPlayer).map((v) => Number(v) || 0), 0);
    const responderTeamKey = canto11.responderTeamKey;
    const order = getTurnOrder(gameState, gameState.roundStarter || gameState.turn || gameState.players?.[0]?.id);
    const responderIds = order.filter((id) => getPlayerTeamKey(gameState, id) === responderTeamKey);
    const responderTurnId = responderIds[0] || null;
    const responderValues = responderIds.map((id) => computeEnvido(snapshot[id] || [], gameState.vira));
    const responderMaxEnvite = Math.max(...responderValues, 0);
    const responderEligible = responderMaxEnvite > singingMaxEnvite;

    gameState.canto11 = {
      ...gameState.canto11,
      status: "responding",
      singingMaxEnvite,
      responderMaxEnvite,
      responderEligible,
      responderTurnId,
    };
    if (responderTurnId) {
      gameState.turn = responderTurnId;
    }
    emitGameUpdate(roomId, gameState);
  });

  socket.on("canto11:privo-truco", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const canto11 = gameState.canto11 || {};
    if (canto11.status !== "responding") return;
    if (getPlayerTeamKey(gameState, socket.id) !== canto11.responderTeamKey) {
      socket.emit("server:error", "No te corresponde responder");
      return;
    }
    if (canto11.responderTurnId && !isSameTeam(gameState, socket.id, canto11.responderTurnId)) {
      socket.emit("server:error", "No te corresponde responder");
      return;
    }
    if (!canto11.responderEligible) {
      socket.emit("server:error", "No puedes privar: no superas el envite");
      return;
    }

    const action = applyCanto11PrivoAction(roomId, gameState, socket.id, "Jugador");
    if (!action.ok) {
      socket.emit("server:error", action.error);
      return;
    }
    emitGameUpdate(roomId, gameState);
  });

  socket.on("canto11:no-privo", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const canto11 = gameState.canto11 || {};
    if (canto11.status !== "responding") return;
    if (getPlayerTeamKey(gameState, socket.id) !== canto11.responderTeamKey) {
      socket.emit("server:error", "No te corresponde responder");
      return;
    }
    if (canto11.responderTurnId && !isSameTeam(gameState, socket.id, canto11.responderTurnId)) {
      socket.emit("server:error", "No te corresponde responder");
      return;
    }

    const action = applyCanto11NoPrivoAction(room, roomId, gameState, socket.id, "Jugador");
    if (!action.ok) {
      socket.emit("server:error", action.error);
      return;
    }
    emitGameUpdate(roomId, gameState);
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
      socket.emit("server:error", "No te corresponde responder ese canto");
      return;
    }
    applyTrucoAcceptAction(roomId, gameState, socket.id, "Jugador");
    emitGameUpdate(roomId, gameState);
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
      socket.emit("server:error", "No te corresponde responder ese canto");
      return;
    }
    applyTrucoRejectAction(room, roomId, gameState, socket.id, "Jugador");
    emitGameUpdate(roomId, room.gameState);
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
      socket.emit("server:error", "No es tu turno de elegir en la parda");
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
      socket.emit("server:error", "Seleccion parda invalida");
      return;
    }

    gameState.pardaSelections = gameState.pardaSelections || {};
    const pickedBottom = {
      ...hand[bottomIndex],
      playerId: socket.id,
      pardaPair: true,
      pardaLayer: "bottom",
      pardaNoGap: true,
      pardaRevealGap: false,
      hiddenInParda: true,
    };
    const pickedTop = {
      ...hand[topIndex],
      playerId: socket.id,
      pardaPair: true,
      pardaLayer: "top",
      pardaNoGap: true,
      pardaRevealGap: false,
      hiddenInParda: false,
    };

    const remaining = hand.filter((_, idx) => idx !== bottomIndex && idx !== topIndex);
    gameState.hands[socket.id] = remaining;
    gameState.tableCards.push(pickedBottom, pickedTop);

    gameState.pardaSelections[socket.id] = {
      bottomCard: pickedBottom,
      topCard: pickedTop,
      revealedBottom: false,
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
      emitGameUpdate(roomId, gameState);
      return;
    }

    if (!resolvePardaRound(room, roomId)) {
      socket.emit("server:error", "No se pudo resolver la parda");
      return;
    }

    emitGameUpdate(roomId, room.gameState);
  });

  socket.on("parda:reveal", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (gameState.roundEnding) return;
    if (isInputLocked(gameState)) return;
    if (!(gameState.firstHandTie && gameState.pardaPhase === "reveal")) return;
    if (gameState.truco?.status === "pending") {
      socket.emit("server:error", "Esperando respuesta de Truco");
      return;
    }
    if (gameState.envido?.status === "pending") {
      socket.emit("server:error", "Esperando respuesta de Envido");
      return;
    }
    if (isFlorEnvidoPending(gameState)) {
      socket.emit("server:error", "Esperando respuesta de Flor Envido");
      return;
    }
    if (gameState.turn !== socket.id) {
      socket.emit("server:error", "No es tu turno");
      return;
    }

    gameState.pardaSelections = gameState.pardaSelections || {};
    const selected = gameState.pardaSelections[socket.id];
    if (!selected?.bottomCard) return;
    if (selected.revealedBottom) return;

    selected.revealedBottom = true;
    const revealBottomCard = selected.bottomCard;
    if (selected.topCard) {
      selected.topCard = { ...selected.topCard, pardaRevealGap: true };
    }
    for (let i = gameState.tableCards.length - 1; i >= 0; i -= 1) {
      const c = gameState.tableCards[i];
      if (c.playerId === socket.id && c.pardaPair && c.pardaLayer === "bottom" && c.hiddenInParda) {
        gameState.tableCards[i] = { ...revealBottomCard, hiddenInParda: false };
        break;
      }
    }
    for (let i = gameState.tableCards.length - 1; i >= 0; i -= 1) {
      const c = gameState.tableCards[i];
      if (c.playerId === socket.id && c.pardaPair && c.pardaLayer === "top") {
        gameState.tableCards[i] = { ...gameState.tableCards[i], pardaRevealGap: true };
        break;
      }
    }

    const me = gameState.players.find((p) => p.id === socket.id);
    emitLockedMessage(roomId, gameState, `${me?.name || "Jugador"}: descubre carta`);

    const order = Array.isArray(gameState.pardaRevealOrder) ? gameState.pardaRevealOrder : [];
    const nextIndex = order.findIndex((id) => !gameState.pardaSelections?.[id]?.revealedBottom);
    if (nextIndex >= 0) {
      gameState.pardaRevealIndex = nextIndex;
      gameState.turn = order[nextIndex];
      emitGameUpdate(roomId, gameState);
      return;
    }

    const playerIds = gameState.players.map((p) => p.id);
    const selections = gameState.pardaSelections || {};
    const bottomPlays = [];
    for (const playerId of playerIds) {
      const entry = selections[playerId];
      if (!entry?.bottomCard) continue;
      bottomPlays.push({ ...entry.bottomCard, playerId, hiddenInParda: false });
    }

    const bottomWithRank = bottomPlays.map((card) => ({ card, rank: resolveHandRank(card, gameState.vira) }));
    const bestBottom = Math.max(...bottomWithRank.map((item) => item.rank));
    const bottomWinners = bottomWithRank.filter((item) => item.rank === bestBottom);
    const bottomWinnerId = resolveWinnerFromRankEntries(gameState, bottomWinners);
    const finalWinnerId = bottomWinnerId || gameState.pardaTopWinnerId || gameState.roundStarter || playerIds[0];

    resolveRound(room, finalWinnerId, roomId);
    emitGameUpdate(roomId, room.gameState);
  });

  socket.on("play:mazo", ({ roomId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", MSG.MAZO_BLOCKED_IN_CANTO11);
      return;
    }
    if (gameState.roundEnding) return;
    const mazoError = firstError(guardTurn(gameState, socket.id, MSG.NOT_TURN));
    if (mazoError) {
      socket.emit("server:error", mazoError);
      return;
    }
    if (isInputLocked(gameState)) return;
    if (isFlorEnvidoPending(gameState) || gameState.envido?.status === "pending" || gameState.truco?.status === "pending") {
      socket.emit("server:error", MSG.MAZO_BLOCKED_BY_PENDING_CALL);
      return;
    }
    if (isTrucoRaiseWindowOpen(gameState)) {
      socket.emit("server:error", MSG.MAZO_BLOCKED_BY_TRUCO_WINDOW);
      return;
    }

    if (gameState.pendingMazo?.callerId) {
      if (gameState.pendingMazo.callerId !== socket.id) {
        socket.emit("server:error", MSG.MAZO_PENDING_EXISTS);
        return;
      }
      if (!maybeResolvePendingMazo(room, roomId)) {
        socket.emit("server:error", MSG.MAZO_WAIT_FLOR_RESOLUTION);
      }
      return;
    }

    const opposingFlorNotSungIds = (gameState.players || [])
      .map((p) => p.id)
      .filter(
        (playerId) =>
          !isSameTeam(gameState, socket.id, playerId) &&
          !!gameState.flor?.hasFlorByPlayer?.[playerId] &&
          !gameState.flor?.burnedByPlayer?.[playerId] &&
          !gameState.flor?.sungByPlayer?.[playerId]
      );
    const callerSangFlor =
      !!gameState.flor?.sungByPlayer?.[socket.id] &&
      !!gameState.flor?.hasFlorByPlayer?.[socket.id] &&
      !gameState.flor?.burnedByPlayer?.[socket.id];

    if (callerSangFlor && opposingFlorNotSungIds.length > 0) {
      gameState.pendingMazo = {
        callerId: socket.id,
        awaitingOppFlorIds: opposingFlorNotSungIds,
      };
      gameState.turn = opposingFlorNotSungIds[0];
      emitLockedMessage(roomId, gameState, `${gameState.players.find((p) => p.id === socket.id)?.name || "Jugador"}: al mazo (pendiente Flor rival)`);
      emitGameUpdate(roomId, gameState);
      return;
    }

    resolveMazoForPlayer(room, roomId, socket.id);
  });

  socket.on("play:card", ({ roomId, cardIndex, faceDown }) => {
    if (!roomId || typeof cardIndex !== "number") return;

    const room = getRoom(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    if (isCanto11Active(gameState)) {
      socket.emit("server:error", MSG.WAIT_CANTO11);
      return;
    }
    if (gameState.roundEnding) {
      socket.emit("server:error", MSG.WAIT_ROUND_ENDING);
      return;
    }
    if (gameState.pendingMazo?.callerId) {
      socket.emit("server:error", MSG.WAIT_PENDING_FLOR_BEFORE_CONTINUE);
      return;
    }
    if (isTrucoRaiseWindowOpen(gameState)) {
      socket.emit("server:error", MSG.WAIT_TRUCO_RAISE_WINDOW);
      return;
    }
    if (isInputLocked(gameState)) return;
    if (gameState.truco?.status === "pending") {
      socket.emit("server:error", MSG.WAIT_PENDING_TRUCO);
      return;
    }
    if (gameState.envido?.status === "pending") {
      socket.emit("server:error", MSG.WAIT_PENDING_ENVIDO);
      return;
    }
    if (isFlorEnvidoPending(gameState)) {
      socket.emit("server:error", MSG.WAIT_PENDING_FLOR_ENVIDO);
      return;
    }
    if (gameState.firstHandTie && gameState.pardaPhase === "selecting") {
      socket.emit("server:error", MSG.MUST_SELECT_PARDA_CARDS);
      return;
    }
    if (gameState.firstHandTie && gameState.pardaPhase === "reveal") {
      socket.emit("server:error", "Debes descubrir la carta de abajo");
      return;
    }

    if (guardTurn(gameState, socket.id, MSG.NOT_TURN)) {
      socket.emit("server:error", MSG.NOT_TURN);
      return;
    }
    ensureAwayByPlayer(gameState);
    gameState.awayByPlayer[socket.id] = false;
    turnTimerLog("play-card", {
      roomId,
      playerId: socket.id,
      turn: gameState.turn,
      cardIndex,
      faceDown: !!faceDown,
    });
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
      socket.emit("server:error", MSG.INVALID_CARD);
      return;
    }

    const [playedCard] = hand.splice(cardIndex, 1);
    const currentHandNumber = Number(gameState.handNumber || 1);
    const forceFaceDown =
      !!gameState.forcedFaceDownByPlayer?.[socket.id] &&
      currentHandNumber >= 2;
    const useFaceDown = !!faceDown || forceFaceDown;
    if (currentHandNumber === 1 && !!faceDown) {
      gameState.forcedFaceDownByPlayer = gameState.forcedFaceDownByPlayer || {};
      gameState.forcedFaceDownByPlayer[socket.id] = true;
    }
    const cardToPlay = useFaceDown
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
      emitGameUpdate(roomId, gameState);
      return;
    }

    const handStarterId = gameState.currentHandStarter;
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
      emitGameUpdate(roomId, gameState);
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
      emitGameUpdate(roomId, room.gameState);
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
        emitGameUpdate(roomId, room.gameState);
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
      emitGameUpdate(roomId, room.gameState);
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
    emitGameUpdate(roomId, gameState);
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
    emitGameUpdate(roomId, gameState);
    scheduleBotRematchVotes(room, roomId);
    finalizeRematchIfReady(room, roomId);
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
    removeFromVoiceRoom(socket, "disconnect", socket.data.voiceRoomId);
    for (const key of teamSignalCooldownByPlayer.keys()) {
      if (key.endsWith(`:${socket.id}`)) {
        teamSignalCooldownByPlayer.delete(key);
      }
    }

    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (player && room.gameState) {
      player.connected = false;
      player.lastSeenAt = Date.now();
      ensureAwayByPlayer(room.gameState);
      room.gameState.awayByPlayer[socket.id] = true;
      turnTimerLog("disconnect-mark-away", {
        roomId,
        playerId: socket.id,
        turn: room.gameState.turn,
      });
      clearSeatTimeout(roomId, socket.id);

      io.to(roomId).emit("room:update", room);
      emitGameUpdate(roomId, room.gameState);
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

const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${PORT}`);
});
