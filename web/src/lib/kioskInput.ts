import { KIOSK_COMMANDS, type KioskCommand, type KioskInputPhase } from './types';

export const SELECT_LONG_PRESS_MS = 1000;
export const PLAY_LONG_PRESS_MS = 1500;
export const MENU_COMBO_HOLD_MS = 2000;
export const GAMEPAD_REPEAT_DELAY_MS = 320;
export const GAMEPAD_REPEAT_INTERVAL_MS = 110;
export const GAMEPAD_AXIS_DEADZONE = 0.5;

const ALLOWED_COMMANDS = new Set<string>(KIOSK_COMMANDS);
const DIRECTIONAL_COMMANDS = new Set<KioskCommand>(['UP', 'DOWN', 'LEFT', 'RIGHT']);

export interface KioskHoldState {
  target: 'BACK' | 'SKIP' | 'MENU';
  startedAt: number;
  durationMs: number;
}

export type KioskTimerHandle = ReturnType<typeof setTimeout>;

export interface KioskInputControllerOptions {
  onCommand: (command: KioskCommand) => void;
  onHoldChange?: (hold: KioskHoldState | null) => void;
  setTimer?: (fn: () => void, ms: number) => KioskTimerHandle;
  clearTimer?: (id: KioskTimerHandle) => void;
  now?: () => number;
}

export interface KioskInputController {
  handlePhase: (command: KioskCommand, phase: KioskInputPhase, isRepeat?: boolean) => void;
  reset: () => void;
}

export interface GamepadLike {
  connected?: boolean;
  buttons: ReadonlyArray<{ pressed: boolean; value?: number }>;
  axes: ReadonlyArray<number>;
}

/** Maps a keyboard `KeyboardEvent.key` value to an abstract Kiosk command. */
export function mapKeyToKioskCommand(key: string): KioskCommand | null {
  switch (key) {
    case 'ArrowUp':
      return 'UP';
    case 'ArrowDown':
      return 'DOWN';
    case 'ArrowLeft':
      return 'LEFT';
    case 'ArrowRight':
      return 'RIGHT';
    case 'Enter':
      return 'SELECT';
    case ' ':
    case 'Spacebar':
      return 'PLAY';
    case 'Escape':
    case 'Backspace':
      return 'BACK';
    default:
      return null;
  }
}

/** Normalizes an untrusted string into a valid KioskCommand or null. */
export function parseKioskCommand(value: unknown): KioskCommand | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return ALLOWED_COMMANDS.has(upper) ? (upper as KioskCommand) : null;
}

/** Returns true when keyboard input should go to text entry instead of D-Pad navigation. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const inputType = (el.type ?? 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range'].includes(inputType);
  }
  return false;
}

/** Reads currently pressed abstract commands from a standard Gamepad snapshot. */
export function readGamepadCommands(gamepad: GamepadLike | null | undefined): Set<KioskCommand> {
  const active = new Set<KioskCommand>();
  if (!gamepad || gamepad.connected === false) return active;

  const isPressed = (idx: number): boolean => {
    const btn = gamepad.buttons[idx];
    return Boolean(btn && (btn.pressed || (btn.value ?? 0) > 0.5));
  };

  const axisX = gamepad.axes[0] ?? 0;
  const axisY = gamepad.axes[1] ?? 0;

  if (isPressed(12) || axisY < -GAMEPAD_AXIS_DEADZONE) active.add('UP');
  if (isPressed(13) || axisY > GAMEPAD_AXIS_DEADZONE) active.add('DOWN');
  if (isPressed(14) || axisX < -GAMEPAD_AXIS_DEADZONE) active.add('LEFT');
  if (isPressed(15) || axisX > GAMEPAD_AXIS_DEADZONE) active.add('RIGHT');

  if (isPressed(0)) active.add('SELECT');
  if (isPressed(1)) active.add('BACK');
  if (isPressed(2) || isPressed(9)) active.add('PLAY');
  if (isPressed(3) || isPressed(8)) active.add('MENU');
  if (isPressed(5)) active.add('SKIP');

  return active;
}

/**
 * Stateful translator for short presses, long presses, and combos across keyboard,
 * gamepad, and WebSocket hardware events.
 */
export function createKioskInputController(options: KioskInputControllerOptions): KioskInputController {
  const {
    onCommand,
    onHoldChange,
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = (id) => globalThis.clearTimeout(id),
    now = () => Date.now(),
  } = options;

  const pressed = new Set<KioskCommand>();
  let selectTimer: KioskTimerHandle | null = null;
  let selectLongFired = false;
  let playTimer: KioskTimerHandle | null = null;
  let playLongFired = false;
  let menuComboTimer: KioskTimerHandle | null = null;
  let menuComboFired = false;
  let activeHold: KioskHoldState | null = null;

  const emitHold = (next: KioskHoldState | null) => {
    activeHold = next;
    onHoldChange?.(next);
  };

  const clearSelectTimer = () => {
    if (selectTimer !== null) {
      clearTimer(selectTimer);
      selectTimer = null;
    }
    if (activeHold?.target === 'BACK') emitHold(null);
  };

  const clearPlayTimer = () => {
    if (playTimer !== null) {
      clearTimer(playTimer);
      playTimer = null;
    }
    if (activeHold?.target === 'SKIP') emitHold(null);
  };

  const clearMenuComboTimer = () => {
    if (menuComboTimer !== null) {
      clearTimer(menuComboTimer);
      menuComboTimer = null;
    }
    if (activeHold?.target === 'MENU') emitHold(null);
  };

  const reset = () => {
    pressed.clear();
    clearSelectTimer();
    clearPlayTimer();
    clearMenuComboTimer();
    selectLongFired = false;
    playLongFired = false;
    menuComboFired = false;
    emitHold(null);
  };

  const handlePhase = (command: KioskCommand, phase: KioskInputPhase, isRepeat = false) => {
    if (phase === 'press') {
      if (isRepeat && !DIRECTIONAL_COMMANDS.has(command)) return;
      onCommand(command);
      return;
    }

    if (phase === 'down') {
      if (isRepeat) {
        if (!DIRECTIONAL_COMMANDS.has(command)) return;
        if (pressed.has('LEFT') && pressed.has('RIGHT')) return;
        onCommand(command);
        return;
      }

      if (pressed.has(command)) return;
      pressed.add(command);

      if (command === 'SELECT') {
        selectLongFired = false;
        clearSelectTimer();
        emitHold({ target: 'BACK', startedAt: now(), durationMs: SELECT_LONG_PRESS_MS });
        selectTimer = setTimer(() => {
          selectTimer = null;
          selectLongFired = true;
          emitHold(null);
          onCommand('BACK');
        }, SELECT_LONG_PRESS_MS);
        return;
      }

      if (command === 'PLAY') {
        playLongFired = false;
        clearPlayTimer();
        emitHold({ target: 'SKIP', startedAt: now(), durationMs: PLAY_LONG_PRESS_MS });
        playTimer = setTimer(() => {
          playTimer = null;
          playLongFired = true;
          emitHold(null);
          onCommand('SKIP');
        }, PLAY_LONG_PRESS_MS);
        return;
      }

      if (command === 'LEFT' || command === 'RIGHT') {
        if (pressed.has('LEFT') && pressed.has('RIGHT')) {
          menuComboFired = false;
          clearMenuComboTimer();
          emitHold({ target: 'MENU', startedAt: now(), durationMs: MENU_COMBO_HOLD_MS });
          menuComboTimer = setTimer(() => {
            menuComboTimer = null;
            menuComboFired = true;
            emitHold(null);
            onCommand('MENU');
          }, MENU_COMBO_HOLD_MS);
          return;
        }
        onCommand(command);
        return;
      }

      onCommand(command);
      return;
    }

    // phase === 'up'
    pressed.delete(command);

    if (command === 'SELECT') {
      clearSelectTimer();
      const shouldFireShort = !selectLongFired;
      selectLongFired = false;
      if (shouldFireShort) onCommand('SELECT');
      return;
    }

    if (command === 'PLAY') {
      clearPlayTimer();
      const shouldFireShort = !playLongFired;
      playLongFired = false;
      if (shouldFireShort) onCommand('PLAY');
      return;
    }

    if (command === 'LEFT' || command === 'RIGHT') {
      clearMenuComboTimer();
      if (!pressed.has('LEFT') && !pressed.has('RIGHT')) {
        menuComboFired = false;
      } else if (menuComboFired) {
        return;
      }
    }
  };

  return { handlePhase, reset };
}
