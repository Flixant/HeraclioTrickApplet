import { useEffect, useRef, useState } from "react";
import logo from "../assets/logo.png";
import { db, isFirebaseConfigured } from "../firebase";
import { collection, doc, getDoc, getDocs, limit, query, where } from "firebase/firestore";

export default function RoomWaitingPage({
  connected,
  roomId,
  room,
  effectivePlayerName,
  currentProfile,
  reconnectToken,
  socketId,
  countdown,
  onLeave,
}) {
  const players = Array.isArray(room?.players) ? room.players : [];
  const maxPlayers = Math.max(2, Number(room?.maxPlayers) || 0);
  const mode = room?.mode || "-";
  const filledSeats = Math.min(players.length, maxPlayers);
  const seatsLeft = Math.max(0, maxPlayers - filledSeats);
  const countdownValue = Number(countdown);
  const isStarting = Number.isFinite(countdownValue) && countdownValue > 0;
  const previousPlayersRef = useRef(players);
  const [animatingIds, setAnimatingIds] = useState({});
  const [remoteStatsByProfileId, setRemoteStatsByProfileId] = useState({});

  const isMyPlayer = (player) =>
    !!player &&
    (player.id === socketId ||
      (!!reconnectToken && player.reconnectToken === reconnectToken));

  useEffect(() => {
    const previousPlayers = previousPlayersRef.current || [];
    const previousIds = new Set(previousPlayers.map((player) => player?.id).filter(Boolean));
    const joinedPlayers = players.filter((player) => player?.id && !previousIds.has(player.id));
    if (!joinedPlayers.length) {
      previousPlayersRef.current = players;
      return undefined;
    }

    const idsToAnimate = joinedPlayers.map((player) => player.id);
    setAnimatingIds((prev) => {
      const next = { ...prev };
      idsToAnimate.forEach((id) => {
        next[id] = true;
      });
      return next;
    });

    const animationTimer = setTimeout(() => {
      setAnimatingIds((prev) => {
        const next = { ...prev };
        idsToAnimate.forEach((id) => delete next[id]);
        return next;
      });
    }, 520);

    previousPlayersRef.current = players;
    return () => {
      clearTimeout(animationTimer);
    };
  }, [players]);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return undefined;
    const targets = players.filter((player) => player?.profileId && !isMyPlayer(player));
    if (!targets.length) return undefined;
    let cancelled = false;

    (async () => {
      const nextStats = {};
      for (const player of targets) {
        const profileKey = String(player.profileId || "").trim();
        if (
          !profileKey ||
          Object.prototype.hasOwnProperty.call(remoteStatsByProfileId, profileKey)
        ) {
          continue;
        }
        let data = null;
        try {
          const uid = String(player.playerUid || "").trim();
          if (uid) {
            const snapshot = await getDoc(doc(db, "players", uid));
            if (snapshot.exists()) data = snapshot.data() || null;
          }
          if (!data) {
            const q = query(
              collection(db, "players"),
              where("profileId", "==", profileKey),
              limit(1)
            );
            const snap = await getDocs(q);
            if (!snap.empty) {
              data = snap.docs[0]?.data() || null;
            }
          }
        } catch {
          data = null;
        }
        if (data) {
          nextStats[profileKey] = {
            wins: Number(data.wins || 0),
            losses: Number(data.losses || 0),
          };
        } else {
          nextStats[profileKey] = null;
        }
      }
      if (cancelled || !Object.keys(nextStats).length) return;
      setRemoteStatsByProfileId((prev) => ({ ...prev, ...nextStats }));
    })();

    return () => {
      cancelled = true;
    };
  }, [players, remoteStatsByProfileId, reconnectToken, socketId]);

  const renderSeatCard = (player, index) => {
    if (!player) {
      return (
        <div
          key={`seat-empty-${index}`}
          className="h-[84px] rounded-xl border border-dashed border-emerald-300/20 bg-emerald-950/35 px-3 py-2.5"
        >
          <div className="flex h-full items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-emerald-900/60" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-emerald-200/75">Asiento libre</p>
              <p className="text-xs text-emerald-200/45">Esperando jugador...</p>
            </div>
          </div>
        </div>
      );
    }

    const mine = isMyPlayer(player);
    const remoteStats = !mine && player?.profileId ? remoteStatsByProfileId[player.profileId] : null;
    const winsRaw = mine
      ? Number(currentProfile?.wins || 0)
      : remoteStats
        ? Number(remoteStats.wins || 0)
        : Number(player?.wins);
    const lossesRaw = mine
      ? Number(currentProfile?.losses || 0)
      : remoteStats
        ? Number(remoteStats.losses || 0)
        : Number(player?.losses);
    const hasStats = Number.isFinite(winsRaw) && Number.isFinite(lossesRaw);
    const wins = hasStats ? Math.max(0, winsRaw) : 0;
    const losses = hasStats ? Math.max(0, lossesRaw) : 0;
    const total = wins + losses;
    const winPct = total > 0 ? Math.round((wins / total) * 100) : 0;
    const lossPct = 100 - winPct;
    const winDeg = Math.round((winPct / 100) * 360);
    const cardAnimation = animatingIds[player.id]
      ? "animate-[seatJoinIn_460ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
      : "";

    return (
      <div
        key={player.id || `seat-player-${index}`}
        className={`h-[84px] rounded-xl border px-3 py-2.5 shadow-[0_8px_18px_rgba(0,0,0,0.2)] ${cardAnimation} ${
          mine
            ? "border-cyan-300/35 bg-cyan-900/30"
            : "border-emerald-300/20 bg-emerald-900/45"
        }`}
      >
        <div className="flex h-full items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-emerald-700 text-sm font-bold text-emerald-50">
            {player.avatarUrl ? (
              <img
                src={player.avatarUrl}
                alt={player.name || "Jugador"}
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              String(player.name || "J").slice(0, 1).toUpperCase()
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className={`truncate text-sm font-semibold ${mine ? "text-cyan-100" : "text-emerald-50"}`}>
              {player.name || "Jugador"}
              {mine ? " (Tu)" : ""}
            </p>
            <p className={`truncate text-xs ${mine ? "text-cyan-200/80" : "text-emerald-200/70"}`}>
              ID: {player.profileId || "-"}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-center">
            <div
              className="relative h-10 w-10 rounded-full ring-2 ring-emerald-200/15"
              style={{
                background: `conic-gradient(from -90deg, #22c55e 0deg ${winDeg}deg, #ef4444 ${winDeg}deg 360deg)`,
              }}
              aria-label={`Victorias ${winPct}%, derrotas ${lossPct}%`}
              title={`Victorias ${winPct}% / Derrotas ${lossPct}%`}
            >
              <div className="absolute inset-[3px] flex items-center justify-center rounded-full bg-emerald-950 text-[10px] font-bold text-emerald-300">
                {hasStats ? `${winPct}%` : "--"}
              </div>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-1 text-[10px]">
              <span className="rounded px-0.5 py-0.5 text-center text-emerald-300">
                {hasStats ? `${wins}W` : "-W"}
              </span>
              <span className="rounded px-0.5 py-0.5 text-center text-red-300">
                {hasStats ? `${losses}L` : "-L"}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-900 via-emerald-950 to-emerald-950 px-4 py-6 text-emerald-50">
      <div className="mx-auto w-full max-w-md rounded-2xl border border-emerald-300/20 bg-emerald-900/45 p-5 shadow-[0_16px_40px_rgba(0,0,0,0.32)]">
        <div className="mb-4 flex items-center gap-2">
          <img src={logo} alt="Truco Venezolano" className="h-12 opacity-80" />
          <div>
            <h1 className="text-lg font-bold tracking-wide text-emerald-100">Sala {roomId}</h1>
            <p className="text-xs text-emerald-200/80">Modo {mode}</p>
          </div>
          <span
            className={`ml-auto rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              connected ? "bg-emerald-500/20 text-emerald-100" : "bg-emerald-700/30 text-emerald-100/80"
            }`}
          >
            {connected ? "Conectado" : "Desconectado"}
          </span>
        </div>

        <div className="rounded-xl border border-emerald-300/15 bg-emerald-950/45 p-3">
          <p className="text-sm text-emerald-100">
            Sentado como <span className="font-semibold">{effectivePlayerName}</span>
          </p>
          <p className="mt-1 text-sm text-emerald-200/85">
            Esperando jugadores: {filledSeats}/{maxPlayers}
          </p>
          <p className="mt-1 text-xs text-emerald-200/70">
            {isStarting
              ? "Mesa completa. Preparando cartas..."
              : seatsLeft === 1
                ? "Falta 1 jugador para empezar"
                : `Faltan ${seatsLeft} jugadores para empezar`}
          </p>
        </div>

        <div className="mt-4 space-y-2">
          {Array.from({ length: maxPlayers }).map((_, index) =>
            renderSeatCard(players[index], index)
          )}
        </div>

        <button
          type="button"
          onClick={onLeave}
          className="mt-4 w-full rounded-full border border-emerald-300/25 bg-emerald-900/45 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-800/55"
        >
          Salir al roomlist
        </button>
      </div>
      {isStarting ? (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/65 px-4 backdrop-blur-[2px]">
          <div className="w-full max-w-sm rounded-2xl border border-amber-300/35 bg-amber-900/35 px-6 py-6 text-center shadow-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200/90">
              Iniciando partida
            </p>
            <p className="mt-2 text-7xl font-black leading-none text-amber-100 animate-[countdownBeat_1000ms_ease-in-out_infinite]">
              {countdownValue}
            </p>
            <p className="mt-3 text-sm text-amber-100/90">Preparando cartas y posiciones...</p>
          </div>
        </div>
      ) : null}
      <style>{`
        @keyframes seatJoinIn {
          0% {
            opacity: 0;
            transform: translateY(12px) scale(0.96);
          }
          70% {
            opacity: 1;
            transform: translateY(0) scale(1.02);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes countdownBeat {
          0% {
            transform: scale(1);
            opacity: 0.95;
          }
          45% {
            transform: scale(1.08);
            opacity: 1;
          }
          100% {
            transform: scale(1);
            opacity: 0.95;
          }
        }
      `}</style>
    </div>
  );
}
