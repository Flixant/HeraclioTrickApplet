const VENEZUELA_IATA_CODES = [
  "CCS",
  "MAR",
  "VLN",
  "PMV",
  "BLA",
  "CUM",
  "PZO",
  "BRM",
  "LSP",
  "LFR",
  "SVZ",
  "CBL",
];

function random3Digits() {
  return String(Math.floor(Math.random() * 1000)).padStart(3, "0");
}

function generateCode(used) {
  while (true) {
    const iata =
      VENEZUELA_IATA_CODES[
        Math.floor(Math.random() * VENEZUELA_IATA_CODES.length)
      ];
    const code = iata + random3Digits();
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
  }
}

function createInitialRooms() {
  const used = new Set();
  const generatedRooms = {};

  for (let i = 0; i < 9; i += 1) {
    const id = generateCode(used);
    generatedRooms[id] = {
      id,
      mode: "1vs1",
      maxPlayers: 2,
      players: [],
      status: "waiting",
      gameState: null,
    };
  }

  for (let i = 0; i < 9; i += 1) {
    const id = generateCode(used);
    generatedRooms[id] = {
      id,
      mode: "2vs2",
      maxPlayers: 4,
      players: [],
      status: "waiting",
      gameState: null,
    };
  }

  const botRoomId = "BOTTEST";
  used.add(botRoomId);
  generatedRooms[botRoomId] = {
    id: botRoomId,
    mode: "2vs2",
    maxPlayers: 4,
    players: [],
    status: "waiting",
    gameState: null,
    allowBots: true,
  };

  const botDuelRoomId = "BOTDUEL";
  used.add(botDuelRoomId);
  generatedRooms[botDuelRoomId] = {
    id: botDuelRoomId,
    mode: "1vs1",
    maxPlayers: 2,
    players: [],
    status: "waiting",
    gameState: null,
    allowBots: true,
  };

  return generatedRooms;
}

const rooms = createInitialRooms();

function getPublicRooms() {
  return Object.values(rooms).map((room) => ({
    id: room.id,
    mode: room.mode,
    allowBots: !!room.allowBots,
    maxPlayers: room.maxPlayers,
    players: room.players,
    status: room.status,
  }));
}

function getRoom(id) {
  return rooms[id];
}

function addPlayer(roomId, player) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: "Room no existe" };

  const existingPlayer = room.players.find((existing) => existing.id === player.id);
  if (existingPlayer) {
    existingPlayer.name = player.name || existingPlayer.name;
    existingPlayer.reconnectToken = player.reconnectToken || existingPlayer.reconnectToken || null;
    existingPlayer.connected = typeof player.connected === "boolean" ? player.connected : existingPlayer.connected;
    existingPlayer.lastSeenAt = player.lastSeenAt || Date.now();
    existingPlayer.avatarUrl = player.avatarUrl || "";
    existingPlayer.profileId = player.profileId || existingPlayer.profileId || null;
    existingPlayer.playerUid = player.playerUid || existingPlayer.playerUid || null;
    return { ok: true, room };
  }

  if (room.allowBots) {
    const hasHuman = room.players.some((existing) => !String(existing.id).startsWith("bot:"));
    if (hasHuman && !String(player.id).startsWith("bot:")) {
      return { ok: false, error: "Sala de testing con bots ocupada" };
    }
  }

  if (room.players.length >= room.maxPlayers) {
    return { ok: false, error: "Room llena" };
  }

  room.players.push(player);
  room.status = room.players.length === room.maxPlayers ? "full" : "waiting";

  return { ok: true, room };
}

function removePlayer(roomId, socketId) {
  const room = rooms[roomId];
  if (!room) return null;

  room.players = room.players.filter((player) => player.id !== socketId);
  if (room.allowBots) {
    room.players = room.players.filter((player) => !String(player.id).startsWith("bot:"));
  }
  room.status = "waiting";
  room.gameState = null;

  return room;
}

module.exports = { rooms, getPublicRooms, getRoom, addPlayer, removePlayer };
