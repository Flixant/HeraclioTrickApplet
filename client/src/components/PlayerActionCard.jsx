function PlayerActionCard({
  avatarUrl,
  avatarLoadFailed,
  onAvatarError,
  onAvatarClick,
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
  pendingCallType,
  onAcceptPendingCall,
  onRejectPendingCall,
  onRespondWithFlor,
  canCallNextRaise,
  onCallNextRaise,
  isPendingCallerWaiting,
  nextCallLabel,
  canRevealPardaCard,
  onRevealPardaCard,
  canCallEnvido,
  canCallFlor,
  onCallEnvido,
  micEnabled,
  onToggleMic,
  isSpeaking,
  turnTimerPlayerId,
  turnTimerRemainingMs,
  turnTimerDurationMs,
  myPlayerId,
  isVoiceSpeaking,
}) {
  const showTurnCountdownRing =
    !!myPlayerId &&
    turnTimerPlayerId === myPlayerId &&
    Number(turnTimerRemainingMs || 0) > 0 &&
    Number(turnTimerDurationMs || 0) > 0;
  const ringProgress = showTurnCountdownRing
    ? Math.max(0, Math.min(1, Number(turnTimerRemainingMs || 0) / Number(turnTimerDurationMs || 45000)))
    : 0;
  const circumference = 2 * Math.PI * 18;
  const ringOffset = circumference * (1 - ringProgress);
  const ringColorClass =
    ringProgress <= 0.2 ? "text-rose-500" : ringProgress <= 0.45 ? "text-amber-400" : "text-emerald-400";
  const canRespondEnvidoWithFlor =
    isPendingResponder && pendingCallType === "envido" && hasAvailableFlor;
  return (
    <div className="mt-0.5 rounded-lg bg-slate-50 p-2.5 text-slate-700 shadow-[0_8px_18px_rgba(0,0,0,0.35)] sm:p-2">
      <div className="mb-2 flex items-center gap-2 sm:mb-1.5">
        <div className="relative h-9 w-9 sm:h-8 sm:w-8">
          {showTurnCountdownRing && (
            <svg className={`pointer-events-none absolute -inset-[3px] z-10 ${ringColorClass}`} viewBox="0 0 42 42">
              <circle cx="21" cy="21" r="18" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.8" />
              <circle
                cx="21"
                cy="21"
                r="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={ringOffset}
                transform="rotate(-90 21 21)"
              />
            </svg>
          )}
          <button
            type="button"
            onClick={onAvatarClick}
            className={`flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-[#0d6b50] text-sm font-bold text-white outline-none transition hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-emerald-300/80 sm:text-xs ${
              isVoiceSpeaking || isSpeaking
                ? "ring-2 ring-cyan-300/90 shadow-[0_0_0_4px_rgba(34,211,238,0.22)] animate-pulse"
                : ""
            }`}
            title="Ver estadisticas"
          >
            {avatarUrl && !avatarLoadFailed ? (
              <img
                src={avatarUrl}
                alt="Avatar"
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
                onError={onAvatarError}
              />
            ) : (
              (playerName || "J").slice(0, 1).toUpperCase()
            )}
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">{playerName || "Jugador"}</div>
          <div className="truncate text-xs text-slate-500 sm:text-[11px]">ID: {roomId}</div>
        </div>
        <button
          type="button"
          onClick={onToggleMic}
          className={`shrink-0 h-8 w-8 rounded-full border p-0 text-[10px] font-semibold transition flex items-center justify-center ${
            micEnabled
              ? "border-blue-300/60 bg-blue-500 text-white shadow-sm hover:bg-blue-400"
              : "border-slate-300 bg-slate-200 text-slate-600 hover:bg-slate-300"
          }`}
          title="Activar o desactivar microfono"
          aria-label={micEnabled ? "Microfono activado" : "Microfono desactivado"}
        >
          {micEnabled ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2.5" width="6" height="11" rx="3" />
              <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0" />
              <path d="M12 17v4" />
              <path d="M8.5 21h7" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="3" x2="21" y2="21" />
              <path d="M9 9.2V5.5a3 3 0 1 1 6 0v7a2.9 2.9 0 0 1-.2 1.1" />
              <path d="M5.5 10.5a6.5 6.5 0 0 0 10.9 4.7" />
              <path d="M12 17v4" />
              <path d="M8.5 21h7" />
            </svg>
          )}
        </button>
      </div>

      <div className="flex gap-2.5 sm:gap-2">
        {isCanto11Active ? (
          <>
            <button
              type="button"
              onClick={canDeclareCanto11Envite ? onDeclareCanto11Envite : canCanto11Privo ? onCallCanto11PrivoTruco : undefined}
              disabled={!(canDeclareCanto11Envite || canCanto11Privo)}
              className={`flex-1 rounded-full px-3 py-2 text-xs font-semibold text-white transition sm:py-1 ${
                canDeclareCanto11Envite || canCanto11Privo
                  ? "bg-emerald-700 hover:bg-emerald-800"
                  : "cursor-not-allowed bg-slate-400"
              }`}
            >
              {canDeclareCanto11Envite
                ? hasAvailableFlor
                  ? "Tengo Flor"
                  : `Tengo ${myCurrentEnvite}`
                : "Privo y Truco"}
            </button>
            <button
              type="button"
              onClick={onCallCanto11NoPrivo}
              disabled={!canCanto11NoPrivo}
              className={`flex-1 rounded-full px-3 py-2 text-xs font-semibold text-white transition sm:py-1 ${
                canCanto11NoPrivo
                  ? "bg-gradient-to-r from-emerald-600 to-emerald-800 hover:from-emerald-700 hover:to-emerald-900"
                  : "cursor-not-allowed bg-slate-400"
              }`}
            >
              No Privo
            </button>
          </>
        ) : isPendingResponder ? (
          <>
            <button
              type="button"
              onClick={onAcceptPendingCall}
              className="flex-1 rounded-full bg-emerald-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-800 sm:py-1 sm:text-xs"
            >
              {canRespondEnvidoWithFlor ? "Quiero al Envido" : "Quiero"}
            </button>
            <button
              type="button"
              onClick={canRespondEnvidoWithFlor ? onRespondWithFlor : onRejectPendingCall}
              className="flex-1 rounded-full bg-gradient-to-r from-emerald-600 to-emerald-800 px-3 py-2 text-sm font-semibold text-white transition hover:from-emerald-700 hover:to-emerald-900 sm:py-1 sm:text-xs"
            >
              {canRespondEnvidoWithFlor ? "Flor" : "No Quiero"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onCallNextRaise}
              disabled={!canCallNextRaise}
              className={`flex-1 rounded-full px-3 py-2 text-sm font-semibold text-white transition sm:py-1 sm:text-xs ${
                !canCallNextRaise
                  ? "cursor-not-allowed bg-slate-400"
                  : "bg-emerald-700 hover:bg-emerald-800"
              }`}
            >
              {isPendingCallerWaiting ? "Esperando..." : nextCallLabel || "Truco"}
            </button>
            <button
              type="button"
              onClick={canRevealPardaCard ? onRevealPardaCard : onCallEnvido}
              disabled={canRevealPardaCard ? false : !(canCallEnvido || canCallFlor)}
              className={`flex-1 rounded-full px-3 py-2 text-sm font-semibold text-white transition sm:py-1 sm:text-xs ${
                canRevealPardaCard || canCallEnvido || canCallFlor
                  ? "bg-emerald-700 hover:bg-emerald-800"
                  : "cursor-not-allowed bg-slate-400"
              }`}
            >
              {canRevealPardaCard ? "Descubrir carta" : hasAvailableFlor ? "Flor" : "Envido"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default PlayerActionCard;
