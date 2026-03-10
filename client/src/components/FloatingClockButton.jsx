function FloatingClockButton({
  x,
  y,
  isDragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onClick,
}) {
  return (
    <button
      type="button"
      aria-label="Reloj"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      className={`fixed z-[78] flex h-[52px] w-[52px] touch-none select-none items-center justify-center rounded-full border border-emerald-200/30 bg-slate-50/95 text-slate-700 shadow-[0_10px_24px_rgba(0,0,0,0.35)] backdrop-blur-sm hover:bg-slate-200/90 active:scale-95 ${
        isDragging
          ? "transition-none"
          : "transition-[left,top,background-color,transform] duration-300 ease-out"
      }`}
      style={{ left: `${x}px`, top: `${y}px` }}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v4h4" />
        <path d="M12 7v5l3 2" />
      </svg>
    </button>
  );
}

export default FloatingClockButton;

