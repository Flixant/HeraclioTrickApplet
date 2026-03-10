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

function computeFlorValue(cards, vira) {
  return computeEnvido(cards, vira);
}

module.exports = {
  resolveHandRank,
  computeEnvido,
  computeFlorValue,
};
