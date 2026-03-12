import { useEffect, useRef, useState } from "react";
import { socket } from "./socket";
import Mesa from "./pages/mesa";
import LoginPage from "./pages/LoginPage";
import RoomListPage from "./pages/RoomListPage";
import RoomWaitingPage from "./pages/RoomWaitingPage";
import { auth, db, googleProvider, isFirebaseConfigured } from "./firebase";
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from "firebase/auth";
import { doc, getDoc, runTransaction, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
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

function shouldUseStartCountdown(nextGameState) {
  return (
    !nextGameState?.matchEnded &&
    Number(nextGameState?.handNumber || 1) === 1 &&
    Number(nextGameState?.tableCards?.length || 0) === 0
  );
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

function clearRoomHistoryStorage(roomId) {
  if (!roomId || typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(`truco_history_${roomId}`);
  } catch {}
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
      recentMatches: Array.isArray(current.recentMatches) ? current.recentMatches.slice(0, 5) : [],
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
    recentMatches: [],
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
    recentMatches: [],
  };
}

function App() {
  const [connected, setConnected] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [gameState, setGameState] = useState(null);
  const [pendingGameStart, setPendingGameStart] = useState(null);
  const [roomId, setRoomId] = useState(() => getRoomIdFromPathname() || null);
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
      recentMatches: [],
      isGuest: true,
    };
  });
  const [authError, setAuthError] = useState("");
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  const autoJoinAttemptRef = useRef("");
  const pendingMatchUpdateRef = useRef(new Set());
  const myPlayerIdRef = useRef(null);
  const suppressAutoJoinUntilRef = useRef(0);
  const countdownConsumedUntilRef = useRef(new Map());
  const liveRoomIdRef = useRef(roomId);
  const liveGameStateRef = useRef(gameState);
  const livePendingGameStartRef = useRef(pendingGameStart);

  const currentProfile = profile || guestProfile;
  const isGuestMode = !!guestProfile;
  const effectivePlayerName = (currentProfile?.displayName || authUser?.displayName || "").trim();
  const currentRoom = roomId ? rooms.find((room) => room?.id === roomId) || null : null;
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
      profileId: currentProfile?.profileId || null,
      playerUid: currentProfile?.uid || null,
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
    if (!pendingGameStart?.roomId) return undefined;
    if (!pendingGameStart.showCountdown) return undefined;
    if (Number(pendingGameStart.countdown || 0) <= 0) {
      countdownConsumedUntilRef.current.set(pendingGameStart.roomId, Date.now() + 20000);
      setGameState(pendingGameStart.gameState || null);
      setPendingGameStart(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setPendingGameStart((prev) => {
        if (!prev || prev.roomId !== pendingGameStart.roomId) return prev;
        return {
          ...prev,
          countdown: Math.max(0, Number(prev.countdown || 0) - 1),
        };
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [pendingGameStart]);

  useEffect(() => {
    liveRoomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    liveGameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    livePendingGameStartRef.current = pendingGameStart;
  }, [pendingGameStart]);

  useEffect(() => {
    if (!pendingGameStart?.roomId || pendingGameStart.showCountdown) return undefined;
    const timer = setTimeout(() => {
      setPendingGameStart((prev) => {
        if (!prev || prev.showCountdown) return prev;
        return { ...prev, showCountdown: true };
      });
    }, 2200);
    return () => clearTimeout(timer);
  }, [pendingGameStart]);

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

    function onConnectError() {
      setConnected(false);
    }

    function onRoomsUpdate(updatedRooms) {
      setRooms(updatedRooms);
      if (!Array.isArray(updatedRooms)) return;
      for (const room of updatedRooms) {
        const playersCount = Array.isArray(room?.players) ? room.players.length : 0;
        if (playersCount === 0) {
          clearRoomHistoryStorage(room.id);
        }
      }
    }

    function onGameStart({ roomId: nextRoomId, gameState: nextGameState }) {
      const activeRoomId = liveRoomIdRef.current;
      const activeGameState = liveGameStateRef.current;
      const alreadyPlayingThisRoom =
        activeRoomId === nextRoomId && !!activeGameState && !activeGameState.matchEnded;
      const shouldUseCountdown = shouldUseStartCountdown(nextGameState);
      const countdownAlreadyConsumed =
        Number(countdownConsumedUntilRef.current.get(nextRoomId) || 0) > Date.now();
      setRoomId(nextRoomId);
      if (!alreadyPlayingThisRoom && shouldUseCountdown && !countdownAlreadyConsumed) {
        setGameState(null);
        setPendingGameStart((prev) => {
          if (prev?.roomId === nextRoomId) {
            return {
              ...prev,
              gameState: nextGameState,
            };
          }
          return {
            roomId: nextRoomId,
            gameState: nextGameState,
            countdown: 5,
            showCountdown: false,
          };
        });
      } else {
        setPendingGameStart(null);
        setGameState(nextGameState);
      }
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
      const activeRoomId = liveRoomIdRef.current;
      const activeGameState = liveGameStateRef.current;
      const activePendingStart = livePendingGameStartRef.current;
      if (payloadRoomId && (!activeRoomId || payloadRoomId !== activeRoomId)) return;
      const targetRoomId = payloadRoomId || activeRoomId || null;
      const shouldUseCountdown = shouldUseStartCountdown(nextState);
      const hasPendingForRoom =
        !!activePendingStart?.roomId &&
        (!!payloadRoomId ? activePendingStart.roomId === payloadRoomId : activePendingStart.roomId === activeRoomId);
      const countdownAlreadyConsumed =
        !!targetRoomId &&
        Number(countdownConsumedUntilRef.current.get(targetRoomId) || 0) > Date.now();
      const alreadyPlayingThisRoom =
        !!activeGameState &&
        !activeGameState.matchEnded &&
        (!payloadRoomId || payloadRoomId === activeRoomId);

      if (((shouldUseCountdown && !countdownAlreadyConsumed) || hasPendingForRoom) && !alreadyPlayingThisRoom) {
        if (payloadRoomId && activeRoomId !== payloadRoomId) {
          setRoomId(payloadRoomId);
        }
        setPendingGameStart((prev) => {
          const effectiveRoomId = payloadRoomId || prev?.roomId || activeRoomId || null;
          if (!effectiveRoomId) return prev;
          if (!prev || prev.roomId !== effectiveRoomId) {
            return {
              roomId: effectiveRoomId,
              gameState: nextState,
              countdown: 5,
              showCountdown: false,
            };
          }
          const prevVersion = Number(prev.gameState?.stateVersion) || 0;
          const nextVersion = Number(nextState?.stateVersion) || 0;
          if (nextVersion && prevVersion && nextVersion < prevVersion) return prev;
          return { ...prev, gameState: nextState };
        });
        setGameState(null);
        return;
      }

      setPendingGameStart((prev) => {
        if (!prev || !payloadRoomId || prev.roomId !== payloadRoomId) return prev;
        const prevVersion = Number(prev.gameState?.stateVersion) || 0;
        const nextVersion = Number(nextState?.stateVersion) || 0;
        if (nextVersion && prevVersion && nextVersion < prevVersion) return prev;
        return { ...prev, gameState: nextState };
      });
      setGameState((prev) => {
        const prevVersion = Number(prev?.stateVersion) || 0;
        const nextVersion = Number(nextState?.stateVersion) || 0;
        if (nextVersion && prevVersion && nextVersion < prevVersion) return prev;
        return nextState;
      });
    }

    function onReturnRoomList() {
      suppressAutoJoinUntilRef.current = Date.now() + 4000;
      setPendingGameStart(null);
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
    socket.on("connect_error", onConnectError);
    socket.on("rooms:update", onRoomsUpdate);
    socket.on("game:start", onGameStart);
    socket.on("game:update", onGameUpdate);
    socket.on("match:return-roomlist", onReturnRoomList);

    // If the socket connected before listeners were attached, sync immediately.
    setConnected(socket.connected);
    if (socket.connected) {
      socket.emit("rooms:list");
    } else {
      socket.connect();
    }

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("rooms:update", onRoomsUpdate);
      socket.off("game:start", onGameStart);
      socket.off("game:update", onGameUpdate);
      socket.off("match:return-roomlist", onReturnRoomList);
    };
  }, [avatarUrl, currentProfile?.profileId, currentProfile?.uid, effectivePlayerName, isGuestMode, reconnectToken]);

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
    if (!roomId) return;
    socket.emit("room:away", { roomId, away: false });
  }, [roomId]);

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

    const iWon =
      gameState.mode === "2vs2"
        ? isSameTeamInState(gameState, myPlayerId, gameState.matchWinnerId)
        : myPlayerId === gameState.matchWinnerId;

    const profileRef = doc(db, "players", authUser.uid);
    const recentEntry = {
      id: fingerprint,
      roomId: roomId || "",
      mode: gameState?.mode || "1vs1",
      result: iWon ? "W" : "L",
      winnerId: gameState?.matchWinnerId || null,
      endedAt: Number(gameState?.matchEndedAt) || Date.now(),
    };

    runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(profileRef);
      const current = snapshot.exists() ? snapshot.data() || {} : {};
      const wins = Number(current.wins || 0) + (iWon ? 1 : 0);
      const losses = Number(current.losses || 0) + (iWon ? 0 : 1);
      const recent = Array.isArray(current.recentMatches) ? current.recentMatches : [];
      const withoutCurrent = recent.filter((entry) => entry?.id !== fingerprint);
      const recentMatches = [recentEntry, ...withoutCurrent].slice(0, 5);
      transaction.set(
        profileRef,
        {
          wins,
          losses,
          recentMatches,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    })
      .then(() => {
        const countedNow = readCountedMatches();
        if (!countedNow.includes(fingerprint)) {
          writeCountedMatches([...countedNow, fingerprint].slice(-20));
        }
        setProfile((prev) => {
          if (!prev) return prev;
          const currentRecent = Array.isArray(prev.recentMatches) ? prev.recentMatches : [];
          const nextRecent = [recentEntry, ...currentRecent.filter((entry) => entry?.id !== fingerprint)].slice(0, 5);
          return {
            ...prev,
            wins: Number(prev.wins || 0) + (iWon ? 1 : 0),
            losses: Number(prev.losses || 0) + (iWon ? 0 : 1),
            recentMatches: nextRecent,
          };
        });
        pendingMatchUpdateRef.current.delete(fingerprint);
      })
      .catch((error) => {
        console.error("No se pudo actualizar stats en Firebase:", error);
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
      profileId: currentProfile?.profileId || null,
      playerUid: currentProfile?.uid || null,
    });
    socket.emit("room:away", { roomId: nextRoomId, away: false });
  };

  const leaveToRoomList = ({ forceUnsubscribe = false } = {}) => {
    suppressAutoJoinUntilRef.current = Date.now() + 4000;
    autoJoinAttemptRef.current = "";
    window.history.replaceState({}, "", "/");
    const previousRoomId = roomId;
    const leavingAfterMatchEnd = !!gameState?.matchEnded;
    const waitingCountdownActive =
      pendingGameStart?.roomId === previousRoomId && Number(pendingGameStart?.countdown || 0) > 0;
    const shouldUnsubscribeSeat =
      forceUnsubscribe || !gameState || leavingAfterMatchEnd || waitingCountdownActive;
    const keepRoomForReconnect = !!gameState && !leavingAfterMatchEnd && !shouldUnsubscribeSeat;
    if (previousRoomId) {
      if (shouldUnsubscribeSeat) {
        socket.emit("room:leave");
      } else {
        socket.emit("room:away", { roomId: previousRoomId, away: true });
      }
    }
    setPendingGameStart(null);
    setGameState(null);
    if (previousRoomId) {
      countdownConsumedUntilRef.current.delete(previousRoomId);
    }
    setRoomId(null);
    writeStoredSession({
      ...readStoredSession(),
      isGuest: isGuestMode,
      playerName: effectivePlayerName,
      profileId: currentProfile?.profileId || readStoredSession().profileId || null,
      reconnectToken,
      roomId: keepRoomForReconnect ? previousRoomId || null : null,
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
      recentMatches: [],
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
      setPendingGameStart(null);
      setGameState(null);
      if (roomId) {
        countdownConsumedUntilRef.current.delete(roomId);
      }
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
      setPendingGameStart(null);
      setGameState(null);
      if (roomId) {
        countdownConsumedUntilRef.current.delete(roomId);
      }
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
      <LoginPage
        authError={authError}
        isFirebaseConfigured={isFirebaseConfigured}
        onSignInWithGoogle={signInWithGoogle}
        onStartAnonymousSession={startAnonymousSession}
      />
    );
  }

  const hasActiveCountdown =
    pendingGameStart?.roomId === roomId &&
    !!pendingGameStart?.showCountdown &&
    Number(pendingGameStart?.countdown || 0) > 0;

  if (roomId && (hasActiveCountdown || !gameState)) {
    const fallbackMaxPlayers =
      pendingGameStart?.gameState?.mode === "2vs2"
        ? 4
        : pendingGameStart?.gameState?.mode === "1vs1"
          ? 2
          : 0;
    const waitingRoom = currentRoom || {
      id: roomId,
      mode: pendingGameStart?.gameState?.mode || "-",
      maxPlayers: fallbackMaxPlayers,
      players: Array.isArray(pendingGameStart?.gameState?.players)
        ? pendingGameStart.gameState.players
        : [],
    };
    return (
      <RoomWaitingPage
        connected={connected}
        roomId={roomId}
        room={waitingRoom}
        effectivePlayerName={effectivePlayerName}
        currentProfile={currentProfile}
        reconnectToken={reconnectToken}
        socketId={socket.id}
        countdown={hasActiveCountdown ? pendingGameStart?.countdown : null}
        onLeave={() => leaveToRoomList({ forceUnsubscribe: true })}
      />
    );
  }

  if (gameState) {
    return (
      <Mesa
        key={roomId || "mesa"}
        roomId={roomId}
        gameState={gameState}
        myAvatarUrl={avatarUrl}
        myEmail={currentProfile?.email || authUser?.email || ""}
        myProfile={currentProfile}
        onLeaveToRoomList={leaveToRoomList}
      />
    );
  }

  return (
    <RoomListPage
      connected={connected}
      rooms={rooms}
      effectivePlayerName={effectivePlayerName}
      currentProfile={currentProfile}
      avatarUrl={avatarUrl}
      avatarLoadFailed={avatarLoadFailed}
      onAvatarLoadError={() => setAvatarLoadFailed(true)}
      isGuestMode={isGuestMode}
      reconnectToken={reconnectToken}
      socketId={socket.id}
      onJoinRoom={joinRoom}
      onLogout={logout}
    />
  );
}

export default App;

