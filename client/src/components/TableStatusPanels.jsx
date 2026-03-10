function TableStatusPanels({
  nsTeamNames,
  eoTeamNames,
  nsTeamPoints,
  eoTeamPoints,
  activeTrucoTitle,
  isTrucoActive,
  activeTrucoLabel,
  enviteTitle,
  isCanto11Active,
  isEnviteActiveDisplay,
  activeEnviteLabelDisplay,
}) {
  return (
    <>
      <div className="fixed right-2 top-2 z-50 w-[132px] rounded-lg border border-emerald-200/35 bg-emerald-50/95 p-1 text-slate-800 shadow-[0_8px_18px_rgba(0,0,0,0.3)] sm:right-4 sm:top-4 sm:w-[195px] sm:p-1.5">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:text-[10px] sm:tracking-[0.1em]">
            Marcador
          </div>
        </div>
        <div className="space-y-0.5 sm:space-y-1">
          <div className="flex items-center justify-between rounded-md bg-white/80 px-1 py-0.5 sm:px-1.5 sm:py-1">
            <div className="truncate text-[11px] font-semibold sm:text-xs">
              <span className="mr-1 inline-block rounded bg-emerald-700 px-1 py-0.5 text-[8px] text-white sm:text-[9px]">
                E1
              </span>
              {nsTeamNames || "Norte / Sur"}
            </div>
            <div className="text-xs font-extrabold leading-none sm:text-sm">{nsTeamPoints}</div>
          </div>
          <div className="flex items-center justify-between rounded-md bg-white/80 px-1 py-0.5 sm:px-1.5 sm:py-1">
            <div className="truncate text-[11px] font-semibold sm:text-xs">
              <span className="mr-1 inline-block rounded bg-emerald-700 px-1 py-0.5 text-[8px] text-white sm:text-[9px]">
                E2
              </span>
              {eoTeamNames || "Este / Oeste"}
            </div>
            <div className="text-xs font-extrabold leading-none sm:text-sm">{eoTeamPoints}</div>
          </div>
        </div>
      </div>

      <div className="fixed left-2 top-2 z-50 w-[132px] rounded-lg border border-emerald-200/35 bg-emerald-50/95 p-1 text-slate-800 shadow-[0_8px_18px_rgba(0,0,0,0.3)] sm:left-4 sm:top-4 sm:w-[195px] sm:p-1.5">
        <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:text-[10px] sm:tracking-[0.1em]">
          Cantos Activos
        </div>
        <div className="space-y-0.5 sm:space-y-1">
          <div className="flex items-center justify-between rounded-md bg-white/80 px-1 py-0.5 sm:px-1.5 sm:py-1">
            <span className="text-[10px] font-semibold text-slate-700 sm:text-xs">{activeTrucoTitle}</span>
            <span
              className={`inline-block h-4 w-4 rounded-full sm:h-4 sm:w-14 ${isTrucoActive ? "bg-green-700" : "bg-slate-500"}`}
              title={isTrucoActive ? activeTrucoLabel : "Sin canto"}
              aria-label={isTrucoActive ? activeTrucoLabel : "Sin canto"}
            />
          </div>
          <div className="flex items-center justify-between rounded-md bg-white/80 px-1 py-0.5 sm:px-1.5 sm:py-1">
            <span className={`text-[10px] font-semibold sm:text-xs ${isCanto11Active ? "text-red-600" : "text-slate-700"}`}>
              {enviteTitle}
            </span>
            <span
              className={`inline-block h-4 w-4 rounded-full sm:h-4 sm:w-14 ${isEnviteActiveDisplay ? "bg-green-700" : "bg-slate-500"}`}
              title={isEnviteActiveDisplay ? activeEnviteLabelDisplay : "Sin canto"}
              aria-label={isEnviteActiveDisplay ? activeEnviteLabelDisplay : "Sin canto"}
            />
          </div>
        </div>
      </div>
    </>
  );
}

export default TableStatusPanels;

