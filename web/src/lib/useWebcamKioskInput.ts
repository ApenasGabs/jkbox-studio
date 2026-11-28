import type { GestureRecognizer } from '@mediapipe/tasks-vision';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  ACTIVE_INTERVAL_MS,
  createInitialGestureEngineState,
  drawHandSkeleton,
  evaluateGestureFrame,
  GESTURE_RESOLUTION_PRESETS,
  type GestureAction,
  type GestureContextMode,
  type GestureEngineState,
  type GestureFrameOutput,
  type GesturePowerMode,
  type GestureSettings,
  type Point2D,
  STANDBY_INTERVAL_MS,
} from './gestureEngine';

const LOCAL_WASM_PATH = '/mediapipe/wasm';
const LOCAL_MODEL_PATH = '/mediapipe/gesture_recognizer.task';
const TRANSIENT_ERROR_THRESHOLD = 5;
const WEBGL_ERROR_PATTERN = /webgl|activetexture|glctx|teximage|bindtexture|opengl|context/i;

export type WebcamGestureStatus = 'off' | 'loading' | 'ready' | 'error';

export interface UseWebcamKioskInputOptions {
  settings: GestureSettings;
  context: GestureContextMode;
  onAction: (action: GestureAction) => void;
}

export interface WebcamKioskInputSnapshot {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  status: WebcamGestureStatus;
  error: string | null;
  powerMode: GesturePowerMode;
  wakeProgress: number;
  dwellProgress: number;
  pendingAction: GestureAction | null;
  tooFar: boolean;
  fps: number;
  delegate: 'GPU' | 'CPU' | null;
}

export interface VisionModuleApi {
  FilesetResolver: {
    forVisionTasks: (wasmFilesPath: string) => Promise<unknown>;
  };
  GestureRecognizer: {
    createFromOptions: (
      vision: unknown,
      options: {
        baseOptions: { modelAssetPath: string; delegate: 'GPU' | 'CPU' };
        runningMode: 'VIDEO';
        numHands: number;
      },
    ) => Promise<GestureRecognizer>;
  };
}

export interface CreateRecognizerOptions {
  forceCpu?: boolean;
  checkWebGL2?: () => boolean;
  loadVisionModule?: () => Promise<VisionModuleApi>;
}

export interface CpuFrameCaptureState {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
}

export interface GestureFrameRunnerDeps {
  getVideo: () => HTMLVideoElement | null;
  getHudCanvas: () => HTMLCanvasElement | null;
  getRecognizer: () => GestureRecognizer | null;
  setRecognizer: (recognizer: GestureRecognizer | null) => void;
  getDelegate: () => 'GPU' | 'CPU' | null;
  setDelegate: (delegate: 'GPU' | 'CPU') => void;
  getEngineState: () => GestureEngineState;
  setEngineState: (state: GestureEngineState) => void;
  getSettings: () => GestureSettings;
  getContextMode: () => GestureContextMode;
  onOutput: (output: GestureFrameOutput) => void;
  onFps: (fps: number) => void;
  onRecover?: () => void;
  onTransientError?: (message: string) => void;
  onFatalError: (message: string) => void;
  recreateCpuRecognizer: () => Promise<{ recognizer: GestureRecognizer; delegate: 'GPU' | 'CPU' }>;
  scheduleNext: (delayMs: number, fn: () => void) => void;
  isCancelled: () => boolean;
  now?: () => number;
}

/** Checks whether the browser provides a usable WebGL2 context with activeTexture support. */
export const hasWorkingWebGL2 = (): boolean => {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') {
      return false;
    }
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl || typeof gl.activeTexture !== 'function') {
      return false;
    }
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

/** Detects WebGL / GLctx / activeTexture runtime failures that require CPU fallback. */
export const isWebGLError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return WEBGL_ERROR_PATTERN.test(message);
};

const defaultLoadVisionModule = (): Promise<VisionModuleApi> =>
  import('@mediapipe/tasks-vision') as unknown as Promise<VisionModuleApi>;

const buildGestureRecognizer = async (
  visionApi: VisionModuleApi,
  delegate: 'GPU' | 'CPU',
): Promise<GestureRecognizer> => {
  // Always request a fresh FilesetResolver per delegate attempt so a failed GPU init
  // never leaves a broken GLctx WASM state for the CPU fallback.
  const vision = await visionApi.FilesetResolver.forVisionTasks(LOCAL_WASM_PATH);
  return visionApi.GestureRecognizer.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: LOCAL_MODEL_PATH,
      delegate,
    },
    runningMode: 'VIDEO',
    numHands: 1,
  });
};

/**
 * Instantiates MediaPipe GestureRecognizer from local WASM/model assets, pre-checking
 * WebGL2 and creating a clean WASM FilesetResolver instance for CPU fallback.
 */
export const createOfflineGestureRecognizer = async (
  options: CreateRecognizerOptions = {},
): Promise<{
  recognizer: GestureRecognizer;
  delegate: 'GPU' | 'CPU';
}> => {
  const loadVision = options.loadVisionModule ?? defaultLoadVisionModule;
  const checkWebGL2 = options.checkWebGL2 ?? hasWorkingWebGL2;
  const visionApi = await loadVision();

  if (!options.forceCpu && checkWebGL2()) {
    try {
      const gpu = await buildGestureRecognizer(visionApi, 'GPU');
      return { recognizer: gpu, delegate: 'GPU' };
    } catch {
      // Fall through to a brand-new CPU FilesetResolver instance.
    }
  }

  const cpu = await buildGestureRecognizer(visionApi, 'CPU');
  return { recognizer: cpu, delegate: 'CPU' };
};

/** Computes bounded 2D capture dimensions preserving aspect ratio within the configured preset. */
export const resolveCpuCaptureDimensions = (
  video: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'>,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } => {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || vw <= 0 || vh <= 0) {
    return { width: maxWidth, height: maxHeight };
  }
  const scale = Math.min(1, maxWidth / vw, maxHeight / vh);
  return {
    width: Math.max(1, Math.round(vw * scale)),
    height: Math.max(1, Math.round(vh * scale)),
  };
};

/** Captures a video frame as ImageData via a 2D canvas so CPU inference never touches WebGL textures. */
export const captureVideoFrameImageData = (
  state: CpuFrameCaptureState,
  video: HTMLVideoElement,
  maxWidth: number,
  maxHeight: number,
): ImageData => {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Ambiente sem DOM para captura 2D em CPU.');
  }
  if (!state.canvas) {
    state.canvas = document.createElement('canvas');
    state.ctx = state.canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!state.ctx) {
    throw new Error('Contexto 2D indisponível para fallback de gestos em CPU.');
  }
  const { width, height } = resolveCpuCaptureDimensions(video, maxWidth, maxHeight);
  if (state.canvas.width !== width || state.canvas.height !== height) {
    state.canvas.width = width;
    state.canvas.height = height;
  }
  state.ctx.drawImage(video, 0, 0, width, height);
  return state.ctx.getImageData(0, 0, width, height);
};

/**
 * Runs the guarded frame inference loop, automatically downgrading GPU -> CPU (ImageData)
 * on WebGL/activeTexture failures and keeping the loop resilient against frame errors.
 */
export const createGestureFrameRunner = (deps: GestureFrameRunnerDeps) => {
  let lastVideoTime = -1;
  let hasSuccessfulGpuFrame = false;
  let consecutiveErrors = 0;
  let isDowngrading = false;
  let frameCount = 0;
  const getNow = deps.now ?? (() => performance.now());
  let fpsWindowStart = getNow();
  const cpuCapture: CpuFrameCaptureState = { canvas: null, ctx: null };

  const renderHudSkeleton = (
    video: HTMLVideoElement,
    landmarks: ReadonlyArray<Point2D> | null,
    output: GestureFrameOutput,
    preset: { width: number; height: number },
  ) => {
    const canvas = deps.getHudCanvas();
    const settings = deps.getSettings();
    if (!canvas || settings.hudMode === 'compact') return;

    const targetW = video.videoWidth || preset.width;
    const targetH = video.videoHeight || preset.height;
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (output.powerMode === 'active' || output.wakeProgress > 0 || output.tooFar) {
      drawHandSkeleton(ctx, canvas.width, canvas.height, landmarks, output.tooFar);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const downgradeToCpu = async () => {
    isDowngrading = true;
    const broken = deps.getRecognizer();
    deps.setRecognizer(null);
    if (broken) {
      try {
        broken.close();
      } catch {
        // Ignore cleanup errors from broken WebGL contexts.
      }
    }
    lastVideoTime = -1;

    try {
      const created = await deps.recreateCpuRecognizer();
      if (deps.isCancelled()) {
        try {
          created.recognizer.close();
        } catch {
          // Ignore close during teardown.
        }
        return;
      }
      deps.setRecognizer(created.recognizer);
      deps.setDelegate('CPU');
      consecutiveErrors = 0;
      deps.onRecover?.();
      deps.scheduleNext(0, tick);
    } catch {
      if (deps.isCancelled()) return;
      deps.onFatalError('Não foi possível alternar o sensor de gestos para o modo CPU.');
    } finally {
      isDowngrading = false;
    }
  };

  const tick = () => {
    if (deps.isCancelled() || isDowngrading) return;

    const video = deps.getVideo();
    const recognizer = deps.getRecognizer();
    const settings = deps.getSettings();
    const preset = GESTURE_RESOLUTION_PRESETS[settings.resolution] ?? GESTURE_RESOLUTION_PRESETS['240p'];
    let nextInterval =
      deps.getEngineState().powerMode === 'active' ? ACTIVE_INTERVAL_MS : STANDBY_INTERVAL_MS;

    if (video && recognizer && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      try {
        const now = getNow();
        const activeDelegate = deps.getDelegate();
        const frameInput: TexImageSource =
          activeDelegate === 'CPU'
            ? captureVideoFrameImageData(cpuCapture, video, preset.width, preset.height)
            : video;

        const result = recognizer.recognizeForVideo(frameInput, now);
        lastVideoTime = video.currentTime;
        if (activeDelegate === 'GPU') {
          hasSuccessfulGpuFrame = true;
        }
        if (consecutiveErrors > 0) {
          consecutiveErrors = 0;
          deps.onRecover?.();
        }

        const topGesture = result.gestures[0]?.[0];
        const landmarks = result.landmarks[0] ?? null;

        const output = evaluateGestureFrame(
          deps.getEngineState(),
          {
            gestureName: topGesture?.categoryName ?? null,
            confidence: topGesture?.score ?? 0,
            landmarks,
            timestampMs: now,
            context: deps.getContextMode(),
          },
          settings,
        );

        deps.setEngineState(output.nextState);
        nextInterval = output.recommendedIntervalMs;
        deps.onOutput(output);
        renderHudSkeleton(video, landmarks, output, preset);

        frameCount += 1;
        const elapsedWindow = now - fpsWindowStart;
        if (elapsedWindow >= 1000) {
          deps.onFps(Math.round((frameCount * 1000) / elapsedWindow));
          frameCount = 0;
          fpsWindowStart = now;
        }
      } catch (err) {
        if (deps.getDelegate() === 'GPU' && (isWebGLError(err) || !hasSuccessfulGpuFrame)) {
          void downgradeToCpu();
          return;
        }
        consecutiveErrors += 1;
        if (consecutiveErrors >= TRANSIENT_ERROR_THRESHOLD) {
          deps.onTransientError?.(
            'Falha temporária ao processar vídeo da câmera para gestos. Tentando recuperar…',
          );
        }
      }
    }

    deps.scheduleNext(nextInterval, tick);
  };

  return { tick };
};

/**
 * Opt-in 100% offline webcam gesture hook for the Kiosk screen.
 * Operates at 4 FPS in standby and ramps up to ~24 FPS for 15s upon wake gesture.
 */
export const useWebcamKioskInput = ({
  settings,
  context,
  onAction,
}: UseWebcamKioskInputOptions): WebcamKioskInputSnapshot => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognizerRef = useRef<GestureRecognizer | null>(null);
  const delegateRef = useRef<'GPU' | 'CPU' | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const engineStateRef = useRef(createInitialGestureEngineState());
  const settingsRef = useRef(settings);
  const contextRef = useRef(context);
  const onActionRef = useRef(onAction);

  settingsRef.current = settings;
  contextRef.current = context;
  onActionRef.current = onAction;

  const [status, setStatus] = useState<WebcamGestureStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [powerMode, setPowerMode] = useState<GesturePowerMode>('standby');
  const [wakeProgress, setWakeProgress] = useState(0);
  const [dwellProgress, setDwellProgress] = useState(0);
  const [pendingAction, setPendingAction] = useState<GestureAction | null>(null);
  const [tooFar, setTooFar] = useState(false);
  const [fps, setFps] = useState(0);
  const [delegate, setDelegate] = useState<'GPU' | 'CPU' | null>(null);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const stopCapture = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    clearCanvas();
  }, [clearCanvas]);

  useEffect(() => {
    if (!settings.enabled) {
      stopCapture();
      engineStateRef.current = createInitialGestureEngineState();
      setStatus('off');
      setError(null);
      setPowerMode('standby');
      setWakeProgress(0);
      setDwellProgress(0);
      setPendingAction(null);
      setTooFar(false);
      setFps(0);
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus('error');
      setError('Navegador sem suporte a getUserMedia (use localhost ou HTTPS).');
      return;
    }

    let cancelled = false;

    const start = async () => {
      setStatus('loading');
      setError(null);
      stopCapture();

      try {
        if (!recognizerRef.current) {
          const created = await createOfflineGestureRecognizer();
          if (cancelled) {
            created.recognizer.close();
            return;
          }
          recognizerRef.current = created.recognizer;
          delegateRef.current = created.delegate;
          setDelegate(created.delegate);
        }

        const preset = GESTURE_RESOLUTION_PRESETS[settings.resolution] ?? GESTURE_RESOLUTION_PRESETS['240p'];
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: preset.width },
            height: { ideal: preset.height },
            frameRate: { ideal: 24, max: 30 },
            facingMode: 'user',
          },
          audio: false,
        });

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          try {
            await video.play();
          } catch (playErr) {
            if (playErr instanceof Error && playErr.name !== 'AbortError') {
              throw playErr;
            }
          }
        }

        engineStateRef.current = createInitialGestureEngineState();
        setStatus('ready');

        const runner = createGestureFrameRunner({
          getVideo: () => videoRef.current,
          getHudCanvas: () => canvasRef.current,
          getRecognizer: () => recognizerRef.current,
          setRecognizer: (next) => {
            recognizerRef.current = next;
          },
          getDelegate: () => delegateRef.current,
          setDelegate: (next) => {
            delegateRef.current = next;
            setDelegate(next);
          },
          getEngineState: () => engineStateRef.current,
          setEngineState: (next) => {
            engineStateRef.current = next;
          },
          getSettings: () => settingsRef.current,
          getContextMode: () => contextRef.current,
          onOutput: (output) => {
            setPowerMode(output.powerMode);
            setWakeProgress(output.wakeProgress);
            setDwellProgress(output.dwellProgress);
            setPendingAction(output.pendingAction);
            setTooFar(output.tooFar);
            if (output.triggeredAction !== null) {
              onActionRef.current(output.triggeredAction);
            }
          },
          onFps: setFps,
          onRecover: () => {
            setError(null);
            setStatus('ready');
          },
          onTransientError: (message) => {
            setStatus('error');
            setError(message);
          },
          onFatalError: (message) => {
            stopCapture();
            setStatus('error');
            setError(message);
          },
          recreateCpuRecognizer: () => createOfflineGestureRecognizer({ forceCpu: true }),
          scheduleNext: (delayMs, fn) => {
            timerRef.current = window.setTimeout(fn, delayMs);
          },
          isCancelled: () => cancelled,
        });

        runner.tick();
      } catch (err) {
        if (cancelled) return;
        stopCapture();
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Falha ao acessar webcam ou modelo offline.');
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopCapture();
    };
  }, [settings.enabled, settings.resolution, stopCapture]);

  useEffect(() => {
    return () => {
      stopCapture();
      if (recognizerRef.current) {
        recognizerRef.current.close();
        recognizerRef.current = null;
      }
      delegateRef.current = null;
    };
  }, [stopCapture]);

  return {
    videoRef,
    canvasRef,
    status,
    error,
    powerMode,
    wakeProgress,
    dwellProgress,
    pendingAction,
    tooFar,
    fps,
    delegate,
  };
};
