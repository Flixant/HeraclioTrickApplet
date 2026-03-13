import { useEffect, useRef, useState } from "react";
import { socket } from "../socket";
import { getDeckCard, preloadDeckAssets, renderBackCard, renderCard } from "./deck";
import { resolveMyPlayerId } from "../utils/playerIdentity";
import { db, isFirebaseConfigured } from "../firebase";
import { collection, doc, getDoc, getDocs, limit, query, where } from "firebase/firestore";
import HistoryPanel from "../components/HistoryPanel";
import FloatingClockButton from "../components/FloatingClockButton";
import TableStatusPanels from "../components/TableStatusPanels";
import TestControlsPanel from "../components/TestControlsPanel";
import RightActionPanel from "../components/RightActionPanel";
import logo from "../assets/logo.png";

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];

function parseIceUrlList(rawValue) {
  if (typeof rawValue !== "string") return [];
  return rawValue
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function buildIceServers() {
  const stunUrls = parseIceUrlList(import.meta.env.VITE_WEBRTC_STUN_URLS).concat(DEFAULT_STUN_URLS);
  const uniqueStun = [...new Set(stunUrls)];
  const turnUrls = parseIceUrlList(import.meta.env.VITE_WEBRTC_TURN_URLS);
  const turnUsername = import.meta.env.VITE_WEBRTC_TURN_USERNAME || "";
  const turnCredential = import.meta.env.VITE_WEBRTC_TURN_CREDENTIAL || "";
  const servers = [{ urls: uniqueStun }];
  if (turnUrls.length && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  }
  return servers;
}

function shouldForceRelay() {
  const raw = String(import.meta.env.VITE_WEBRTC_FORCE_RELAY || "");
  if (!raw) return import.meta.env.PROD;
  return raw === "1" || raw.toLowerCase() === "true";
}

function simplifyPlayerActionMessage(rawMessage) {
  if (typeof rawMessage !== "string") return rawMessage;
  const message = rawMessage.trim();
  if (!message) return rawMessage;

  const verbPattern = "(canto|canta|respondio|responde|juega|jugo|activo|activa)";
  const withColon = message.match(new RegExp(`^([^:]+):\\s*${verbPattern}\\s*:?\\s*(.+)$`, "i"));
  if (withColon) {
    const [, rawPlayer, rest] = withColon;
    const player = rawPlayer.trim();
    if (player && rest?.trim()) return `${player}: ${rest.trim()}`;
  }

  const withoutColon = message.match(new RegExp(`^([^:]+?)\\s+${verbPattern}\\s*:?\\s*(.+)$`, "i"));
  if (withoutColon) {
    const [, rawPlayer, rest] = withoutColon;
    const player = rawPlayer.trim();
    if (player && rest?.trim()) return `${player}: ${rest.trim()}`;
  }

  const seFueWithColon = message.match(/^([^:]+):\s*se fue\s*:?\s*(.+)$/i);
  if (seFueWithColon) {
    const [, rawPlayer, rest] = seFueWithColon;
    const player = rawPlayer.trim();
    if (player && rest?.trim()) return `${player}: ${rest.trim()}`;
  }

  const seFueWithoutColon = message.match(/^([^:]+?)\s+se fue\s*:?\s*(.+)$/i);
  if (seFueWithoutColon) {
    const [, rawPlayer, rest] = seFueWithoutColon;
    const player = rawPlayer.trim();
    if (player && rest?.trim()) return `${player}: ${rest.trim()}`;
  }

  return rawMessage;
}

function computeEnvidoValueClient(card, vira) {
  if (!card) return 0;
  const base = Number(card.envValue || 0);
  if (!vira || card.suit !== vira.suit) return base;
  const viraValue = Number(vira.value);
  const cardValue = Number(card.value);
  const pericoValue = viraValue === 11 ? 12 : 11;
  const pericaValue = viraValue === 10 ? 12 : 10;
  if (cardValue === pericoValue) return 30;
  if (cardValue === pericaValue) return 29;
  return base;
}

function computeEnvidoClient(cards, vira) {
  if (!Array.isArray(cards) || cards.length === 0) return 0;
  const bySuit = {};
  const values = [];
  let bestSingle = 0;
  for (const card of cards) {
    const v = computeEnvidoValueClient(card, vira);
    values.push(v);
    bestSingle = Math.max(bestSingle, v);
    bySuit[card.suit] = bySuit[card.suit] || [];
    bySuit[card.suit].push(v);
  }
  let bestPair = 0;
  for (const suitValues of Object.values(bySuit)) {
    if (suitValues.length >= 2) {
      const topTwo = [...suitValues].sort((a, b) => b - a).slice(0, 2);
      const hasPiece = topTwo.some((x) => x >= 29);
      bestPair = Math.max(bestPair, topTwo[0] + topTwo[1] + (hasPiece ? 0 : 20));
    }
  }
  const special = values.filter((v) => v >= 29);
  const regular = values.filter((v) => v < 29);
  if (special.length && regular.length) {
    bestPair = Math.max(bestPair, Math.max(...special) + Math.max(...regular));
  }
  return Math.max(bestSingle, bestPair);
}

function Mesa({
  roomId,
  gameState,
  myAvatarUrl = "",
  myEmail = "",
  myProfile = null,
  onLeaveToRoomList,
}) {
  const [state, setState] = useState(gameState);
  const stateRef = useRef(gameState);
  const [message, setMessage] = useState("");
  const messageTimeoutRef = useRef(null);
  const [showAdvancedCantos, setShowAdvancedCantos] = useState(false);
  const [showAdvancedJugadas, setShowAdvancedJugadas] = useState(false);
  const [showCommunicationCantos, setShowCommunicationCantos] = useState(false);
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [passCardArmed, setPassCardArmed] = useState(false);
  const [pardaDraft, setPardaDraft] = useState([]);
  const [showEnvidoStoneSlider, setShowEnvidoStoneSlider] = useState(false);
  const [envidoStoneRaise, setEnvidoStoneRaise] = useState(2);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  const [remoteAvatarLoadFailed, setRemoteAvatarLoadFailed] = useState({});
  const [matchModalVisible, setMatchModalVisible] = useState(false);
  const [suppressMessagesForMatchEnd, setSuppressMessagesForMatchEnd] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [messageHistory, setMessageHistory] = useState([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [voiceSpeakingByPlayer, setVoiceSpeakingByPlayer] = useState({});
  const [selectedPlayerForModal, setSelectedPlayerForModal] = useState(null);
  const [selectedPlayerStats, setSelectedPlayerStats] = useState(null);
  const [selectedPlayerStatsLoading, setSelectedPlayerStatsLoading] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const FLOAT_CLOCK_SIZE = 52;
  const FLOAT_CLOCK_EDGE_GAP = 12;
  const [floatingClockPos, setFloatingClockPos] = useState(() => {
    if (typeof window === "undefined") return { x: FLOAT_CLOCK_EDGE_GAP, y: 180 };
    return {
      x: FLOAT_CLOCK_EDGE_GAP,
      y: Math.max(
        FLOAT_CLOCK_EDGE_GAP,
        Math.round(window.innerHeight * 0.6 - FLOAT_CLOCK_SIZE / 2)
      ),
    };
  });
  const [isFloatingClockDragging, setIsFloatingClockDragging] = useState(false);
  const floatingClockDragRef = useRef({
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    moved: false,
    suppressClick: false,
  });
  const roundCounterRef = useRef(1);
  const suppressMessagesRef = useRef(false);
  const historyHydratedRef = useRef(false);
  const historyStorageKey = roomId ? `truco_history_${roomId}` : null;
  const voiceIceServersRef = useRef(buildIceServers());
  const localVoiceStreamRef = useRef(null);
  const micEnabledRef = useRef(false);
  const voicePeerConnectionsRef = useRef(new Map());
  const voiceRemoteAudioByPeerRef = useRef(new Map());
  const voiceMeterCleanupByKeyRef = useRef(new Map());
  const voiceAudioContextRef = useRef(null);
  const responderAlertAudioCtxRef = useRef(null);
  const lastResponderAlertKeyRef = useRef("");

  const clampFloatingClockPos = (x, y) => {
    if (typeof window === "undefined") return { x, y };
    const maxX = Math.max(FLOAT_CLOCK_EDGE_GAP, window.innerWidth - FLOAT_CLOCK_SIZE - FLOAT_CLOCK_EDGE_GAP);
    const maxY = Math.max(FLOAT_CLOCK_EDGE_GAP, window.innerHeight - FLOAT_CLOCK_SIZE - FLOAT_CLOCK_EDGE_GAP);
    return {
      x: Math.min(Math.max(FLOAT_CLOCK_EDGE_GAP, x), maxX),
      y: Math.min(Math.max(FLOAT_CLOCK_EDGE_GAP, y), maxY),
    };
  };


  const pushHistoryEntry = (text, contextState) => {
    const normalized = simplifyPlayerActionMessage(text);
    const hand = Number(contextState?.handNumber || 1);
    const round = Number(roundCounterRef.current || 1);
    const timestamp = Date.now();
    setMessageHistory((prev) => {
      const next = [
        {
          id: `hist-${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
          text: normalized,
          timestamp,
          round,
          hand,
        },
        ...prev,
      ];
      return next.slice(0, 120);
    });
  };

  useEffect(() => {
    historyHydratedRef.current = false;
    if (!historyStorageKey || typeof window === "undefined") {
      historyHydratedRef.current = true;
      return;
    }
    try {
      const raw = window.sessionStorage.getItem(historyStorageKey);
      if (!raw) {
        setMessageHistory([]);
        setTimeout(() => {
          if (historyStorageKey) historyHydratedRef.current = true;
        }, 0);
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setMessageHistory([]);
        setTimeout(() => {
          if (historyStorageKey) historyHydratedRef.current = true;
        }, 0);
        return;
      }
      setMessageHistory(parsed.slice(0, 120));
      setTimeout(() => {
        if (historyStorageKey) historyHydratedRef.current = true;
      }, 0);
    } catch {
      setMessageHistory([]);
      setTimeout(() => {
        if (historyStorageKey) historyHydratedRef.current = true;
      }, 0);
    }
  }, [historyStorageKey]);

  useEffect(() => {
    if (!historyStorageKey || typeof window === "undefined") return;
    if (!historyHydratedRef.current) return;
    try {
      window.sessionStorage.setItem(
        historyStorageKey,
        JSON.stringify((messageHistory || []).slice(0, 120))
      );
    } catch {
      // ignore storage quota/security errors
    }
  }, [historyStorageKey, messageHistory]);

  const formatCardForHistory = (card) => {
    if (!card) return "carta";
    if (card.hiddenInParda || card.faceDown || card.passed) return "carta tapada";
    const value = card.value ?? "?";
    const suit = card.suit || "";
    return suit ? `${value} de ${suit}` : `${value}`;
  };

  const safeAvatarUrl =
    typeof myAvatarUrl === "string" && /^https?:\/\//i.test(myAvatarUrl.trim())
      ? myAvatarUrl.trim()
      : "";

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [safeAvatarUrl]);

  useEffect(() => {
    preloadDeckAssets();
  }, []);

  useEffect(() => {
    if (!roomId) return undefined;
    const reportAway = () => {
      const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
      socket.emit("room:away", { roomId, away: hidden });
    };
    reportAway();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", reportAway);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", reportAway);
      }
      socket.emit("room:away", { roomId, away: true });
    };
  }, [roomId]);

  useEffect(() => {
    setState(gameState);
    stateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    suppressMessagesRef.current = suppressMessagesForMatchEnd;
  }, [suppressMessagesForMatchEnd]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setFloatingClockPos(
      clampFloatingClockPos(
        FLOAT_CLOCK_EDGE_GAP,
        Math.max(
          FLOAT_CLOCK_EDGE_GAP,
          Math.round(window.innerHeight * 0.6 - FLOAT_CLOCK_SIZE / 2)
        )
      )
    );
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => {
      setFloatingClockPos((prev) => clampFloatingClockPos(prev.x, prev.y));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const until = Number(state?.truco?.raiseWindowUntil || 0);
    if (until <= Date.now()) return;
    const timeout = setTimeout(() => {
      setState((prev) => ({ ...prev }));
    }, Math.max(50, until - Date.now() + 20));
    return () => clearTimeout(timeout);
  }, [state?.truco?.raiseWindowUntil]);

  useEffect(() => {
    const until = Number(state?.uiMessageUntil || 0);
    if (until <= Date.now()) return;
    const timeout = setTimeout(() => {
      setState((prev) => ({ ...prev }));
    }, Math.max(50, until - Date.now() + 20));
    return () => clearTimeout(timeout);
  }, [state?.uiMessageUntil]);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 200);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setMessage("");
    setShowEnvidoStoneSlider(false);
    setShowHistoryPanel(false);
    setRemoteAvatarLoadFailed({});
    setMatchModalVisible(false);
    setSuppressMessagesForMatchEnd(false);
    roundCounterRef.current = 1;
    if (messageTimeoutRef.current) {
      clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = null;
    }
  }, [roomId]);

  useEffect(() => {
    function onGameUpdate(payload) {
      const payloadRoomId = payload?.roomId;
      const nextState = payload?.gameState || payload;
      if (!nextState) return;
      if (payloadRoomId && payloadRoomId !== roomId) return;
      const nextVersion = Number(nextState.stateVersion) || 0;
      const currentVersion = Number(stateRef.current?.stateVersion) || 0;
      if (nextVersion < currentVersion) return;
      const prevState = stateRef.current;
      const prevHand = Number(prevState?.handNumber || 1);
      const nextHand = Number(nextState?.handNumber || 1);
      const prevTableCount = Array.isArray(prevState?.tableCards) ? prevState.tableCards.length : 0;
      const nextTableCount = Array.isArray(nextState?.tableCards) ? nextState.tableCards.length : 0;
      const startedNewRound =
        nextHand === 1 &&
        (prevHand !== 1 ||
          (prevTableCount > 0 && nextTableCount === 0 && !!prevState?.roundEnding && !nextState?.roundEnding));
      if (startedNewRound) {
        roundCounterRef.current += 1;
      }
      if (nextTableCount > prevTableCount) {
        const newCards = (nextState.tableCards || []).slice(prevTableCount);
        newCards.forEach((card) => {
          const playerName =
            (nextState.players || []).find((p) => p.id === card.playerId)?.name || "Jugador";
          pushHistoryEntry(`${playerName}: ${formatCardForHistory(card)}`, nextState);
        });
      }
      stateRef.current = nextState;
      setState({ ...nextState });
    }

    function onServerMessage(msg) {
      if (suppressMessagesRef.current) return;
      const normalizedMsg = simplifyPlayerActionMessage(msg);
      if (messageTimeoutRef.current) {
        clearTimeout(messageTimeoutRef.current);
      }
      setMessage(normalizedMsg);
      messageTimeoutRef.current = setTimeout(() => {
        setMessage("");
        messageTimeoutRef.current = null;
      }, 1700);
    }

    function onServerEvent(payload) {
      if (suppressMessagesRef.current) return;
      const raw = typeof payload === "string" ? payload : payload?.message;
      if (!raw) return;
      pushHistoryEntry(raw, stateRef.current);
    }

    socket.on("game:update", onGameUpdate);
    socket.on("server:error", onServerMessage);
    socket.on("server:event", onServerEvent);

    return () => {
      if (messageTimeoutRef.current) {
        clearTimeout(messageTimeoutRef.current);
      }
      socket.off("game:update", onGameUpdate);
      socket.off("server:error", onServerMessage);
      socket.off("server:event", onServerEvent);
    };
  }, [roomId]);

  if (!state) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-emerald-950 text-white">
        Cargando mesa...
      </div>
    );
  }

  const reconnectToken = (() => {
    try {
      const raw = localStorage.getItem("truco_session_v1");
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed?.reconnectToken || null;
    } catch {
      return null;
    }
  })();
  const players = Array.isArray(state.players) ? state.players : [];
  const myPlayerId = resolveMyPlayerId(players, {
    socketId: socket.id,
    reconnectToken,
    fallbackId: socket.id,
  });

  const myCards = state.hands[myPlayerId] || [];

  const ensureVoiceAudioContext = async () => {
    if (typeof window === "undefined") return null;
    if (!voiceAudioContextRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      voiceAudioContextRef.current = new Ctx();
    }
    if (voiceAudioContextRef.current.state === "suspended") {
      try {
        await voiceAudioContextRef.current.resume();
      } catch {
        // ignore
      }
    }
    return voiceAudioContextRef.current;
  };

  const clearVoiceMeter = (key) => {
    const cleanup = voiceMeterCleanupByKeyRef.current.get(key);
    if (cleanup) {
      cleanup();
      voiceMeterCleanupByKeyRef.current.delete(key);
    }
    setVoiceSpeakingByPlayer((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const startVoiceMeter = async (key, stream) => {
    clearVoiceMeter(key);
    const ctx = await ensureVoiceAudioContext();
    if (!ctx) return;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let rafId = null;
      let active = false;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          sum += Math.abs(data[i] - 128);
        }
        const avg = sum / data.length;
        const nextActive = avg > 7.5;
        if (nextActive !== active) {
          active = nextActive;
          setVoiceSpeakingByPlayer((prev) => {
            if (prev[key] === nextActive) return prev;
            return { ...prev, [key]: nextActive };
          });
        }
        rafId = requestAnimationFrame(tick);
      };
      tick();
      voiceMeterCleanupByKeyRef.current.set(key, () => {
        if (rafId) cancelAnimationFrame(rafId);
        try {
          source.disconnect();
          analyser.disconnect();
        } catch {
          // ignore
        }
      });
    } catch {}
  };

  const cleanupVoicePeer = (peerId) => {
    const pc = voicePeerConnectionsRef.current.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {
        // ignore
      }
      voicePeerConnectionsRef.current.delete(peerId);
    }
    const audioEl = voiceRemoteAudioByPeerRef.current.get(peerId);
    if (audioEl) {
      try {
        audioEl.srcObject = null;
      } catch {
        // ignore
      }
      voiceRemoteAudioByPeerRef.current.delete(peerId);
    }
    clearVoiceMeter(peerId);
  };

  const closeAllVoicePeers = () => {
    for (const peerId of voicePeerConnectionsRef.current.keys()) {
      cleanupVoicePeer(peerId);
    }
  };

  const ensureVoicePeer = (peerId) => {
    const existing = voicePeerConnectionsRef.current.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({
      iceServers: voiceIceServersRef.current,
      iceTransportPolicy: shouldForceRelay() ? "relay" : "all",
    });
    voicePeerConnectionsRef.current.set(peerId, pc);

    const localStream = localVoiceStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      socket.emit("voice:signal", {
        roomId,
        toId: peerId,
        candidate: event.candidate,
      });
    };

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams || [];
      if (!remoteStream) return;
      let audioEl = voiceRemoteAudioByPeerRef.current.get(peerId);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        voiceRemoteAudioByPeerRef.current.set(peerId, audioEl);
      }
      audioEl.srcObject = remoteStream;
      audioEl.play().catch(() => {});
      startVoiceMeter(peerId, remoteStream);
    };

    pc.onconnectionstatechange = () => {
      const stateValue = pc.connectionState;
      if (stateValue === "failed" || stateValue === "closed" || stateValue === "disconnected") {
        cleanupVoicePeer(peerId);
      }
    };

    return pc;
  };

  const ensureResponderAlertAudioContext = async () => {
    if (typeof window === "undefined") return null;
    if (voiceAudioContextRef.current) {
      const sharedCtx = voiceAudioContextRef.current;
      if (sharedCtx?.state === "suspended") {
        try {
          await sharedCtx.resume();
        } catch {
          // ignore autoplay-policy resume errors
        }
      }
      return sharedCtx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!responderAlertAudioCtxRef.current) {
      responderAlertAudioCtxRef.current = new Ctx();
    }
    const ctx = responderAlertAudioCtxRef.current;
    if (ctx?.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // ignore autoplay-policy resume errors
      }
    }
    return ctx;
  };

  const playResponderTurnDing = async () => {
    const ctx = await ensureResponderAlertAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.001, now);
      master.connect(ctx.destination);

      const scheduleTone = (startAt, frequency, duration, type = "triangle", peak = 0.35) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.001, startAt);
        gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
        osc.connect(gain);
        gain.connect(master);
        osc.start(startAt);
        osc.stop(startAt + duration + 0.02);
      };

      scheduleTone(now, 1175, 0.11, "sine", 0.22);
      scheduleTone(now + 0.13, 1568, 0.2, "triangle", 0.32);
      master.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
    } catch {
      // ignore audio synthesis errors
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const unlockAudio = () => {
      void ensureResponderAlertAudioContext();
    };
    window.addEventListener("pointerdown", unlockAudio, { passive: true });
    window.addEventListener("touchstart", unlockAudio, { passive: true });
    window.addEventListener("keydown", unlockAudio);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  const createVoiceOffer = async (peerId) => {
    try {
      const pc = ensureVoicePeer(peerId);
      if (pc.signalingState !== "stable") return;
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      socket.emit("voice:signal", {
        roomId,
        toId: peerId,
        description: pc.localDescription,
      });
    } catch {}
  };

  const handleVoiceSignal = async ({ fromId, description, candidate }) => {
    if (!fromId) return;
    try {
      const pc = ensureVoicePeer(fromId);
      if (description) {
        await pc.setRemoteDescription(new RTCSessionDescription(description));
        if (description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("voice:signal", {
            roomId,
            toId: fromId,
            description: pc.localDescription,
          });
        }
      } else if (candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch {}
  };

  const syncLocalTracksToPeers = () => {
    const localStream = localVoiceStreamRef.current;
    if (!localStream) return;
    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) return;
    voicePeerConnectionsRef.current.forEach((pc, peerId) => {
      const senders = pc.getSenders();
      const audioSender = senders.find((sender) => sender.track && sender.track.kind === "audio");
      if (!audioSender) {
        audioTracks.forEach((track) => {
          pc.addTrack(track, localStream);
        });
        createVoiceOffer(peerId);
      } else {
        const preferredTrack = audioTracks[0];
        if (preferredTrack && audioSender.track?.id !== preferredTrack.id) {
          audioSender.replaceTrack(preferredTrack).catch(() => {});
          createVoiceOffer(peerId);
        }
      }
    });
  };

  const stopVoiceSession = (reason = "manual", keepToggle = false) => {
    if (roomId) {
      socket.emit("voice:leave", { roomId });
    }
    closeAllVoicePeers();
    const localStream = localVoiceStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localVoiceStreamRef.current = null;
    }
    clearVoiceMeter(myPlayerId || socket.id);
    if (!keepToggle) setMicEnabled(false);
    micEnabledRef.current = false;
  };

  const toggleVoiceMic = async () => {
    if (micEnabled) {
      const localStream = localVoiceStreamRef.current;
      if (localStream) {
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }
      clearVoiceMeter(myPlayerId || socket.id);
      setMicEnabled(false);
      micEnabledRef.current = false;
      return;
    }
    if (!roomId) return;
    const isLocalhost =
      typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
    const isSecureAllowed = (typeof window !== "undefined" && window.isSecureContext) || isLocalhost;
    if (!isSecureAllowed) {
      setMessage("Microfono bloqueado: usa HTTPS o localhost");
      if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = setTimeout(() => {
        setMessage("");
        messageTimeoutRef.current = null;
      }, 2500);
      return;
    }
    try {
      let localStream = localVoiceStreamRef.current;
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        localVoiceStreamRef.current = localStream;
      } else {
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
      }
      localVoiceStreamRef.current = localStream;
      micEnabledRef.current = true;
      await startVoiceMeter(myPlayerId || socket.id, localStream);
      setMicEnabled(true);
      socket.emit("voice:join", { roomId });
      syncLocalTracksToPeers();
    } catch (error) {
      setMicEnabled(false);
      micEnabledRef.current = false;
      const reason = String(error?.name || error?.message || "permiso denegado");
      setMessage(`No se pudo abrir el microfono (${reason})`);
      if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = setTimeout(() => {
        setMessage("");
        messageTimeoutRef.current = null;
      }, 2500);
    }
  };

  useEffect(() => {
    micEnabledRef.current = micEnabled;
  }, [micEnabled]);

  useEffect(() => {
    if (!roomId) return undefined;

    const shouldInitiateWith = (peerId) => String(socket.id || "") < String(peerId || "");

    const onVoicePeers = ({ roomId: incomingRoomId, peerIds = [] }) => {
      if (incomingRoomId && incomingRoomId !== roomId) return;
      peerIds.forEach((peerId) => {
        ensureVoicePeer(peerId);
        if (shouldInitiateWith(peerId)) {
          createVoiceOffer(peerId);
        }
      });
    };

    const onVoicePeerJoined = ({ roomId: incomingRoomId, peerId }) => {
      if (!peerId) return;
      if (incomingRoomId && incomingRoomId !== roomId) return;
      ensureVoicePeer(peerId);
      if (shouldInitiateWith(peerId)) {
        createVoiceOffer(peerId);
      }
    };

    const onVoicePeerLeft = ({ roomId: incomingRoomId, peerId }) => {
      if (!peerId) return;
      if (incomingRoomId && incomingRoomId !== roomId) return;
      cleanupVoicePeer(peerId);
    };

    const onVoiceSignal = ({ roomId: incomingRoomId, fromId, description, candidate }) => {
      if (incomingRoomId && incomingRoomId !== roomId) return;
      handleVoiceSignal({ fromId, description, candidate });
    };

    const onVoiceSocketReconnect = () => {
      socket.emit("voice:join", { roomId });
    };

    socket.on("voice:peers", onVoicePeers);
    socket.on("voice:peer-joined", onVoicePeerJoined);
    socket.on("voice:peer-left", onVoicePeerLeft);
    socket.on("voice:signal", onVoiceSignal);
    socket.on("connect", onVoiceSocketReconnect);
    socket.emit("voice:join", { roomId });

    return () => {
      socket.off("voice:peers", onVoicePeers);
      socket.off("voice:peer-joined", onVoicePeerJoined);
      socket.off("voice:peer-left", onVoicePeerLeft);
      socket.off("voice:signal", onVoiceSignal);
      socket.off("connect", onVoiceSocketReconnect);
    };
  }, [roomId, myPlayerId]);

  useEffect(() => {
    return () => {
      stopVoiceSession("unmount", true);
    };
  }, []);
  useEffect(() => {
    return () => {
      const ctx = responderAlertAudioCtxRef.current;
      responderAlertAudioCtxRef.current = null;
      if (ctx && typeof ctx.close === "function") {
        ctx.close().catch(() => {});
      }
    };
  }, []);
  const allowedTestEmails = new Set([
    "frantoima@gmail.com",
    "fantomcdolibre1@gmail.com",
    "fantochtron@gmail.com",
    "antoimahome@gmail.com",
  ]);
  const isTestUser = allowedTestEmails.has(String(myEmail || "").trim().toLowerCase());
  const isTwoVsTwo = state.mode === "2vs2" && state.players.length === 4;
  const mySeatIndex = state.players.findIndex((p) => p.id === myPlayerId);
  const safeMySeat = mySeatIndex >= 0 ? mySeatIndex : 0;
  const seatPlayerByOffset = (offset) => {
    if (!state.players.length) return null;
    const idx = (safeMySeat + offset + state.players.length) % state.players.length;
    return state.players[idx] || null;
  };
  const opponent = seatPlayerByOffset(isTwoVsTwo ? 2 : 1);
  const leftPlayer = isTwoVsTwo ? seatPlayerByOffset(1) : null;
  const rightPlayer = isTwoVsTwo ? seatPlayerByOffset(3) : null;
  const opponentCards = state.hands[opponent?.id] || [];
  const leftCards = state.hands[leftPlayer?.id] || [];
  const rightCards = state.hands[rightPlayer?.id] || [];
  const currentPlayer = state.players.find((p) => p.id === state.turn);
  const isMyTurn = state.turn === myPlayerId;
  const roundStarterId = state.roundStarter || state.currentHandStarter || state.turn || null;
  const starterIndex = state.players.findIndex((p) => p.id === roundStarterId);
  const starterOffset =
    starterIndex >= 0
      ? (starterIndex - safeMySeat + state.players.length) % state.players.length
      : 0;

  const allTableCards = Array.isArray(state.tableCards) ? state.tableCards : [];
  const florRevealCards = allTableCards.filter((card) => !!card?.isFlorReveal);
  const isFlorRevealMode = !!state.roundEnding && florRevealCards.length > 0;
  const normalTableCards = isFlorRevealMode
    ? allTableCards.filter((card) => !card?.isFlorReveal)
    : allTableCards;
  const myPlayedCards = normalTableCards.filter((card) => card.playerId === myPlayerId);
  const opponentPlayedCards = opponent
    ? normalTableCards.filter((card) => card.playerId === opponent.id)
    : [];
  const leftPlayedCards = leftPlayer
    ? normalTableCards.filter((card) => card.playerId === leftPlayer.id)
    : [];
  const rightPlayedCards = rightPlayer
    ? normalTableCards.filter((card) => card.playerId === rightPlayer.id)
    : [];
  const myFlorRevealCards = florRevealCards.filter((card) => card.playerId === myPlayerId);
  const opponentFlorRevealCards = opponent
    ? florRevealCards.filter((card) => card.playerId === opponent.id)
    : [];
  const leftFlorRevealCards = leftPlayer
    ? florRevealCards.filter((card) => card.playerId === leftPlayer.id)
    : [];
  const rightFlorRevealCards = rightPlayer
    ? florRevealCards.filter((card) => card.playerId === rightPlayer.id)
    : [];

  const roundPointValue = state.roundPointValue ?? 1;
  const serverTeam1Ids = Array.isArray(state.teams?.team1) ? state.teams.team1 : [];
  const serverTeam2Ids = Array.isArray(state.teams?.team2) ? state.teams.team2 : [];
  const nsTeamIds = serverTeam1Ids.length
    ? serverTeam1Ids
    : [state.players[0]?.id, state.players[2]?.id].filter(Boolean);
  const eoTeamIds = serverTeam2Ids.length
    ? serverTeam2Ids
    : [state.players[1]?.id, state.players[3]?.id].filter(Boolean);
  const nameById = new Map((state.players || []).map((p) => [p.id, p.name]));
  const nsTeamNames = nsTeamIds.map((id) => nameById.get(id)).filter(Boolean).join(" / ");
  const eoTeamNames = eoTeamIds.map((id) => nameById.get(id)).filter(Boolean).join(" / ");
  const hasTeamScore =
    state.mode === "2vs2" &&
    typeof state.score?.team1 === "number" &&
    typeof state.score?.team2 === "number";
  const nsTeamPoints = hasTeamScore
    ? state.score.team1
    : nsTeamIds.reduce((acc, id) => acc + (state.pointsByPlayer?.[id] ?? 0), 0);
  const eoTeamPoints = hasTeamScore
    ? state.score.team2
    : eoTeamIds.reduce((acc, id) => acc + (state.pointsByPlayer?.[id] ?? 0), 0);
  const awayByPlayer = state.awayByPlayer || {};
  const nsTeamAway = nsTeamIds.some((id) => !!awayByPlayer[id]);
  const eoTeamAway = eoTeamIds.some((id) => !!awayByPlayer[id]);
  const isSameTeamByState = (playerA, playerB) => {
    if (!playerA || !playerB) return false;
    const team1 = Array.isArray(state.teams?.team1) ? state.teams.team1 : [];
    const team2 = Array.isArray(state.teams?.team2) ? state.teams.team2 : [];
    if (team1.length || team2.length) {
      return (
        (team1.includes(playerA) && team1.includes(playerB)) ||
        (team2.includes(playerA) && team2.includes(playerB))
      );
    }
    const aIdx = state.players.findIndex((p) => p.id === playerA);
    const bIdx = state.players.findIndex((p) => p.id === playerB);
    if (aIdx < 0 || bIdx < 0) return false;
    return aIdx % 2 === bIdx % 2;
  };
  const getPlayerTeamKeyFromTeams = (teams, playerId, playersList) => {
    const team1 = Array.isArray(teams?.team1) ? teams.team1 : [];
    const team2 = Array.isArray(teams?.team2) ? teams.team2 : [];
    if (team1.includes(playerId)) return "team1";
    if (team2.includes(playerId)) return "team2";
    const idx = (playersList || []).findIndex((p) => p.id === playerId);
    if (idx < 0) return null;
    return idx % 2 === 0 ? "team1" : "team2";
  };

  useEffect(() => {
    if (!selectedPlayerForModal) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setSelectedPlayerForModal(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPlayerForModal]);

  useEffect(() => {
    let cancelled = false;
    const loadPlayerStats = async () => {
      if (!selectedPlayerForModal) {
        setSelectedPlayerStats(null);
        setSelectedPlayerStatsLoading(false);
        return;
      }

      const isMe =
        (!!selectedPlayerForModal?.id && !!myPlayerId && selectedPlayerForModal.id === myPlayerId) ||
        (!!reconnectToken &&
          !!selectedPlayerForModal?.reconnectToken &&
          selectedPlayerForModal.reconnectToken === reconnectToken) ||
        (!!myProfile?.uid &&
          !!(selectedPlayerForModal?.playerUid || selectedPlayerForModal?.uid) &&
          (selectedPlayerForModal.playerUid || selectedPlayerForModal.uid) === myProfile.uid) ||
        (!!myProfile?.profileId &&
          !!selectedPlayerForModal?.profileId &&
          selectedPlayerForModal.profileId === myProfile.profileId);

      if (isMe && myProfile) {
        setSelectedPlayerStats({
          wins: Number(myProfile.wins || 0),
          losses: Number(myProfile.losses || 0),
          recentMatches: Array.isArray(myProfile.recentMatches)
            ? myProfile.recentMatches.slice(0, 5)
            : [],
          profileId: myProfile.profileId || null,
        });
        setSelectedPlayerStatsLoading(false);
        return;
      }

      const firebaseUid =
        (isMe ? myProfile?.uid : selectedPlayerForModal.playerUid || selectedPlayerForModal.uid) || null;
      const profileId =
        selectedPlayerForModal.profileId || (isMe ? myProfile?.profileId : null) || null;

      if (!isFirebaseConfigured || !db || !firebaseUid) {
        if (!profileId) {
          setSelectedPlayerStats(null);
          setSelectedPlayerStatsLoading(false);
          return;
        }
      }

      setSelectedPlayerStatsLoading(true);
      try {
        let data = null;

        if (firebaseUid) {
          const snapshot = await getDoc(doc(db, "players", firebaseUid));
          if (cancelled) return;
          if (snapshot.exists()) {
            data = snapshot.data() || {};
          }
        }

        // Fallback for older room sessions where playerUid is missing.
        if (!data && profileId) {
          const q = query(
            collection(db, "players"),
            where("profileId", "==", profileId),
            limit(1)
          );
          const snap = await getDocs(q);
          if (cancelled) return;
          if (!snap.empty) {
            data = snap.docs[0].data() || {};
          }
        }

        if (!data) {
          setSelectedPlayerStats(null);
          return;
        }

        setSelectedPlayerStats({
          wins: Number(data.wins || 0),
          losses: Number(data.losses || 0),
          recentMatches: Array.isArray(data.recentMatches) ? data.recentMatches.slice(0, 5) : [],
          profileId: data.profileId || null,
        });
      } catch {
        if (!cancelled) {
          setSelectedPlayerStats(null);
        }
      } finally {
        if (!cancelled) {
          setSelectedPlayerStatsLoading(false);
        }
      }
    };

    loadPlayerStats();
    return () => {
      cancelled = true;
    };
  }, [
    myPlayerId,
    myProfile?.uid,
    myProfile?.profileId,
    myProfile?.wins,
    myProfile?.losses,
    myProfile?.recentMatches,
    reconnectToken,
    selectedPlayerForModal,
  ]);

  const trucoState = state.truco || { status: "idle", callerId: null, responderId: null };
  const isTrucoPending = trucoState.status === "pending";
  const isTrucoResponder =
    isTrucoPending &&
    (trucoState.responderId === myPlayerId ||
      isSameTeamByState(trucoState.responderId, myPlayerId));
  const isTrucoCallerWaiting =
    isTrucoPending &&
    (trucoState.callerId === myPlayerId ||
      isSameTeamByState(trucoState.callerId, myPlayerId));
  const envidoState = state.envido || { status: "idle" };
  const isEnvidoPending = envidoState.status === "pending";
  const isFaltaEnvidoPending = isEnvidoPending && envidoState.callType === "falta";
  const isEnvidoResponder =
    isEnvidoPending &&
    (envidoState.responderId === myPlayerId ||
      isSameTeamByState(envidoState.responderId, myPlayerId));
  const isEnvidoCallerWaiting =
    isEnvidoPending &&
    (envidoState.callerId === myPlayerId ||
      isSameTeamByState(envidoState.callerId, myPlayerId));
  const florState = state.flor || { status: "idle", hasFlorByPlayer: {}, reservadaByPlayer: {}, sungByPlayer: {}, burnedByPlayer: {}, leyByPlayer: {} };
  const isFlorPending = (florState.florEnvidoStatus || "idle") === "pending";
  const isFlorResponder =
    isFlorPending &&
    (florState.florEnvidoResponderId === myPlayerId ||
      isSameTeamByState(florState.florEnvidoResponderId, myPlayerId));
  const isFlorCallerWaiting =
    isFlorPending &&
    (florState.florEnvidoCallerId === myPlayerId ||
      isSameTeamByState(florState.florEnvidoCallerId, myPlayerId));
  const myHasAvailableFlor =
    !!florState.hasFlorByPlayer?.[myPlayerId] &&
    (!florState.sungByPlayer?.[myPlayerId] || !!florState.requireThirdByPlayer?.[myPlayerId]) &&
    !florState.burnedByPlayer?.[myPlayerId];
  const myHasFlorReservada = !!florState.reservadaByPlayer?.[myPlayerId];
  const myPlayedLey = !!florState.leyByPlayer?.[myPlayerId];
  const myMustConfirmFlorThird = !!florState.requireThirdByPlayer?.[myPlayerId];
  const myAlreadySangFlor = !!florState.sungByPlayer?.[myPlayerId];
  const florAlreadySung = Object.values(florState.sungByPlayer || {}).some(Boolean);
  const nsTeamSangFlor = nsTeamIds.some((id) => !!florState.sungByPlayer?.[id]);
  const eoTeamSangFlor = eoTeamIds.some((id) => !!florState.sungByPlayer?.[id]);
  const bothTeamsSangFlor = nsTeamSangFlor && eoTeamSangFlor;
  const isFlorCallPending = (florState.status || "idle") === "pending";
  const pendingCallType = isFlorPending ? "florEnvido" : isTrucoPending ? "truco" : isEnvidoPending ? "envido" : null;
  const isPendingResponder = isTrucoResponder || isEnvidoResponder || isFlorResponder;
  const isPendingCallerWaiting = isTrucoCallerWaiting || isEnvidoCallerWaiting || isFlorCallerWaiting;
  const hasPendingCall = isTrucoPending || isEnvidoPending || isFlorPending;
  const trucoLabelByCallType = {
    truco: "Truco",
    retruco: "Retruco",
    vale9: "Vale 9",
    valejuego: "Vale Juego",
  };
  const activeTrucoLabel =
    trucoState.status === "pending"
      ? `${trucoLabelByCallType[trucoState.callType] || "Truco"} pendiente`
      : roundPointValue > 1
        ? `Activo (${roundPointValue})`
        : "Sin canto";
  const activeTrucoTitle =
    trucoState.status === "pending" || trucoState.status === "accepted"
      ? trucoLabelByCallType[trucoState.callType] || "Truco"
      : roundPointValue >= 12
        ? "Vale Juego"
        : roundPointValue >= 9
          ? "Vale 9"
          : roundPointValue >= 6
            ? "Retruco"
            : "Truco";
  const activeEnviteLabel = isFlorPending
    ? "Flor Envido pendiente"
    : florState.florEnvidoStatus === "rejected"
      ? "Flor Envido rechazado"
      : florState.florEnvidoStatus === "accepted"
        ? "Flor Envido aceptado"
    : florState.florEnvidoCalled
      ? "Flor Envido cantado"
      : florAlreadySung
        ? "Flor cantada"
        : envidoState.status === "pending"
          ? `${isFaltaEnvidoPending ? "Falta Envido" : "Envido"} pendiente`
          : envidoState.status === "accepted"
            ? "Envido aceptado"
            : envidoState.status === "rejected"
              ? "Envido rechazado"
              : "Sin canto";
  const isTrucoActive = trucoState.status === "pending" || roundPointValue > 1;
  const isEnviteActive =
    isFlorPending ||
    !!florState.florEnvidoCalled ||
    florAlreadySung ||
    envidoState.status === "pending" ||
    envidoState.status === "accepted" ||
    envidoState.status === "rejected";
  const baseEnviteTitle = isFlorPending || !!florState.florEnvidoCalled || florAlreadySung ? "Flor" : "Envido";
  const isPardaSelecting = state.firstHandTie && state.pardaPhase === "selecting";
  const isPardaRevealing = state.firstHandTie && state.pardaPhase === "reveal";
  const hasSubmittedParda = isPardaSelecting && !!state.pardaSelections?.[myPlayerId];
  const playerIds = state.players.map((p) => p.id);
  const isInFirstHand =
    Object.values(state.handWinsByPlayer || {}).every((wins) => wins === 0) &&
    (state.tableCards?.length || 0) < playerIds.length;
  const canto11 = state.canto11 || { status: "idle" };
  const canto11Resolution = String(canto11.resolution || "");
  const isCanto11DuelDeclaring = canto11.status === "duel_declaring";
  const isCanto11DuelResolving = canto11.status === "duel_resolving";
  const isCanto11Declaring = canto11.status === "declaring" || isCanto11DuelDeclaring;
  const isCanto11Responding = canto11.status === "responding";
  const isCanto11Active = isCanto11Declaring || isCanto11Responding || isCanto11DuelResolving;
  const isCanto11PrivoResolved =
    canto11.status === "resolved" &&
    canto11Resolution === "privo_truco" &&
    (trucoState.status === "pending" || trucoState.status === "accepted");
  const isCanto11NoPrivoResolved =
    canto11.status === "resolved" && canto11Resolution === "no_privo";
  const myTeamKey = getPlayerTeamKeyFromTeams(state.teams, myPlayerId, state.players);
  const isCanto11SingerTeam = !!myTeamKey && myTeamKey === canto11.singingTeamKey;
  const isCanto11ResponderTeam = !!myTeamKey && myTeamKey === canto11.responderTeamKey;
  const canto11ResponderTurnId = canto11.responderTurnId || state.turn;
  const canDeclareCanto11Envite = isCanto11DuelDeclaring
    ? state.turn === myPlayerId
    : isCanto11Declaring && isCanto11SingerTeam && state.turn === myPlayerId;
  const canRespondCanto11 = isCanto11Responding && isCanto11ResponderTeam && (
    canto11ResponderTurnId === myPlayerId || isSameTeamByState(canto11ResponderTurnId, myPlayerId)
  );
  const canCanto11Privo = canRespondCanto11 && !!canto11.responderEligible;
  const canCanto11NoPrivo = canRespondCanto11;
  const myCurrentEnvite = computeEnvidoClient(myCards, state.vira);
  const isCantandoDisplayState =
    isCanto11Active || isCanto11PrivoResolved || isCanto11NoPrivoResolved;
  const enviteTitle = isCantandoDisplayState ? "Cantando" : baseEnviteTitle;
  const activeEnviteLabelDisplay = isCanto11Active
    ? "Estoy cantando"
    : isCanto11PrivoResolved
      ? "Privo y Truco"
      : isCanto11NoPrivoResolved
        ? "No Privo"
        : activeEnviteLabel;
  const isEnviteActiveDisplay = isCantandoDisplayState || isEnviteActive;
  const isTrucoRejectedDisplay =
    String(trucoState.lastResolution || "") === "rejected" ||
    /no quiero|rechazado/i.test(String(activeTrucoLabel || ""));
  const isEnviteRejectedDisplay =
    isCanto11NoPrivoResolved ||
    /no quiero|rechazado|no privo/i.test(String(activeEnviteLabelDisplay || ""));
  const isTrucoAwaitingResponse = isTrucoPending;
  const isEnviteAwaitingResponse =
    isCanto11Active || isEnvidoPending || isFlorPending || isFlorCallPending;
  const canCallEnvido =
    isMyTurn &&
    envidoState.status === "idle" &&
    isInFirstHand &&
    roundPointValue === 1 &&
    trucoState.status !== "accepted" &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending &&
    !isCanto11Active &&
    !florAlreadySung &&
    !myHasAvailableFlor;
  const canCallFlor =
    (isMyTurn || myMustConfirmFlorThird) &&
    (isInFirstHand || myPlayedLey || myMustConfirmFlorThird) &&
    !myAlreadySangFlor &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending &&
    !isCanto11Active &&
    myHasAvailableFlor;

  const nextCallByValue = {
    1: { label: "Truco", event: "call:truco", requiresAcceptedBy: false },
    3: { label: "Retruco", event: "call:retruco", requiresAcceptedBy: true },
    6: { label: "Vale 9", event: "call:vale9", requiresAcceptedBy: true },
    9: { label: "Vale Juego", event: "call:valejuego", requiresAcceptedBy: true },
  };
  const teamSignals = [
    { key: "ven_a_mi", label: "Ven a mi" },
    { key: "voy_para_alla", label: "Voy para alla" },
    { key: "mata", label: "Mata" },
    { key: "puyalo", label: "Puyalo" },
    { key: "pegaselo", label: "Pegaselo" },
    { key: "no_venga", label: "No venga" },
    { key: "llevo", label: "Llevo" },
    { key: "tiene_algo", label: "Tiene algo" },
  ];

  const nextCall = nextCallByValue[roundPointValue] || null;
  const acceptedByMyTeam =
    !!trucoState.acceptedById &&
    (trucoState.acceptedById === myPlayerId ||
      isSameTeamByState(trucoState.acceptedById, myPlayerId));
  const trucoRaiseWindowOpen = Number(trucoState.raiseWindowUntil || 0) > Date.now();
  const canRaiseWithinWindow = trucoRaiseWindowOpen && acceptedByMyTeam;
  const canCallNextRaise =
    !!nextCall &&
    (isMyTurn || canRaiseWithinWindow) &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending &&
    !isCanto11Active &&
    (!nextCall.requiresAcceptedBy || acceptedByMyTeam);

  useEffect(() => {
    if (!roomId || !myPlayerId) return;
    if (!isPendingResponder) {
      lastResponderAlertKeyRef.current = "";
      return;
    }
    const alertKey = `${roomId}:${pendingCallType || "pending"}:${state.turn || ""}:${
      Number(state.stateVersion || 0)
    }`;
    if (lastResponderAlertKeyRef.current === alertKey) return;
    lastResponderAlertKeyRef.current = alertKey;

    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate([110, 70, 140]);
      } catch {
        // ignore unsupported/blocked vibration calls
      }
    }
    void playResponderTurnDing();
  }, [
    isPendingResponder,
    myPlayerId,
    pendingCallType,
    roomId,
    state.stateVersion,
    state.turn,
  ]);
  const me = state.players.find((p) => p.id === myPlayerId);
  const getPlayerAvatarUrl = (player) => {
    const raw = player?.avatarUrl;
    return typeof raw === "string" && /^https?:\/\//i.test(raw.trim()) ? raw.trim() : "";
  };
  const openPlayerProfileModal = (player) => {
    if (!player?.id) return;
    setSelectedPlayerForModal(player);
  };
  const selectedStatsData = selectedPlayerStats || { wins: 0, losses: 0, recentMatches: [] };
  const selectedPlayerIsMe =
    !!selectedPlayerForModal &&
    (
      (!!selectedPlayerForModal?.id && !!myPlayerId && selectedPlayerForModal.id === myPlayerId) ||
      (!!reconnectToken &&
        !!selectedPlayerForModal?.reconnectToken &&
        selectedPlayerForModal.reconnectToken === reconnectToken) ||
      (!!myProfile?.uid &&
        !!(selectedPlayerForModal?.playerUid || selectedPlayerForModal?.uid) &&
        (selectedPlayerForModal.playerUid || selectedPlayerForModal.uid) === myProfile.uid) ||
      (!!myProfile?.profileId &&
        !!selectedPlayerForModal?.profileId &&
        selectedPlayerForModal.profileId === myProfile.profileId)
    );
  const selectedWins = selectedPlayerIsMe
    ? Number(myProfile?.wins ?? selectedStatsData.wins ?? 0)
    : Number(selectedStatsData.wins || 0);
  const selectedLosses = selectedPlayerIsMe
    ? Number(myProfile?.losses ?? selectedStatsData.losses ?? 0)
    : Number(selectedStatsData.losses || 0);
  const selectedTotalMatches = selectedWins + selectedLosses;
  const selectedWinPct = selectedTotalMatches > 0 ? Math.round((selectedWins / selectedTotalMatches) * 100) : 0;
  const selectedLossPct = selectedTotalMatches > 0 ? 100 - selectedWinPct : 0;
  const selectedRecentMatches = Array.isArray(
    selectedStatsData.recentMatches || (selectedPlayerIsMe ? myProfile?.recentMatches : null)
  )
    ? (selectedStatsData.recentMatches || myProfile?.recentMatches || []).slice(0, 5)
    : [];
  const selectedProfileCode =
    selectedStatsData.profileId ||
    selectedPlayerForModal?.profileId ||
    (selectedPlayerIsMe ? myProfile?.profileId : null) ||
    selectedPlayerForModal?.id ||
    "-";
  const activeTurnTimerPlayerId = state?.turnTimer?.playerId || null;
  const activeTurnTimerEndsAt = Number(state?.turnTimer?.endsAt || 0);
  const activeTurnTimerDurationMs = Number(state?.turnTimer?.durationMs || 45000);
  const activeTurnTimerRemainingMs =
    activeTurnTimerPlayerId && activeTurnTimerEndsAt > 0
      ? Math.max(0, activeTurnTimerEndsAt - nowMs)
      : 0;
  const renderSeatAvatar = (player, fallback = "J", sizeClass = "h-9 w-9 text-sm") => {
    const playerId = player?.id || fallback;
    const avatar = getPlayerAvatarUrl(player);
    const failed = !!remoteAvatarLoadFailed[playerId];
    const isSpeaking = !!voiceSpeakingByPlayer[playerId];
    const showTurnCountdownRing =
      !!player?.id &&
      player.id === activeTurnTimerPlayerId &&
      activeTurnTimerRemainingMs > 0 &&
      activeTurnTimerDurationMs > 0;
    const ringProgress = showTurnCountdownRing
      ? Math.max(0, Math.min(1, activeTurnTimerRemainingMs / activeTurnTimerDurationMs))
      : 0;
    const circumference = 2 * Math.PI * 18;
    const ringOffset = circumference * (1 - ringProgress);
    const ringColorClass =
      ringProgress <= 0.2 ? "text-rose-500" : ringProgress <= 0.45 ? "text-amber-400" : "text-emerald-400";
    const isVoiceSpeaking = !!(player?.id && voiceSpeakingByPlayer[player.id]);
    return (
      <div className={`relative mx-auto mb-1 ${sizeClass}`}>
        {isVoiceSpeaking && (
          <span className="pointer-events-none absolute -inset-[6px] z-[9] rounded-full border-2 border-cyan-300/80 [animation:mesaVoicePulse_900ms_ease-out_infinite]" />
        )}
        {showTurnCountdownRing && (
          <svg className={`pointer-events-none absolute -inset-[3px] z-10 ${ringColorClass}`} viewBox="0 0 42 42">
            <circle cx="21" cy="21" r="18" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.8" />
            <circle
              cx="21"
              cy="21"
              r="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={ringOffset}
              transform="rotate(-90 21 21)"
            />
          </svg>
        )}
        <button
          type="button"
          onClick={() => openPlayerProfileModal(player)}
          className={`flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-[#0d6b50] font-bold text-white shadow outline-none transition hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-emerald-300/80 ${
            isVoiceSpeaking || isSpeaking
              ? "ring-2 ring-cyan-300/90 shadow-[0_0_0_4px_rgba(34,211,238,0.22)] animate-pulse"
              : ""
          }`}
        >
          {avatar && !failed ? (
            <img
              src={avatar}
              alt={player?.name || "Jugador"}
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
              onError={() =>
                setRemoteAvatarLoadFailed((prev) => ({
                  ...prev,
                  [playerId]: true,
                }))
              }
            />
          ) : (
            (player?.name || fallback).slice(0, 1).toUpperCase()
          )}
        </button>
      </div>
    );
  };
  const isMatchEnded = !!state.matchEnded;
  const rematch = state.rematch || { decisionsByPlayer: {}, resolved: false, result: null, status: "pending" };
  const myRematchDecision = rematch.decisionsByPlayer?.[myPlayerId] || null;
  const rematchVotes = state.players.map((p) => ({
    id: p.id,
    name: p.name || "Jugador",
    decision: rematch.decisionsByPlayer?.[p.id] || null,
  }));
  const everyoneAnsweredRematch =
    rematchVotes.length > 0 && rematchVotes.every((v) => v.decision === "replay" || v.decision === "exit");
  const isBastosEspadasMode =
    Array.isArray(state.deckConfig?.allowedSuits) &&
    state.deckConfig.allowedSuits.length === 2 &&
    state.deckConfig.allowedSuits.includes("bastos") &&
    state.deckConfig.allowedSuits.includes("espadas");
  const viraPositionClassByOffset = isTwoVsTwo
    ? {
        0: "left-4 bottom-4 sm:left-6 sm:bottom-6", // Sur: izquierda del local
        1: "left-4 top-4 sm:left-6 sm:top-6", // Oeste: izquierda del oeste (hacia arriba)
        2: "right-4 top-4 sm:right-6 sm:top-6", // Norte: izquierda del norte (hacia derecha)
        3: "right-4 bottom-4 sm:right-6 sm:bottom-6", // Este: izquierda del este (hacia abajo)
      }
    : {
        0: "left-4 bottom-4 sm:left-6 sm:bottom-6", // Yo inicio: vira a mi izquierda
        1: "right-4 top-4 sm:right-6 sm:top-6", // Rival inicia: vira a su izquierda (mi derecha visual)
      };
  const viraPositionClass =
    viraPositionClassByOffset[starterOffset] || "left-4 bottom-4 sm:left-6 sm:bottom-6";

  const playCard = (cardIndex) => {
    if (hasPendingCall) return;
    if (isPardaSelecting) {
      if (hasSubmittedParda) return;

      setPardaDraft((prev) => {
        if (prev.includes(cardIndex)) {
          return prev.filter((idx) => idx !== cardIndex);
        }

        if (prev.length >= 2) {
          return prev;
        }

        const next = [...prev, cardIndex];
        if (next.length === 2) {
          socket.emit("parda:select", {
            roomId,
            bottomIndex: next[0],
            topIndex: next[1],
          });
          return [];
        }

        return next;
      });
      return;
    }

    socket.emit("play:card", { roomId, cardIndex, faceDown: passCardArmed });
    if (passCardArmed) {
      setPassCardArmed(false);
    }
  };

  const callNextRaise = () => {
    if (!nextCall) return;
    socket.emit(nextCall.event, { roomId });
  };

  const callEnvido = (stones = null) => {
    if (myHasAvailableFlor) {
      socket.emit("call:flor", { roomId });
      return;
    }
    const safeStones =
      Number.isFinite(Number(stones)) ? Math.max(1, Math.min(12, Math.floor(Number(stones)))) : null;
    socket.emit("call:envido", { roomId, stones: safeStones });
  };

  const declareCanto11Envite = () => {
    socket.emit("canto11:declare-envite", { roomId });
  };

  const callCanto11PrivoTruco = () => {
    socket.emit("canto11:privo-truco", { roomId });
  };

  const callCanto11NoPrivo = () => {
    socket.emit("canto11:no-privo", { roomId });
  };

  const toggleTestDeckMode = () => {
    socket.emit("debug:set-deck-mode", {
      roomId,
      onlyBastosEspadas: !isBastosEspadasMode,
    });
  };

  const redealTestRound = () => {
    socket.emit("debug:redeal-round", { roomId });
  };

  const forceTestFlor = () => {
    socket.emit("debug:force-flor", { roomId });
  };

  const forceTestFlorReservada = () => {
    socket.emit("debug:force-flor-reservada", { roomId });
  };

  const setMyScore11 = () => {
    socket.emit("debug:set-my-score-11", { roomId });
  };

  const setMyTeamScore11 = () => {
    socket.emit("debug:set-my-team-score-11", { roomId });
  };
  const forceTestPardaFirst = () => {
    socket.emit("debug:force-parda-first", { roomId });
  };
  const forceTestPardaTiebreak2 = () => {
    socket.emit("debug:force-parda-tiebreak2", { roomId });
  };

  const acceptPendingCall = () => {
    if (pendingCallType === "florEnvido") {
      socket.emit("flor-envido:accept", { roomId });
      return;
    }
    if (pendingCallType === "truco") {
      socket.emit("truco:accept", { roomId });
      return;
    }
    if (pendingCallType === "envido") {
      socket.emit("envido:accept", { roomId });
    }
  };

  const rejectPendingCall = () => {
    if (pendingCallType === "florEnvido") {
      socket.emit("flor-envido:reject", { roomId });
      return;
    }
    if (pendingCallType === "truco") {
      socket.emit("truco:reject", { roomId });
      return;
    }
    if (pendingCallType === "envido") {
      socket.emit("envido:reject", { roomId });
    }
  };

  const raiseEnvido = (kind = "envido", stones = null) => {
    if (pendingCallType === "florEnvido" && kind === "envido" && isPendingResponder) {
      socket.emit("flor-envido:raise", { roomId });
      return;
    }

    if (kind === "falta") {
      if (isPendingResponder && pendingCallType === "envido") {
        socket.emit("envido:raise", { roomId, kind: "falta" });
        return;
      }
      if (envidoState.status === "idle" && isInFirstHand && !isTrucoPending && !isEnvidoPending && !isFlorPending) {
        socket.emit("call:falta-envido", { roomId });
      }
      return;
    }

    socket.emit("envido:raise", { roomId, kind, stones });
  };
  const canUseAdvancedEnvido =
    isPendingResponder &&
    ((pendingCallType === "envido" && !isFaltaEnvidoPending) || pendingCallType === "florEnvido") &&
    !florAlreadySung;
  const canCallFaltaDirect =
    isMyTurn &&
    envidoState.status === "idle" &&
    isInFirstHand &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending &&
    !florAlreadySung &&
    (!myHasAvailableFlor || myHasFlorReservada);
  const canUseFaltaEnvido =
    (isPendingResponder &&
      envidoState.status === "pending" &&
      envidoState.callType !== "falta") ||
    canCallFaltaDirect;
  const canUseStoneEnvidoRaise = canUseAdvancedEnvido || canCallEnvido;
  const canCallPrimeroEnvido =
    isTrucoPending &&
    isTrucoResponder &&
    isInFirstHand &&
    envidoState.status === "idle" &&
    !florAlreadySung &&
    !isEnvidoPending;
  const canUseConFlor =
    isPendingResponder &&
    pendingCallType !== "florEnvido" &&
    myHasAvailableFlor;
  const canCallFlorEnvido =
    isMyTurn &&
    bothTeamsSangFlor &&
    !florState.florEnvidoCalled &&
    !!florState.florEnvidoWindowOpen &&
    florState.florEnvidoWindowTurnId === myPlayerId &&
    !isTrucoPending &&
    !isEnvidoPending &&
    !isFlorPending;
  const canRevealPardaCard =
    !!state.firstHandTie &&
    state.pardaPhase === "reveal" &&
    isMyTurn &&
    !!state.pardaSelections?.[myPlayerId]?.bottomCard &&
    !state.pardaSelections?.[myPlayerId]?.revealedBottom;

  const callPrimeroEnvido = () => {
    socket.emit("call:primero-envido", { roomId });
  };
  const revealPardaCard = () => {
    socket.emit("parda:reveal", { roomId });
  };

  const canPassCard =
    isMyTurn &&
    !hasPendingCall &&
    !isCanto11Active &&
    !isPardaSelecting &&
    myCards.length > 0;
  const canGoMazo =
    isMyTurn &&
    !hasPendingCall &&
    !isCanto11Active &&
    myCards.length > 0;
  const canPlayLey =
    isMyTurn && isInFirstHand && !hasPendingCall && !isCanto11Active;

  const togglePassCard = () => {
    if (!canPassCard) return;
    setPassCardArmed((prev) => !prev);
  };

  const respondConFlor = () => {
    socket.emit("flor:con-flor", { roomId });
  };

  const playLey = () => {
    socket.emit("flor:jugar-ley", { roomId });
  };

  const goMazo = () => {
    socket.emit("play:mazo", { roomId });
  };

  const callFlorEnvido = () => {
    socket.emit("call:flor-envido", { roomId });
  };

  const callTeamSignal = (signal) => {
    if (!isTwoVsTwo || !signal) return;
    socket.emit("call:team-signal", { roomId, signal });
  };

  const runAdvancedCanto = (action) => {
    action?.();
    setShowAdvancedCantos(false);
  };

  const runAdvancedJugada = (action) => {
    action?.();
    setShowAdvancedJugadas(false);
  };

  const chooseReplay = () => {
    socket.emit("match:decision", {
      roomId,
      decision: myRematchDecision === "replay" ? "pending" : "replay",
    });
  };

  const chooseExit = () => {
    socket.emit("match:decision", { roomId, decision: "exit" });
    onLeaveToRoomList?.();
  };
  const leaveLobbyNow = () => {
    onLeaveToRoomList?.();
  };

  const canCallTeamSignals = isTwoVsTwo && !isMatchEnded && !!myPlayerId;
  const uiMessageActive = Number(state.uiMessageUntil || 0) > Date.now();
  const rawCurrentMessage = (uiMessageActive ? String(state.uiMessage || "") : "") || message;
  const currentMessage = suppressMessagesForMatchEnd ? "" : rawCurrentMessage;

  useEffect(() => {
    if (!isMatchEnded) {
      if (matchModalVisible) setMatchModalVisible(false);
      if (suppressMessagesForMatchEnd) setSuppressMessagesForMatchEnd(false);
      return;
    }
    if (matchModalVisible) return;
    if (rawCurrentMessage) return;
    setMatchModalVisible(true);
    setSuppressMessagesForMatchEnd(true);
    if (messageTimeoutRef.current) {
      clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = null;
    }
    setMessage("");
  }, [
    isMatchEnded,
    matchModalVisible,
    rawCurrentMessage,
    suppressMessagesForMatchEnd,
  ]);

  useEffect(() => {
    if (!isPardaSelecting || hasSubmittedParda) {
      setPardaDraft([]);
    }
  }, [isPardaSelecting, hasSubmittedParda]);

  useEffect(() => {
    if (!canPassCard && passCardArmed) {
      setPassCardArmed(false);
    }
  }, [canPassCard, passCardArmed]);

  const renderDeckCardOrFallback = (card) => {
    if (card?.hiddenInParda) {
      return renderBackCard();
    }
    const deckCard = getDeckCard(card);
    if (deckCard) {
      const effectiveCard = {
        ...deckCard,
        rank: typeof card?.rank === "number" ? card.rank : deckCard.rank,
      };
      return renderCard(effectiveCard);
    }

    return (
      <div className="flex h-[75px] w-[48px] items-center justify-center rounded-sm border border-slate-300 bg-white text-[10px] font-semibold text-slate-700">
        {card?.value}
      </div>
    );
  };

  const renderPlayedStack = (cards, options = {}) => {
    const { fromNorth = false, rotateDeg = 0, stackAxis = "y", stackSign = 1 } = options;
    const stackStep = 13;
    const offsets = [];
    let units = 0;
    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i];
      const prev = cards[i - 1];
      if (
        i > 0 &&
        card?.pardaNoGap &&
        prev?.pardaNoGap &&
        card?.pardaPair &&
        prev?.pardaPair
      ) {
        offsets.push(units * stackStep);
      } else {
        units += i === 0 ? 0 : 1;
        offsets.push(units * stackStep);
      }
    }
    const stackCount = cards.length;
    const stackSize = offsets.length ? Math.max(...offsets) : 0;
    const stackStart = fromNorth && stackAxis === "y"
      ? (index) => stackSize - offsets[index]
      : (index) => offsets[index];
    const containerStyle =
      stackAxis === "x"
        ? { width: `${78 + stackSize}px`, height: "76px" }
        : { width: "78px", height: `${76 + stackSize}px` };

    return (
      <div className="relative" style={containerStyle}>
        {cards.map((card, index) => {
          const offset = stackStart(index);
          const zIndex = index + 1;
          let xOffset = stackAxis === "x" ? offset * stackSign : 0;
          let yOffset = stackAxis === "y" ? offset : 0;
          const revealGapShift = card?.pardaPair && card?.pardaLayer === "top" && card?.pardaRevealGap ? 20 : 0;
          if (revealGapShift > 0) {
            if (stackAxis === "x") xOffset += revealGapShift * stackSign;
            else yOffset += fromNorth ? -revealGapShift : revealGapShift;
          }
          const baseRotate = fromNorth && rotateDeg === 0 ? 180 : 0;
          const totalRotate = baseRotate + rotateDeg;
          const transform = `translateX(-50%) translateY(${yOffset}px) rotate(${totalRotate}deg)`;
          return (
            <div
              key={`${card.playerId}-${card.value}-${card.suit}-${index}`}
              className="absolute transition-transform duration-300 ease-out"
              style={{
                left: `calc(50% + ${xOffset}px)`,
                top: "0px",
                zIndex,
                transform,
              }}
            >
              {renderDeckCardOrFallback(card)}
            </div>
          );
        })}
      </div>
    );
  };

  const renderPlayedFan = (cards, options = {}) => {
    const { fromNorth = false, rotateDeg = 0 } = options;
    const total = cards.length;
    if (!total) return null;

    const spread = Math.min(56, 30 + total * 9);
    const center = (total - 1) / 2;

    return (
      <div className="relative h-[92px] w-[130px]">
        {cards.map((card, index) => {
          const angleStep = total > 1 ? spread / (total - 1) : 0;
          const angle = -spread / 2 + angleStep * index;
          const centerDist = Math.abs(index - center);
          const maxDist = center || 1;
          const arcFactor = 1 - centerDist / maxDist;
          const arcPx = Math.round(arcFactor * 12);
          const yOffset = fromNorth ? arcPx : -arcPx;
          const xOffset = Math.round((index - center) * 22);
          const baseRotate = fromNorth ? 180 - angle : angle;
          const totalRotate = baseRotate + rotateDeg;
          return (
            <div
              key={`${card.playerId}-${card.suit}-${card.value}-${index}`}
              className="absolute left-1/2 top-0"
              style={{
                marginLeft: `${xOffset}px`,
                transform: `translateX(-50%) translateY(${yOffset}px) rotate(${totalRotate}deg)`,
                zIndex: total - index,
              }}
            >
              {renderDeckCardOrFallback(card)}
            </div>
          );
        })}
      </div>
    );
  };

  const renderFanHand = (cards, options = {}) => {
    const { fromNorth = false, playable = false, selectedIndexes = [] } = options;
    const total = cards.length;
    if (!total) return null;
    const selectedSet = new Set(selectedIndexes);

    const spread = Math.min(62, 34 + total * 7);
    const center = (total - 1) / 2;

    return (
      <div className="relative h-[112px] w-[min(88vw,420px)] sm:h-[120px] sm:w-[420px]">
        {cards.map((card, index) => {
          const angleStep = total > 1 ? spread / (total - 1) : 0;
          const angle = -spread / 2 + angleStep * index;
          const centerDist = Math.abs(index - center);
          const maxDist = center || 1;
          const arcFactor = 1 - centerDist / maxDist;
          const arcPx = Math.round(arcFactor * 10);
          const xOffset = Math.round((index - center) * 28);
          const rotation = fromNorth ? 180 - angle : angle;
          const zIndex = total - index;
          const commonStyle = {
            left: "50%",
            marginLeft: `${xOffset}px`,
            transform: `translateX(-50%) rotate(${rotation}deg)`,
            zIndex,
          };

          if (fromNorth) {
            return (
              <div
                key={`fan-opp-${index}`}
                className="absolute pointer-events-none"
                style={{ ...commonStyle, top: `${arcPx}px` }}
              >
                {renderBackCard()}
              </div>
            );
          }

          const isDisabled = !playable;
          return (
            <button
              key={`${card.suit}-${card.value}-${index}`}
              type="button"
              onClick={() => playCard(index)}
              disabled={isDisabled}
              className={`absolute pointer-events-auto transition ${
                isDisabled
                  ? "cursor-not-allowed opacity-95 saturate-75"
                  : "cursor-pointer hover:-translate-y-2"
              }`}
              style={{ ...commonStyle, bottom: `${arcPx}px` }}
            >
              <div
                className={`rounded-sm ${
                  selectedSet.has(index) ? "ring-2 ring-amber-300 ring-offset-2 ring-offset-transparent" : ""
                }`}
              >
                {renderDeckCardOrFallback(card)}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  const renderSideFanBackCards = (cards, side = "left") => {
    const total = cards.length;
    if (!total) return null;
    const center = (total - 1) / 2;
    const spread = Math.min(52, 28 + total * 8);

    return (
      <div className="relative mx-auto flex h-[126px] w-[82px] items-center justify-center">
        {cards.map((_, index) => {
          const angleStep = total > 1 ? spread / (total - 1) : 0;
          const arcAngle = -spread / 2 + angleStep * index;
          const signedAngle = side === "left" ? -90 + arcAngle : 90 - arcAngle;
          const rel = index - center;
          const xDir = side === "left" ? -1 : 1;
          const xOffset = Math.round((Math.abs(rel) * 6 + 2) * xDir);
          const yOffset = Math.round(rel * 16);
          return (
            <div
              key={`${side}-fan-${index}`}
              className="absolute"
              style={{
                transform: `translate(${xOffset}px, ${yOffset}px) rotate(${signedAngle}deg)`,
                zIndex: total - index,
              }}
            >
              {renderBackCard()}
            </div>
          );
        })}
      </div>
    );
  };
  const onFloatingClockPointerDown = (event) => {
    const target = event.currentTarget;
    target?.setPointerCapture?.(event.pointerId);
    const drag = floatingClockDragRef.current;
    drag.active = true;
    drag.pointerId = event.pointerId;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    drag.originX = floatingClockPos.x;
    drag.originY = floatingClockPos.y;
    drag.moved = false;
    drag.suppressClick = false;
    setIsFloatingClockDragging(true);
  };

  const onFloatingClockPointerMove = (event) => {
    const drag = floatingClockDragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      drag.moved = true;
    }
    const next = clampFloatingClockPos(drag.originX + dx, drag.originY + dy);
    setFloatingClockPos(next);
  };

  const onFloatingClockPointerUp = (event) => {
    const drag = floatingClockDragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    const target = event.currentTarget;
    target?.releasePointerCapture?.(event.pointerId);
    drag.active = false;
    drag.pointerId = null;
    setIsFloatingClockDragging(false);

    if (!drag.moved) return;
    drag.suppressClick = true;
    setFloatingClockPos((prev) => {
      if (typeof window === "undefined") return prev;
      const snapLeft = prev.x + FLOAT_CLOCK_SIZE / 2 < window.innerWidth / 2;
      const snapX = snapLeft
        ? FLOAT_CLOCK_EDGE_GAP
        : window.innerWidth - FLOAT_CLOCK_SIZE - FLOAT_CLOCK_EDGE_GAP;
      return clampFloatingClockPos(snapX, prev.y);
    });
  };

  const onFloatingClockClick = (event) => {
    const drag = floatingClockDragRef.current;
    if (drag.suppressClick) {
      drag.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setShowHistoryPanel((prev) => !prev);
  };

  const rightPanelEnvidoStone = {
    show: showEnvidoStoneSlider,
    setShow: setShowEnvidoStoneSlider,
    value: envidoStoneRaise,
    setValue: setEnvidoStoneRaise,
    canUseAdvancedEnvido,
    raiseEnvido,
    canCallEnvido,
    callEnvido,
    canUseStoneEnvidoRaise,
    closeAdvancedCantos: setShowAdvancedCantos,
  };

  const rightPanelAdvancedCantos = {
    show: showAdvancedCantos,
    setShow: setShowAdvancedCantos,
    closeOthers: () => {
      setShowAdvancedJugadas(false);
      setShowCommunicationCantos(false);
    },
    runAdvancedCanto,
    canUseFaltaEnvido,
    canCallPrimeroEnvido,
    callPrimeroEnvido,
    canUseConFlor,
    respondConFlor,
    canCallFlorEnvido,
    callFlorEnvido,
  };

  const rightPanelAdvancedJugadas = {
    show: showAdvancedJugadas,
    setShow: setShowAdvancedJugadas,
    closeOthers: () => {
      setShowAdvancedCantos(false);
      setShowCommunicationCantos(false);
    },
    runAdvancedJugada,
    togglePassCard,
    canPassCard,
    passCardArmed,
    playLey,
    canPlayLey,
    goMazo,
    canGoMazo,
  };

  const rightPanelCommunicationCantos = {
    isTwoVsTwo,
    show: showCommunicationCantos,
    setShow: setShowCommunicationCantos,
    closeOthers: () => {
      setShowAdvancedCantos(false);
      setShowAdvancedJugadas(false);
    },
    teamSignals,
    callTeamSignal,
    canCallTeamSignals,
  };

  const rightPanelPlayerCard = {
    avatarUrl: safeAvatarUrl,
    avatarLoadFailed,
    onAvatarError: () => setAvatarLoadFailed(true),
    onAvatarClick: () => {
      if (me?.id) openPlayerProfileModal(me);
    },
    playerName: me?.name || "Jugador",
    roomId,
    isCanto11Active,
    canDeclareCanto11Envite,
    canCanto11Privo,
    canCanto11NoPrivo,
    hasAvailableFlor:
      !!(florState.hasFlorByPlayer?.[myPlayerId] && !florState.burnedByPlayer?.[myPlayerId]) || myHasAvailableFlor,
    myCurrentEnvite,
    onDeclareCanto11Envite: declareCanto11Envite,
    onCallCanto11PrivoTruco: callCanto11PrivoTruco,
    onCallCanto11NoPrivo: callCanto11NoPrivo,
    isPendingResponder,
    pendingCallType,
    onAcceptPendingCall: acceptPendingCall,
    onRejectPendingCall: rejectPendingCall,
    onRespondWithFlor: respondConFlor,
    canCallNextRaise,
    onCallNextRaise: callNextRaise,
    isPendingCallerWaiting,
    nextCallLabel: nextCall?.label,
    canRevealPardaCard,
    onRevealPardaCard: revealPardaCard,
    canCallEnvidoForCard: canCallEnvido,
    canCallFlor,
    onCallEnvido: () => callEnvido(),
    micEnabled,
    onToggleMic: toggleVoiceMic,
    isSpeaking: !!voiceSpeakingByPlayer[myPlayerId],
    turnTimerPlayerId: activeTurnTimerPlayerId,
    turnTimerRemainingMs: activeTurnTimerRemainingMs,
    turnTimerDurationMs: activeTurnTimerDurationMs,
    myPlayerId,
    isVoiceSpeaking: !!voiceSpeakingByPlayer[myPlayerId],
  };

  return (
    <div className="relative h-screen overflow-hidden bg-emerald-950 px-14 pt-10 text-white sm:px-6 sm:py-6">
      <img
        src={logo}
        alt="Truco Venezolano"
        className="pointer-events-none fixed bottom-14 left-3 z-[10] h-24 select-none opacity-50 sm:bottom-16 "
      />
      <button
        type="button"
        onClick={leaveLobbyNow}
        disabled={isMatchEnded}
        className={`fixed bottom-3 left-3 z-[10] rounded-full px-4 py-2 text-xs font-semibold shadow-lg transition sm:text-sm ${
          isMatchEnded
            ? "cursor-not-allowed bg-slate-500/80 text-slate-200"
            : "bg-emerald-800/95 text-white hover:bg-emerald-700"
        }`}
      >
        Salir al lobby
      </button>
      {matchModalVisible && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 px-4 [animation:mesaModalBackdropIn_220ms_ease-out_forwards]">
          <div className="w-full max-w-md rounded-2xl border border-emerald-200/30 bg-slate-900/95 p-5 text-white shadow-2xl [animation:mesaModalCardIn_280ms_cubic-bezier(0.16,1,0.3,1)_forwards]">
            <h2 className="text-center text-xl font-bold text-amber-200">Partida terminada</h2>
            <p className="mt-1 text-center text-sm text-slate-300">
              {state.matchWinnerId
                ? `${state.players.find((p) => p.id === state.matchWinnerId)?.name || "Pareja"} llego a 12 puntos.`
                : "Se alcanzo el fin de partida."}
            </p>

            <div className="mt-4 rounded-lg bg-slate-800/80 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Decisiones</div>
              <div className="space-y-1.5">
                {rematchVotes.map((vote) => (
                  <div key={vote.id} className="flex items-center justify-between rounded-md bg-slate-700/40 px-2 py-1.5 text-sm">
                    <span className="font-medium">{vote.name}</span>
                    <span
                      key={`${vote.id}-${vote.decision || "pending"}`}
                      className={`rounded px-2 py-0.5 text-xs font-semibold [animation:rematchDecisionIn_240ms_ease-out_forwards] ${
                        vote.decision === "replay"
                          ? "bg-emerald-600/80 text-emerald-100"
                          : vote.decision === "exit"
                            ? "bg-emerald-700/80 text-emerald-100"
                            : "bg-slate-600 text-slate-200"
                      }`}
                    >
                      {vote.decision === "replay" ? "Jugar de nuevo" : vote.decision === "exit" ? "Salir" : "Pendiente"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={chooseReplay}
                disabled={rematch.resolved}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  rematch.resolved
                    ? "cursor-not-allowed bg-slate-600 text-slate-300"
                    : "bg-emerald-600 text-white hover:bg-emerald-700"
                }`}
              >
                {myRematchDecision === "replay" ? "Pendiente" : "Jugar de nuevo"}
              </button>
              <button
                type="button"
                onClick={chooseExit}
                disabled={rematch.resolved}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  rematch.resolved
                    ? "cursor-not-allowed bg-slate-600 text-slate-300"
                    : "bg-emerald-700 text-white hover:bg-emerald-800"
                }`}
              >
                Salir al roomlist
              </button>
            </div>

            <p className="mt-3 text-center text-xs text-slate-400">
              {rematch.resolved
                ? rematch.result === "replay"
                  ? "Todos aceptaron: iniciando nueva partida..."
                  : "Se decidio salir al roomlist."
                : everyoneAnsweredRematch
                  ? "Procesando decision final..."
                  : "Esperando la respuesta de todos los jugadores..."}
            </p>
            {rematch.resolved && rematch.result === "exit" && (
              <div className="mt-3 text-center">
                <button
                  type="button"
                  onClick={() => onLeaveToRoomList?.()}
                  className="rounded-md bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-white"
                >
                  Volver ahora
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {selectedPlayerForModal && (
        <div
          className="fixed inset-0 z-[125] flex items-center justify-center bg-black/60 px-4 [animation:mesaProfileBackdropIn_220ms_ease-out_forwards]"
          onClick={() => setSelectedPlayerForModal(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-emerald-300/20 bg-emerald-950/95 p-4 text-white shadow-2xl [animation:mesaProfileCardIn_280ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto flex w-full items-center gap-3 rounded-xl border border-emerald-300/25 bg-emerald-900/25 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex gap-2">
                  <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-emerald-700 text-sm font-bold text-emerald-50">
                    {getPlayerAvatarUrl(selectedPlayerForModal) &&
                    !remoteAvatarLoadFailed[selectedPlayerForModal.id] ? (
                      <img
                        src={getPlayerAvatarUrl(selectedPlayerForModal)}
                        alt={selectedPlayerForModal?.name || "Jugador"}
                        className="h-full w-full object-cover"
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setRemoteAvatarLoadFailed((prev) => ({
                            ...prev,
                            [selectedPlayerForModal.id]: true,
                          }))
                        }
                      />
                    ) : (
                      (selectedPlayerForModal?.name || "J").slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-emerald-50">
                      {selectedPlayerForModal?.name || "Jugador"}
                    </p>
                    <p className="truncate text-xs text-emerald-200/75">ID: {selectedProfileCode}</p>
                  </div>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-emerald-100/85">
                  <span className="rounded-md bg-emerald-900/55 px-2 py-1">Victorias: {selectedWins}</span>
                  <span className="rounded-md bg-emerald-900/55 px-2 py-1">Derrotas: {selectedLosses}</span>
                </div>
              </div>
              <div className="flex flex-col items-center">
                <div
                  className="relative h-11 w-11 rounded-full ring-2 ring-emerald-200/10"
                  style={{
                    background: `conic-gradient(from -90deg, #22c55e 0deg ${Math.round(
                      (selectedWinPct / 100) * 360
                    )}deg, #ef4444 ${Math.round((selectedWinPct / 100) * 360)}deg 360deg)`,
                  }}
                  aria-label={`Victorias ${selectedWinPct}%, derrotas ${selectedLossPct}%`}
                  title={`Victorias ${selectedWinPct}% / Derrotas ${selectedLossPct}%`}
                >
                  <div className="absolute inset-[3px] flex items-center justify-center rounded-full bg-emerald-950 text-[10px] font-bold text-emerald-300">
                    {selectedWinPct}%
                  </div>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-1 text-[10px]">
                  <span className="rounded px-0.5 py-1 text-center text-emerald-300">{selectedWins}W</span>
                  <span className="rounded px-0.5 py-1 text-center text-red-300">{selectedLosses}L</span>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-200/85">
                Ultimos 5 juegos
              </h4>
              <div className="mt-2 space-y-1.5">
                {selectedPlayerStatsLoading ? (
                  <div className="rounded-md bg-slate-800/60 px-2 py-2 text-center text-xs text-slate-400">
                    Cargando estadisticas...
                  </div>
                ) : selectedRecentMatches.length > 0 ? (
                  selectedRecentMatches.map((entry, idx) => (
                    <div
                      key={`${selectedPlayerForModal.id}-recent-${idx}-${entry.id || entry.endedAt || idx}`}
                      className="flex items-center justify-between rounded-md bg-emerald-900/35 px-2 py-1.5 text-xs"
                    >
                      <span className={entry.result === "W" ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
                        {entry.result === "W" ? "Ganada" : "Perdida"}
                      </span>
                      <span className="text-slate-300">{entry.mode || "1vs1"}</span>
                      <span className="text-slate-400">
                        {entry.endedAt ? new Date(entry.endedAt).toLocaleDateString() : "-"}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="rounded-md bg-emerald-900/30 px-2 py-2 text-center text-xs text-slate-400">
                    Sin estadisticas recientes
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSelectedPlayerForModal(null)}
              className="mt-4 w-full rounded-lg bg-emerald-700/90 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
      <style>{`
        @keyframes mesaMessageFloat {
          0% {
            opacity: 0;
            transform: translateY(-24px);
          }
          36.36% {
            opacity: 1;
            transform: translateY(0);
          }
          81.82% {
            opacity: 1;
            transform: translateY(0);
          }
          100% {
            opacity: 0;
            transform: translateY(8px);
          }
        }
        @keyframes mesaVoicePulse {
          0% {
            opacity: 0.85;
            transform: scale(0.92);
          }
          70% {
            opacity: 0;
            transform: scale(1.22);
          }
          100% {
            opacity: 0;
            transform: scale(1.22);
          }
        }
        @keyframes mesaModalBackdropIn {
          0% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        @keyframes mesaModalCardIn {
          0% {
            opacity: 0;
            transform: translateY(12px) scale(0.96);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes rematchDecisionIn {
          0% {
            opacity: 0.55;
            transform: scale(0.92);
          }
          70% {
            opacity: 1;
            transform: scale(1.06);
          }
          100% {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes mesaProfileBackdropIn {
          0% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        @keyframes mesaProfileCardIn {
          0% {
            opacity: 0;
            transform: translateY(12px) scale(0.96);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
      <HistoryPanel
        open={showHistoryPanel}
        entries={messageHistory}
        onClose={() => setShowHistoryPanel(false)}
      />
      <FloatingClockButton
        x={floatingClockPos.x}
        y={floatingClockPos.y}
        isDragging={isFloatingClockDragging}
        onPointerDown={onFloatingClockPointerDown}
        onPointerMove={onFloatingClockPointerMove}
        onPointerUp={onFloatingClockPointerUp}
        onClick={onFloatingClockClick}
      />
      {isTestUser && (
        <TestControlsPanel
          isOpen={showTestPanel}
          onToggleOpen={() => setShowTestPanel((prev) => !prev)}
          isBastosEspadasMode={isBastosEspadasMode}
          onToggleTestDeckMode={toggleTestDeckMode}
          onRedealTestRound={redealTestRound}
          onForceTestFlor={forceTestFlor}
          onForceTestFlorReservada={forceTestFlorReservada}
          onSetMyScore11={setMyScore11}
          onSetMyTeamScore11={setMyTeamScore11}
          onForceTestPardaFirst={forceTestPardaFirst}
          onForceTestPardaTiebreak2={forceTestPardaTiebreak2}
        />
      )}

      <TableStatusPanels
        nsTeamNames={nsTeamNames}
        eoTeamNames={eoTeamNames}
        nsTeamPoints={nsTeamPoints}
        eoTeamPoints={eoTeamPoints}
        nsTeamAway={nsTeamAway}
        eoTeamAway={eoTeamAway}
        activeTrucoTitle={activeTrucoTitle}
        isTrucoActive={isTrucoActive}
        activeTrucoLabel={activeTrucoLabel}
        enviteTitle={enviteTitle}
        isCanto11Active={isCanto11Active}
        isEnviteActiveDisplay={isEnviteActiveDisplay}
        activeEnviteLabelDisplay={activeEnviteLabelDisplay}
        isTrucoAwaitingResponse={isTrucoAwaitingResponse}
        isEnviteAwaitingResponse={isEnviteAwaitingResponse}
        isTrucoRejected={isTrucoRejectedDisplay}
        isEnviteRejected={isEnviteRejectedDisplay}
      />

      <RightActionPanel
        envidoStone={rightPanelEnvidoStone}
        advancedCantos={rightPanelAdvancedCantos}
        advancedJugadas={rightPanelAdvancedJugadas}
        communicationCantos={rightPanelCommunicationCantos}
        playerCard={rightPanelPlayerCard}
      />

      <div className="mx-auto flex h-full w-full items-start justify-center pb-[34vh] pt-28 sm:items-center sm:px-8 sm:pb-0 sm:pt-0">
        <div className="relative w-[min(96vw,60dvh)] max-w-[500px] sm:w-[min(76vw,76vh)] sm:-translate-y-[4vh]">
          <div className="relative aspect-square">
            <div className="absolute left-1/2 top-[-74px] z-30 -translate-x-1/2 text-center sm:top-[-100px]">
              {renderSeatAvatar(opponent, "R", "h-9 w-9 text-sm")}

              {!isFlorRevealMode && renderFanHand(opponentCards, { fromNorth: true })}
            </div>

            {isTwoVsTwo && (
              <div className="absolute left-[-46px] top-1/2 z-30 -translate-y-1/2 text-center sm:left-[-70px]">
                {renderSeatAvatar(leftPlayer, "L", "h-8 w-8 text-xs")}
                {!isFlorRevealMode && renderSideFanBackCards(leftCards, "left")}
              </div>
            )}

            {isTwoVsTwo && (
              <div className="absolute right-[-46px] top-1/2 z-30 -translate-y-1/2 text-center sm:right-[-70px]">
                {renderSeatAvatar(rightPlayer, "R", "h-8 w-8 text-xs")}
                {!isFlorRevealMode && renderSideFanBackCards(rightCards, "right")}
              </div>
            )}

            <div className="absolute inset-x-0 bottom-0 top-[0px] rounded-[10px] border-2 border-emerald-200/45 bg-[radial-gradient(circle_at_50%_35%,#8fbfa9_0%,#7db49f_45%,#4f9a78_100%)] shadow-[inset_0_0_28px_rgba(255,255,255,0.12),0_24px_48px_rgba(0,0,0,0.45)]">
              {currentMessage && (
                <div className="pointer-events-none absolute inset-0 z-[26] overflow-hidden rounded-[10px]">
                  <div className="absolute inset-x-[8%] top-1/2 -translate-y-1/2 text-center">
                    <div
                      className="mx-auto max-w-full whitespace-normal break-normal text-lg font-semibold leading-tight tracking-[0.02em] text-[#0b1f3a] [animation:mesaMessageFloat_1.6s_ease-in-out_forwards]"
                      style={{
                        textShadow:
                          "0 1px 2px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.2)",
                      }}
                    >
                      {currentMessage}
                    </div>
                  </div>
                </div>
              )}
              <div className={`absolute  ${viraPositionClass}`}>
                {renderDeckCardOrFallback(state.vira)}
              </div>

              {isFlorRevealMode ? (
                <>
                  <div className="absolute left-1/2 top-[4%] -translate-x-1/2">
                    {renderPlayedFan(opponentFlorRevealCards, { fromNorth: true })}
                  </div>
                  <div className="absolute left-1/2 bottom-[4%] -translate-x-1/2">
                    {renderPlayedFan(myFlorRevealCards)}
                  </div>
                  {isTwoVsTwo && (
                    <div className="absolute left-[10%] top-1/2 -translate-y-1/2">
                      {renderPlayedFan(leftFlorRevealCards, { rotateDeg: 90 })}
                    </div>
                  )}
                  {isTwoVsTwo && (
                    <div className="absolute right-[10%] top-1/2 -translate-y-1/2">
                      {renderPlayedFan(rightFlorRevealCards, { rotateDeg: -90 })}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="absolute left-1/2 top-[4%] -translate-x-1/2">
                    {isCanto11DuelDeclaring || isCanto11DuelResolving
                      ? renderPlayedFan(opponentPlayedCards, { fromNorth: true })
                      : renderPlayedStack(opponentPlayedCards, { fromNorth: true })}
                  </div>
                  <div className="absolute left-1/2 bottom-[4%] -translate-x-1/2">
                    {isCanto11DuelDeclaring || isCanto11DuelResolving
                      ? renderPlayedFan(myPlayedCards)
                      : renderPlayedStack(myPlayedCards)}
                  </div>
                  {isTwoVsTwo && (
                    <div className="absolute left-[10%] top-1/2 -translate-y-1/2">
                      {isCanto11DuelDeclaring || isCanto11DuelResolving
                        ? renderPlayedFan(leftPlayedCards, { rotateDeg: 90 })
                        : renderPlayedStack(leftPlayedCards, { rotateDeg: 90, stackAxis: "x", stackSign: -1 })}
                    </div>
                  )}
                  {isTwoVsTwo && (
                    <div className="absolute right-[10%] top-1/2 -translate-y-1/2">
                      {isCanto11DuelDeclaring || isCanto11DuelResolving
                        ? renderPlayedFan(rightPlayedCards, { rotateDeg: -90 })
                        : renderPlayedStack(rightPlayedCards, { rotateDeg: -90, stackAxis: "x", stackSign: 1 })}
                    </div>
                  )}

                  <div className="absolute left-1/2 bottom-[-56px] z-30 -translate-x-1/2 sm:bottom-[-65px]">
                    {renderFanHand(myCards, {
                      playable: isPardaSelecting
                        ? isMyTurn && !hasSubmittedParda && !hasPendingCall
                        : isMyTurn && !hasPendingCall && !isPardaRevealing,
                      selectedIndexes: pardaDraft,
                    })}
                  </div>
                </>
              )}

            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

export default Mesa;


