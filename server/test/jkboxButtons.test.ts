import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ABS_HAT0X,
  ABS_X,
  ABS_Y,
  buildWpctlArgs,
  createButtonProcessor,
  encodeInputEvent,
  EV_ABS,
  EV_KEY,
  KEY_NAME_TO_CODE,
  loadJkboxEnv,
  parseInputEventBuffer,
  parseProcBusInputDevices,
  resolveButtonsConfig,
  selectInputDevices,
} from '../../os/lib/buttons-core.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const BUTTONS_BIN = path.join(REPO_ROOT, 'os', 'jkbox-buttons');

afterEach(() => {
  vi.useRealTimers();
});

describe('os/lib/buttons-core.mjs', () => {
  it('parses 64-bit and 32-bit evdev structs across split buffer chunks', () => {
    for (const arch of ['x64', 'arm'] as const) {
      const b1 = encodeInputEvent({ sec: 100, usec: 500, type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_UP, value: 1 }, arch);
      const b2 = encodeInputEvent({ sec: 100, usec: 600, type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_UP, value: 0 }, arch);
      const combined = Buffer.concat([b1, b2]);

      const splitAt = b1.length + 5;
      const first = parseInputEventBuffer(combined.subarray(0, splitAt), arch);
      expect(first.events).toHaveLength(1);
      expect(first.events[0]).toMatchObject({ type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_UP, value: 1 });
      expect(first.remainder.length).toBe(5);

      const second = parseInputEventBuffer(
        Buffer.concat([first.remainder, combined.subarray(splitAt)]),
        arch,
      );
      expect(second.events).toHaveLength(1);
      expect(second.events[0]).toMatchObject({ type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_UP, value: 0 });
      expect(second.remainder.length).toBe(0);
    }
  });

  it('parses /proc/bus/input/devices and filters keyboards/arcades while ignoring noise devices', () => {
    const procSample = `
I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
H: Handlers=kbd event0
B: EV=3

I: Bus=0003 Vendor=046d Product=c31c Version=0110
N: Name="Logitech USB Keyboard"
H: Handlers=sysrq kbd leds event2
B: EV=120013
B: KEY=1000000000007

I: Bus=0003 Vendor=0079 Product=0006 Version=0110
N: Name="DragonRise Inc. Generic USB Joystick"
H: Handlers=event5 js0
B: EV=1b
B: KEY=fff 0 0 0 0
B: ABS=3002f

I: Bus=0003 Vendor=046d Product=c077 Version=0111
N: Name="Logitech USB Optical Mouse"
H: Handlers=mouse0 event3
B: EV=17
`;
    const parsed = parseProcBusInputDevices(procSample);
    expect(parsed).toHaveLength(4);

    const autoSelected = selectInputDevices(parsed, []);
    expect(autoSelected.map((d) => d.devicePath)).toEqual(['/dev/input/event2', '/dev/input/event5']);

    const explicit = selectInputDevices(parsed, ['DragonRise']);
    expect(explicit.map((d) => d.devicePath)).toEqual(['/dev/input/event5']);
  });

  it('debounces physical switch bounce and resolves short/long presses and LEFT+RIGHT combo', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { config, keyMap } = resolveButtonsConfig({}, {});
    const commands: string[] = [];
    const volumes: string[] = [];

    const proc = createButtonProcessor({
      keyMap,
      absAxes: config.absAxes,
      debounceMs: 40,
      longPressSelectMs: 1000,
      longPressPlayMs: 1500,
      menuComboHoldMs: 2000,
      onCommand: (cmd: string) => commands.push(cmd),
      onVolume: (vol: string) => volumes.push(vol),
    });

    // Bounce on SELECT press (t=0 down, t=10 up bounce, t=20 down bounce), then release at t=120 -> single SELECT
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 1 });
    vi.advanceTimersByTime(10);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 0 });
    vi.advanceTimersByTime(10);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 1 });
    // Kernel auto-repeat (value=2) must be ignored
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 2 });
    vi.advanceTimersByTime(100);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 0 });
    expect(commands).toEqual(['SELECT']);

    // Long press SELECT (>= 1000ms) -> BACK, no SELECT on release
    vi.advanceTimersByTime(100);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 1 });
    vi.advanceTimersByTime(1000);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 0 });
    expect(commands).toEqual(['SELECT', 'BACK']);

    // Long press PLAY (>= 1500ms) -> SKIP
    vi.advanceTimersByTime(100);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_SPACE, value: 1 });
    vi.advanceTimersByTime(1500);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_SPACE, value: 0 });
    expect(commands).toEqual(['SELECT', 'BACK', 'SKIP']);

    // Short PLAY (< 1500ms) -> PLAY
    vi.advanceTimersByTime(100);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_SPACE, value: 1 });
    vi.advanceTimersByTime(200);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_SPACE, value: 0 });
    expect(commands).toEqual(['SELECT', 'BACK', 'SKIP', 'PLAY']);

    // Combo LEFT + RIGHT held >= 2000ms -> MENU
    vi.advanceTimersByTime(100);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_LEFT, value: 1 });
    vi.advanceTimersByTime(50);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_RIGHT, value: 1 });
    vi.advanceTimersByTime(2000);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_LEFT, value: 0 });
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_RIGHT, value: 0 });
    expect(commands).toEqual(['SELECT', 'BACK', 'SKIP', 'PLAY', 'LEFT', 'MENU']);

    // Volume keys route to wpctl handler
    vi.advanceTimersByTime(100);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_VOLUMEUP, value: 1 });
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_VOLUMEDOWN, value: 1 });
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_MUTE, value: 1 });
    expect(volumes).toEqual(['VOL_UP', 'VOL_DOWN', 'MUTE']);

    proc.reset();
  });

  it('settles rapid sub-debounce tap without getting stuck in pressed state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const { config, keyMap } = resolveButtonsConfig({}, {});
    const commands: string[] = [];

    const proc = createButtonProcessor({
      keyMap,
      absAxes: config.absAxes,
      debounceMs: 40,
      longPressSelectMs: 1000,
      onCommand: (cmd: string) => commands.push(cmd),
    });

    // Very short tap: down at t=0, up at t=15ms (< debounceMs=40)
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 1 });
    vi.advanceTimersByTime(15);
    proc.processEvent('dev0', { type: EV_KEY, code: KEY_NAME_TO_CODE.KEY_ENTER, value: 0 });

    // Settle timer fires at t=40ms -> processes release and fires SELECT (never triggers BACK!)
    vi.advanceTimersByTime(30);
    vi.advanceTimersByTime(1500);
    expect(commands).toEqual(['SELECT']);
    proc.reset();
  });

  it('handles Zero Delay EV_ABS 0..255 axes and HAT0 axes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const { config, keyMap } = resolveButtonsConfig({}, {});
    const commands: string[] = [];

    const proc = createButtonProcessor({
      keyMap,
      absAxes: config.absAxes,
      debounceMs: 30,
      repeatDelayMs: 0,
      onCommand: (cmd: string) => commands.push(cmd),
    });

    // Zero Delay 0..255: Y=0 -> UP, Y=128 -> center, X=255 -> RIGHT, X=128 -> center
    proc.processEvent('arc0', { type: EV_ABS, code: ABS_Y, value: 0 });
    vi.advanceTimersByTime(50);
    proc.processEvent('arc0', { type: EV_ABS, code: ABS_Y, value: 128 });
    vi.advanceTimersByTime(50);
    proc.processEvent('arc0', { type: EV_ABS, code: ABS_X, value: 255 });
    vi.advanceTimersByTime(50);
    proc.processEvent('arc0', { type: EV_ABS, code: ABS_X, value: 128 });
    vi.advanceTimersByTime(50);
    // HAT0X: -1 -> LEFT, 0 -> center
    proc.processEvent('arc0', { type: EV_ABS, code: ABS_HAT0X, value: -1 });
    vi.advanceTimersByTime(50);
    proc.processEvent('arc0', { type: EV_ABS, code: ABS_HAT0X, value: 0 });

    expect(commands).toEqual(['UP', 'RIGHT', 'LEFT']);
    proc.reset();
  });

  it('builds wpctl arguments and derives wsUrl from jkbox.env PORT', () => {
    expect(buildWpctlArgs('VOL_UP', { step: '5%', maxVolume: '1.0' })).toEqual([
      'set-volume',
      '-l',
      '1.0',
      '@DEFAULT_AUDIO_SINK@',
      '5%+',
    ]);
    expect(buildWpctlArgs('VOL_DOWN', { step: '5%' })).toEqual(['set-volume', '@DEFAULT_AUDIO_SINK@', '5%-']);
    expect(buildWpctlArgs('MUTE')).toEqual(['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-btn-env-'));
    const envPath = path.join(tmp, 'jkbox.env');
    fs.writeFileSync(envPath, 'PORT=4123\nHOST_PIN=9999\n');
    const env = loadJkboxEnv(envPath);
    const { config } = resolveButtonsConfig({}, env);
    expect(config.wsUrl).toBe('ws://127.0.0.1:4123/ws');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('supports --help CLI execution without external dependencies', async () => {
    const { stdout } = await execFileAsync('node', [BUTTONS_BIN, '--help']);
    expect(stdout).toContain('--calibrate');
    expect(stdout).toContain('--list-devices');
  });
});
