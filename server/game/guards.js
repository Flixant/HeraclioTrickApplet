function firstError(...checks) {
  for (const check of checks) {
    if (check) return check;
  }
  return null;
}

function guardTurn(gameState, playerId, message) {
  return gameState?.turn !== playerId ? message : null;
}

module.exports = {
  firstError,
  guardTurn,
};
