import type { GestureRecognizer, GestureRecognizerResult } from '@mediapipe/tasks-vision';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialGestureEngineState, DEFAULT_GESTURE_SETTINGS } from './gestureEngine';
import {
  captureVideoFrameImageData,
  createGestureFrameRunner,
  createOfflineGestureRecognizer,
  hasWorkingWebGL2,
  isWebGLError,
  type VisionModuleApi,
} from './useWebcamKioskInput';

afterEach(() => {
  vi.unstubAllGlobals();
});

const emptyResult = (): GestureRecognizerResult => ({
  gestures: [],
  landmarks: [],
  worldLandmarks: [],
  handednesses: [],
  handedness: [],
});

const makeFakeImageData = (width: number, height: number): ImageData =>
  ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    colorSpace: 'srgb',
  }) as unknown as ImageData;

const stubCanvasDocument = (options: {
  webgl2?: unknown;
  drawSpy?: ReturnType<typeof vi.fn>;
  getImageDataSpy?: ReturnType<typeof vi.fn>;
  getContext2dOptionsSpy?: (opts?: unknown) => void;
}) => {
  const drawImage = options.drawSpy ?? vi.fn();
  const getImageData =
    options.getImageDataSpy ?? vi.fn((_x: number, _y: number, w: number, h: number) => makeFakeImageData(w, h));
  const ctx2d = {
    drawImage,
    getImageData,
    clearRect: vi.fn(),
  };

  vi.stubGlobal('document', {
    createElement: vi.fn((tag: string) => {
      if (tag !== 'canvas') return {};
      const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn((kind: string, opts?: unknown) => {
          if (kind === 'webgl2') {
            return options.webgl2 ?? null;
          }
          if (kind === '2d') {
            options.getContext2dOptionsSpy?.(opts);
            return ctx2d;
          }
          return null;
        }),
      };
      return canvas;
    }),
  });

  return { drawImage, getImageData, ctx2d };
};

describe('useWebcamKioskInput — WebGL2 pre-check & CPU ImageData fallback', () => {
  it('returns false in hasWorkingWebGL2 when getContext("webgl2") returns null or lacks activeTexture', () => {
    stubCanvasDocument({ webgl2: null });
    expect(hasWorkingWebGL2()).toBe(false);

    stubCanvasDocument({ webgl2: {} });
    expect(hasWorkingWebGL2()).toBe(false);

    stubCanvasDocument({
      webgl2: {
        activeTexture: vi.fn(),
        isContextLost: () => true,
      },
    });
    expect(hasWorkingWebGL2()).toBe(false);

    stubCanvasDocument({
      webgl2: {
        activeTexture: vi.fn(),
        isContextLost: () => false,
      },
    });
    expect(hasWorkingWebGL2()).toBe(true);
  });

  it('skips GPU creation completely when getContext("webgl2") returns null and instantiates CPU directly', async () => {
    stubCanvasDocument({ webgl2: null });

    const fakeCpuRecognizer = { recognizeForVideo: vi.fn(), close: vi.fn() } as unknown as GestureRecognizer;
    const forVisionTasks = vi.fn(async () => ({ id: 'clean-cpu-vision' }));
    const createFromOptions = vi.fn(async () => fakeCpuRecognizer);
    const visionModule: VisionModuleApi = {
      FilesetResolver: { forVisionTasks },
      GestureRecognizer: { createFromOptions },
    };

    const created = await createOfflineGestureRecognizer({
      loadVisionModule: async () => visionModule,
    });

    expect(created.delegate).toBe('CPU');
    expect(created.recognizer).toBe(fakeCpuRecognizer);
    expect(forVisionTasks).toHaveBeenCalledTimes(1);
    expect(createFromOptions).toHaveBeenCalledTimes(1);
    expect(createFromOptions).toHaveBeenCalledWith(
      { id: 'clean-cpu-vision' },
      expect.objectContaining({
        baseOptions: expect.objectContaining({ delegate: 'CPU' }),
      }),
    );
  });

  it('creates a brand-new FilesetResolver WASM instance for CPU when GPU initialization throws activeTexture error', async () => {
    stubCanvasDocument({
      webgl2: { activeTexture: vi.fn(), isContextLost: () => false },
    });

    const gpuVision = { wasmInstance: 'corrupted-gpu-glctx' };
    const cpuVision = { wasmInstance: 'fresh-cpu-wasm' };
    const fakeCpuRecognizer = { recognizeForVideo: vi.fn(), close: vi.fn() } as unknown as GestureRecognizer;

    const forVisionTasks = vi
      .fn<VisionModuleApi['FilesetResolver']['forVisionTasks']>()
      .mockResolvedValueOnce(gpuVision)
      .mockResolvedValueOnce(cpuVision);

    const createFromOptions = vi
      .fn<VisionModuleApi['GestureRecognizer']['createFromOptions']>()
      .mockImplementationOnce(async (vision, opts) => {
        expect(vision).toBe(gpuVision);
        expect(opts.baseOptions.delegate).toBe('GPU');
        throw new TypeError("Cannot read properties of undefined (reading 'activeTexture')");
      })
      .mockImplementationOnce(async (vision, opts) => {
        expect(vision).toBe(cpuVision);
        expect(vision).not.toBe(gpuVision);
        expect(opts.baseOptions.delegate).toBe('CPU');
        return fakeCpuRecognizer;
      });

    const created = await createOfflineGestureRecognizer({
      loadVisionModule: async () => ({
        FilesetResolver: { forVisionTasks },
        GestureRecognizer: { createFromOptions },
      }),
    });

    expect(created.delegate).toBe('CPU');
    expect(created.recognizer).toBe(fakeCpuRecognizer);
    expect(forVisionTasks).toHaveBeenCalledTimes(2);
    expect(createFromOptions).toHaveBeenCalledTimes(2);
  });

  it('captures frames via 2D canvas with willReadFrequently and passes ImageData when in CPU mode', () => {
    const getContext2dOptionsSpy = vi.fn();
    const { drawImage, getImageData } = stubCanvasDocument({ getContext2dOptionsSpy });

    const video = {
      videoWidth: 640,
      videoHeight: 480,
    } as unknown as HTMLVideoElement;

    const captureState = { canvas: null, ctx: null };
    const img = captureVideoFrameImageData(captureState, video, 320, 240);

    expect(getContext2dOptionsSpy).toHaveBeenCalledWith({ willReadFrequently: true });
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 240);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 320, 240);
    expect(img.width).toBe(320);
    expect(img.height).toBe(240);
  });

  it('automatically downgrades from GPU to CPU (ImageData) without crashing when 1st recognizeForVideo throws activeTexture', async () => {
    const { drawImage, getImageData } = stubCanvasDocument({
      webgl2: { activeTexture: vi.fn(), isContextLost: () => false },
    });

    const gpuRecognize = vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'activeTexture')");
    });
    const gpuClose = vi.fn();
    const cpuRecognize = vi.fn((_input: TexImageSource, _now: number) => emptyResult());
    const cpuClose = vi.fn();

    const gpuRecognizer = {
      recognizeForVideo: gpuRecognize,
      close: gpuClose,
    } as unknown as GestureRecognizer;

    const cpuRecognizer = {
      recognizeForVideo: cpuRecognize,
      close: cpuClose,
    } as unknown as GestureRecognizer;

    let activeRecognizer: GestureRecognizer | null = gpuRecognizer;
    let activeDelegate: 'GPU' | 'CPU' | null = 'GPU';
    let engineState = createInitialGestureEngineState();
    const scheduled: Array<{ delayMs: number; fn: () => void }> = [];
    const fatalErrors: string[] = [];
    const transientErrors: string[] = [];

    const video = {
      readyState: 4,
      currentTime: 1.5,
      videoWidth: 320,
      videoHeight: 240,
    } as unknown as HTMLVideoElement;

    const runner = createGestureFrameRunner({
      getVideo: () => video,
      getHudCanvas: () => null,
      getRecognizer: () => activeRecognizer,
      setRecognizer: (next) => {
        activeRecognizer = next;
      },
      getDelegate: () => activeDelegate,
      setDelegate: (next) => {
        activeDelegate = next;
      },
      getEngineState: () => engineState,
      setEngineState: (next) => {
        engineState = next;
      },
      getSettings: () => ({ ...DEFAULT_GESTURE_SETTINGS, enabled: true, resolution: '240p' }),
      getContextMode: () => 'stage',
      onOutput: vi.fn(),
      onFps: vi.fn(),
      onTransientError: (msg) => transientErrors.push(msg),
      onFatalError: (msg) => fatalErrors.push(msg),
      recreateCpuRecognizer: async () => ({ recognizer: cpuRecognizer, delegate: 'CPU' }),
      scheduleNext: (delayMs, fn) => {
        scheduled.push({ delayMs, fn });
      },
      isCancelled: () => false,
      now: () => 1000,
    });

    // 1st tick: GPU fails with activeTexture -> triggers clean downgrade to CPU
    runner.tick();
    expect(gpuRecognize).toHaveBeenCalledWith(video, 1000);
    expect(gpuClose).toHaveBeenCalledTimes(1);

    // Wait for async downgradeToCpu microtask to finish
    await vi.waitFor(() => {
      expect(activeDelegate).toBe('CPU');
      expect(activeRecognizer).toBe(cpuRecognizer);
      expect(scheduled.length).toBe(1);
    });

    // Next scheduled tick runs on CPU using ImageData (NOT HTMLVideoElement)
    scheduled.pop()!.fn();

    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 240);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 320, 240);
    expect(cpuRecognize).toHaveBeenCalledTimes(1);
    const passedInput = cpuRecognize.mock.calls[0]?.[0] as unknown as ImageData;
    expect(passedInput).toMatchObject({ width: 320, height: 240 });
    expect(passedInput.data).toBeInstanceOf(Uint8ClampedArray);
    expect(fatalErrors).toEqual([]);
    expect(transientErrors).toEqual([]);
  });

  it('keeps the tick loop alive on transient CPU frame errors and recovers cleanly', () => {
    stubCanvasDocument({ webgl2: null });

    let shouldFail = true;
    const cpuRecognize = vi.fn(() => {
      if (shouldFail) {
        throw new Error('Frame decode pending');
      }
      return emptyResult();
    });
    let activeRecognizer: GestureRecognizer | null = {
      recognizeForVideo: cpuRecognize,
      close: vi.fn(),
    } as unknown as GestureRecognizer;
    let activeDelegate: 'GPU' | 'CPU' | null = 'CPU';
    let engineState = createInitialGestureEngineState();
    const scheduled: Array<() => void> = [];
    const transientErrors: string[] = [];
    const onRecover = vi.fn();

    const video = {
      readyState: 4,
      currentTime: 0.5,
      videoWidth: 320,
      videoHeight: 240,
    } as unknown as HTMLVideoElement;

    const runner = createGestureFrameRunner({
      getVideo: () => video,
      getHudCanvas: () => null,
      getRecognizer: () => activeRecognizer,
      setRecognizer: (next) => {
        activeRecognizer = next;
      },
      getDelegate: () => activeDelegate,
      setDelegate: (next) => {
        activeDelegate = next;
      },
      getEngineState: () => engineState,
      setEngineState: (next) => {
        engineState = next;
      },
      getSettings: () => ({ ...DEFAULT_GESTURE_SETTINGS, enabled: true, resolution: '240p' }),
      getContextMode: () => 'stage',
      onOutput: vi.fn(),
      onFps: vi.fn(),
      onRecover,
      onTransientError: (msg) => transientErrors.push(msg),
      onFatalError: vi.fn(),
      recreateCpuRecognizer: async () => ({ recognizer: activeRecognizer!, delegate: 'CPU' }),
      scheduleNext: (_delay, fn) => {
        scheduled.push(fn);
      },
      isCancelled: () => false,
      now: () => 2000,
    });

    // 5 transient errors trigger friendly Portuguese message without stopping the loop
    for (let i = 0; i < 5; i++) {
      runner.tick();
      expect(scheduled.length).toBe(i + 1);
    }
    expect(transientErrors).toHaveLength(1);
    expect(transientErrors[0]).toContain('Falha temporária');

    // Recovery on next successful frame
    shouldFail = false;
    scheduled.pop()!();
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(isWebGLError(new TypeError("Cannot read properties of undefined (reading 'activeTexture')"))).toBe(true);
  });
});
