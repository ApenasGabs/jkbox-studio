import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GestureHudOverlay } from '../components/GestureHudOverlay';
import { GestureControlPanel } from '../components/HostControls';
import {
  ACTIVE_INTERVAL_MS,
  computeHandBoundingScale,
  createInitialGestureEngineState,
  DEFAULT_GESTURE_SETTINGS,
  evaluateGestureFrame,
  type GestureEngineState,
  type GestureSettings,
  loadGestureSettings,
  mapContextualGesture,
  normalizeGestureSettings,
  type Point2D,
  STANDBY_INTERVAL_MS,
  saveGestureSettings,
} from './gestureEngine';

const makeLandmarks = (scale: number): Point2D[] => {
  const pts: Point2D[] = [];
  for (let i = 0; i < 21; i++) {
    const ratio = i / 20;
    pts.push({ x: 0.3 + ratio * scale, y: 0.3 + ratio * scale });
  }
  return pts;
};

const TEST_SETTINGS: GestureSettings = {
  ...DEFAULT_GESTURE_SETTINGS,
  enabled: true,
  dwellMs: 300,
  skipHoldMs: 1200,
  minHandScale: 0.18,
  minConfidence: 0.7,
  wakeHoldMs: 800,
  activeWindowMs: 15_000,
  repeatIntervalMs: 350,
  cooldownMs: 500,
  graceMs: 120,
};

describe('gestureEngine — proximity & contextual mapping', () => {
  it('computes hand bounding-box scale accurately and filters distant hands', () => {
    expect(computeHandBoundingScale(null)).toBe(0);
    expect(computeHandBoundingScale(makeLandmarks(0.1))).toBeCloseTo(0.1, 2);
    expect(computeHandBoundingScale(makeLandmarks(0.25))).toBeCloseTo(0.25, 2);

    const state = createInitialGestureEngineState();
    const farResult = evaluateGestureFrame(
      state,
      {
        gestureName: 'Open_Palm',
        confidence: 0.95,
        landmarks: makeLandmarks(0.1),
        timestampMs: 1000,
        context: 'stage',
      },
      TEST_SETTINGS,
    );
    expect(farResult.tooFar).toBe(true);
    expect(farResult.powerMode).toBe('standby');
    expect(farResult.wakeProgress).toBe(0);
    expect(farResult.recommendedIntervalMs).toBe(STANDBY_INTERVAL_MS);
  });

  it('maps gestures contextually between Stage (Palco) and Modal/Catalog', () => {
    expect(mapContextualGesture('Thumb_Up', 'stage')).toBe('VOL_UP');
    expect(mapContextualGesture('Thumb_Down', 'stage')).toBe('VOL_DOWN');
    expect(mapContextualGesture('Victory', 'stage')).toBe('SKIP');
    expect(mapContextualGesture('Closed_Fist', 'stage')).toBe('PLAY');
    expect(mapContextualGesture('Open_Palm', 'stage')).toBe('OPEN_CATALOG');
    expect(mapContextualGesture('Pointing_Up', 'stage')).toBe('CYCLE_STAGE');

    expect(mapContextualGesture('Thumb_Up', 'modal')).toBe('UP');
    expect(mapContextualGesture('Thumb_Down', 'modal')).toBe('DOWN');
    expect(mapContextualGesture('Victory', 'modal')).toBe('SELECT');
    expect(mapContextualGesture('Closed_Fist', 'modal')).toBe('PLAY');
    expect(mapContextualGesture('Open_Palm', 'modal')).toBe('BACK');
    expect(mapContextualGesture('Pointing_Up', 'modal')).toBe('CYCLE_TAB');
  });

  it('wakes up from 4 FPS standby to 24 FPS active after wakeHoldMs without misfiring on wake pose, and returns to standby after idle', () => {
    const closeHand = makeLandmarks(0.24);
    let state = createInitialGestureEngineState();

    // Start holding Open_Palm at t=0
    const f1 = evaluateGestureFrame(
      state,
      {
        gestureName: 'Open_Palm',
        confidence: 0.9,
        landmarks: closeHand,
        timestampMs: 0,
        context: 'stage',
      },
      TEST_SETTINGS,
    );
    expect(f1.powerMode).toBe('standby');
    expect(f1.wakeProgress).toBe(0);
    state = f1.nextState;

    // Halfway wake at t=400ms
    const f2 = evaluateGestureFrame(
      state,
      {
        gestureName: 'Open_Palm',
        confidence: 0.9,
        landmarks: closeHand,
        timestampMs: 400,
        context: 'stage',
      },
      TEST_SETTINGS,
    );
    expect(f2.powerMode).toBe('standby');
    expect(f2.wakeProgress).toBe(50);
    expect(f2.recommendedIntervalMs).toBe(ACTIVE_INTERVAL_MS);
    state = f2.nextState;

    // Complete wake at t=810ms -> transitions to active, does NOT immediately trigger OPEN_CATALOG!
    const f3 = evaluateGestureFrame(
      state,
      {
        gestureName: 'Open_Palm',
        confidence: 0.9,
        landmarks: closeHand,
        timestampMs: 810,
        context: 'stage',
      },
      TEST_SETTINGS,
    );
    expect(f3.powerMode).toBe('active');
    expect(f3.justWokeUp).toBe(true);
    expect(f3.triggeredAction).toBeNull();
    state = f3.nextState;

    // Still holding Open_Palm at t=1200ms -> remains latched until pose changes/releases
    const f4 = evaluateGestureFrame(
      state,
      {
        gestureName: 'Open_Palm',
        confidence: 0.9,
        landmarks: closeHand,
        timestampMs: 1200,
        context: 'stage',
      },
      TEST_SETTINGS,
    );
    expect(f4.triggeredAction).toBeNull();
    state = f4.nextState;

    // After 16 seconds of no hand -> drops back to 4 FPS standby
    const fIdle = evaluateGestureFrame(
      state,
      {
        gestureName: null,
        confidence: 0,
        landmarks: null,
        timestampMs: 20_000,
        context: 'stage',
      },
      TEST_SETTINGS,
    );
    expect(fIdle.powerMode).toBe('standby');
    expect(fIdle.recommendedIntervalMs).toBe(STANDBY_INTERVAL_MS);
  });

  it('requires 1.2s safe hold for SKIP on stage, single-latches SELECT in catalog, and auto-repeats UP/VOL_UP', () => {
    const closeHand = makeLandmarks(0.25);
    let state: GestureEngineState = {
      ...createInitialGestureEngineState(),
      powerMode: 'active',
      activeUntilMs: 20_000,
    };

    // Victory on stage -> SKIP requires 1200ms (not 300ms!)
    state = evaluateGestureFrame(
      state,
      { gestureName: 'Victory', confidence: 0.9, landmarks: closeHand, timestampMs: 1000, context: 'stage' },
      TEST_SETTINGS,
    ).nextState;

    const at400ms = evaluateGestureFrame(
      state,
      { gestureName: 'Victory', confidence: 0.9, landmarks: closeHand, timestampMs: 1400, context: 'stage' },
      TEST_SETTINGS,
    );
    expect(at400ms.triggeredAction).toBeNull();
    expect(at400ms.pendingAction).toBe('SKIP');
    expect(at400ms.dwellProgress).toBe(33);
    state = at400ms.nextState;

    const at1210ms = evaluateGestureFrame(
      state,
      { gestureName: 'Victory', confidence: 0.9, landmarks: closeHand, timestampMs: 2210, context: 'stage' },
      TEST_SETTINGS,
    );
    expect(at1210ms.triggeredAction).toBe('SKIP');
    state = at1210ms.nextState;

    // Holding Victory further does NOT double-skip
    const heldMore = evaluateGestureFrame(
      state,
      { gestureName: 'Victory', confidence: 0.9, landmarks: closeHand, timestampMs: 3000, context: 'stage' },
      TEST_SETTINGS,
    );
    expect(heldMore.triggeredAction).toBeNull();
    state = heldMore.nextState;

    // Switch to Thumb_Up in modal -> UP fires at 300ms and auto-repeats after 350ms
    state = evaluateGestureFrame(
      state,
      { gestureName: 'Thumb_Up', confidence: 0.9, landmarks: closeHand, timestampMs: 4000, context: 'modal' },
      TEST_SETTINGS,
    ).nextState;

    const firstUp = evaluateGestureFrame(
      state,
      { gestureName: 'Thumb_Up', confidence: 0.9, landmarks: closeHand, timestampMs: 4310, context: 'modal' },
      TEST_SETTINGS,
    );
    expect(firstUp.triggeredAction).toBe('UP');
    state = firstUp.nextState;

    const repeatUp = evaluateGestureFrame(
      state,
      { gestureName: 'Thumb_Up', confidence: 0.9, landmarks: closeHand, timestampMs: 4680, context: 'modal' },
      TEST_SETTINGS,
    );
    expect(repeatUp.triggeredAction).toBe('UP');
  });

  it('persists and clamps GestureSettings safely with opt-in disabled by default', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };

    expect(loadGestureSettings(storage).enabled).toBe(false);
    expect(loadGestureSettings(storage).hudMode).toBe('skeleton');

    saveGestureSettings(
      normalizeGestureSettings({
        enabled: true,
        resolution: '480p',
        hudMode: 'video',
        dwellMs: 9999,
        minHandScale: 0.95,
      }),
      storage,
    );

    const loaded = loadGestureSettings(storage);
    expect(loaded.enabled).toBe(true);
    expect(loaded.resolution).toBe('480p');
    expect(loaded.hudMode).toBe('video');
    expect(loaded.dwellMs).toBe(800);
    expect(loaded.minHandScale).toBe(0.4);
  });

  it('renders GestureHudOverlay in privacy skeleton mode and GestureControlPanel in Host panel', () => {
    const hudHtml = renderToStaticMarkup(
      <GestureHudOverlay
        enabled
        hudMode="skeleton"
        context="stage"
        status="ready"
        error={null}
        powerMode="active"
        wakeProgress={100}
        dwellProgress={60}
        pendingAction="SKIP"
        tooFar={false}
        fps={24}
        videoRef={createRef()}
        canvasRef={createRef()}
      />,
    );

    expect(hudHtml).toContain('Privado');
    expect(hudHtml).toContain('Segure p/ Pular');
    expect(hudHtml).toContain('opacity-0');

    const panelHtml = renderToStaticMarkup(
      <GestureControlPanel
        settings={{ ...DEFAULT_GESTURE_SETTINGS, enabled: true }}
        status="ready"
        fps={24}
        delegate="GPU"
        onChange={() => {}}
      />,
    );

    expect(panelHtml).toContain('Controle por Gestos (Webcam)');
    expect(panelHtml).toContain('Esqueleto 21pt (Privado)');
    expect(panelHtml).toContain('320x240 Leve');
    expect(panelHtml).toContain('640x480');
  });
});
