import EnvidoStoneSlider from "./EnvidoStoneSlider";
import PlayerActionCard from "./PlayerActionCard";
import CollapsibleActionGroup from "./CollapsibleActionGroup";

export default function RightActionPanel({
  envidoStone,
  advancedCantos,
  advancedJugadas,
  communicationCantos,
  playerCard,
}) {
  const {
    show,
    setShow,
    value,
    setValue,
    canUseAdvancedEnvido,
    raiseEnvido,
    canCallEnvido,
    callEnvido,
    canUseStoneEnvidoRaise,
    closeAdvancedCantos,
  } = envidoStone;

  const {
    show: showAdvancedCantos,
    setShow: setShowAdvancedCantos,
    closeOthers,
    runAdvancedCanto,
    canUseFaltaEnvido,
    canCallPrimeroEnvido,
    callPrimeroEnvido,
    canUseConFlor,
    respondConFlor,
    canCallFlorEnvido,
    callFlorEnvido,
  } = advancedCantos;

  const {
    show: showAdvancedJugadas,
    setShow: setShowAdvancedJugadas,
    closeOthers: closeOtherForJugadas,
    runAdvancedJugada,
    togglePassCard,
    canPassCard,
    passCardArmed,
    playLey,
    canPlayLey,
    goMazo,
    canGoMazo,
  } = advancedJugadas;

  const {
    isTwoVsTwo,
    show: showCommunicationCantos,
    setShow: setShowCommunicationCantos,
    closeOthers: closeOtherForCommunication,
    teamSignals,
    callTeamSignal,
    canCallTeamSignals,
  } = communicationCantos;

  const {
    avatarUrl,
    avatarLoadFailed,
    onAvatarError,
    playerName,
    roomId,
    isCanto11Active,
    canDeclareCanto11Envite,
    canCanto11Privo,
    canCanto11NoPrivo,
    hasAvailableFlor,
    myCurrentEnvite,
    onDeclareCanto11Envite,
    onCallCanto11PrivoTruco,
    onCallCanto11NoPrivo,
    isPendingResponder,
    onAcceptPendingCall,
    onRejectPendingCall,
    canCallNextRaise,
    onCallNextRaise,
    isPendingCallerWaiting,
    nextCallLabel,
    canRevealPardaCard,
    onRevealPardaCard,
    canCallEnvidoForCard,
    canCallFlor,
    onCallEnvido,
  } = playerCard;

  return (
    <div className="fixed bottom-4 right-2 z-50 w-[min(96vw,240px)] ">
      <div className="flex flex-col gap-y-0.5">
        <EnvidoStoneSlider
          show={show}
          value={value}
          setValue={setValue}
          onClose={() => setShow(false)}
          onConfirm={(event) => {
            event?.stopPropagation?.();
            let emitted = false;
            if (canUseAdvancedEnvido) {
              raiseEnvido("envido", value);
              emitted = true;
            } else if (canCallEnvido) {
              callEnvido(value);
              emitted = true;
            }
            if (emitted) {
              setShow(false);
              closeAdvancedCantos(false);
            }
          }}
          canConfirm={canUseStoneEnvidoRaise}
        />

        <CollapsibleActionGroup
          title="Cantos Avanzados"
          open={showAdvancedCantos}
          maxHeightClass="max-h-[560px]"
          onToggle={() =>
            setShowAdvancedCantos((prev) => {
              const next = !prev;
              if (next) {
                closeOthers();
              }
              return next;
            })
          }
        >
          <div className="overflow-hidden rounded-lg bg-slate-50 p-1.5 shadow-[0_6px_14px_rgba(0,0,0,0.25)]">
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => runAdvancedCanto(() => raiseEnvido("falta"))}
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
                onClick={() => runAdvancedCanto(callPrimeroEnvido)}
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
                onClick={() => runAdvancedCanto(() => raiseEnvido("envido"))}
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
                onClick={() => setShow((prev) => !prev)}
                disabled={!canUseStoneEnvidoRaise}
                className={`w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:py-1.5 sm:text-xs ${
                  canUseStoneEnvidoRaise
                    ? "bg-emerald-700 hover:bg-emerald-800"
                    : "cursor-not-allowed bg-slate-400 opacity-80"
                }`}
              >
                Envido (x) piedras
              </button>
              <button
                type="button"
                onClick={() => runAdvancedCanto(respondConFlor)}
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
                onClick={() => runAdvancedCanto(callFlorEnvido)}
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
        </CollapsibleActionGroup>

        <CollapsibleActionGroup
          title="Jugadas Avanzadas"
          open={showAdvancedJugadas}
          maxHeightClass="max-h-[170px]"
          onToggle={() =>
            setShowAdvancedJugadas((prev) => {
              const next = !prev;
              if (next) {
                closeOtherForJugadas();
              }
              return next;
            })
          }
        >
          <div className="rounded-lg bg-slate-50 p-2 shadow-[0_6px_14px_rgba(0,0,0,0.25)] sm:p-1.5">
            <button
              type="button"
              onClick={() => runAdvancedJugada(togglePassCard)}
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
              onClick={() => runAdvancedJugada(playLey)}
              disabled={!canPlayLey}
              className={`mt-2 w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:mt-1.5 sm:py-1.5 sm:text-xs ${
                canPlayLey
                  ? "bg-emerald-700 hover:bg-emerald-800"
                  : "cursor-not-allowed bg-slate-400 opacity-80"
              }`}
            >
              Jugar a Ley
            </button>
            <button
              type="button"
              onClick={() => runAdvancedJugada(goMazo)}
              disabled={!canGoMazo}
              className={`mt-2 w-full rounded-md px-3 py-2 text-sm font-semibold text-white transition sm:mt-1.5 sm:py-1.5 sm:text-xs ${
                canGoMazo
                  ? "bg-emerald-700 hover:bg-emerald-800"
                  : "cursor-not-allowed bg-slate-400 opacity-80"
              }`}
            >
              Irme al mazo
            </button>
          </div>
        </CollapsibleActionGroup>

        {isTwoVsTwo && (
          <CollapsibleActionGroup
            title="Cantos de Comunicacion"
            open={showCommunicationCantos}
            maxHeightClass="max-h-[260px]"
            onToggle={() =>
              setShowCommunicationCantos((prev) => {
                const next = !prev;
                if (next) {
                  closeOtherForCommunication();
                }
                return next;
              })
            }
          >
            <div className="overflow-hidden rounded-lg bg-slate-50 p-1.5 shadow-[0_6px_14px_rgba(0,0,0,0.25)]">
              <div className="grid grid-cols-2 gap-1.5">
                {teamSignals.map((signal) => (
                  <button
                    key={signal.key}
                    type="button"
                    onClick={() => callTeamSignal(signal.key)}
                    disabled={!canCallTeamSignals}
                    className={`rounded-md px-2 py-1.5 text-[11px] font-semibold text-white transition sm:text-[10px] ${
                      canCallTeamSignals
                        ? "bg-emerald-700 hover:bg-emerald-800"
                        : "cursor-not-allowed bg-slate-400 opacity-80"
                    }`}
                  >
                    {signal.label}
                  </button>
                ))}
              </div>
            </div>
          </CollapsibleActionGroup>
        )}
      </div>

      <PlayerActionCard
        avatarUrl={avatarUrl}
        avatarLoadFailed={avatarLoadFailed}
        onAvatarError={onAvatarError}
        playerName={playerName}
        roomId={roomId}
        isCanto11Active={isCanto11Active}
        canDeclareCanto11Envite={canDeclareCanto11Envite}
        canCanto11Privo={canCanto11Privo}
        canCanto11NoPrivo={canCanto11NoPrivo}
        hasAvailableFlor={hasAvailableFlor}
        myCurrentEnvite={myCurrentEnvite}
        onDeclareCanto11Envite={onDeclareCanto11Envite}
        onCallCanto11PrivoTruco={onCallCanto11PrivoTruco}
        onCallCanto11NoPrivo={onCallCanto11NoPrivo}
        isPendingResponder={isPendingResponder}
        onAcceptPendingCall={onAcceptPendingCall}
        onRejectPendingCall={onRejectPendingCall}
        canCallNextRaise={canCallNextRaise}
        onCallNextRaise={onCallNextRaise}
        isPendingCallerWaiting={isPendingCallerWaiting}
        nextCallLabel={nextCallLabel}
        canRevealPardaCard={canRevealPardaCard}
        onRevealPardaCard={onRevealPardaCard}
        canCallEnvido={canCallEnvidoForCard}
        canCallFlor={canCallFlor}
        onCallEnvido={onCallEnvido}
      />
    </div>
  );
}
