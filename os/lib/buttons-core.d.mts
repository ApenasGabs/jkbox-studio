export const EV_SYN: number;
export const EV_KEY: number;
export const EV_ABS: number;
export const ABS_X: number;
export const ABS_Y: number;
export const ABS_HAT0X: number;
export const ABS_HAT0Y: number;

export const KIOSK_COMMANDS: string[];
export const VOLUME_COMMANDS: string[];
export const ALL_ACTIONS: string[];
export const KEY_NAME_TO_CODE: Record<string, number>;
export const CODE_TO_KEY_NAME: Record<number, string>;
export const ABS_AXIS_NAMES: Record<number, string>;

export interface RawInputEvent {
  sec: number;
  usec: number;
  type: number;
  code: number;
  value: number;
}

export interface InputDeviceInfo {
  name: string;
  eventHandler: string;
  devicePath: string;
  handlers: string[];
  hasEvKey: boolean;
  hasEvAbs: boolean;
  hasKeyMask: boolean;
  isKeyboard: boolean;
  isGamepad: boolean;
  recommended: boolean;
}

export interface AbsAxisConfig {
  center: number;
  deadzone: number;
}

export interface ResolvedButtonsConfig {
  config: {
    wsUrl: string;
    activeProfile: string;
    deviceMatch: string[];
    debounceMs: number;
    longPressSelectMs: number;
    longPressPlayMs: number;
    menuComboHoldMs: number;
    repeatDelayMs: number;
    repeatIntervalMs: number;
    emitPhases: boolean;
    volumeStep: string;
    volumeMax: string;
    absAxes: Record<string, AbsAxisConfig>;
    profiles: Record<string, unknown>;
  };
  keyMap: Map<string, string>;
}

export function getInputEventSize(arch?: string): number;
export function parseInputEventBuffer(
  buffer: Buffer,
  arch?: string,
): { events: RawInputEvent[]; remainder: Buffer };
export function encodeInputEvent(
  ev: { sec?: number; usec?: number; type: number; code: number; value: number },
  arch?: string,
): Buffer;
export function parseProcBusInputDevices(text: string): InputDeviceInfo[];
export function selectInputDevices(devices: InputDeviceInfo[], deviceMatch?: string[]): InputDeviceInfo[];
export function loadJkboxEnv(envFile?: string): Record<string, string>;
export function loadDefaultButtonsConfig(): Record<string, unknown>;
export function resolveButtonsConfig(
  userConfig?: Record<string, unknown>,
  env?: Record<string, string>,
): ResolvedButtonsConfig;
export function normalizeToken(token: string): string;
export function keyCodeToToken(code: number): string;
export function classifyAbsAxisValue(
  code: number,
  value: number,
  absAxes?: Record<string, AbsAxisConfig>,
  axisState?: { sawSignedOrWide?: boolean },
): -1 | 0 | 1;
export function createButtonProcessor(options: {
  keyMap: Map<string, string>;
  absAxes?: Record<string, AbsAxisConfig>;
  debounceMs?: number;
  longPressSelectMs?: number;
  longPressPlayMs?: number;
  menuComboHoldMs?: number;
  repeatDelayMs?: number;
  repeatIntervalMs?: number;
  emitPhases?: boolean;
  onCommand?: (command: string) => void;
  onVolume?: (command: string) => void;
  onPhase?: (command: string, phase: 'down' | 'up') => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}): {
  processEvent: (deviceId: string, ev: { type: number; code: number; value: number }) => void;
  reset: () => void;
};
export function buildWpctlArgs(
  command: string,
  options?: { step?: string; maxVolume?: string; sink?: string },
): string[] | null;
