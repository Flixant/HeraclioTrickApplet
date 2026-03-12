import { useEffect } from "react";
import carta from "../assets/carta.png";

export default function LoginPage({
  authError,
  isFirebaseConfigured,
  onSignInWithGoogle,
  onStartAnonymousSession,
}) {
  useEffect(() => {
    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    const prevHtmlOverflow = htmlEl.style.overflow;
    const prevBodyOverflow = bodyEl.style.overflow;
    htmlEl.style.overflow = "hidden";
    bodyEl.style.overflow = "hidden";
    return () => {
      htmlEl.style.overflow = prevHtmlOverflow;
      bodyEl.style.overflow = prevBodyOverflow;
    };
  }, []);

  return (
    <div className="h-screen w-screen overflow bg-gradient-to-b from-emerald-900 via-emerald-950 to-emerald-950  text-emerald-50">
      <div className="mx-auto flex h-full w-full max-w-sm flex-col items-center justify-center gap-4">
        <div className="w-[min(70vw,250px)] aspect-[5/8] rounded-md border-2 border-white bg-white p-4 shadow-2xl">
          <div className="relative h-full w-full rounded-sm border border-black p-2">
            <span className="absolute left-0.5 top-0 z-10 text-2xl font-bold leading-none text-slate-800">1</span>
            <img
              src={carta}
              alt="Diseno de naipe"
              className="h-full w-full object-contain"
              draggable={false}
            />
            <span className="absolute bottom-0 right-0.5 z-10 rotate-180 text-2xl font-bold leading-none text-slate-800">1</span>
          </div>
        </div>

        <div className="w-[min(70vw,250px)] pt-4">
          <h1 className="text-center text-lg font-semibold uppercase tracking-[0.08em] bg-gradient-to-tl from-[#d4c18d] via-[#b69f66] to-[#8e7a4a] bg-clip-text text-transparent">
            Truco Venezolano
          </h1>
          <p className="mt-1 text-center text-xs text-emerald-100/90">
            Inicia sesion con Google o entra como invitado para jugar.
          </p>

          <div className="mt-3 space-y-2">
            <button
              type="button"
              onClick={onSignInWithGoogle}
              disabled={!isFirebaseConfigured}
              className="flex w-full items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15 18.9 12 24 12c3 0 5.8 1.1 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.3l-6.3-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.6 5.1C9.5 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3-3.2 5.4-6 6.9l.1-.1 6.3 5.2C35.2 40.4 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" />
              </svg>
              Iniciar sesion con Google
            </button>

            <button
              type="button"
              onClick={onStartAnonymousSession}
              className="w-full rounded-full border border-emerald-300/35 bg-emerald-800/70 px-4 py-2 text-sm font-semibold text-emerald-50 transition hover:bg-emerald-700/75"
            >
              Entrar como invitado
            </button>
          </div>

          {!isFirebaseConfigured ? (
            <p className="mt-2 text-center text-[11px] text-amber-200">
              Google Auth deshabilitado: faltan variables `VITE_FIREBASE_*`.
            </p>
          ) : null}
          {authError ? <p className="mt-2 text-center text-xs text-red-300">{authError}</p> : null}
        </div>
      </div>
    </div>
  );
}
