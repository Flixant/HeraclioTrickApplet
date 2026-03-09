import { useEffect, useRef, useState } from "react";
import { socket } from "../socket";
import { getDeckCard, preloadDeckAssets, renderBackCard, renderCard } from "./deck";

function Mesa2v2({ roomId, gameState, onLeaveToRoomList }) {
  const [state, setState] = useState(gameState);
  const stateRef = useRef(gameState);
  const [message, setMessage] = useState("");
  const messageTimeoutRef = useRef(null);
  const [showAdvancedCantos, setShowAdvancedCantos] = useState(false);
  const [showAdvancedJugadas, setShowAdvancedJugadas] = useState(false);
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [passCardArmed, setPassCardArmed] = useState(false);
  const [pardaDraft, setPardaDraft] = useState([]);

  useEffect(() => {
    preloadDeckAssets();
  }, []);

  useEffect(() => {
    setState(gameState);
    stateRef.current = gameState;
    setMessage("");
    if (messageTimeoutRef.current) {
      clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = null;
    }
  }, [gameState, roomId]);

  useEffect(() => {
    function onGameUpdate(payload) {
      const payloadRoomId = payload?.roomId;
      const nextState = payload?.gameState || payload;
      if (!nextState) return;
      if (payloadRoomId && payloadRoomId !== roomId) return;
      const nextVersion = Number(nextState.stateVersion) || 0;
      const currentVersion = Number(stateRef.current?.stateVersion) || 0;
      if (nextVersion < currentVersion) return;
      stateRef.current = nextState;
      setState({ ...nextState });
    }

    function onServerMessage(msg) {
      const isMatchEndMessage = /gana la partida|llego a 12|llegó a 12/i.test(String(msg || ""));
      if (isMatchEndMessage && !stateRef.current?.matchEnded) {
        return;
      }
      if (messageTimeoutRef.current) {
        clearTimeout(messageTimeoutRef.current);
      }
      setMessage(msg);
      messageTimeoutRef.current = setTimeout(() => {
        setMessage("");
        messageTimeoutRef.current = null;
      }, 1700);
    }

    socket.on("game:update", onGameUpdate);
    socket.on("server:message", onServerMessage);

    return () => {
      if (messageTimeoutRef.current) {
        clearTimeout(messageTimeoutRef.current);
      }
      socket.off("game:update", onGameUpdate);
      socket.off("server:message", onServerMessage);
    };
  }, [roomId]);

  if (!state) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-emerald-950 text-white">
        Cargando mesa...
      </div>
    );
  }

  const myCards = state.hands[socket.id] || [];
  const mySeatIndex = state.players.findIndex((p) => p.id === socket.id);
  const safeMySeat = mySeatIndex >= 0 ? mySeatIndex : 0;
  const seatPlayerByOffset = (offset) => {
    if (!state.players.length) return null;
    const idx = (safeMySeat + offset + state.players.length) % state.players.length;
    return state.players[idx] || null;
  };
  const opponent = seatPlayerByOffset(2);
  const leftPlayer = seatPlayerByOffset(1);
  const rightPlayer = seatPlayerByOffset(3);
  const opponentCards = state.hands[opponent?.id] || [];
  const leftCards = state.hands[leftPlayer?.id] || [];
  const rightCards = state.hands[rightPlayer?.id] || [];
  const currentPlayer = state.players.find((p) => p.id === state.turn);
  const isMyTurn = state.turn === socket.id;
  const roundStarterId = state.roundStarter || state.currentHandStarter || state.turn || null;
  const starterIndex = state.players.findIndex((p) => p.id === roundStarterId);
  const starterOffset =
    starterIndex >= 0
      ? (starterIndex - safeMySeat + state.players.length) % state.players.length
      : 0;

  const myPlayedCards = state.tableCards.filter((card) => card.playerId === socket.id);
  const opponentPlayedCards = opponent
    ? state.tableCards.filter((card) => card.playerId === opponent.id)
    : [];
  const leftPlayedCards = leftPlayer
    ? state.tableCards.filter((card) => card.playerId === leftPlayer.id)
    : [];
  const rightPlayedCards = rightPlayer
    ? state.tableCards.filter((card) => card.playerId === rightPlayer.id)
    : [];

  const roundPointValue = state.roundPointValue ?? 1;
  const serverTeam1Ids = Array.isArray(state.teams?.team1) ? state.teams.team1 : [];
  const serverTeam2Ids = Array.isArray(state.teams?.team2) ? state.teams.team2 : [];
  const nsTeamIds = serverTeam1Ids.length
    ? serverTeam1Ids
    : [state.players[0]?.id, state.players[2]?.id].filter(Boolean);
  const eoTeamIds = serverTeam2Ids.length
    ? serverTeam2Ids
    : [state.players[1]?.id, state.players[3]?.id].filter(Boolean);
  const nameById = new Map((state.players || []).map((p) => [p.id, p.name]));
  const nsTeamNames = nsTeamIds.map((id) => nameById.get(id)).filter(Boolean).join(" / ");
  const eoTeamNames = eoTeamIds.map((id) => nameById.get(id)).filter(Boolean).join(" / ");
  const hasTeamScore =
    typeof state.score?.team1 === "number" &&
    typeof state.score?.team2 === "number";
  const nsTeamPoints = hasTeamScore
    ? state.score.team1
    : nsTeamIds.reduce((acc, id) => acc + (state.pointsByPlayer?.[id] ?? 0), 0);
  const eoTeamPoints = hasTeamScore
    ? state.score.team2
    : eoTeamIds.reduce((acc, id) => acc + (state.pointsByPlayer?.[id] ?? 0), 0);
  const isSameTeamByState = (playerA, playerB) => {
    if (!playerA || !playerB) return false;
    const team1 = Array.isArray(state.teams?.team1) ? state.teams.team1 : [];
    const team2 = Array.isArray(state.teams?.team2) ? state.teams.team2 : [];
    if (team1.length || team2.length) {
      return (
        (team1.includes(playerA) && team1.includes(playerB)) ||
        (team2.includes(playerA) && team2.includes(playerB))
      );
    }
    const aIdx = state.players.findIndex((p) => p.id === playerA);
    const bIdx = state.players.findIndex((p) => p.id === playerB);
    if (aIdx < 0 || bIdx < 0) return false;
    return aIdx % 2 === bIdx % 2;
  };

  const trucoState = state.truco || { status: "idle", callerId: null, responderId: null };
  const isTrucoPending = trucoState.status === "pending";
  const isTrucoResponder =
    isTrucoPending &&
    (trucoState.responderId === socket.id ||
      isSameTeamByState(trucoState.responderId, socket.id));
  const isTrucoCallerWaiting =
    isTrucoPending &&
    (trucoState.callerId === socket.id ||
      isSameTeamByState(trucoState.callerId, socket.id));
  const envidoState = state.envido || { status: "idle" };
  const isEnvidoPending = envidoState.status === "pending";
  const isFaltaEnvidoPending = isEnvidoPending && envidoState.callType === "falta";
  const isEnvidoResponder =
    isEnvidoPending &&
    (envidoState.responderId === socket.id ||
      isSameTeamByState(envidoState.responderId, socket.id));
  const isEnvidoCallerWaiting =
    isEnvidoPending &&
    (envidoState.callerId === socket.id ||
      isSameTeamByState(envidoState.callerId, socket.id));
  const florState = state.flor || { status: "idle", hasFlorByPlayer: {}, reservadaByPlayer: {}, sungByPlayer: {}, burnedByPlayer: {}, leyByPlayer: {} };
  const isFlorPending = (florState.florEnvidoStatus || "idle") === "pending";
  const isFlorResponder =
    isFlorPending &&
    (florState.florEnvidoResponderId === socket.id ||
      isSameTeamByState(florState.florEnvidoResponderId, socket.id));
  const isFlorCallerWaiting =
    isFlorPending &&
    (florState.florEnvidoCallerId === socket.id ||
      isSameTeamByState(florState.florEnvidoCallerId, socket.id));
  const myHasAvailableFlor =
    !!florState.hasFlorByPlayer?.[socket.id] &&
    (!florState.sungByPlayer?.[socket.id] || !!florState.requireThirdByPlayer?.[socket.id]) &&
    !florState.burnedByPlayer?.[socket.id];
  const myHasFlorReservada = !!florState.reservadaByPlayer?.[socket.id];
  const myPlayedLey = !!florState.leyByPlayer?.[socket.id];
  const myMustConfirmFlorThird = !!florState.requireThirdByPlayer?.[socket.id];
  const florAlreadySung = Object.values(florState.sungByPlayer || {}).some(Boolean);
  const nsTeamSangFlor = nsTeamIds.some((id) => !!florState.sungByPlayer?.[id]);
  const eoTeamSangFlor = eoTeamIds.some((id) => !!florState.sungByPlayer?.[id]);
  const bothTeamsSangFlor = nsTeamSangFlor && eoTeamSangFlor;
  const pendingCallType = isFlorPending ? "florEnvido" : isTrucoPending ? "truco" : isEnvidoPending ? "envido" : null;
  const isPendingResponder = isTrucoResponder || isEnvidoResponder || isFlorResponder;
  const isPendingCallerWaiting = isTrucoCallerWaiting || isEnvidoCallerWaiting || isFlorCallerWaiting;
  const hasPendingCall = isTrucoPending || isEnvidoPending || isFlorPending;
  const isPardaSelecting = state.firstHandTie && state.pardaPhase === "selecting";
  const hasSubmittedParda = isPardaSelecting && !!state.pardaSelections?.[socket.id];
  const playerIds = state.players.map((p) => p.id);
  const isInFirstHand =
    Object.values(state.handWinsByPlayer || {}).every((wins) => wins === 0) &&
    (state.tableCards?.length || 0) < playerIds.length;
  const canCallEnvido =
    isMyTurn &&
    envidoState.status === "idle" &&
    isInFirstHand &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending &&
    !florAlreadySung &&
    !myHasAvailableFlor;
  const canCallFlor =
    (isMyTurn || myMustConfirmFlorThird) &&
    (isInFirstHand || myPlayedLey || myMustConfirmFlorThird) &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending &&
    myHasAvailableFlor;

  const nextCallByValue = {
    1: { label: "Truco", event: "call:truco", requiresAcceptedBy: false },
    3: { label: "Retruco", event: "call:retruco", requiresAcceptedBy: true },
    6: { label: "Vale 9", event: "call:vale9", requiresAcceptedBy: true },
    9: { label: "Vale Juego", event: "call:valejuego", requiresAcceptedBy: true },
  };

  const nextCall = nextCallByValue[roundPointValue] || null;
  const acceptedByMyTeam =
    !!trucoState.acceptedById &&
    (trucoState.acceptedById === socket.id ||
      isSameTeamByState(trucoState.acceptedById, socket.id));
  const canCallNextRaise =
    !!nextCall &&
    isMyTurn &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending &&
    (!nextCall.requiresAcceptedBy || acceptedByMyTeam);

  const me = state.players.find((p) => p.id === socket.id);
  const isMatchEnded = !!state.matchEnded;
  const rematch = state.rematch || { decisionsByPlayer: {}, resolved: false, result: null, status: "pending" };
  const myRematchDecision = rematch.decisionsByPlayer?.[socket.id] || null;
  const rematchVotes = state.players.map((p) => ({
    id: p.id,
    name: p.name || "Jugador",
    decision: rematch.decisionsByPlayer?.[p.id] || null,
  }));
  const everyoneAnsweredRematch =
    rematchVotes.length > 0 && rematchVotes.every((v) => v.decision === "replay" || v.decision === "exit");
  const isBastosEspadasMode =
    Array.isArray(state.deckConfig?.allowedSuits) &&
    state.deckConfig.allowedSuits.length === 2 &&
    state.deckConfig.allowedSuits.includes("bastos") &&
    state.deckConfig.allowedSuits.includes("espadas");
  const viraPositionClassByOffset = {
    0: "left-4 bottom-4 sm:left-6 sm:bottom-6", // Sur: izquierda del local
    1: "left-4 top-4 sm:left-6 sm:top-6", // Oeste: izquierda del oeste (hacia arriba)
    2: "right-4 top-4 sm:right-6 sm:top-6", // Norte: izquierda del norte (hacia derecha)
    3: "right-4 bottom-4 sm:right-6 sm:bottom-6", // Este: izquierda del este (hacia abajo)
  };
  const viraPositionClass =
    viraPositionClassByOffset[starterOffset] || "left-4 bottom-4 sm:left-6 sm:bottom-6";

  const playCard = (cardIndex) => {
    if (hasPendingCall) return;
    if (isPardaSelecting) {
      if (hasSubmittedParda) return;

      setPardaDraft((prev) => {
        if (prev.includes(cardIndex)) {
          return prev.filter((idx) => idx !== cardIndex);
        }

        if (prev.length >= 2) {
          return prev;
        }

        const next = [...prev, cardIndex];
        if (next.length === 2) {
          socket.emit("parda:select", {
            roomId,
            bottomIndex: next[0],
            topIndex: next[1],
          });
          return [];
        }

        return next;
      });
      return;
    }

    socket.emit("play:card", { roomId, cardIndex, faceDown: passCardArmed });
    if (passCardArmed) {
      setPassCardArmed(false);
    }
  };

  const callNextRaise = () => {
    if (!nextCall) return;
    socket.emit(nextCall.event, { roomId });
  };

  const callEnvido = () => {
    if (myHasAvailableFlor) {
      socket.emit("call:flor", { roomId });
      return;
    }
    socket.emit("call:envido", { roomId });
  };

  const toggleTestDeckMode = () => {
    socket.emit("debug:set-deck-mode", {
      roomId,
      onlyBastosEspadas: !isBastosEspadasMode,
    });
  };

  const redealTestRound = () => {
    socket.emit("debug:redeal-round", { roomId });
  };

  const forceTestFlor = () => {
    socket.emit("debug:force-flor", { roomId });
  };

  const forceTestFlorReservada = () => {
    socket.emit("debug:force-flor-reservada", { roomId });
  };

  const acceptPendingCall = () => {
    if (pendingCallType === "florEnvido") {
      socket.emit("flor-envido:accept", { roomId });
      return;
    }
    if (pendingCallType === "truco") {
      socket.emit("truco:accept", { roomId });
      return;
    }
    if (pendingCallType === "envido") {
      socket.emit("envido:accept", { roomId });
    }
  };

  const rejectPendingCall = () => {
    if (pendingCallType === "florEnvido") {
      socket.emit("flor-envido:reject", { roomId });
      return;
    }
    if (pendingCallType === "truco") {
      socket.emit("truco:reject", { roomId });
      return;
    }
    if (pendingCallType === "envido") {
      socket.emit("envido:reject", { roomId });
    }
  };

  const raiseEnvido = (kind = "envido") => {
    if (pendingCallType === "florEnvido" && kind === "envido" && isPendingResponder) {
      socket.emit("flor-envido:raise", { roomId });
      return;
    }

    if (kind === "falta") {
      if (isPendingResponder && pendingCallType === "envido") {
        socket.emit("envido:raise", { roomId, kind: "falta" });
        return;
      }
      if (envidoState.status === "idle" && isInFirstHand && !isTrucoPending && !isEnvidoPending && !isFlorPending) {
        socket.emit("call:falta-envido", { roomId });
      }
      return;
    }

    socket.emit("envido:raise", { roomId, kind });
  };
  const canUseAdvancedEnvido =
    isPendingResponder &&
    ((pendingCallType === "envido" && !isFaltaEnvidoPending) || pendingCallType === "florEnvido") &&
    !florAlreadySung;
  const canCallFaltaDirect =
    isMyTurn &&
    envidoState.status === "idle" &&
    isInFirstHand &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending &&
    !florAlreadySung &&
    (!myHasAvailableFlor || myHasFlorReservada);
  const canUseFaltaEnvido =
    (isPendingResponder && pendingCallType === "envido" && !isFaltaEnvidoPending) ||
    canCallFaltaDirect;
  const canCallPrimeroEnvido =
    isTrucoPending &&
    isTrucoResponder &&
    isInFirstHand &&
    envidoState.status === "idle" &&
    !florAlreadySung &&
    !isEnvidoPending;
  const canUseConFlor =
    isPendingResponder &&
    pendingCallType !== "florEnvido" &&
    myHasAvailableFlor;
  const canCallFlorEnvido =
    isMyTurn &&
    bothTeamsSangFlor &&
    !florState.florEnvidoCalled &&
    !!florState.florEnvidoWindowOpen &&
    florState.florEnvidoWindowTurnId === socket.id &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending;

  const callPrimeroEnvido = () => {
    socket.emit("call:primero-envido", { roomId });
  };

  const canPassCard =
    isMyTurn &&
    !hasPendingCall &&
    !isPardaSelecting &&
    myCards.length > 0;
  const canPlayLey =
    isMyTurn && isInFirstHand && !hasPendingCall;

  const togglePassCard = () => {
    if (!canPassCard) return;
    setPassCardArmed((prev) => !prev);
  };

  const respondConFlor = () => {
    socket.emit("flor:con-flor", { roomId });
  };

  const playLey = () => {
    socket.emit("flor:jugar-ley", { roomId });
  };

  const callFlorEnvido = () => {
    socket.emit("call:flor-envido", { roomId });
  };

  const chooseReplay = () => {
    socket.emit("match:decision", {
      roomId,
      decision: myRematchDecision === "replay" ? "pending" : "replay",
    });
  };

  const chooseExit = () => {
    socket.emit("match:decision", { roomId, decision: "exit" });
    onLeaveToRoomList?.();
  };

  useEffect(() => {
    if (!isPardaSelecting || hasSubmittedParda) {
      setPardaDraft([]);
    }
  }, [isPardaSelecting, hasSubmittedParda]);

  useEffect(() => {
    if (!canPassCard && passCardArmed) {
      setPassCardArmed(false);
    }
  }, [canPassCard, passCardArmed]);

  const renderDeckCardOrFallback = (card) => {
    const deckCard = getDeckCard(card);
    if (deckCard) {
      const effectiveCard = {
        ...deckCard,
        rank: typeof card?.rank === "number" ? card.rank : deckCard.rank,
      };
      return renderCard(effectiveCard);
    }

    return (
      <div className="flex h-[75px] w-[48px] items-center justify-center rounded-sm border border-slate-300 bg-white text-[10px] font-semibold text-slate-700">
        {card?.value}
      </div>
    );
  };

  const renderPlayedStack = (cards, options = {}) => {
    const { fromNorth = false, rotateDeg = 0, stackAxis = "y", stackSign = 1 } = options;
    const stackStep = 13;
    const stackCount = cards.length;
    const stackSize = (stackCount - 1) * stackStep;
    const stackStart =
      fromNorth && stackAxis === "y"
        ? (index) => (stackCount - 1 - index) * stackStep
        : (index) => index * stackStep;
    const containerStyle =
      stackAxis === "x"
        ? { width: `${78 + stackSize}px`, height: "76px" }
        : { width: "78px", height: `${76 + stackSize}px` };

    return (
      <div className="relative" style={containerStyle}>
        {cards.map((card, index) => {
          const offset = stackStart(index);
          const zIndex = index + 1;
          const xOffset = stackAxis === "x" ? offset * stackSign : 0;
          const yOffset = stackAxis === "y" ? offset : 0;
          const baseRotate = fromNorth && rotateDeg === 0 ? 180 : 0;
          const totalRotate = baseRotate + rotateDeg;
          const transform = `translateX(-50%) translateY(${yOffset}px) rotate(${totalRotate}deg)`;
          return (
            <div
              key={`${card.playerId}-${card.value}-${card.suit}-${index}`}
              className="absolute"
              style={{
                left: `calc(50% + ${xOffset}px)`,
                top: "0px",
                zIndex,
                transform,
              }}
            >
              {renderDeckCardOrFallback(card)}
            </div>
          );
        })}
      </div>
    );
  };

  const renderFanHand = (cards, options = {}) => {
    const { fromNorth = false, playable = false, selectedIndexes = [] } = options;
    const total = cards.length;
    if (!total) return null;
    const selectedSet = new Set(selectedIndexes);

    const spread = Math.min(62, 34 + total * 7);
    const center = (total - 1) / 2;

    return (
      <div className="relative h-[112px] w-[min(88vw,420px)] sm:h-[120px] sm:w-[420px]">
        {cards.map((card, index) => {
          const angleStep = total > 1 ? spread / (total - 1) : 0;
          const angle = -spread / 2 + angleStep * index;
          const centerDist = Math.abs(index - center);
          const maxDist = center || 1;
          const arcFactor = 1 - centerDist / maxDist;
          const arcPx = Math.round(arcFactor * 10);
          const xOffset = Math.round((index - center) * 28);
          const rotation = fromNorth ? 180 - angle : angle;
          const zIndex = total - index;
          const commonStyle = {
            left: "50%",
            marginLeft: `${xOffset}px`,
            transform: `translateX(-50%) rotate(${rotation}deg)`,
            zIndex,
          };

          if (fromNorth) {
            return (
              <div
                key={`fan-opp-${index}`}
                className="absolute pointer-events-none"
                style={{ ...commonStyle, top: `${arcPx}px` }}
              >
                {renderBackCard()}
              </div>
            );
          }

          const isDisabled = !playable;
          return (
            <button
              key={`${card.suit}-${card.value}-${index}`}
              type="button"
              onClick={() => playCard(index)}
              disabled={isDisabled}
              className={`absolute pointer-events-auto transition ${
                isDisabled
                  ? "cursor-not-allowed opacity-60 saturate-75"
                  : "cursor-pointer hover:-translate-y-2"
              }`}
              style={{ ...commonStyle, bottom: `${arcPx}px` }}
            >
              <div
                className={`rounded-sm ${
                  selectedSet.has(index) ? "ring-2 ring-amber-300 ring-offset-2 ring-offset-transparent" : ""
                }`}
              >
                {renderDeckCardOrFallback(card)}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  const renderSideFanBackCards = (cards, side = "left") => {
    const total = cards.length;
    if (!total) return null;
    const center = (total - 1) / 2;
    const spread = Math.min(52, 28 + total * 8);

    return (
      <div className="relative mx-auto flex h-[126px] w-[82px] items-center justify-center">
        {cards.map((_, index) => {
          const angleStep = total > 1 ? spread / (total - 1) : 0;
          const arcAngle = -spread / 2 + angleStep * index;
          const signedAngle = side === "left" ? -90 + arcAngle : 90 - arcAngle;
          const rel = index - center;
          const xDir = side === "left" ? -1 : 1;
          const xOffset = Math.round((Math.abs(rel) * 6 + 2) * xDir);
          const yOffset = Math.round(rel * 16);
          return (
            <div
              key={`${side}-fan-${index}`}
              className="absolute"
              style={{
                transform: `translate(${xOffset}px, ${yOffset}px) rotate(${signedAngle}deg)`,
                zIndex: total - index,
              }}
            >
              {renderBackCard()}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="relative h-screen overflow-hidden bg-emerald-950 px-14 pt-10 text-white sm:px-6 sm:py-6">
      {message && (
        <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center px-4">
          <div className="bg-gradient-to-r from-amber-100 via-yellow-200 to-amber-300 bg-clip-text text-center text-2xl font-extrabold tracking-wide text-transparent drop-shadow-[0_1px_3px_rgba(0,0,0,0.35)] [animation:mesaMessageFloat_1.6s_ease-in-out_forwards]">
            {message}
          </div>
        </div>
      )}
      {isMatchEnded && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 px-4">
          <div className="w-full max-w-md rounded-2xl border border-emerald-200/30 bg-slate-900/95 p-5 text-white shadow-2xl">
            <h2 className="text-center text-xl font-bold text-amber-200">Partida terminada</h2>
            <p className="mt-1 text-center text-sm text-slate-300">
              {state.matchWinnerId
                ? `${state.players.find((p) => p.id === state.matchWinnerId)?.name || "Pareja"} llegÃ³ a 12 puntos.`
                : "Se alcanzÃ³ el fin de partida."}
            </p>

            <div className="mt-4 rounded-lg bg-slate-800/80 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Decisiones</div>
              <div className="space-y-1.5">
                {rematchVotes.map((vote) => (
                  <div key={vote.id} className="flex items-center justify-between rounded-md bg-slate-700/40 px-2 py-1.5 text-sm">
                    <span className="font-medium">{vote.name}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${
                        vote.decision === "replay"
                          ? "bg-emerald-600/80 text-emerald-100"
                          : vote.decision === "exit"
                            ? "bg-emerald-700/80 text-emerald-100"
                            : "bg-slate-600 text-slate-200"
                      }`}
                    >
                      {vote.decision === "replay" ? "Jugar de nuevo" : vote.decision === "exit" ? "Salir" : "Pendiente"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={chooseReplay}
                disabled={rematch.resolved}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  rematch.resolved
                    ? "cursor-not-allowed bg-slate-600 text-slate-300"
                    : "bg-emerald-600 text-white hover:bg-emerald-700"
                }`}
              >
                {myRematchDecision === "replay" ? "Pendiente" : "Jugar de nuevo"}
              </button>
              <button
                type="button"
                onClick={chooseExit}
                disabled={rematch.resolved}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  rematch.resolved
                    ? "cursor-not-allowed bg-slate-600 text-slate-300"
                    : "bg-emerald-700 text-white hover:bg-emerald-800"
                }`}
              >
                Salir al roomlist
              </button>
            </div>

            <p className="mt-3 text-center text-xs text-slate-400">
              {rematch.resolved
                ? rematch.result === "replay"
                  ? "Todos aceptaron: iniciando nueva partida..."
                  : "Se decidiÃ³ salir al roomlist."
                : everyoneAnsweredRematch
                  ? "Procesando decisiÃ³n final..."
                  : "Esperando la respuesta de todos los jugadores..."}
            </p>
            {rematch.resolved && rematch.result === "exit" && (
              <div className="mt-3 text-center">
                <button
                  type="button"
                  onClick={() => onLeaveToRoomList?.()}
                  className="rounded-md bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-white"
                >
                  Volver ahora
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <style>{`
        @keyframes mesaMessageFloat {
          0% {
            opacity: 0;
            transform: translateY(-24px);
          }
          36.36% {
            opacity: 1;
            transform: translateY(0);
          }
          81.82% {
            opacity: 1;
            transform: translateY(0);
          }
          100% {
            opacity: 0;
            transform: translateY(8px);
          }
        }
      `}</style>
      <button
        type="button"
        onClick={() => setShowTestPanel((prev) => !prev)}
        className="fixed left-0 top-4 z-[70] rounded-r-full bg-emerald-800 px-3 py-2 text-xs font-semibold text-white shadow-[0_6px_14px_rgba(0,0,0,0.35)] transition hover:bg-emerald-700"
      >
        {showTestPanel ? "Cerrar Test" : "Test"}
      </button>

      <div
        className={`fixed left-0 top-4 z-50 w-[220px] rounded-r-lg border border-emerald-200/35 bg-emerald-50/95 p-2 text-slate-800 shadow-[0_8px_18px_rgba(0,0,0,0.3)] transition-transform duration-300 ease-out ${
          showTestPanel ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Test</div>
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={toggleTestDeckMode}
            className={`w-full rounded-full px-3 py-1.5 text-xs font-semibold text-white transition ${
              isBastosEspadasMode
                ? "bg-slate-600 hover:bg-slate-700"
                : "bg-emerald-700 hover:bg-emerald-800"
            }`}
          >
            {isBastosEspadasMode ? "Desactivar Bastos/Espadas" : "Activar Bastos/Espadas"}
          </button>
          <button
            type="button"
            onClick={redealTestRound}
            className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
          >
            Repartir de nuevo
          </button>
          <button
            type="button"
            onClick={forceTestFlor}
            className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
          >
            Forzar Flor (yo)
          </button>
          <button
            type="button"
            onClick={forceTestFlorReservada}
            className="w-full rounded-full bg-emerald-800 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-900"
          >
            Forzar Flor Reservada
          </button>
        </div>
      </div>

      <div className="fixed right-2 top-2 z-50 w-[132px] rounded-lg border border-emerald-200/35 bg-emerald-50/95 p-1 text-slate-800 shadow-[0_8px_18px_rgba(0,0,0,0.3)] sm:right-4 sm:top-4 sm:w-[195px] sm:p-1.5">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:text-[10px] sm:tracking-[0.1em]">
            Marcador
          </div>
          <div className="rounded-full bg-slate-200 px-1 py-0.5 text-[8px] font-semibold text-slate-700 sm:text-[9px]">
            Ronda {roundPointValue}
          </div>
        </div>
        <div className="space-y-0.5 sm:space-y-1">
          <div className="flex items-center justify-between rounded-md bg-white/80 px-1 py-0.5 sm:px-1.5 sm:py-1">
            <div className="truncate text-[11px] font-semibold sm:text-xs">
              <span className="mr-1 inline-block rounded bg-emerald-700 px-1 py-0.5 text-[8px] text-white sm:text-[9px]">
                NS
              </span>
              {nsTeamNames || "Norte / Sur"}
            </div>
            <div className="text-xs font-extrabold leading-none sm:text-sm">{nsTeamPoints}</div>
          </div>
          <div className="flex items-center justify-between rounded-md bg-white/80 px-1 py-0.5 sm:px-1.5 sm:py-1">
            <div className="truncate text-[11px] font-semibold sm:text-xs">
              <span className="mr-1 inline-block rounded bg-emerald-700 px-1 py-0.5 text-[8px] text-white sm:text-[9px]">
                EO
              </span>
              {eoTeamNames || "Este / Oeste"}
            </div>
            <div className="text-xs font-extrabold leading-none sm:text-sm">{eoTeamPoints}</div>
          </div>
        </div>
      </div>

      <div className="fixed z-50 w-[min(96vw,240px)] space-y-2 bottom-4 right-2 sm:w-[196px] sm:translate-x-0 sm:space-y-1.5">
        <div className="space-y-2 sm:space-y-1.5">
          <button
            type="button"
            onClick={() => setShowAdvancedCantos((prev) => !prev)}
            className="flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-left text-sm font-medium text-slate-600 shadow-[0_6px_14px_rgba(0,0,0,0.25)] transition  sm:py-1.5 sm:text-xs"
          >
            <span>Cantos Avanzados</span>
            <span className="text-lg leading-none">{showAdvancedCantos ? "-" : "+"}</span>
          </button>
          {showAdvancedCantos && (
            <div className="rounded-lg bg-slate-50 p-2 shadow-[0_6px_14px_rgba(0,0,0,0.25)] sm:p-1.5">
              <div className="space-y-2 sm:space-y-1.5">
                <button
                  type="button"
                  onClick={() => raiseEnvido("falta")}
                  disabled={!canUseFaltaEnvido}
                  className={`w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:py-1.5 sm:text-xs ${
                    canUseFaltaEnvido
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : "cursor-not-allowed bg-slate-400 opacity-80"
                  }`}
                >
                  Falta Envido
                </button>
                <button
                  type="button"
                  onClick={callPrimeroEnvido}
                  disabled={!canCallPrimeroEnvido}
                  className={`w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:py-1.5 sm:text-xs ${
                    canCallPrimeroEnvido
                      ? "bg-emerald-700 hover:bg-emerald-800"
                      : "cursor-not-allowed bg-slate-400 opacity-80"
                  }`}
                >
                  Primero Envido
                </button>
                <button
                  type="button"
                  onClick={() => raiseEnvido("envido")}
                  disabled={!canUseAdvancedEnvido}
                  className={`w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:py-1.5 sm:text-xs ${
                    canUseAdvancedEnvido
                      ? "bg-emerald-700 hover:bg-emerald-800"
                      : "cursor-not-allowed bg-slate-400 opacity-80"
                  }`}
                >
                  Quiero y Envido
                </button>
                <button
                  type="button"
                  onClick={respondConFlor}
                  disabled={!canUseConFlor}
                  className={`w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:py-1.5 sm:text-xs ${
                    canUseConFlor
                      ? "bg-emerald-700 hover:bg-emerald-800"
                      : "cursor-not-allowed bg-slate-400 opacity-80"
                  }`}
                >
                  Con Flor
                </button>


                <button
                  type="button"
                  onClick={callFlorEnvido}
                  disabled={!canCallFlorEnvido}
                  className={`w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:py-1.5 sm:text-xs ${
                    canCallFlorEnvido
                      ? "bg-emerald-700 hover:bg-emerald-800"
                      : "cursor-not-allowed bg-slate-400 opacity-80"
                  }`}
                >
                  Flor Envido
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowAdvancedJugadas((prev) => !prev)}
            className="flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-left text-sm font-medium text-slate-600 shadow-[0_6px_14px_rgba(0,0,0,0.25)] transition  sm:py-1.5 sm:text-xs"
          >
            <span>Jugadas Avanzadas</span>
            <span className="text-lg leading-none">{showAdvancedJugadas ? "-" : "+"}</span>
          </button>
          {showAdvancedJugadas && (
            <div className="rounded-lg bg-slate-50 p-2 shadow-[0_6px_14px_rgba(0,0,0,0.25)] sm:p-1.5">
              <button
                type="button"
                onClick={togglePassCard}
                disabled={!canPassCard}
                className={`w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:py-1.5 sm:text-xs ${
                  !canPassCard
                    ? "cursor-not-allowed bg-slate-400 opacity-80"
                    : passCardArmed
                      ? "bg-emerald-600 hover:bg-emerald-500"
                      : "bg-emerald-900 hover:bg-emerald-800"
                }`}
              >
                {passCardArmed ? "Pasar Carta (Activo)" : "Pasar Carta"}
              </button>
              <button
                type="button"
                onClick={playLey}
                disabled={!canPlayLey}
                className={`mt-2 w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:mt-1.5 sm:py-1.5 sm:text-xs ${
                  canPlayLey
                    ? "bg-emerald-700 hover:bg-emerald-800"
                    : "cursor-not-allowed bg-slate-400 opacity-80"
                }`}
              >
                Jugar a Ley
              </button>
            </div>
          )}
        </div>

        <div className="rounded-lg bg-slate-50 p-2.5 text-slate-700 shadow-[0_8px_18px_rgba(0,0,0,0.35)] sm:p-2">
          <div className="mb-2 flex items-center gap-2 sm:mb-1.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0d6b50] text-sm font-bold text-white sm:h-8 sm:w-8 sm:text-xs">
              {(me?.name || "J").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-tight">{me?.name || "Jugador"}</div>
              <div className="truncate text-xs text-slate-500 sm:text-[11px]">ID: {roomId}</div>
            </div>
          </div>

          <div className="flex gap-2.5 sm:gap-2">
            {isPendingResponder ? (
              <>
                <button
                  type="button"
                  onClick={acceptPendingCall}
                   className="flex-1 rounded-full bg-emerald-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-800 sm:py-1 sm:text-xs"
                >
                  Quiero
                </button>
                <button
                  type="button"
                  onClick={rejectPendingCall}
                  className="flex-1 rounded-full bg-gradient-to-r from-emerald-600 to-emerald-800 px-3 py-2 text-sm font-semibold text-white transition hover:from-emerald-700 hover:to-emerald-900 sm:py-1 sm:text-xs"
                >
                  No Quiero
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={callNextRaise}
                  disabled={!canCallNextRaise}
                  className={`flex-1 rounded-full px-3 py-2 text-sm font-semibold text-white transition sm:py-1 sm:text-xs ${
                    !canCallNextRaise
                      ? "cursor-not-allowed bg-slate-400"
                      : "bg-emerald-700 hover:bg-emerald-800"
                  }`}
                >
                  {isPendingCallerWaiting ? "Esperando..." : nextCall?.label || "Truco"}
                </button>
                <button
                  type="button"
                  onClick={callEnvido}
                  disabled={!(canCallEnvido || canCallFlor)}
                  className={`flex-1 rounded-full px-3 py-2 text-sm font-semibold text-white transition sm:py-1 sm:text-xs ${
                    canCallEnvido || canCallFlor
                      ? "bg-emerald-700 hover:bg-emerald-800"
                      : "cursor-not-allowed bg-slate-400"
                  }`}
                >
                  {myHasAvailableFlor ? "Flor" : "Envido"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto flex h-full w-full items-start justify-center pb-[34vh] pt-28 sm:items-center sm:px-8 sm:pb-0 sm:pt-0">
        <div className="relative w-[min(96vw,60dvh)] max-w-[500px] sm:w-[min(76vw,76vh)] sm:-translate-y-[4vh]">
          <div className="relative aspect-square">
            <div className="absolute left-1/2 top-[-74px] z-30 -translate-x-1/2 text-center sm:top-[-100px]">
              <div className="mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-[#0d6b50] text-sm font-bold text-white shadow">
                {(opponent?.name || "R").slice(0, 1).toUpperCase()}
              </div>

              {renderFanHand(opponentCards, { fromNorth: true })}
            </div>

            <div className="absolute left-[-46px] top-1/2 z-30 -translate-y-1/2 text-center sm:left-[-70px]">
              <div className="mx-auto mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-[#0d6b50] text-xs font-bold text-white shadow">
                {(leftPlayer?.name || "L").slice(0, 1).toUpperCase()}
              </div>
              {renderSideFanBackCards(leftCards, "left")}
            </div>

            <div className="absolute right-[-46px] top-1/2 z-30 -translate-y-1/2 text-center sm:right-[-70px]">
              <div className="mx-auto mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-[#0d6b50] text-xs font-bold text-white shadow">
                {(rightPlayer?.name || "R").slice(0, 1).toUpperCase()}
              </div>
              {renderSideFanBackCards(rightCards, "right")}
            </div>

            <div className="absolute inset-x-0 bottom-0 top-[0px] rounded-[10px] border-2 border-emerald-200/45 bg-[radial-gradient(circle_at_50%_35%,#8fbfa9_0%,#7db49f_45%,#4f9a78_100%)] shadow-[inset_0_0_28px_rgba(255,255,255,0.12),0_24px_48px_rgba(0,0,0,0.45)]">
              <div className={`absolute  ${viraPositionClass}`}>
                {renderDeckCardOrFallback(state.vira)}
              </div>

              <div className="absolute left-1/2 top-[4%] -translate-x-1/2">
                {renderPlayedStack(opponentPlayedCards, { fromNorth: true })}
              </div>
              <div className="absolute left-1/2 bottom-[4%] -translate-x-1/2">
                {renderPlayedStack(myPlayedCards)}
              </div>
              <div className="absolute left-[10%] top-1/2 -translate-y-1/2">
                {renderPlayedStack(leftPlayedCards, { rotateDeg: 90, stackAxis: "x", stackSign: -1 })}
              </div>
              <div className="absolute right-[10%] top-1/2 -translate-y-1/2">
                {renderPlayedStack(rightPlayedCards, { rotateDeg: -90, stackAxis: "x", stackSign: 1 })}
              </div>

              <div className="absolute left-1/2 bottom-[-56px] z-30 -translate-x-1/2 sm:bottom-[-65px]">
                {renderFanHand(myCards, {
                  playable: isPardaSelecting
                    ? isMyTurn && !hasSubmittedParda && !hasPendingCall
                    : isMyTurn && !hasPendingCall,
                  selectedIndexes: pardaDraft,
                })}
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Mesa2v2;


