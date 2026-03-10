function EnvidoStoneSlider({
  show,
  value,
  setValue,
  onClose,
  onConfirm,
  canConfirm,
}) {
  return (
    <div
      className={`fixed inset-0 z-[80] transition ${
        show ? "pointer-events-auto" : "pointer-events-none"
      }`}
    >
      <div
        className={`absolute inset-0 bg-black/20 transition-opacity duration-200 ${
          show ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        className={`absolute right-0 top-1/2 flex w-[40px] -translate-y-1/2 flex-col items-center rounded-full border-l border-emerald-200/35 bg-emerald-50/95 text-center text-slate-700 shadow-[-8px_0_18px_rgba(0,0,0,0.3)] transition-transform duration-300 ${
          show ? "right-2 translate-x-0" : "right-0 translate-x-full"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mt-2 text-lg font-extrabold text-emerald-900">{value}</div>
        <div className="mt-1 flex items-center justify-center gap-2">
          <input
            type="range"
            min={1}
            max={12}
            value={value}
            onChange={(event) => setValue(Number(event.target.value))}
            className="h-40 w-1.5 cursor-pointer accent-emerald-700 [writing-mode:bt-lr] [-webkit-appearance:slider-vertical]"
          />
        </div>
        <div className="mt-2 h-[40px] w-[40px] p-[4px]">
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`h-full w-full rounded-full text-xs font-bold tracking-wide text-white shadow-[0_6px_14px_rgba(0,0,0,0.25)] transition active:scale-[0.98] ${
              canConfirm
                ? "bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800"
                : "cursor-not-allowed bg-slate-400 opacity-80"
            }`}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

export default EnvidoStoneSlider;

