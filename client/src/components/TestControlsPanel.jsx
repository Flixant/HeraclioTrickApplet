export default function TestControlsPanel({
  isOpen,
  onToggleOpen,
  isBastosEspadasMode,
  onToggleTestDeckMode,
  onRedealTestRound,
  onForceTestFlor,
  onForceTestFlorReservada,
  onSetMyScore11,
  onSetMyTeamScore11,
  onForceTestPardaFirst,
  onForceTestPardaTiebreak2,
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggleOpen}
        className="fixed bottom-48 left-0 z-[76] rounded-r-full bg-emerald-800 px-3 py-2 text-xs font-semibold text-white shadow-[0_6px_14px_rgba(0,0,0,0.35)] transition hover:bg-emerald-700"
      >
        {isOpen ? "Cerrar Test" : "Test"}
      </button>

      <div
        className={`fixed bottom-4 left-0 z-[75] w-[220px] rounded-r-lg border border-emerald-200/35 bg-emerald-50/95 p-2 text-slate-800 shadow-[0_8px_18px_rgba(0,0,0,0.3)] transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Test</div>
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={onToggleTestDeckMode}
            className={`w-full rounded-full px-3 py-1.5 text-xs font-semibold text-white transition ${
              isBastosEspadasMode ? "bg-slate-600 hover:bg-slate-700" : "bg-emerald-700 hover:bg-emerald-800"
            }`}
          >
            {isBastosEspadasMode ? "Desactivar Bastos/Espadas" : "Activar Bastos/Espadas"}
          </button>
          <button
            type="button"
            onClick={onRedealTestRound}
            className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
          >
            Repartir de nuevo
          </button>
          <button
            type="button"
            onClick={onForceTestFlor}
            className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
          >
            Forzar Flor (yo)
          </button>
          <button
            type="button"
            onClick={onForceTestFlorReservada}
            className="w-full rounded-full bg-emerald-800 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-900"
          >
            Forzar Flor Reservada
          </button>
          <button
            type="button"
            onClick={onSetMyScore11}
            className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
          >
            Ponerme en 11
          </button>
          <button
            type="button"
            onClick={onSetMyTeamScore11}
            className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
          >
            Ambos en 11
          </button>
          <button
            type="button"
            onClick={onForceTestPardaFirst}
            className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
          >
            Pardas en primera
          </button>
          <button
            type="button"
            onClick={onForceTestPardaTiebreak2}
            className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
          >
            Pardas desempate 2
          </button>
        </div>
      </div>
    </>
  );
}
