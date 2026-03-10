export default function CollapsibleActionGroup({ title, open, onToggle, maxHeightClass, children }) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-left text-sm font-medium text-slate-600 shadow-[0_6px_14px_rgba(0,0,0,0.25)] transition sm:py-1.5 sm:text-xs"
      >
        <span>{title}</span>
        <span className="text-lg leading-none">{open ? "-" : "+"}</span>
      </button>
      <div
        className={`overflow-hidden transition-[max-height] duration-300 ease-out ${
          open ? `${maxHeightClass} pointer-events-auto my-0.5` : "max-h-0 pointer-events-none"
        }`}
      >
        {children}
      </div>
    </>
  );
}
