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
  type GesturePowerMode,
  type GestureSettings,
  STANDBY_INTERVAL_MS,
} from './gestureEngine';

const LOCAL_WASM_PATH = '/mediapipe/wasm';
const LOCAL_MODEL_PATH = '/mediapipe/gesture_recognizer.task';

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

const createOfflineGestureRecognizer = async (): Promise<{
  recognizer: GestureRecognizer;
  delegate: 'GPU' | 'CPU';
}> => {
  const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision');
  const vision = await FilesetResolver.forVisionTasks(LOCAL_WASM_PATH);
  try {
    const gpu = await GestureRecognizer.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: LOCAL_MODEL_PATH,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
    });
    return { recognizer: gpu, delegate: 'GPU' };
  } catch {
    const cpu = await GestureRecognizer.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: LOCAL_MODEL_PATH,
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
    });
    return { recognizer: cpu, delegate: 'CPU' };
  }
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
    let lastVideoTime = -1;
    let frameCount = 0;
    let fpsWindowStart = performance.now();

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

        const tick = () => {
          if (cancelled) return;
          const v = videoRef.current;
          const recognizer = recognizerRef.current;
          let nextInterval =
            engineStateRef.current.powerMode === 'active' ? ACTIVE_INTERVAL_MS : STANDBY_INTERVAL_MS;

          if (v && recognizer && v.readyState >= 2 && v.currentTime !== lastVideoTime) {
            lastVideoTime = v.currentTime;
            const now = performance.now();
            const result = recognizer.recognizeForVideo(v, now);
            const topGesture = result.gestures[0]?.[0];
            const landmarks = result.landmarks[0] ?? null;

            const output = evaluateGestureFrame(
              engineStateRef.current,
              {
                gestureName: topGesture?.categoryName ?? null,
                confidence: topGesture?.score ?? 0,
                landmarks,
                timestampMs: now,
                context: contextRef.current,
              },
              settingsRef.current,
            );

            engineStateRef.current = output.nextState;
            nextInterval = output.recommendedIntervalMs;

            setPowerMode(output.powerMode);
            setWakeProgress(output.wakeProgress);
            setDwellProgress(output.dwellProgress);
            setPendingAction(output.pendingAction);
            setTooFar(output.tooFar);

            if (output.triggeredAction !== null) {
              onActionRef.current(output.triggeredAction);
            }

            const canvas = canvasRef.current;
            if (canvas && settingsRef.current.hudMode !== 'compact') {
              const targetW = v.videoWidth || preset.width;
              const targetH = v.videoHeight || preset.height;
              if (canvas.width !== targetW || canvas.height !== targetH) {
                canvas.width = targetW;
                canvas.height = targetH;
              }
              const ctx = canvas.getContext('2d');
              if (ctx) {
                if (output.powerMode === 'active' || output.wakeProgress > 0 || output.tooFar) {
                  drawHandSkeleton(ctx, canvas.width, canvas.height, landmarks, output.tooFar);
                } else {
                  ctx.clearRect(0, 0, canvas.width, canvas.height);
                }
              }
            }

            frameCount += 1;
            const elapsedWindow = now - fpsWindowStart;
            if (elapsedWindow >= 1000) {
              setFps(Math.round((frameCount * 1000) / elapsedWindow));
              frameCount = 0;
              fpsWindowStart = now;
            }
          }

          timerRef.current = window.setTimeout(tick, nextInterval);
        };

        tick();
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
