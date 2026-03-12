import { useState } from "react";
import logo from "../assets/logo.png";

export default function RoomListPage({
  connected,
  rooms,
  effectivePlayerName,
  currentProfile,
  avatarUrl,
  avatarLoadFailed,
  onAvatarLoadError,
  isGuestMode,
  reconnectToken,
  socketId,
  onJoinRoom,
  onLogout,
  onResetLocalSession,
}) {
  const [show1v1Rooms, setShow1v1Rooms] = useState(true);
  const [show2v2Rooms, setShow2v2Rooms] = useState(true);

  const rooms1v1 = rooms.filter((room) => room.mode === "1vs1");
  const rooms2v2 = rooms.filter((room) => room.mode === "2vs2");
  const needsScroll1v1 = rooms1v1.length > 3;
  const needsScroll2v2 = rooms2v2.length > 3;
  const totalMatches = Number(currentProfile?.wins || 0) + Number(currentProfile?.losses || 0);
  const safeTotalMatches = Math.max(1, totalMatches);
  const winPct = Math.round((Number(currentProfile?.wins || 0) / safeTotalMatches) * 100);
  const lossPct = 100 - winPct;
  const winDeg = Math.round((winPct / 100) * 360);

  const renderRoomCard = (room) => {
    const isFull = room.players.length >= room.maxPlayers;
    const isMySeat = room.players.some(
      (player) =>
        player.id === socketId ||
        (!!reconnectToken && player.reconnectToken === reconnectToken)
    );
    const canReenter = !!effectivePlayerName.trim() && isMySeat;
    const canJoin = !!effectivePlayerName.trim() && (!isFull || canReenter);
    const statusLabel = isFull ? "en juego" : "abierto";
    const enterLabel = canReenter ? "Regresar al juego" : isFull ? "Mesa llena" : "Entrar";

    return (
      <article
        key={room.id}
        className="rounded-xl border border-emerald-300/15 bg-emerald-900/35 p-3 shadow-[0_8px_18px_rgba(0,0,0,0.2)]"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-wide text-emerald-50">{room.id}</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
              isFull ? "bg-red-500 text-white" : "bg-emerald-700 text-emerald-100"
            }`}
          >
            {statusLabel}
          </span>
        </div>

        <div className="mb-3 flex items-center justify-between gap-2 text-xs sm:text-sm">
          <span className="rounded-full border border-cyan-300/20 bg-cyan-800/45 px-2.5 py-0.5 font-medium text-cyan-100">
            Modo: {room.allowBots ? `${room.mode} bots` : room.mode}
          </span>
          <span className="font-medium text-emerald-100/90">
            Jugadores: {room.players.length}/{room.maxPlayers}
          </span>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onJoinRoom(room.id)}
            disabled={!canJoin}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              canJoin
                ? "bg-yellow-400 text-emerald-950 hover:bg-yellow-300"
                : "cursor-not-allowed bg-yellow-400/55 text-emerald-950/55"
            }`}
          >
            {enterLabel}
          </button>
        </div>
      </article>
    );
  };

  return (
    <div className="min-h-screen overflow-y-auto bg-gradient-to-b from-emerald-900 via-emerald-950 to-emerald-950 text-emerald-50">
      <div className="mx-auto w-full max-w-md px-3 py-5 sm:max-w-2xl sm:px-6">
        <header className="relative mb-5 rounded-2xl border border-emerald-300/20 bg-emerald-900/45 p-4 shadow-[0_16px_40px_rgba(0,0,0,0.32)] backdrop-blur">
          <div
            className={`absolute right-4 top-4 rounded-full px-3 py-1 text-[11px] font-semibold ${
              connected ? "bg-emerald-500/20 text-emerald-100" : "bg-emerald-700/30 text-emerald-100/80"
            }`}
          >
            {connected ? "Conectado" : "Desconectado"}
          </div>

          <div className="mb-3 flex items-center justify-left">
            <img
              src={logo}
              alt="Logo Truco Venezolano"
              className="h-28 mr-1.5 opacity-80"
            />
            <h1 className="text-2xl font-semibold uppercase tracking-[0.14em] sm:text-3xl bg-gradient-to-tl from-[#d4c18d] via-[#b69f66] to-[#8e7a4a] bg-clip-text text-transparent">
              Truco Venezolano
            </h1>



          </div>

          <div className="mx-auto mt-1 flex w-full max-w-sm items-center gap-3 rounded-xl border border-emerald-300/25 bg-emerald-950/55 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-700 text-sm font-bold text-emerald-50 overflow-hidden">
                  {avatarUrl && !avatarLoadFailed ? (
                    <img
                      src={avatarUrl}
                      alt="Avatar"
                      className="h-full w-full object-cover"
                      referrerPolicy="no-referrer"
                      onError={onAvatarLoadError}
                    />
                  ) : (
                    effectivePlayerName.slice(0, 1).toUpperCase()
                  )}
                </div>
                <div>
                  <p className="truncate text-sm font-semibold text-emerald-50">{effectivePlayerName}</p>
                  <p className="text-xs text-emerald-200/75">ID: {currentProfile?.profileId || "-"}</p>
                </div>
              </div>

              <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-emerald-100/85">
                <span className="rounded-md bg-emerald-900/55 px-2 py-1">
                  Real: $
                  {Number(currentProfile?.realMoneyAccumulated || 0).toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span className="rounded-md bg-emerald-900/55 px-2 py-1">
                  Fantasia: ${Number(currentProfile?.fantasyMoneyAccumulated || 0).toLocaleString("en-US")}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-center">
              <div
                className="relative h-11 w-11 rounded-full ring-2 ring-emerald-200/10"
                style={{
                  background: `conic-gradient(from -90deg, #22c55e 0deg ${winDeg}deg, #ef4444 ${winDeg}deg 360deg)`,
                }}
                aria-label={`Victorias ${winPct}%, derrotas ${lossPct}%`}
                title={`Victorias ${winPct}% / Derrotas ${lossPct}%`}
              >
                <div className="absolute inset-[3px] flex items-center justify-center rounded-full bg-emerald-950 text-[10px] font-bold text-emerald-300">
                  {winPct}%
                </div>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1 text-[10px]">
                <span className="rounded px-0.5 py-1 text-center text-emerald-300">
                  {currentProfile?.wins || 0}W
                </span>
                <span className="rounded px-0.5 py-1 text-center text-red-300">
                  {currentProfile?.losses || 0}L
                </span>
              </div>
            </div>
          </div>

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={onLogout}
              className="rounded-full border border-emerald-300/25 bg-emerald-900/45 px-4 py-1.5 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-800/55"
            >
              {isGuestMode ? "Salir invitado" : "Cerrar sesion"}
            </button>
          </div>
        </header>

        <section className="space-y-5">
          <div className="rounded-2xl border border-emerald-300/15 bg-emerald-900/25 p-3">
            <button
              type="button"
              onClick={() => setShow1v1Rooms((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-lg bg-emerald-800/35 px-2.5 py-1.5 text-left transition hover:bg-emerald-700/45 sm:px-3 sm:py-2"
            >
              <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-200/90 sm:text-sm">
                Salas 1vs1
              </h3>
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-emerald-700/60 text-sm font-bold text-emerald-100">
                {show1v1Rooms ? "-" : "+"}
              </span>
            </button>
            <div
              className={`grid overflow-hidden transition-[grid-template-rows,margin-top] duration-300 ease-out ${
                show1v1Rooms ? "mt-3 grid-rows-[1fr]" : "mt-0 grid-rows-[0fr]"
              }`}
            >
              <div className="min-h-0 overflow-hidden">
                <div
                  className={`space-y-3 ${
                    needsScroll1v1 ? "max-h-[28.5rem] overflow-y-auto pr-1" : ""
                  }`}
                >
                  {rooms1v1.length ? rooms1v1.map((room) => renderRoomCard(room)) : (
                    <p className="rounded-xl bg-emerald-950/45 px-3 py-2 text-sm text-emerald-200/70">
                      No hay salas 1vs1 disponibles.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-emerald-300/15 bg-emerald-900/25 p-3">
            <button
              type="button"
              onClick={() => setShow2v2Rooms((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-lg bg-emerald-800/35 px-2.5 py-1.5 text-left transition hover:bg-emerald-700/45 sm:px-3 sm:py-2"
            >
              <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-200/90 sm:text-sm">
                Salas 2vs2
              </h3>
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-emerald-700/60 text-sm font-bold text-emerald-100">
                {show2v2Rooms ? "-" : "+"}
              </span>
            </button>
            <div
              className={`grid overflow-hidden transition-[grid-template-rows,margin-top] duration-300 ease-out ${
                show2v2Rooms ? "mt-3 grid-rows-[1fr]" : "mt-0 grid-rows-[0fr]"
              }`}
            >
              <div className="min-h-0 overflow-hidden">
                <div
                  className={`space-y-3 ${
                    needsScroll2v2 ? "max-h-[28.5rem] overflow-y-auto pr-1" : ""
                  }`}
                >
                  {rooms2v2.length ? rooms2v2.map((room) => renderRoomCard(room)) : (
                    <p className="rounded-xl bg-emerald-950/45 px-3 py-2 text-sm text-emerald-200/70">
                      No hay salas 2vs2 disponibles.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <p className="mt-8 pb-2 text-center text-xl font-medium text-cyan-100/80 sm:text-2xl">
          Gestiona tus partidas de Truco Venezolano
        </p>

        <div className="mt-2 flex justify-center gap-2 pb-4">
          <button
            type="button"
            onClick={onResetLocalSession}
            className="rounded-full border border-emerald-300/25 bg-emerald-900/45 px-4 py-1.5 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-800/55"
          >
            Reset sesion local (debug)
          </button>
        </div>
      </div>
    </div>
  );
}
