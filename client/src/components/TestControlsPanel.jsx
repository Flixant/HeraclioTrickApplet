import { useState } from "react";

export default function TestControlsPanel({
  isOpen,
  onClose,
  isBastosEspadasMode,
  onPreviewEnvidoTable,
  onPreviewFlorTable,
  onToggleTestDeckMode,
  onRedealTestRound,
  onForceTestFlor,
  onForceTestFlorReservada,
  onSetMyScore11,
  onSetOpponentScore11,
  onSetMyTeamScore11,
  onForceTestPardaFirst,
  onForceTestPardaTiebreak2,
  onTestCallTruco,
  onTestCallRetruco,
  onTestCallVale9,
  onTestCallValeJuego,
  onTestCallEnvido,
  onTestCallPrimeroEnvido,
  onTestCallFaltaEnvido,
  onTestAccept,
  onTestReject,
  onTestRaiseEnvido,
  onTestCallFlor,
  onTestConFlor,
  onTestCallFlorEnvido,
  onTestCallPrivoTruco,
  onTestCallNoPrivo,
  onTestPlayLey,
  onTestGoMazo,
}) {
  const [showDirectCalls, setShowDirectCalls] = useState(true);
  const [showVisualScenarios, setShowVisualScenarios] = useState(true);
  const [showGameScenarios, setShowGameScenarios] = useState(true);

  const renderSectionToggle = (label, isOpenSection, onToggle) => (
    <button
      type="button"
      onClick={onToggle}
      className="mb-1 flex w-full items-center justify-between rounded-md bg-emerald-100/80 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-600 transition hover:bg-emerald-200/70"
    >
      <span>{label}</span>
      <span className="text-xs font-bold text-slate-500">{isOpenSection ? "−" : "+"}</span>
    </button>
  );

  return (
    <>
      <div
        className={`fixed inset-0 z-[79] bg-black/20 transition-opacity duration-200 ${
          isOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        className={`fixed left-0 top-0 z-[80] flex h-full w-[260px] max-w-[82vw] flex-col border-r border-emerald-200/35 bg-emerald-50/95 p-3 text-slate-800 shadow-[0_10px_24px_rgba(0,0,0,0.3)] transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Test</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-300"
          >
            Cerrar
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto pb-4">
          <section>
            {renderSectionToggle("Cantos Directos", showDirectCalls, () => setShowDirectCalls((prev) => !prev))}
            {showDirectCalls && (
              <div className="grid grid-cols-2 gap-1.5">
                <button type="button" onClick={onTestCallTruco} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Truco</button>
                <button type="button" onClick={onTestCallRetruco} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Retruco</button>
                <button type="button" onClick={onTestCallVale9} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Vale 9</button>
                <button type="button" onClick={onTestCallValeJuego} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Vale Juego</button>
                <button type="button" onClick={onTestCallEnvido} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Envido</button>
                <button type="button" onClick={onTestCallPrimeroEnvido} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Primero Envido</button>
                <button type="button" onClick={onTestCallFaltaEnvido} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Falta Envido</button>
                <button type="button" onClick={onTestRaiseEnvido} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Quiero y Envido</button>
                <button type="button" onClick={onTestCallFlor} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Flor</button>
                <button type="button" onClick={onTestConFlor} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Con Flor</button>
                <button type="button" onClick={onTestCallFlorEnvido} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Flor Envido</button>
                <button type="button" onClick={onTestCallPrivoTruco} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Privo y Truco</button>
                <button type="button" onClick={onTestCallNoPrivo} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">No Privo</button>
                <button type="button" onClick={onTestAccept} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Quiero</button>
                <button type="button" onClick={onTestReject} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">No Quiero</button>
                <button type="button" onClick={onTestPlayLey} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">A Ley</button>
                <button type="button" onClick={onTestGoMazo} className="rounded-md bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-800">Al Mazo</button>
              </div>
            )}
          </section>
          <section>
            {renderSectionToggle("Escenarios Visuales", showVisualScenarios, () => setShowVisualScenarios((prev) => !prev))}
            {showVisualScenarios && (
              <div className="grid grid-cols-1 gap-1.5">
                <button type="button" onClick={onPreviewEnvidoTable} className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800">
                  Preview mesa Envido
                </button>
                <button type="button" onClick={onPreviewFlorTable} className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800">
                  Preview mesa Flor
                </button>
              </div>
            )}
          </section>
          <section>
            {renderSectionToggle("Escenarios de Juego", showGameScenarios, () => setShowGameScenarios((prev) => !prev))}
            {showGameScenarios && (
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
                  onClick={onSetOpponentScore11}
                  className="w-full rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-800"
                >
                  Rival cantando
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
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
