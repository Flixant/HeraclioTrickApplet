import { useEffect, useRef, useState } from "react";
import { socket } from "./socket";
import Mesa from "./pages/mesa";
import logo from "./assets/logo.png";

const SESSION_STORAGE_KEY = "truco_session_v1";
const MESA_PATH_PREFIX = "/mesa/";

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStoredSession(nextSession) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession));
  } catch {}
}

function getOrCreateReconnectToken() {
  const current = readStoredSession();
  if (current.reconnectToken) return current.reconnectToken;
  const token =
    (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  writeStoredSession({ ...current, reconnectToken: token });
  return token;
}

function getOrCreateDummyProfile() {
  const current = readStoredSession();
  const defaultName = "Felix";
  const needsNameMigration =
    !current.playerName || current.playerName.trim().toLowerCase() === "jugador demo";
  const hasBaseProfileData =
    current.profileId &&
    typeof current.realMoneyAccumulated === "number" &&
    typeof current.fantasyMoneyAccumulated === "number";
  const missingWinLossData =
    typeof current.wins !== "number" || typeof current.losses !== "number";

  if (hasBaseProfileData && missingWinLossData) {
    writeStoredSession({
      ...current,
      wins: Math.floor(18 + Math.random() * 82),
      losses: Math.floor(8 + Math.random() * 44),
    });
  }

  const refreshed = readStoredSession();
  if (
    (refreshed.playerName || needsNameMigration) &&
    refreshed.profileId &&
    typeof refreshed.realMoneyAccumulated === "number" &&
    typeof refreshed.fantasyMoneyAccumulated === "number" &&
    typeof refreshed.wins === "number" &&
    typeof refreshed.losses === "number"
  ) {
    const finalName = needsNameMigration ? defaultName : refreshed.playerName;
    if (finalName !== refreshed.playerName) {
      writeStoredSession({
        ...refreshed,
        playerName: finalName,
      });
    }
    return {
      name: finalName,
      id: refreshed.profileId,
      realMoneyAccumulated: refreshed.realMoneyAccumulated,
      fantasyMoneyAccumulated: refreshed.fantasyMoneyAccumulated,
      wins: refreshed.wins,
      losses: refreshed.losses,
    };
  }
  const profileId = `VEN${Math.floor(1000 + Math.random() * 9000)}`;
  const name = defaultName;
  const realMoneyAccumulated = Number((Math.random() * 250 + 25).toFixed(2));
  const fantasyMoneyAccumulated = Math.floor(8000 + Math.random() * 42000);
  const wins = Math.floor(18 + Math.random() * 82);
  const losses = Math.floor(8 + Math.random() * 44);
  writeStoredSession({
    ...current,
    playerName: name,
    profileId,
    realMoneyAccumulated,
    fantasyMoneyAccumulated,
    wins,
    losses,
  });
  return {
    name,
    id: profileId,
    realMoneyAccumulated,
    fantasyMoneyAccumulated,
    wins,
    losses,
  };
}

function getRoomIdFromPathname() {
  const path = window.location.pathname || "/";
  if (!path.startsWith(MESA_PATH_PREFIX)) return null;
  const roomId = decodeURIComponent(path.slice(MESA_PATH_PREFIX.length)).trim();
  return roomId || null;
}

function setUrlForRoom(roomId) {
  const nextPath = roomId ? `${MESA_PATH_PREFIX}${encodeURIComponent(roomId)}` : "/";
  if (window.location.pathname !== nextPath) {
    window.history.replaceState({}, "", nextPath);
  }
}

function clearLocalSessionAndReload() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {}
  window.location.reload();
}

function App() {
  const [dummyProfile] = useState(() => getOrCreateDummyProfile());
  const [connected, setConnected] = useState(false);
  const [playerName] = useState(() => {
    const saved = readStoredSession().playerName;
    return saved || dummyProfile.name;
  });
  const [rooms, setRooms] = useState([]);
  const [gameState, setGameState] = useState(null);
  const [roomId, setRoomId] = useState(() => getRoomIdFromPathname() || null);
  const [show1v1Rooms, setShow1v1Rooms] = useState(true);
  const [show2v2Rooms, setShow2v2Rooms] = useState(true);
  const [reconnectToken] = useState(() => getOrCreateReconnectToken());
  const autoJoinAttemptRef = useRef("");

  const attemptJoinByUrl = (nameCandidate) => {
    const roomIdFromUrl = getRoomIdFromPathname();
    const cleanName = (nameCandidate || "").trim();
    if (!connected || !roomIdFromUrl || !cleanName) return;

    const attemptKey = `${roomIdFromUrl}:${cleanName}:${socket.id || "no-socket"}`;
    if (autoJoinAttemptRef.current === attemptKey) return;
    autoJoinAttemptRef.current = attemptKey;

    setRoomId(roomIdFromUrl);
    writeStoredSession({
      ...readStoredSession(),
      playerName: cleanName,
      reconnectToken,
      roomId: roomIdFromUrl,
    });
    socket.emit("room:join", {
      roomId: roomIdFromUrl,
      playerName: cleanName,
      reconnectToken,
    });
  };

  useEffect(() => {
    function onConnect() {
      setConnected(true);
      socket.emit("rooms:list");
      const saved = readStoredSession();
      const roomIdFromUrl = getRoomIdFromPathname();
      // URL manda: solo autojoin en /mesa/CODIGO (no en raiz).
      if (roomIdFromUrl && reconnectToken) {
        const preferredName = (saved?.playerName || playerName || "").trim();
        attemptJoinByUrl(preferredName);
      }
    }

    function onDisconnect() {
      setConnected(false);
      autoJoinAttemptRef.current = "";
    }

    function onRoomsUpdate(updatedRooms) {
      setRooms(updatedRooms);
    }

    function onGameStart({ roomId: nextRoomId, gameState: nextGameState }) {
      setRoomId(nextRoomId);
      setGameState(nextGameState);
      writeStoredSession({
        ...readStoredSession(),
        playerName: playerName || readStoredSession().playerName || "",
        reconnectToken,
        roomId: nextRoomId,
      });
    }

    function onReturnRoomList() {
      setGameState(null);
      setRoomId(null);
      writeStoredSession({
        ...readStoredSession(),
        playerName,
        reconnectToken,
        roomId: null,
      });
      socket.emit("rooms:list");
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("rooms:update", onRoomsUpdate);
    socket.on("game:start", onGameStart);
    socket.on("match:return-roomlist", onReturnRoomList);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("rooms:update", onRoomsUpdate);
      socket.off("game:start", onGameStart);
      socket.off("match:return-roomlist", onReturnRoomList);
    };
  }, [playerName, reconnectToken]);

  useEffect(() => {
    // Si abren /mesa/CODIGO sin nombre en cache, al escribir nombre entra.
    attemptJoinByUrl(playerName);
  }, [playerName, connected, gameState]);

  useEffect(() => {
    writeStoredSession({
      ...readStoredSession(),
      playerName,
      reconnectToken,
      roomId,
    });
    setUrlForRoom(roomId);
  }, [playerName, reconnectToken, roomId]);

  useEffect(() => {
    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    const previousHtmlOverflow = htmlEl.style.overflow;
    const previousBodyOverflow = bodyEl.style.overflow;

    if (gameState) {
      htmlEl.style.overflow = "hidden";
      bodyEl.style.overflow = "hidden";
    } else {
      htmlEl.style.overflow = "";
      bodyEl.style.overflow = "";
    }

    return () => {
      htmlEl.style.overflow = previousHtmlOverflow;
      bodyEl.style.overflow = previousBodyOverflow;
    };
  }, [gameState]);

  const joinRoom = (nextRoomId) => {
    if (!playerName.trim()) return;
    setRoomId(nextRoomId);
    writeStoredSession({
      ...readStoredSession(),
      playerName,
      reconnectToken,
      roomId: nextRoomId,
    });
    socket.emit("room:join", { roomId: nextRoomId, playerName, reconnectToken });
  };

  const leaveToRoomList = () => {
    if (roomId) {
      socket.emit("room:leave");
    }
    setGameState(null);
    setRoomId(null);
    writeStoredSession({
      ...readStoredSession(),
      playerName,
      reconnectToken,
      roomId: null,
    });
    socket.emit("rooms:list");
  };

  if (gameState) {
    return (
      <Mesa
        key={roomId || "mesa"}
        roomId={roomId}
        gameState={gameState}
        onLeaveToRoomList={leaveToRoomList}
      />
    );
  }

  const rooms1v1 = rooms.filter((room) => room.mode === "1vs1");
  const rooms2v2 = rooms.filter((room) => room.mode === "2vs2");
  const needsScroll1v1 = rooms1v1.length > 3;
  const needsScroll2v2 = rooms2v2.length > 3;
  const totalMatches = Number(dummyProfile.wins || 0) + Number(dummyProfile.losses || 0);
  const safeTotalMatches = Math.max(1, totalMatches);
  const winPct = Math.round((Number(dummyProfile.wins || 0) / safeTotalMatches) * 100);
  const lossPct = 100 - winPct;
  const winDeg = Math.round((winPct / 100) * 360);

  const renderRoomCard = (room) => {
    const isFull = room.players.length >= room.maxPlayers;
    const isMySeat = room.players.some(
      (player) =>
        player.id === socket.id ||
        (!!reconnectToken && player.reconnectToken === reconnectToken)
    );
    const canReenter = !!playerName.trim() && isMySeat;
    const canJoin = !!playerName.trim() && (!isFull || canReenter);
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
            Modo: {room.allowBots ? "2vs2 bots" : room.mode}
          </span>
          <span className="font-medium text-emerald-100/90">
            Jugadores: {room.players.length}/{room.maxPlayers}
          </span>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => joinRoom(room.id)}
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

          <div className="mb-3 flex justify-center">
            
          </div>

          <div className="mb-3 flex items-center justify-left">
            <img
              src={logo}
              alt="Logo Truco Venezolano"
              className="h-20 w-20 rounded-xl object-contain sm:h-24 sm:w-24"
            />
            <h1 className="text-2xl font-extrabold tracking-wide sm:text-3xl">
              <span className="bg-gradient-to-r from-amber-200 via-yellow-200 to-amber-400 bg-clip-text text-transparent">
                Truco Venezolano
              </span>
            </h1>
          </div>

          <div className="mx-auto mt-1 flex w-full max-w-sm items-center gap-3 rounded-xl border border-emerald-300/25 bg-emerald-950/55 px-3 py-2.5">
            
            <div className="min-w-0 flex-1">
              <div className="flex gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-700 text-sm font-bold text-emerald-50">
                  {playerName.slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <p className="truncate text-sm font-semibold text-emerald-50">{playerName}</p>
              <p className="text-xs text-emerald-200/75">ID: {dummyProfile.id}</p>
                </div>
              
            </div>
              
              
              <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-emerald-100/85">
                <span className="rounded-md bg-emerald-900/55 px-2 py-1">
                  Real: ${dummyProfile.realMoneyAccumulated?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="rounded-md bg-emerald-900/55 px-2 py-1">
                  Fantasía: ${Number(dummyProfile.fantasyMoneyAccumulated || 0).toLocaleString("en-US")}
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
                <span className="rounded  px-0.5 py-1 text-center text-emerald-300">
                  {dummyProfile.wins || 0}W
                </span>
                <span className="rounded  px-0.5 py-1 text-center text-red-300">
                  {dummyProfile.losses || 0}L
                </span>
              </div>
            </div>
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
            {show1v1Rooms && (
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
            )}
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
            {show2v2Rooms && (
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
            )}
          </div>
        </section>

        <p className="mt-8 pb-2 text-center text-xl font-medium text-cyan-100/80 sm:text-2xl">
          Gestiona tus partidas de Truco Venezolano
        </p>

        <div className="mt-2 flex justify-center pb-4">
          <button
            type="button"
            onClick={clearLocalSessionAndReload}
            className="rounded-full border border-emerald-300/25 bg-emerald-900/45 px-4 py-1.5 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-800/55"
          >
            Reset sesión local (debug)
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
