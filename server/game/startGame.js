const { createDeck, shuffle } = require("./deck");

function dealCards(players, options = {}) {
  const deck = createDeck(options.allowedSuits);
  shuffle(deck);

  const hands = {};

  for (const playerId of players) {
    hands[playerId] = [];
  }

  for (let round = 0; round < 3; round += 1) {
    for (const playerId of players) {
      hands[playerId].push(deck.pop());
    }
  }

  const vira = deck.pop();
  return { deck, hands, vira };
}

function cloneHands(hands) {
  const snapshot = {};
  for (const [playerId, cards] of Object.entries(hands)) {
    snapshot[playerId] = cards.map((card) => ({ ...card }));
  }
  return snapshot;
}

function buildTeams(players, mode) {
  if (!Array.isArray(players) || players.length === 0) {
    return { team1: [], team2: [] };
  }

  if (mode === "2vs2" && players.length >= 4) {
    return {
      team1: [players[0], players[2]].filter(Boolean),
      team2: [players[1], players[3]].filter(Boolean),
    };
  }

  return {
    team1: [players[0]].filter(Boolean),
    team2: [players[1]].filter(Boolean),
  };
}

function isPericoOrPerica(card, vira) {
  if (!card || !vira) return false;
  if (card.suit !== vira.suit) return false;

  const viraValue = Number(vira.value);
  const cardValue = Number(card.value);
  const pericoValue = viraValue === 11 ? 12 : 11;
  const pericaValue = viraValue === 10 ? 12 : 10;
  return cardValue === pericoValue || cardValue === pericaValue;
}

function isPerico(card, vira) {
  if (!card || !vira || card.suit !== vira.suit) return false;
  const viraValue = Number(vira.value);
  const cardValue = Number(card.value);
  const pericoValue = viraValue === 11 ? 12 : 11;
  return cardValue === pericoValue;
}

function isPerica(card, vira) {
  if (!card || !vira || card.suit !== vira.suit) return false;
  const viraValue = Number(vira.value);
  const cardValue = Number(card.value);
  const pericaValue = viraValue === 10 ? 12 : 10;
  return cardValue === pericaValue;
}

function hasFlor(cards, vira) {
  if (!Array.isArray(cards) || cards.length !== 3) return false;
  const firstSuit = cards[0]?.suit;
  if (cards.every((card) => card?.suit === firstSuit)) return true;

  const specialCards = cards.filter((card) => isPericoOrPerica(card, vira));
  if (specialCards.length !== 1) return false;

  const regularCards = cards.filter((card) => !isPericoOrPerica(card, vira));
  if (regularCards.length !== 2) return false;

  return regularCards[0]?.suit === regularCards[1]?.suit;
}

function hasFlorReservada(cards, vira) {
  if (!Array.isArray(cards) || cards.length !== 3) return false;
  const hasPerico = cards.some((card) => isPerico(card, vira));
  const hasPerica = cards.some((card) => isPerica(card, vira));
  return hasPerico && hasPerica;
}

function buildFlorState(players, hands, vira) {
  const hasFlorByPlayer = {};
  const reservadaByPlayer = {};
  const sungByPlayer = {};
  const burnedByPlayer = {};
  const burnedReasonByPlayer = {};
  const leyByPlayer = {};
  const requireThirdByPlayer = {};
  const florEnvidoSkippedByPlayer = {};
  let reservadaOwnerId = null;

  for (const playerId of players) {
    const cards = hands[playerId] || [];
    const hasReservada = hasFlorReservada(cards, vira);
    hasFlorByPlayer[playerId] = hasFlor(cards, vira) || hasReservada;
    reservadaByPlayer[playerId] = hasReservada;
    if (hasReservada && !reservadaOwnerId) {
      reservadaOwnerId = playerId;
    }
    sungByPlayer[playerId] = false;
    burnedByPlayer[playerId] = false;
    burnedReasonByPlayer[playerId] = null;
    leyByPlayer[playerId] = false;
    requireThirdByPlayer[playerId] = false;
    florEnvidoSkippedByPlayer[playerId] = false;
  }

  return {
    status: "idle",
    callerId: null,
    responderId: null,
    hasFlorByPlayer,
    reservadaByPlayer,
    reservadaOwnerId,
    sungByPlayer,
    burnedByPlayer,
    burnedReasonByPlayer,
    leyByPlayer,
    requireThirdByPlayer,
    points: 3,
    florEnvidoCalled: false,
    florEnvidoStatus: "idle",
    florEnvidoCallerId: null,
    florEnvidoResponderId: null,
    florEnvidoPoints: 0,
    florEnvidoAcceptedPoints: 0,
    florEnvidoWindowOpen: false,
    florEnvidoWindowTurnId: null,
    florEnvidoSkippedByPlayer,
    winnerId: null,
    resolved: false,
  };
}

function startGame(room) {
  const players = room.players.map((p) => p.id);
  const deckConfig = room.deckConfig || { allowedSuits: null };
  const { deck, hands, vira } = dealCards(players, deckConfig);
  const pointsByPlayer = {};
  const handWinsByPlayer = {};

  for (const playerId of players) {
    pointsByPlayer[playerId] = 0;
    handWinsByPlayer[playerId] = 0;
  }

  room.status = "playing";
  room.gameState = {
    started: true,
    roomId: room.id,
    mode: room.mode,
    deckConfig: {
      allowedSuits: deckConfig.allowedSuits || null,
    },
    players: room.players,
    deck,
    vira,
    hands,
    roundHandsSnapshot: cloneHands(hands),
    tableCards: [],
    currentHandCards: [],
    currentHandStarter: players[0],
    roundStarter: players[0],
    handNumber: 1,
    handResults: [],
    firstHandTie: false,
    pardaPhase: null,
    pardaSelections: {},
    roundEnding: false,
    matchEnded: false,
    matchWinnerId: null,
    matchEndedAt: null,
    rematch: null,
    inputLockedUntil: 0,
    roundPointValue: 1,
    truco: {
      status: "idle",
      callerId: null,
      responderId: null,
      callType: null,
      proposedValue: null,
      acceptedById: null,
    },
    envido: {
      status: "idle",
      callerId: null,
      responderId: null,
      callType: null,
      winnerId: null,
      points: 0,
      acceptedPoints: 0,
      envidoByPlayer: {},
      resolved: false,
    },
    flor: buildFlorState(players, hands, vira),
    turn: players[0],
    teams: buildTeams(players, room.mode),
    pointsByPlayer,
    handWinsByPlayer,
    score: {
      team1: 0,
      team2: 0,
    },
  };

  return room.gameState;
}

function redealRound(room, starterId) {
  const gameState = room.gameState;
  if (!gameState) return null;

  const players = room.players.map((p) => p.id);
  const startTurn = players.includes(starterId) ? starterId : players[0];
  const deckConfig = gameState.deckConfig || room.deckConfig || { allowedSuits: null };
  const { deck, hands, vira } = dealCards(players, deckConfig);
  const handWinsByPlayer = {};

  for (const playerId of players) {
    handWinsByPlayer[playerId] = 0;
    if (typeof gameState.pointsByPlayer?.[playerId] !== "number") {
      gameState.pointsByPlayer = gameState.pointsByPlayer || {};
      gameState.pointsByPlayer[playerId] = 0;
    }
  }

  gameState.deck = deck;
  gameState.deckConfig = {
    allowedSuits: deckConfig.allowedSuits || null,
  };
  gameState.vira = vira;
  gameState.hands = hands;
  gameState.roundHandsSnapshot = cloneHands(hands);
  gameState.tableCards = [];
  gameState.currentHandCards = [];
  gameState.currentHandStarter = startTurn;
  gameState.roundStarter = startTurn;
  gameState.handNumber = 1;
  gameState.handResults = [];
  gameState.firstHandTie = false;
  gameState.pardaPhase = null;
  gameState.pardaSelections = {};
  gameState.roundEnding = false;
  gameState.matchEnded = false;
  gameState.matchWinnerId = null;
  gameState.matchEndedAt = null;
  gameState.rematch = null;
  gameState.inputLockedUntil = 0;
  gameState.roundPointValue = 1;
  gameState.truco = {
    status: "idle",
    callerId: null,
    responderId: null,
    callType: null,
    proposedValue: null,
    acceptedById: null,
  };
  gameState.envido = {
    status: "idle",
    callerId: null,
    responderId: null,
    callType: null,
    winnerId: null,
    points: 0,
    acceptedPoints: 0,
    envidoByPlayer: {},
    resolved: false,
  };
  gameState.flor = buildFlorState(players, hands, vira);
  gameState.turn = startTurn;
  gameState.teams = buildTeams(players, room.mode);
  if (!gameState.score || typeof gameState.score.team1 !== "number" || typeof gameState.score.team2 !== "number") {
    gameState.score = {
      team1: 0,
      team2: 0,
    };
  }
  gameState.handWinsByPlayer = handWinsByPlayer;

  return gameState;
}

startGame.redealRound = redealRound;
module.exports = startGame;
