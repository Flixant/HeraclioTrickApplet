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
      badgeClass: "bg-amber-400/20 text-amber-100 border-amber-300/45",
      cardClass: "border-amber-300/30 bg-amber-900/20",
    };
  }
  if (
    /\b(truco|retruco|vale 9|vale juego|envido|falta envido|primero envido|flor envido|flor|con flor|tengo )\b/.test(
      value
    )
  ) {
    return {
      label: "Canto",
      badgeClass: "bg-emerald-400/20 text-emerald-100 border-emerald-300/45",
      cardClass: "border-emerald-300/35 bg-emerald-900/20",
    };
  }
  if (/\b(juega|jugo|carta|pasada|descubrir|descubre|al mazo)\b/.test(value)) {
    return {
      label: "Carta",
      badgeClass: "bg-cyan-400/20 text-cyan-100 border-cyan-300/45",
      cardClass: "border-cyan-300/35 bg-cyan-900/20",
    };
  }
  if (/\b(suma|punto|puntos|gana|total|llego a 12|partida terminada)\b/.test(value)) {
    return {
      label: "Puntos",
      badgeClass: "bg-yellow-300/20 text-yellow-100 border-yellow-300/45",
      cardClass: "border-yellow-300/35 bg-yellow-900/20",
    };
  }
  return {
    label: "",
    badgeClass: "",
    cardClass: "border-emerald-200/20 bg-emerald-950/55",
  };
}

function HistoryPanel({ open, entries, onClose }) {
  return (
    <div
      className={`fixed left-0 top-0 z-[77] h-screen w-[min(84vw,340px)] border-r border-emerald-200/50 bg-emerald-900/95 shadow-[0_20px_44px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-transform duration-300 ease-out ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-emerald-200/15 bg-emerald-900/35 px-4 py-3">
          <h3 className="bg-gradient-to-r from-[#d8c28a] via-[#bca46b] to-[#8f7a4a] bg-clip-text text-sm font-semibold tracking-wide text-transparent">
            Historial de jugadas
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-emerald-200/20 bg-emerald-900/30 px-2 py-1 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-800/45"
          >
            Cerrar
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 pr-2">
          {entries.length === 0 ? (
            <div className="rounded-lg border border-emerald-200/20 bg-emerald-900/35 px-3 py-2 text-xs text-emerald-100/75">
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
                      <div className="rounded-md border border-yellow-300/20 bg-yellow-900/15 px-2 py-1 text-[10px] font-semibold text-yellow-100/85">
                        Ronda {entry.round} - Mano {entry.hand}
                      </div>
                    )}
                    <div className={`rounded-md border px-2 py-1.5 text-xs text-emerald-50 ${meta.cardClass}`}>
                      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                        <span className="shrink-0 text-[10px] font-medium text-emerald-100/50">
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
                          <span className="shrink-0 inline-flex items-center rounded border border-emerald-200/20 bg-emerald-700/55 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                            {playerName}
                          </span>
                        ) : null}
                        <span className="truncate text-[11px] text-emerald-50/92">{actionText}</span>
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
