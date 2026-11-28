import type { KioskCommand } from './types';

export type GestureContextMode = 'stage' | 'modal';

export type GesturePowerMode = 'standby' | 'active';

export type GestureResolutionId = '240p' | '480p';

export type GestureHudMode = 'skeleton' | 'video' | 'compact';

export type GestureAction =
  | KioskCommand
  | 'VOL_UP'
  | 'VOL_DOWN'
  | 'OPEN_CATALOG'
  | 'CYCLE_STAGE'
  | 'CYCLE_TAB';

export interface Point2D {
  x: number;
  y: number;
}

export interface GestureSettings {
  enabled: boolean;
  resolution: GestureResolutionId;
  hudMode: GestureHudMode;
  dwellMs: number;
  skipHoldMs: number;
  minHandScale: number;
  minConfidence: number;
  wakeHoldMs: number;
  activeWindowMs: number;
  repeatIntervalMs: number;
  cooldownMs: number;
  graceMs: number;
}

export interface GestureFrameInput {
  gestureName: string | null;
  confidence: number;
  landmarks: ReadonlyArray<Point2D> | null;
  timestampMs: number;
  context: GestureContextMode;
}

export interface GestureEngineState {
  powerMode: GesturePowerMode;
  activeUntilMs: number | null;
  wakeStartedAtMs: number | null;
  wakeProgress: number;
  candidateAction: GestureAction | null;
  candidateGesture: string | null;
  candidateStartedAtMs: number | null;
  lastValidSeenAtMs: number | null;
  latchedGesture: string | null;
  lastTriggeredAction: GestureAction | null;
  lastTriggeredAtMs: number | null;
  dwellProgress: number;
  handScale: number;
  tooFar: boolean;
}

export interface GestureFrameOutput {
  nextState: GestureEngineState;
  triggeredAction: GestureAction | null;
  pendingAction: GestureAction | null;
  powerMode: GesturePowerMode;
  wakeProgress: number;
  dwellProgress: number;
  tooFar: boolean;
  handScale: number;
  recommendedIntervalMs: number;
  justWokeUp: boolean;
}

export const GESTURE_SETTINGS_KEY = 'jkbox.gestureSettings';

export const STANDBY_INTERVAL_MS = 250;
export const ACTIVE_INTERVAL_MS = 42;

export const GESTURE_RESOLUTION_PRESETS: Record<
  GestureResolutionId,
  { width: number; height: number; label: string; hint: string }
> = {
  '240p': {
    width: 320,
    height: 240,
    label: '320x240 Leve (240p padrão)',
    hint: 'Ideal p/ notebooks antigos (2–4 GB RAM) e luz baixa',
  },
  '480p': {
    width: 640,
    height: 480,
    label: '640x480 Padrão (480p)',
    hint: 'Maior alcance para câmeras 1.3 MP em máquinas modernas',
  },
};

export const DEFAULT_GESTURE_SETTINGS: GestureSettings = {
  enabled: false,
  resolution: '240p',
  hudMode: 'skeleton',
  dwellMs: 320,
  skipHoldMs: 1200,
  minHandScale: 0.18,
  minConfidence: 0.72,
  wakeHoldMs: 800,
  activeWindowMs: 15_000,
  repeatIntervalMs: 360,
  cooldownMs: 600,
  graceMs: 140,
};

const WAKE_GESTURES = new Set<string>(['ILoveYou', 'Open_Palm']);

const REPEATABLE_ACTIONS = new Set<GestureAction>(['UP', 'DOWN', 'VOL_UP', 'VOL_DOWN']);

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];

const FINGERTIP_INDICES = new Set<number>([4, 8, 12, 16, 20]);

/** Loads persisted Host gesture settings from localStorage with safe bounds clamping. */
export const loadGestureSettings = (storage?: Pick<Storage, 'getItem'> | null): GestureSettings => {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!target) return { ...DEFAULT_GESTURE_SETTINGS };
  try {
    const raw = target.getItem(GESTURE_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_GESTURE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GestureSettings>;
    return normalizeGestureSettings(parsed);
  } catch {
    return { ...DEFAULT_GESTURE_SETTINGS };
  }
};

/** Validates and clamps partial gesture settings into a safe configuration object. */
export const normalizeGestureSettings = (partial: Partial<GestureSettings>): GestureSettings => {
  const clamp = (val: unknown, fallback: number, min: number, max: number): number => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
    return Math.min(max, Math.max(min, val));
  };

  return {
    enabled: Boolean(partial.enabled ?? DEFAULT_GESTURE_SETTINGS.enabled),
    resolution: partial.resolution === '480p' ? '480p' : '240p',
    hudMode:
      partial.hudMode === 'video' || partial.hudMode === 'compact' || partial.hudMode === 'skeleton'
        ? partial.hudMode
        : 'skeleton',
    dwellMs: Math.round(clamp(partial.dwellMs, DEFAULT_GESTURE_SETTINGS.dwellMs, 160, 800)),
    skipHoldMs: Math.round(clamp(partial.skipHoldMs, DEFAULT_GESTURE_SETTINGS.skipHoldMs, 600, 2500)),
    minHandScale: Math.round(clamp(partial.minHandScale, DEFAULT_GESTURE_SETTINGS.minHandScale, 0.08, 0.4) * 100) / 100,
    minConfidence:
      Math.round(clamp(partial.minConfidence, DEFAULT_GESTURE_SETTINGS.minConfidence, 0.5, 0.92) * 100) / 100,
    wakeHoldMs: Math.round(clamp(partial.wakeHoldMs, DEFAULT_GESTURE_SETTINGS.wakeHoldMs, 300, 2000)),
    activeWindowMs: Math.round(clamp(partial.activeWindowMs, DEFAULT_GESTURE_SETTINGS.activeWindowMs, 5000, 60_000)),
    repeatIntervalMs: Math.round(clamp(partial.repeatIntervalMs, DEFAULT_GESTURE_SETTINGS.repeatIntervalMs, 180, 900)),
    cooldownMs: Math.round(clamp(partial.cooldownMs, DEFAULT_GESTURE_SETTINGS.cooldownMs, 250, 1500)),
    graceMs: Math.round(clamp(partial.graceMs, DEFAULT_GESTURE_SETTINGS.graceMs, 50, 300)),
  };
};

/** Saves Host gesture settings to localStorage safely. */
export const saveGestureSettings = (
  settings: GestureSettings,
  storage?: Pick<Storage, 'setItem'> | null,
): GestureSettings => {
  const normalized = normalizeGestureSettings(settings);
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    target?.setItem(GESTURE_SETTINGS_KEY, JSON.stringify(normalized));
  } catch (err) {
    if (err instanceof Error) return normalized;
  }
  return normalized;
};

/** Computes normalized bounding-box span (0..1) of 21 hand landmarks to filter distant background hands. */
export const computeHandBoundingScale = (landmarks: ReadonlyArray<Point2D> | null | undefined): number => {
  if (!landmarks || landmarks.length === 0) return 0;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const pt of landmarks) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  const spanX = Math.max(0, maxX - minX);
  const spanY = Math.max(0, maxY - minY);
  return Math.round(Math.max(spanX, spanY) * 1000) / 1000;
};

/** Maps a MediaPipe category name + current Kiosk screen context to the target abstract action. */
export const mapContextualGesture = (
  gestureName: string | null,
  context: GestureContextMode,
): GestureAction | null => {
  if (!gestureName || gestureName === 'None') return null;

  if (context === 'stage') {
    switch (gestureName) {
      case 'Thumb_Up':
        return 'VOL_UP';
      case 'Thumb_Down':
        return 'VOL_DOWN';
      case 'Victory':
        return 'SKIP';
      case 'Closed_Fist':
        return 'PLAY';
      case 'Open_Palm':
        return 'OPEN_CATALOG';
      case 'Pointing_Up':
        return 'CYCLE_STAGE';
      default:
        return null;
    }
  }

  switch (gestureName) {
    case 'Thumb_Up':
      return 'UP';
    case 'Thumb_Down':
      return 'DOWN';
    case 'Victory':
      return 'SELECT';
    case 'Closed_Fist':
      return 'PLAY';
    case 'Open_Palm':
      return 'BACK';
    case 'Pointing_Up':
      return 'CYCLE_TAB';
    default:
      return null;
  }
};

/** Human-readable Portuguese label for HUD feedback. */
export const formatGestureActionLabel = (action: GestureAction): string => {
  switch (action) {
    case 'VOL_UP':
      return 'Volume +';
    case 'VOL_DOWN':
      return 'Volume -';
    case 'SKIP':
      return 'Pular faixa';
    case 'PLAY':
      return 'Play / Pause';
    case 'OPEN_CATALOG':
      return 'Abrir catálogo';
    case 'CYCLE_STAGE':
      return 'Alternar palco';
    case 'UP':
      return 'Subir';
    case 'DOWN':
      return 'Descer';
    case 'SELECT':
      return 'Selecionar';
    case 'BACK':
      return 'Voltar';
    case 'CYCLE_TAB':
      return 'Trocar aba';
    default:
      return action;
  }
};

/** Creates initial idle/standby state for the anti-party gesture state machine. */
export const createInitialGestureEngineState = (): GestureEngineState => ({
  powerMode: 'standby',
  activeUntilMs: null,
  wakeStartedAtMs: null,
  wakeProgress: 0,
  candidateAction: null,
  candidateGesture: null,
  candidateStartedAtMs: null,
  lastValidSeenAtMs: null,
  latchedGesture: null,
  lastTriggeredAction: null,
  lastTriggeredAtMs: null,
  dwellProgress: 0,
  handScale: 0,
  tooFar: false,
});

/**
 * Pure frame processor handling proximity filtering, 4 FPS <-> 24 FPS wake/standby transitions,
 * Dwell Time stabilization, discrete pose latching, 1.2s safe SKIP hold, and directional auto-repeat.
 */
export const evaluateGestureFrame = (
  prevState: GestureEngineState,
  input: GestureFrameInput,
  settings: GestureSettings = DEFAULT_GESTURE_SETTINGS,
): GestureFrameOutput => {
  const now = input.timestampMs;
  const handScale = computeHandBoundingScale(input.landmarks);
  const hasHand = handScale > 0;
  const tooFar = hasHand && handScale < settings.minHandScale;
  const isCloseEnough = hasHand && !tooFar;

  let powerMode: GesturePowerMode = prevState.powerMode;
  let activeUntilMs = prevState.activeUntilMs;

  if (powerMode === 'active' && activeUntilMs !== null && now > activeUntilMs) {
    powerMode = 'standby';
    activeUntilMs = null;
  }

  // ---- STANDBY MODE (4 FPS low-power polling until Wake Gesture held close to screen) ----
  if (powerMode === 'standby') {
    const isWakeCandidate =
      isCloseEnough &&
      input.confidence >= settings.minConfidence &&
      input.gestureName !== null &&
      WAKE_GESTURES.has(input.gestureName);

    if (!isWakeCandidate) {
      const nextStandby: GestureEngineState = {
        ...createInitialGestureEngineState(),
        handScale,
        tooFar,
      };
      return {
        nextState: nextStandby,
        triggeredAction: null,
        pendingAction: null,
        powerMode: 'standby',
        wakeProgress: 0,
        dwellProgress: 0,
        tooFar,
        handScale,
        recommendedIntervalMs: STANDBY_INTERVAL_MS,
        justWokeUp: false,
      };
    }

    const wakeStarted = prevState.wakeStartedAtMs ?? now;
    const elapsedWake = Math.max(0, now - wakeStarted);
    const wakeProgress =
      settings.wakeHoldMs <= 0
        ? 100
        : Math.min(100, Math.round((elapsedWake / settings.wakeHoldMs) * 100));

    if (elapsedWake < settings.wakeHoldMs) {
      const wakingState: GestureEngineState = {
        ...createInitialGestureEngineState(),
        wakeStartedAtMs: wakeStarted,
        wakeProgress,
        handScale,
        tooFar: false,
      };
      return {
        nextState: wakingState,
        triggeredAction: null,
        pendingAction: null,
        powerMode: 'standby',
        wakeProgress,
        dwellProgress: 0,
        tooFar: false,
        handScale,
        recommendedIntervalMs: ACTIVE_INTERVAL_MS,
        justWokeUp: false,
      };
    }

    // Woke up! Latch the wake gesture so the user releases/changes pose before triggering an action.
    const awakeState: GestureEngineState = {
      ...createInitialGestureEngineState(),
      powerMode: 'active',
      activeUntilMs: now + settings.activeWindowMs,
      latchedGesture: input.gestureName,
      handScale,
      tooFar: false,
    };

    return {
      nextState: awakeState,
      triggeredAction: null,
      pendingAction: null,
      powerMode: 'active',
      wakeProgress: 100,
      dwellProgress: 0,
      tooFar: false,
      handScale,
      recommendedIntervalMs: ACTIVE_INTERVAL_MS,
      justWokeUp: true,
    };
  }

  // ---- ACTIVE MODE (~24 FPS contextual control) ----
  const validGesture =
    isCloseEnough && input.confidence >= settings.minConfidence ? input.gestureName : null;
  const mappedAction = mapContextualGesture(validGesture, input.context);

  const isDiscreteCooldown =
    prevState.lastTriggeredAtMs !== null &&
    prevState.lastTriggeredAction !== null &&
    !REPEATABLE_ACTIONS.has(prevState.lastTriggeredAction) &&
    now - prevState.lastTriggeredAtMs < settings.cooldownMs;

  if (mappedAction === null || validGesture === null) {
    const withinGrace =
      prevState.candidateAction !== null &&
      prevState.lastValidSeenAtMs !== null &&
      now - prevState.lastValidSeenAtMs <= settings.graceMs;

    if (withinGrace) {
      const gracedState: GestureEngineState = {
        ...prevState,
        powerMode: 'active',
        activeUntilMs,
        handScale,
        tooFar,
      };
      return {
        nextState: gracedState,
        triggeredAction: null,
        pendingAction: prevState.candidateAction,
        powerMode: 'active',
        wakeProgress: 100,
        dwellProgress: prevState.dwellProgress,
        tooFar,
        handScale,
        recommendedIntervalMs: ACTIVE_INTERVAL_MS,
        justWokeUp: false,
      };
    }

    const clearedActive: GestureEngineState = {
      ...prevState,
      powerMode: 'active',
      activeUntilMs,
      candidateAction: null,
      candidateGesture: null,
      candidateStartedAtMs: null,
      lastValidSeenAtMs: null,
      latchedGesture: null,
      dwellProgress: 0,
      handScale,
      tooFar,
    };

    return {
      nextState: clearedActive,
      triggeredAction: null,
      pendingAction: null,
      powerMode: 'active',
      wakeProgress: 100,
      dwellProgress: 0,
      tooFar,
      handScale,
      recommendedIntervalMs: ACTIVE_INTERVAL_MS,
      justWokeUp: false,
    };
  }

  // Refresh active window whenever a close-enough valid hand pose is tracked
  const refreshedUntil = now + settings.activeWindowMs;

  // If still holding the exact gesture that woke up or fired a discrete action, keep latched
  if (prevState.latchedGesture === validGesture && !REPEATABLE_ACTIONS.has(mappedAction)) {
    const stillLatched: GestureEngineState = {
      ...prevState,
      powerMode: 'active',
      activeUntilMs: refreshedUntil,
      lastValidSeenAtMs: now,
      handScale,
      tooFar: false,
    };
    return {
      nextState: stillLatched,
      triggeredAction: null,
      pendingAction: null,
      powerMode: 'active',
      wakeProgress: 100,
      dwellProgress: 100,
      tooFar: false,
      handScale,
      recommendedIntervalMs: ACTIVE_INTERVAL_MS,
      justWokeUp: false,
    };
  }

  if (prevState.candidateAction !== mappedAction || prevState.candidateGesture !== validGesture) {
    const nextCandidateState: GestureEngineState = {
      ...prevState,
      powerMode: 'active',
      activeUntilMs: refreshedUntil,
      candidateAction: mappedAction,
      candidateGesture: validGesture,
      candidateStartedAtMs: now,
      lastValidSeenAtMs: now,
      latchedGesture: null,
      dwellProgress: 0,
      handScale,
      tooFar: false,
    };

    return {
      nextState: nextCandidateState,
      triggeredAction: null,
      pendingAction: mappedAction,
      powerMode: 'active',
      wakeProgress: 100,
      dwellProgress: 0,
      tooFar: false,
      handScale,
      recommendedIntervalMs: ACTIVE_INTERVAL_MS,
      justWokeUp: false,
    };
  }

  const requiredHoldMs = mappedAction === 'SKIP' ? settings.skipHoldMs : settings.dwellMs;
  const startedAt = prevState.candidateStartedAtMs ?? now;
  const elapsed = Math.max(0, now - startedAt);
  const dwellProgress =
    requiredHoldMs <= 0 ? 100 : Math.min(100, Math.round((elapsed / requiredHoldMs) * 100));

  if (elapsed < requiredHoldMs) {
    const holdingState: GestureEngineState = {
      ...prevState,
      powerMode: 'active',
      activeUntilMs: refreshedUntil,
      candidateStartedAtMs: startedAt,
      lastValidSeenAtMs: now,
      dwellProgress,
      handScale,
      tooFar: false,
    };
    return {
      nextState: holdingState,
      triggeredAction: null,
      pendingAction: mappedAction,
      powerMode: 'active',
      wakeProgress: 100,
      dwellProgress,
      tooFar: false,
      handScale,
      recommendedIntervalMs: ACTIVE_INTERVAL_MS,
      justWokeUp: false,
    };
  }

  if (!REPEATABLE_ACTIONS.has(mappedAction)) {
    if (isDiscreteCooldown) {
      const coolingState: GestureEngineState = {
        ...prevState,
        powerMode: 'active',
        activeUntilMs: refreshedUntil,
        lastValidSeenAtMs: now,
        dwellProgress: 100,
        handScale,
        tooFar: false,
      };
      return {
        nextState: coolingState,
        triggeredAction: null,
        pendingAction: mappedAction,
        powerMode: 'active',
        wakeProgress: 100,
        dwellProgress: 100,
        tooFar: false,
        handScale,
        recommendedIntervalMs: ACTIVE_INTERVAL_MS,
        justWokeUp: false,
      };
    }

    const firedDiscrete: GestureEngineState = {
      ...prevState,
      powerMode: 'active',
      activeUntilMs: refreshedUntil,
      candidateStartedAtMs: startedAt,
      lastValidSeenAtMs: now,
      latchedGesture: validGesture,
      lastTriggeredAction: mappedAction,
      lastTriggeredAtMs: now,
      dwellProgress: 100,
      handScale,
      tooFar: false,
    };

    return {
      nextState: firedDiscrete,
      triggeredAction: mappedAction,
      pendingAction: mappedAction,
      powerMode: 'active',
      wakeProgress: 100,
      dwellProgress: 100,
      tooFar: false,
      handScale,
      recommendedIntervalMs: ACTIVE_INTERVAL_MS,
      justWokeUp: false,
    };
  }

  const canRepeat =
    prevState.lastTriggeredAction !== mappedAction ||
    prevState.lastTriggeredAtMs === null ||
    now - prevState.lastTriggeredAtMs >= settings.repeatIntervalMs;

  if (!canRepeat) {
    const waitingRepeat: GestureEngineState = {
      ...prevState,
      powerMode: 'active',
      activeUntilMs: refreshedUntil,
      lastValidSeenAtMs: now,
      dwellProgress: 100,
      handScale,
      tooFar: false,
    };
    return {
      nextState: waitingRepeat,
      triggeredAction: null,
      pendingAction: mappedAction,
      powerMode: 'active',
      wakeProgress: 100,
      dwellProgress: 100,
      tooFar: false,
      handScale,
      recommendedIntervalMs: ACTIVE_INTERVAL_MS,
      justWokeUp: false,
    };
  }

  const firedRepeat: GestureEngineState = {
    ...prevState,
    powerMode: 'active',
    activeUntilMs: refreshedUntil,
    candidateStartedAtMs: startedAt,
    lastValidSeenAtMs: now,
    latchedGesture: null,
    lastTriggeredAction: mappedAction,
    lastTriggeredAtMs: now,
    dwellProgress: 100,
    handScale,
    tooFar: false,
  };

  return {
    nextState: firedRepeat,
    triggeredAction: mappedAction,
    pendingAction: mappedAction,
    powerMode: 'active',
    wakeProgress: 100,
    dwellProgress: 100,
    tooFar: false,
    handScale,
    recommendedIntervalMs: ACTIVE_INTERVAL_MS,
    justWokeUp: false,
  };
};

/** Draws the 21 hand landmarks on a canvas for privacy-first HUD visualization. */
export const drawHandSkeleton = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  landmarks: ReadonlyArray<Point2D> | null,
  tooFar = false,
): void => {
  ctx.clearRect(0, 0, width, height);
  if (!landmarks || landmarks.length < 21) return;

  ctx.strokeStyle = tooFar ? 'rgba(251, 191, 36, 0.7)' : 'rgba(168, 85, 247, 0.9)';
  ctx.lineWidth = 2.2;

  for (const [a, b] of HAND_CONNECTIONS) {
    const start = landmarks[a];
    const end = landmarks[b];
    if (!start || !end) continue;
    ctx.beginPath();
    ctx.moveTo(start.x * width, start.y * height);
    ctx.lineTo(end.x * width, end.y * height);
    ctx.stroke();
  }

  landmarks.forEach((pt, idx) => {
    const isTip = FINGERTIP_INDICES.has(idx);
    ctx.beginPath();
    ctx.arc(pt.x * width, pt.y * height, isTip ? 4.2 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle = tooFar
      ? 'rgba(253, 224, 71, 0.9)'
      : isTip
        ? 'rgba(56, 189, 248, 0.95)'
        : 'rgba(255, 255, 255, 0.95)';
    ctx.fill();
  });
};
