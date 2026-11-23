import { describe, expect, it, vi } from 'vitest';
import {
  createKioskInputController,
  isTypingTarget,
  mapKeyToKioskCommand,
  MENU_COMBO_HOLD_MS,
  parseKioskCommand,
  PLAY_LONG_PRESS_MS,
  readGamepadCommands,
  SELECT_LONG_PRESS_MS,
} from './kioskInput';
import type { KioskCommand } from './types';

describe('kioskInput', () => {
  it('maps USB keyboard keys to abstract Kiosk commands', () => {
    expect(mapKeyToKioskCommand('ArrowUp')).toBe('UP');
    expect(mapKeyToKioskCommand('ArrowDown')).toBe('DOWN');
    expect(mapKeyToKioskCommand('ArrowLeft')).toBe('LEFT');
    expect(mapKeyToKioskCommand('ArrowRight')).toBe('RIGHT');
    expect(mapKeyToKioskCommand('Enter')).toBe('SELECT');
    expect(mapKeyToKioskCommand(' ')).toBe('PLAY');
    expect(mapKeyToKioskCommand('Escape')).toBe('BACK');
    expect(mapKeyToKioskCommand('Backspace')).toBe('BACK');
    expect(mapKeyToKioskCommand('a')).toBeNull();
  });

  it('normalizes valid commands and rejects unknown ones', () => {
    expect(parseKioskCommand(' up ')).toBe('UP');
    expect(parseKioskCommand('SELECT')).toBe('SELECT');
    expect(parseKioskCommand('skip')).toBe('SKIP');
    expect(parseKioskCommand('invalid')).toBeNull();
    expect(parseKioskCommand(123)).toBeNull();
  });

  it('detects typing targets while allowing buttons/ranges/non-inputs', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'password' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('emits SELECT on short press and BACK on long press (~1s) without double firing', () => {
    vi.useFakeTimers();
    const emitted: KioskCommand[] = [];
    const holds: Array<string | null> = [];
    const ctrl = createKioskInputController({
      onCommand: (cmd) => emitted.push(cmd),
      onHoldChange: (h) => holds.push(h?.target ?? null),
    });

    ctrl.handlePhase('SELECT', 'down');
    vi.advanceTimersByTime(SELECT_LONG_PRESS_MS - 100);
    ctrl.handlePhase('SELECT', 'up');
    expect(emitted).toEqual(['SELECT']);

    ctrl.handlePhase('SELECT', 'down');
    vi.advanceTimersByTime(SELECT_LONG_PRESS_MS);
    expect(emitted).toEqual(['SELECT', 'BACK']);
    ctrl.handlePhase('SELECT', 'up');
    expect(emitted).toEqual(['SELECT', 'BACK']);
    expect(holds.at(-1)).toBeNull();
    vi.useRealTimers();
  });

  it('emits PLAY on short press and SKIP on long press (~1.5s)', () => {
    vi.useFakeTimers();
    const emitted: KioskCommand[] = [];
    const ctrl = createKioskInputController({ onCommand: (cmd) => emitted.push(cmd) });

    ctrl.handlePhase('PLAY', 'down');
    vi.advanceTimersByTime(300);
    ctrl.handlePhase('PLAY', 'up');
    expect(emitted).toEqual(['PLAY']);

    ctrl.handlePhase('PLAY', 'down');
    vi.advanceTimersByTime(PLAY_LONG_PRESS_MS);
    ctrl.handlePhase('PLAY', 'up');
    expect(emitted).toEqual(['PLAY', 'SKIP']);
    vi.useRealTimers();
  });

  it('emits MENU when LEFT + RIGHT are held together for ~2s and cancels if released early', () => {
    vi.useFakeTimers();
    const emitted: KioskCommand[] = [];
    const ctrl = createKioskInputController({ onCommand: (cmd) => emitted.push(cmd) });

    ctrl.handlePhase('LEFT', 'down');
    ctrl.handlePhase('RIGHT', 'down');
    vi.advanceTimersByTime(MENU_COMBO_HOLD_MS - 200);
    ctrl.handlePhase('RIGHT', 'up');
    vi.advanceTimersByTime(500);
    expect(emitted).toEqual(['LEFT']);
    ctrl.handlePhase('LEFT', 'up');

    ctrl.handlePhase('LEFT', 'down');
    ctrl.handlePhase('RIGHT', 'down');
    ctrl.handlePhase('LEFT', 'down', true);
    vi.advanceTimersByTime(MENU_COMBO_HOLD_MS);
    ctrl.handlePhase('LEFT', 'up');
    ctrl.handlePhase('RIGHT', 'up');
    expect(emitted).toEqual(['LEFT', 'LEFT', 'MENU']);
    vi.useRealTimers();
  });

  it('reads Gamepad D-pad, analog axes with deadzone, and face buttons', () => {
    const btn = (pressed: boolean) => ({ pressed, value: pressed ? 1 : 0 });
    const emptyButtons = Array.from({ length: 16 }, () => btn(false));

    expect(readGamepadCommands(null).size).toBe(0);

    const buttons = [...emptyButtons];
    buttons[0] = btn(true);
    buttons[13] = btn(true);
    const commands = readGamepadCommands({ connected: true, buttons, axes: [-0.8, 0.1] });
    expect(commands).toEqual(new Set(['SELECT', 'DOWN', 'LEFT']));
  });

  it('handles direct WebSocket press events and reset()', () => {
    vi.useFakeTimers();
    const emitted: KioskCommand[] = [];
    const ctrl = createKioskInputController({ onCommand: (cmd) => emitted.push(cmd) });

    ctrl.handlePhase('UP', 'press');
    ctrl.handlePhase('MENU', 'press');
    ctrl.handlePhase('SELECT', 'down');
    ctrl.reset();
    vi.advanceTimersByTime(SELECT_LONG_PRESS_MS + 100);
    expect(emitted).toEqual(['UP', 'MENU']);
    vi.useRealTimers();
  });
});
