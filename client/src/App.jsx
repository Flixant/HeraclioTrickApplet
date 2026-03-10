import { useEffect, useRef, useState } from "react";
import { socket } from "./socket";
import Mesa from "./pages/mesa";
import logo from "./assets/logo.png";
import { auth, db, googleProvider, isFirebaseConfigured } from "./firebase";
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from "firebase/auth";
import { doc, getDoc, increment, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { resolveMyPlayerId } from "./utils/playerIdentity";

const SESSION_STORAGE_KEY = "truco_session_v1";
const MESA_PATH_PREFIX = "/mesa/";
const COUNTED_MATCHES_STORAGE_KEY = "truco_counted_matches_v1";

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

function readCountedMatches() {
  try {
    const raw = localStorage.getItem(COUNTED_MATCHES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCountedMatches(nextMatches) {
  try {
    localStorage.setItem(COUNTED_MATCHES_STORAGE_KEY, JSON.stringify(nextMatches));
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

function getRoomIdFromPathname() {
  const path = window.location.pathname || "/";
  if (!path.startsWith(MESA_PATH_PREFIX)) return null;
  const roomId = decodeURIComponent(path.slice(MESA_PATH_PREFIX.length)).trim();
  return roomId || null;
}

function isSameTeamInState(gameState, playerA, playerB) {
  if (!gameState || !playerA || !playerB) return false;
  const team1 = Array.isArray(gameState.teams?.team1) ? gameState.teams.team1 : [];
  const team2 = Array.isArray(gameState.teams?.team2) ? gameState.teams.team2 : [];
  if (team1.length || team2.length) {
    return (
      (team1.includes(playerA) && team1.includes(playerB)) ||
      (team2.includes(playerA) && team2.includes(playerB))
    );
  }
  const players = gameState.players || [];
  const aIdx = players.findIndex((p) => p.id === playerA);
  const bIdx = players.findIndex((p) => p.id === playerB);
  if (aIdx < 0 || bIdx < 0) return false;
  return aIdx % 2 === bIdx % 2;
}

function buildMatchFingerprint(roomId, gameState) {
  const endedAt = Number(gameState?.matchEndedAt) || 0;
  if (endedAt > 0) {
    return [roomId || "", "endedAt", String(endedAt)].join("::");
  }

  const score = gameState?.score || {};
  const points = gameState?.pointsByPlayer || {};
  const pointsPart = Object.keys(points)
    .sort()
    .map((k) => `${k}:${points[k]}`)
    .join("|");
  return [
    roomId || "",
    gameState?.mode || "",
    gameState?.matchWinnerId || "",
    `t1:${Number(score.team1) || 0}`,
    `t2:${Number(score.team2) || 0}`,
    pointsPart,
  ].join("::");
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

function generateProfileId() {
  return `VEN${Math.floor(1000 + Math.random() * 9000)}`;
}

function generateGuestProfileId() {
  return `INV${Math.floor(1000 + Math.random() * 9000)}`;
}

function getUserDisplayName(user, fallback = "Jugador") {
  if (!user) return fallback;
  const providerName = user.providerData?.find((p) => p?.displayName)?.displayName;
  return user.displayName || providerName || fallback;
}

function getUserPhotoURL(user) {
  if (!user) return "";
  const providerPhoto = user.providerData?.find((p) => p?.photoURL)?.photoURL;
  return user.photoURL || providerPhoto || "";
}

async function ensurePlayerProfile(user) {
  const profileRef = doc(db, "players", user.uid);
  const snapshot = await getDoc(profileRef);
  const nextDisplayName = getUserDisplayName(user, "Jugador");
  const nextPhotoURL = getUserPhotoURL(user);

  if (snapshot.exists()) {
    const current = snapshot.data() || {};
    const safeDisplayName = nextDisplayName || current.displayName || "Jugador";
    const safePhotoURL = nextPhotoURL || current.photoURL || "";
    if (current.displayName !== safeDisplayName || current.photoURL !== safePhotoURL) {
      await updateDoc(profileRef, {
        displayName: safeDisplayName,
        photoURL: safePhotoURL,
        updatedAt: serverTimestamp(),
      });
    }
    return {
      uid: user.uid,
      displayName: safeDisplayName,
      email: user.email || "",
      photoURL: safePhotoURL,
      profileId: current.profileId || generateProfileId(),
      realMoneyAccumulated: Number(current.realMoneyAccumulated || 0),
      fantasyMoneyAccumulated: Number(current.fantasyMoneyAccumulated || 0),
      wins: Number(current.wins || 0),
      losses: Number(current.losses || 0),
    };
  }

  const created = {
    uid: user.uid,
    email: user.email || "",
    displayName: nextDisplayName || "Jugador",
    photoURL: nextPhotoURL || "",
    profileId: generateProfileId(),
    realMoneyAccumulated: 0,
    fantasyMoneyAccumulated: 0,
    wins: 0,
    losses: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await setDoc(profileRef, created);
  return {
    uid: user.uid,
    email: created.email,
    displayName: created.displayName,
    photoURL: created.photoURL,
    profileId: created.profileId,
    realMoneyAccumulated: 0,
    fantasyMoneyAccumulated: 0,
    wins: 0,
    losses: 0,
  };
}

function App() {
  const [connected, setConnected] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [gameState, setGameState] = useState(null);
  const [roomId, setRoomId] = useState(() => getRoomIdFromPathname() || null);
  const [show1v1Rooms, setShow1v1Rooms] = useState(true);
  const [show2v2Rooms, setShow2v2Rooms] = useState(true);
  const [reconnectToken] = useState(() => getOrCreateReconnectToken());
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profile, setProfile] = useState(null);
  const [guestProfile, setGuestProfile] = useState(() => {
    const saved = readStoredSession();
    if (!saved?.isGuest || !saved?.playerName) return null;
    return {
      uid: null,
      email: "",
      displayName: saved.playerName,
      photoURL: "",
      profileId: saved.profileId || generateGuestProfileId(),
      realMoneyAccumulated: Number(saved.realMoneyAccumulated || 0),
      fantasyMoneyAccumulated: Number(saved.fantasyMoneyAccumulated || 0),
      wins: Number(saved.wins || 0),
      losses: Number(saved.losses || 0),
      isGuest: true,
    };
  });
  const [authError, setAuthError] = useState("");
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  const autoJoinAttemptRef = useRef("");
  const pendingMatchUpdateRef = useRef(new Set());
  const myPlayerIdRef = useRef(null);
  const suppressAutoJoinUntilRef = useRef(0);

  const currentProfile = profile || guestProfile;
  const isGuestMode = !!guestProfile;
  const effectivePlayerName = (currentProfile?.displayName || authUser?.displayName || "").trim();
  const avatarUrlRaw = profile?.photoURL || getUserPhotoURL(authUser) || "";
  const avatarUrl =
    typeof avatarUrlRaw === "string" && /^https?:\/\//i.test(avatarUrlRaw.trim())
      ? avatarUrlRaw.trim()
      : "";

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [avatarUrl]);

  const attemptJoinByUrl = (nameCandidate, avatarCandidate = "") => {
    if (Date.now() < suppressAutoJoinUntilRef.current) return;
    const roomIdFromUrl = getRoomIdFromPathname();
    const cleanName = (nameCandidate || "").trim();
    const cleanAvatar =
      typeof avatarCandidate === "string" && /^https?:\/\//i.test(avatarCandidate.trim())
        ? avatarCandidate.trim()
        : "";
    if (!connected || !roomIdFromUrl || !cleanName) return;

    const attemptKey = `${roomIdFromUrl}:${cleanName}:${cleanAvatar}:${socket.id || "no-socket"}`;
    if (autoJoinAttemptRef.current === attemptKey) return;
    autoJoinAttemptRef.current = attemptKey;

    setRoomId(roomIdFromUrl);
    writeStoredSession({
      ...readStoredSession(),
      isGuest: isGuestMode,
      playerName: cleanName,
      profileId: currentProfile?.profileId || readStoredSession().profileId || null,
      reconnectToken,
      roomId: roomIdFromUrl,
    });
    socket.emit("room:join", {
      roomId: roomIdFromUrl,
      playerName: cleanName,
      reconnectToken,
      avatarUrl: cleanAvatar,
    });
  };

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) {
      setAuthLoading(false);
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setAuthError("");
      setAuthUser(user);
      if (!user) {
        setProfile(null);
        setAuthLoading(false);
        return;
      }
      setProfileLoading(true);
      try {
        if (guestProfile) {
          setGuestProfile(null);
        }
        const loaded = await ensurePlayerProfile(user);
        setProfile(loaded);
        writeStoredSession({
          ...readStoredSession(),
          isGuest: false,
          playerName: loaded.displayName,
          profileId: loaded.profileId,
          reconnectToken,
          roomId: readStoredSession().roomId || null,
        });
      } catch (error) {
        console.error("No se pudo cargar perfil Firebase:", error);
        setAuthError("No se pudo cargar tu perfil de jugador.");
      } finally {
        setProfileLoading(false);
        setAuthLoading(false);
      }
    });

    return () => unsubscribe();
  }, [guestProfile, reconnectToken]);

  useEffect(() => {
    function onConnect() {
      setConnected(true);
      socket.emit("rooms:list");
      const saved = readStoredSession();
      const roomIdFromUrl = getRoomIdFromPathname();
      if (roomIdFromUrl && reconnectToken) {
        const preferredName = (effectivePlayerName || saved?.playerName || "").trim();
        attemptJoinByUrl(preferredName, avatarUrl);
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
        isGuest: isGuestMode,
        playerName: effectivePlayerName || readStoredSession().playerName || "",
        profileId: currentProfile?.profileId || readStoredSession().profileId || null,
        reconnectToken,
        roomId: nextRoomId,
      });
    }

    function onGameUpdate(payload) {
      const payloadRoomId = payload?.roomId;
      const nextState = payload?.gameState || payload;
      if (!nextState) return;
      if (payloadRoomId && (!roomId || payloadRoomId !== roomId)) return;
      setGameState((prev) => {
        const prevVersion = Number(prev?.stateVersion) || 0;
        const nextVersion = Number(nextState?.stateVersion) || 0;
        if (nextVersion && prevVersion && nextVersion < prevVersion) return prev;
        return nextState;
      });
    }

    function onReturnRoomList() {
      suppressAutoJoinUntilRef.current = Date.now() + 4000;
      setGameState(null);
      setRoomId(null);
      window.history.replaceState({}, "", "/");
      writeStoredSession({
        ...readStoredSession(),
        isGuest: isGuestMode,
        playerName: effectivePlayerName,
        profileId: currentProfile?.profileId || readStoredSession().profileId || null,
        reconnectToken,
        roomId: null,
      });
      socket.emit("rooms:list");
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("rooms:update", onRoomsUpdate);
    socket.on("game:start", onGameStart);
    socket.on("game:update", onGameUpdate);
    socket.on("match:return-roomlist", onReturnRoomList);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("rooms:update", onRoomsUpdate);
      socket.off("game:start", onGameStart);
      socket.off("game:update", onGameUpdate);
      socket.off("match:return-roomlist", onReturnRoomList);
    };
  }, [avatarUrl, currentProfile?.profileId, effectivePlayerName, isGuestMode, reconnectToken, roomId]);

  useEffect(() => {
    attemptJoinByUrl(effectivePlayerName, avatarUrl);
  }, [avatarUrl, effectivePlayerName, connected, gameState]);

  useEffect(() => {
    writeStoredSession({
      ...readStoredSession(),
      isGuest: isGuestMode,
      playerName: effectivePlayerName,
      profileId: currentProfile?.profileId || readStoredSession().profileId || null,
      reconnectToken,
      roomId,
    });
    setUrlForRoom(roomId);
  }, [currentProfile?.profileId, effectivePlayerName, isGuestMode, reconnectToken, roomId]);

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

  useEffect(() => {
    const players = Array.isArray(gameState?.players) ? gameState.players : [];
    if (!players.length) return;
    const resolvedId = resolveMyPlayerId(players, {
      socketId: socket.id,
      reconnectToken,
      playerName: effectivePlayerName,
      fallbackId: null,
    });
    if (resolvedId) {
      myPlayerIdRef.current = resolvedId;
    }
  }, [effectivePlayerName, gameState, reconnectToken]);

  useEffect(() => {
    if (!db || !authUser || !profile || !gameState?.matchEnded || !gameState?.matchWinnerId) return;

    const players = Array.isArray(gameState.players) ? gameState.players : [];
    const myPlayerId = resolveMyPlayerId(players, {
      socketId: socket.id,
      reconnectToken,
      playerName: effectivePlayerName,
      fallbackId: myPlayerIdRef.current || null,
    });
    if (!myPlayerId) {
      console.warn("[W/L] No se pudo resolver myPlayerId al cierre de partida");
      return;
    }

    const fingerprint = buildMatchFingerprint(roomId, gameState);
    const counted = readCountedMatches();
    if (counted.includes(fingerprint) || pendingMatchUpdateRef.current.has(fingerprint)) return;
    pendingMatchUpdateRef.current.add(fingerprint);
    const nextCounted = [...counted, fingerprint].slice(-20);
    writeCountedMatches(nextCounted);

    const iWon =
      gameState.mode === "2vs2"
        ? isSameTeamInState(gameState, myPlayerId, gameState.matchWinnerId)
        : myPlayerId === gameState.matchWinnerId;

    const profileRef = doc(db, "players", authUser.uid);
    setDoc(
      profileRef,
      {
        wins: increment(iWon ? 1 : 0),
        losses: increment(iWon ? 0 : 1),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    )
      .then(() => {
        setProfile((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            wins: Number(prev.wins || 0) + (iWon ? 1 : 0),
            losses: Number(prev.losses || 0) + (iWon ? 0 : 1),
          };
        });
        pendingMatchUpdateRef.current.delete(fingerprint);
      })
      .catch((error) => {
        console.error("No se pudo actualizar W/L en Firebase:", error);
        pendingMatchUpdateRef.current.delete(fingerprint);
      });
  }, [authUser, db, effectivePlayerName, gameState, profile, reconnectToken, roomId]);

  const joinRoom = (nextRoomId) => {
    if (!effectivePlayerName.trim()) return;
    setRoomId(nextRoomId);
    writeStoredSession({
      ...readStoredSession(),
      isGuest: isGuestMode,
      playerName: effectivePlayerName,
      profileId: currentProfile?.profileId || readStoredSession().profileId || null,
      reconnectToken,
      roomId: nextRoomId,
    });
    socket.emit("room:join", {
      roomId: nextRoomId,
      playerName: effectivePlayerName,
      reconnectToken,
      avatarUrl,
    });
  };

  const leaveToRoomList = () => {
    suppressAutoJoinUntilRef.current = Date.now() + 4000;
    autoJoinAttemptRef.current = "";
    window.history.replaceState({}, "", "/");
    if (roomId) {
      socket.emit("room:leave");
    }
    setGameState(null);
    setRoomId(null);
    writeStoredSession({
      ...readStoredSession(),
      isGuest: isGuestMode,
      playerName: effectivePlayerName,
      profileId: currentProfile?.profileId || readStoredSession().profileId || null,
      reconnectToken,
      roomId: null,
    });
    socket.emit("rooms:list");
  };

  const signInWithGoogle = async () => {
    if (!isFirebaseConfigured || !auth || !googleProvider) return;
    setAuthError("");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      const authCode = String(error?.code || "");
      const fallbackToRedirect =
        authCode.includes("popup-blocked") ||
        authCode.includes("popup-closed-by-user") ||
        authCode.includes("operation-not-supported-in-this-environment");
      if (fallbackToRedirect) {
        try {
          await signInWithRedirect(auth, googleProvider);
          return;
        } catch (redirectError) {
          console.error("Error login Google (redirect):", redirectError);
        }
      }
      console.error("Error login Google:", error);
      setAuthError("No se pudo iniciar sesión con Google.");
    }
  };

  const startAnonymousSession = () => {
    const guestName = `Invitado ${Math.floor(100 + Math.random() * 900)}`;
    const guest = {
      uid: null,
      email: "",
      displayName: guestName,
      photoURL: "",
      profileId: generateGuestProfileId(),
      realMoneyAccumulated: 0,
      fantasyMoneyAccumulated: 0,
      wins: 0,
      losses: 0,
      isGuest: true,
    };
    setAuthError("");
    setGuestProfile(guest);
    setProfile(null);
    writeStoredSession({
      ...readStoredSession(),
      isGuest: true,
      playerName: guest.displayName,
      profileId: guest.profileId,
      reconnectToken,
      roomId: readStoredSession().roomId || null,
    });
  };

  const logout = async () => {
    if (isGuestMode) {
      setGuestProfile(null);
      setProfile(null);
      setAuthUser(null);
      setGameState(null);
      setRoomId(null);
      socket.emit("room:leave");
      socket.emit("rooms:list");
      writeStoredSession({
        ...readStoredSession(),
        isGuest: false,
        playerName: "",
        profileId: null,
        roomId: null,
      });
      return;
    }
    if (!auth) return;
    try {
      await signOut(auth);
      setGameState(null);
      setRoomId(null);
      writeStoredSession({
        ...readStoredSession(),
        isGuest: false,
        roomId: null,
      });
      socket.emit("room:leave");
      socket.emit("rooms:list");
    } catch (error) {
      console.error("Error cerrando sesión:", error);
      setAuthError("No se pudo cerrar sesión.");
    }
  };

  if (authLoading || profileLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-emerald-950 text-emerald-100">
        Cargando sesión...
      </div>
    );
  }

  if ((!authUser || !profile) && !isGuestMode) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-emerald-900 via-emerald-950 to-emerald-950 px-4 py-10 text-emerald-50">
        <div className="mx-auto max-w-md rounded-2xl border border-emerald-300/20 bg-emerald-900/45 p-6 text-center shadow-[0_16px_40px_rgba(0,0,0,0.32)]">
          <img
            src={logo}
            alt="Logo Truco Venezolano"
            className="mx-auto h-24 w-24 rounded-xl object-contain"
          />
          <h1 className="mt-4 text-3xl font-extrabold">
            <span className="bg-gradient-to-r from-amber-200 via-yellow-200 to-amber-400 bg-clip-text text-transparent">
              Truco Venezolano
            </span>
          </h1>
          <p className="mt-3 text-sm text-emerald-100/80">
            Inicia sesión con Google o entra como anónimo para jugar.
          </p>
          <button
            type="button"
            onClick={signInWithGoogle}
            disabled={!isFirebaseConfigured}
            className="mt-6 rounded-full bg-yellow-400 px-5 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Iniciar sesión con Google
          </button>
          <button
            type="button"
            onClick={startAnonymousSession}
            className="mt-3 rounded-full border border-emerald-300/30 bg-emerald-800/60 px-5 py-2 text-sm font-semibold text-emerald-50 transition hover:bg-emerald-700/70"
          >
            Entrar como anónimo
          </button>
          {!isFirebaseConfigured ? (
            <p className="mt-2 text-xs text-amber-200/90">
              Google Auth deshabilitado: faltan variables `VITE_FIREBASE_*`.
            </p>
          ) : null}
          {authError ? <p className="mt-3 text-sm text-red-300">{authError}</p> : null}
        </div>
      </div>
    );
  }

  if (gameState) {
    return (
      <Mesa
        key={roomId || "mesa"}
        roomId={roomId}
        gameState={gameState}
        myAvatarUrl={avatarUrl}
        onLeaveToRoomList={leaveToRoomList}
      />
    );
  }

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
        player.id === socket.id ||
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
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-700 text-sm font-bold text-emerald-50 overflow-hidden">
                  {avatarUrl && !avatarLoadFailed ? (
                    <img
                      src={avatarUrl}
                      alt="Avatar"
                      className="h-full w-full object-cover"
                      referrerPolicy="no-referrer"
                      onError={() => setAvatarLoadFailed(true)}
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
                  Fantasía: ${Number(currentProfile?.fantasyMoneyAccumulated || 0).toLocaleString("en-US")}
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
              onClick={logout}
              className="rounded-full border border-emerald-300/25 bg-emerald-900/45 px-4 py-1.5 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-800/55"
            >
              {isGuestMode ? "Salir invitado" : "Cerrar sesión"}
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

        <div className="mt-2 flex justify-center gap-2 pb-4">
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
