import { useEffect, useRef, useState } from 'react';
import {
  createKioskInputController,
  GAMEPAD_REPEAT_DELAY_MS,
  GAMEPAD_REPEAT_INTERVAL_MS,
  isTypingTarget,
  type KioskHoldState,
  mapKeyToKioskCommand,
  readGamepadCommands,
} from './kioskInput';
import type { KioskCommand, KioskInputEvent } from './types';

const DIRECTIONALS = new Set<KioskCommand>(['UP', 'DOWN', 'LEFT', 'RIGHT']);

export interface UseKioskInputOptions {
  onCommand: (command: KioskCommand) => void;
  subscribeInput?: (handler: (event: KioskInputEvent) => void) => () => void;
  enabled?: boolean;
}

/**
 * Unified Kiosk input hook aggregating USB Keyboard, Gamepad API polling, and
 * WebSocket `input` events through a single long-press / combo state machine.
 */
export function useKioskInput({ onCommand, subscribeInput, enabled = true }: UseKioskInputOptions) {
  const [holdState, setHoldState] = useState<KioskHoldState | null>(null);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  useEffect(() => {
    if (!enabled) {
      setHoldState(null);
      return;
    }

    const controller = createKioskInputController({
      onCommand: (cmd) => onCommandRef.current(cmd),
      onHoldChange: setHoldState,
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const cmd = mapKeyToKioskCommand(e.key);
      if (!cmd) return;

      // Allow normal text editing in inputs/textareas, except Escape/ArrowDown/Up to leave or close.
      if (isTypingTarget(e.target)) {
        if (e.key === 'Escape') {
          e.preventDefault();
          (e.target as HTMLElement).blur?.();
          controller.handlePhase('BACK', 'press');
          return;
        }
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.repeat) {
          e.preventDefault();
          (e.target as HTMLElement).blur?.();
          controller.handlePhase(cmd, 'down', false);
          return;
        }
        return;
      }

      e.preventDefault();
      controller.handlePhase(cmd, 'down', e.repeat);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const cmd = mapKeyToKioskCommand(e.key);
      if (!cmd) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      controller.handlePhase(cmd, 'up');
    };

    const onBlur = () => controller.reset();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    // WebSocket input events (e.g., future Linux evdev daemon)
    const unsubscribeWs = subscribeInput?.((event) => {
      controller.handlePhase(event.command, event.phase);
    });

    // Gamepad API polling (only active when a gamepad is connected)
    let rafId: number | null = null;
    let prevPressed = new Set<KioskCommand>();
    const repeatAt = new Map<KioskCommand, number>();

    const pollGamepads = (now: number) => {
      const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
      const current = new Set<KioskCommand>();
      let hasConnectedPad = false;

      for (const pad of pads) {
        if (!pad || !pad.connected) continue;
        hasConnectedPad = true;
        for (const cmd of readGamepadCommands(pad)) current.add(cmd);
      }

      for (const cmd of current) {
        if (!prevPressed.has(cmd)) {
          controller.handlePhase(cmd, 'down', false);
          if (DIRECTIONALS.has(cmd)) repeatAt.set(cmd, now + GAMEPAD_REPEAT_DELAY_MS);
        } else if (DIRECTIONALS.has(cmd)) {
          const nextDue = repeatAt.get(cmd);
          if (nextDue !== undefined && now >= nextDue) {
            controller.handlePhase(cmd, 'down', true);
            repeatAt.set(cmd, now + GAMEPAD_REPEAT_INTERVAL_MS);
          }
        }
      }

      for (const cmd of prevPressed) {
        if (!current.has(cmd)) {
          repeatAt.delete(cmd);
          controller.handlePhase(cmd, 'up');
        }
      }

      prevPressed = current;
      if (hasConnectedPad) {
        rafId = window.requestAnimationFrame(pollGamepads);
      } else {
        rafId = null;
      }
    };

    const ensureGamepadPolling = () => {
      if (rafId !== null || typeof navigator.getGamepads !== 'function') return;
      const pads = navigator.getGamepads();
      if (Array.from(pads).some((p) => p?.connected)) {
        rafId = window.requestAnimationFrame(pollGamepads);
      }
    };

    const onGamepadConnected = () => ensureGamepadPolling();
    const onGamepadDisconnected = () => {
      const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
      if (!Array.from(pads).some((p) => p?.connected)) {
        for (const cmd of prevPressed) controller.handlePhase(cmd, 'up');
        prevPressed.clear();
        repeatAt.clear();
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
      }
    };

    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
    ensureGamepadPolling();

    return () => {
      controller.reset();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('gamepadconnected', onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      unsubscribeWs?.();
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [enabled, subscribeInput]);

  return { holdState };
}
