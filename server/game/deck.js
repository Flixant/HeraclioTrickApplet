const cardDefs = require("../../shared/cards.json");

const deckMap = new Map(cardDefs.map((card) => [`${card.suit}-${card.value}`, card]));

function getCardRank(card) {
  if (!card) return 0;
  const def = deckMap.get(`${card.suit}-${card.value}`);
  return def?.rank ?? 0;
}

function createDeck(allowedSuits = null) {
  const allowSet =
    Array.isArray(allowedSuits) && allowedSuits.length > 0
      ? new Set(allowedSuits)
      : null;

  return cardDefs
    .filter((card) => (allowSet ? allowSet.has(card.suit) : true))
    .map((card) => ({ ...card }));
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

module.exports = { createDeck, shuffle, getCardRank };
