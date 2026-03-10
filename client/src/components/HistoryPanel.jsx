function formatHistoryTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function getHistoryEventMeta(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(quiero|no quiero|privo y truco|no privo|respondio|responde)\b/.test(value)) {
    return {
      label: "Respuesta",
      badgeClass: "bg-amber-500/20 text-amber-200 border-amber-300/40",
      cardClass: "border-amber-300/25 bg-amber-900/15",
    };
  }
  if (
    /\b(truco|retruco|vale 9|vale juego|envido|falta envido|primero envido|flor envido|flor|con flor|tengo )\b/.test(
      value
    )
  ) {
    return {
      label: "Canto",
      badgeClass: "bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-300/40",
      cardClass: "border-fuchsia-300/25 bg-fuchsia-900/15",
    };
  }
  if (/\b(juega|jugo|carta|pasada|descubrir|descubre|al mazo)\b/.test(value)) {
    return {
      label: "Carta",
      badgeClass: "bg-sky-500/20 text-sky-200 border-sky-300/40",
      cardClass: "border-sky-300/25 bg-sky-900/15",
    };
  }
  if (/\b(suma|punto|puntos|gana|total|llego a 12|partida terminada)\b/.test(value)) {
    return {
      label: "Puntos",
      badgeClass: "bg-emerald-500/20 text-emerald-200 border-emerald-300/40",
      cardClass: "border-emerald-300/25 bg-emerald-900/15",
    };
  }
  return {
    label: "",
    badgeClass: "",
    cardClass: "border-slate-300/25 bg-slate-800/70",
  };
}

function HistoryPanel({ open, entries, onClose }) {
  return (
    <div
      className={`fixed left-0 top-0 z-[77] h-screen w-[min(84vw,320px)] border-r border-emerald-200/30 bg-slate-900/95 shadow-[0_16px_38px_rgba(0,0,0,0.4)] backdrop-blur-sm transition-transform duration-300 ease-out ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-emerald-200/20 px-4 py-3">
          <h3 className="text-sm font-semibold tracking-wide text-emerald-100">Historial de jugadas</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs font-semibold text-slate-300 transition hover:bg-slate-700/70 hover:text-white"
          >
            Cerrar
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 pr-2">
          {entries.length === 0 ? (
            <div className="rounded-lg border border-emerald-200/20 bg-slate-800/60 px-3 py-2 text-xs text-slate-300">
              Aun no hay jugadas registradas.
            </div>
          ) : (
            <div className="space-y-1.5">
              {entries.map((entry, index, arr) => {
                const prev = arr[index - 1];
                const startsGroup = !prev || prev.round !== entry.round || prev.hand !== entry.hand;
                const meta = getHistoryEventMeta(entry.text);
                const playerMatch = String(entry.text || "").match(/^([^:]{1,50}):\s*(.+)$/);
                const playerName = playerMatch ? playerMatch[1].trim() : "";
                const actionText = playerMatch ? playerMatch[2].trim() : entry.text;
                return (
                  <div key={entry.id} className="space-y-1">
                    {startsGroup && (
                      <div className="rounded-md border border-emerald-300/25 bg-emerald-900/35 px-2 py-1 text-[11px] font-semibold text-emerald-100">
                        Ronda {entry.round} - Mano {entry.hand}
                      </div>
                    )}
                    <div className={`rounded-lg border px-2 py-1.5 text-xs text-slate-100 ${meta.cardClass}`}>
                      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                        <span className="shrink-0 text-[10px] font-medium text-slate-400">
                          {formatHistoryTime(entry.timestamp)}
                        </span>
                        {meta.label ? (
                          <span
                            className={`shrink-0 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${meta.badgeClass}`}
                          >
                            {meta.label}
                          </span>
                        ) : null}
                        {playerName ? (
                          <span className="shrink-0 inline-flex items-center rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                            {playerName}
                          </span>
                        ) : null}
                        <span className="truncate text-[11px] text-slate-100">{actionText}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default HistoryPanel;

