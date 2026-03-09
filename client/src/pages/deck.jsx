import cardDefs from '@shared/cards.json';

import bastos1 from '../assets/bastos/PALOS-1.svg';
import bastos2 from '../assets/bastos/PALOS-2.svg';
import bastos3 from '../assets/bastos/PALOS-3.svg';
import bastos4 from '../assets/bastos/PALOS-4.svg';
import bastos5 from '../assets/bastos/PALOS-5.svg';
import bastos6 from '../assets/bastos/PALOS-6.svg';
import bastos7 from '../assets/bastos/PALOS-7.svg';
import bastos10 from '../assets/bastos/PALOS-10.svg';
import bastos11 from '../assets/bastos/PALOS-11.svg';
import bastos12 from '../assets/bastos/PALOS-12.svg';

import copas1 from '../assets/copas/COPA-1.svg';
import copas2 from '../assets/copas/COPA-2.svg';
import copas3 from '../assets/copas/COPA-3.svg';
import copas4 from '../assets/copas/COPA-4.svg';
import copas5 from '../assets/copas/COPA-5.svg';
import copas6 from '../assets/copas/COPA-6.svg';
import copas7 from '../assets/copas/COPA-7.svg';
import copas10 from '../assets/copas/COPA-10.svg';
import copas11 from '../assets/copas/COPA-11.svg';
import copas12 from '../assets/copas/COPA-12.svg';

import espadas1 from '../assets/espadas/ESPADA-1.svg';
import espadas2 from '../assets/espadas/ESPADA-2.svg';
import espadas3 from '../assets/espadas/ESPADA-3.svg';
import espadas4 from '../assets/espadas/ESPADA-4.svg';
import espadas5 from '../assets/espadas/ESPADA-5.svg';
import espadas6 from '../assets/espadas/ESPADA-6.svg';
import espadas7 from '../assets/espadas/ESPADA-7.svg';
import espadas10 from '../assets/espadas/ESPADA-10.svg';
import espadas11 from '../assets/espadas/ESPADA-11.svg';
import espadas12 from '../assets/espadas/ESPADA-12.svg';

import oros1 from '../assets/oros/OURO-1.svg';
import oros2 from '../assets/oros/OURO-2.svg';
import oros3 from '../assets/oros/OURO-3.svg';
import oros4 from '../assets/oros/OURO-4.svg';
import oros5 from '../assets/oros/OURO-5.svg';
import oros6 from '../assets/oros/OURO-6.svg';
import oros7 from '../assets/oros/OURO-7.svg';
import oros10 from '../assets/oros/OURO-10.svg';
import oros11 from '../assets/oros/OURO-11.svg';
import oros12 from '../assets/oros/OURO-12.svg';

import backCardImage from '../assets/back_card.svg';

const imageByCardKey = {
  'bastos-1': bastos1,
  'bastos-2': bastos2,
  'bastos-3': bastos3,
  'bastos-4': bastos4,
  'bastos-5': bastos5,
  'bastos-6': bastos6,
  'bastos-7': bastos7,
  'bastos-10': bastos10,
  'bastos-11': bastos11,
  'bastos-12': bastos12,

  'copas-1': copas1,
  'copas-2': copas2,
  'copas-3': copas3,
  'copas-4': copas4,
  'copas-5': copas5,
  'copas-6': copas6,
  'copas-7': copas7,
  'copas-10': copas10,
  'copas-11': copas11,
  'copas-12': copas12,

  'espadas-1': espadas1,
  'espadas-2': espadas2,
  'espadas-3': espadas3,
  'espadas-4': espadas4,
  'espadas-5': espadas5,
  'espadas-6': espadas6,
  'espadas-7': espadas7,
  'espadas-10': espadas10,
  'espadas-11': espadas11,
  'espadas-12': espadas12,

  'oros-1': oros1,
  'oros-2': oros2,
  'oros-3': oros3,
  'oros-4': oros4,
  'oros-5': oros5,
  'oros-6': oros6,
  'oros-7': oros7,
  'oros-10': oros10,
  'oros-11': oros11,
  'oros-12': oros12,
};

const deck = cardDefs.map((card) => ({
  ...card,
  image: imageByCardKey[`${card.suit}-${card.value}`],
}));

const deckMap = new Map(deck.map((card) => [`${card.suit}-${card.value}`, card]));

const getDeckCard = (card) => {
  if (!card) return null;
  return deckMap.get(`${card.suit}-${card.value}`) || null;
};

const renderCard = (card) => {
  if (!card) return null;
  if (card.rank === 0) return renderBackCard();

  return (
    <div
      className="relative inline-block shrink-0 border-2 border-slate-200 aspect-[48/75] h-[75px] bg-white rounded-sm shadow-sm"
      style={{ colorScheme: 'light' }}
    >
      <div className="absolute top-[0.2rem] left-[0.3rem] text-[0.6rem] sm:text-xs font-semibold text-slate-600">
        {card.value}
      </div>

      <img
        src={card.image}
        alt={`Carta de ${card.suit} ${card.value}`}
        className="absolute inset-0 w-full h-full object-contain rounded-sm"
        style={{ colorScheme: 'light' }}
      />

      <div className="absolute bottom-[0.2rem] right-[0.3rem] text-[0.6rem] sm:text-xs font-semibold text-slate-600">
        {card.value}
      </div>
    </div>
  );
};

const renderBackCard = () => (
  <div className="relative inline-block shrink-0 aspect-[48/75] h-[75px] bg-gray-700 rounded-sm shadow-sm overflow-hidden">
    <img
      src={backCardImage}
      alt="Back of card"
      className="absolute inset-0 w-full h-full object-cover"
      style={{ colorScheme: 'light' }}
    />
  </div>
);

export { deck, getDeckCard, renderCard, renderBackCard };
