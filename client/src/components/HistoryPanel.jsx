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
      badgeClass: "bg-amber-700 text-amber-50 border-amber-500",
      cardClass: "border-amber-500 bg-amber-950",
      dotClass: "bg-amber-500",
    };
  }
  if (
    /\b(truco|retruco|vale 9|vale juego|envido|falta envido|primero envido|flor envido|flor|con flor|tengo )\b/.test(
      value
    )
  ) {
    return {
      label: "Canto",
      badgeClass: "bg-emerald-700 text-emerald-50 border-emerald-500",
      cardClass: "border-emerald-500 bg-emerald-950",
      dotClass: "bg-emerald-500",
    };
  }
  if (/\b(juega|jugo|carta|pasada|descubrir|descubre|al mazo)\b/.test(value)) {
    return {
      label: "Carta",
      badgeClass: "bg-sky-700 text-sky-50 border-sky-500",
      cardClass: "border-sky-500 bg-slate-900",
      dotClass: "bg-sky-500",
    };
  }
  if (/\b(suma|punto|puntos|gana|total|llego a 12|partida terminada)\b/.test(value)) {
    return {
      label: "Puntos",
      badgeClass: "bg-yellow-700 text-yellow-50 border-yellow-500",
      cardClass: "border-yellow-500 bg-yellow-950",
      dotClass: "bg-yellow-500",
    };
  }
  return {
    label: "",
    badgeClass: "",
    cardClass: "border-emerald-700 bg-emerald-950",
    dotClass: "bg-emerald-500",
  };
}

function HistoryPanel({ open, entries, onClose }) {
  return (
    <div
      className={`fixed left-0 top-0 z-[77] h-screen w-[min(84vw,360px)] border-r border-emerald-700 bg-emerald-950 shadow-[0_20px_44px_rgba(0,0,0,0.45)] transition-transform duration-300 ease-out ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-emerald-700 bg-emerald-900 px-4 py-3">
          <h3 className="text-sm font-semibold tracking-wide text-yellow-200">
            Historial de jugadas
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-emerald-600 bg-emerald-800 px-2 py-1 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-700"
          >
            Cerrar
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 pr-2">
          {entries.length === 0 ? (
            <div className="rounded-lg border border-emerald-700 bg-emerald-900 px-3 py-2 text-xs text-emerald-100">
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
                      <div className="rounded-md border border-yellow-700 bg-yellow-900 px-2 py-1 text-[10px] font-semibold text-yellow-100">
                        Ronda {entry.round} - Mano {entry.hand}
                      </div>
                    )}
                    <div className="relative pl-4">
                      <div className="absolute bottom-0 left-[5px] top-0 w-px bg-emerald-700" />
                      <div className={`absolute left-0 top-2 h-[10px] w-[10px] rounded-full ${meta.dotClass}`} />
                      <div className={`rounded-md border px-2 py-1.5 text-xs text-emerald-50 ${meta.cardClass}`}>
                        <div className="flex items-start gap-1.5">
                          <span className="shrink-0 text-[10px] font-medium text-emerald-200">
                            {formatHistoryTime(entry.timestamp)}
                          </span>
                          {meta.label ? (
                            <span
                              className={`shrink-0 inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold ${meta.badgeClass}`}
                            >
                              {meta.label}
                            </span>
                          ) : null}
                          {playerName ? (
                            <span className="shrink-0 inline-flex items-center rounded border border-emerald-600 bg-emerald-800 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                              {playerName}
                            </span>
                          ) : null}
                          <span className="min-w-0 text-[11px] leading-snug text-emerald-50">{actionText}</span>
                        </div>
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
