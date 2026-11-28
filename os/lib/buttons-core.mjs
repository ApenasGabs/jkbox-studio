import fs from 'node:fs';
import path from 'node:path';

export const EV_SYN = 0x00;
export const EV_KEY = 0x01;
export const EV_ABS = 0x03;

export const ABS_X = 0x00;
export const ABS_Y = 0x01;
export const ABS_HAT0X = 0x10;
export const ABS_HAT0Y = 0x11;

export const KIOSK_COMMANDS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'SELECT', 'PLAY', 'BACK', 'MENU', 'SKIP'];
export const VOLUME_COMMANDS = ['VOL_UP', 'VOL_DOWN', 'MUTE'];
export const ALL_ACTIONS = [...KIOSK_COMMANDS, ...VOLUME_COMMANDS];

const KIOSK_COMMAND_SET = new Set(KIOSK_COMMANDS);
const VOLUME_COMMAND_SET = new Set(VOLUME_COMMANDS);
const DIRECTIONAL_COMMANDS = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT']);

const ARCH_32_BIT = new Set(['ia32', 'arm', 'mips', 'mipsel', 'riscv32']);

/** Standard Linux input-event-codes (subset relevant to keyboards, arcade encoders, and gamepads). */
export const KEY_NAME_TO_CODE = {
  KEY_ESC: 1,
  KEY_1: 2,
  KEY_2: 3,
  KEY_3: 4,
  KEY_4: 5,
  KEY_5: 6,
  KEY_6: 7,
  KEY_7: 8,
  KEY_8: 9,
  KEY_9: 10,
  KEY_0: 11,
  KEY_MINUS: 12,
  KEY_EQUAL: 13,
  KEY_BACKSPACE: 14,
  KEY_TAB: 15,
  KEY_Q: 16,
  KEY_W: 17,
  KEY_E: 18,
  KEY_R: 19,
  KEY_T: 20,
  KEY_Y: 21,
  KEY_U: 22,
  KEY_I: 23,
  KEY_O: 24,
  KEY_P: 25,
  KEY_ENTER: 28,
  KEY_A: 30,
  KEY_S: 31,
  KEY_D: 32,
  KEY_F: 33,
  KEY_G: 34,
  KEY_H: 35,
  KEY_J: 36,
  KEY_K: 37,
  KEY_L: 38,
  KEY_Z: 44,
  KEY_X: 45,
  KEY_C: 46,
  KEY_V: 47,
  KEY_B: 48,
  KEY_N: 49,
  KEY_M: 50,
  KEY_SPACE: 57,
  KEY_F1: 59,
  KEY_F2: 60,
  KEY_F3: 61,
  KEY_F4: 62,
  KEY_F5: 63,
  KEY_F6: 64,
  KEY_F7: 65,
  KEY_F8: 66,
  KEY_F9: 67,
  KEY_F10: 68,
  KEY_KPMINUS: 74,
  KEY_KPPLUS: 78,
  KEY_F11: 87,
  KEY_F12: 88,
  KEY_KPENTER: 96,
  KEY_UP: 103,
  KEY_PAGEUP: 104,
  KEY_LEFT: 105,
  KEY_RIGHT: 106,
  KEY_DOWN: 108,
  KEY_PAGEDOWN: 109,
  KEY_MUTE: 113,
  KEY_VOLUMEDOWN: 114,
  KEY_VOLUMEUP: 115,
  KEY_NEXTSONG: 163,
  KEY_PLAYPAUSE: 164,
  KEY_PREVIOUSSONG: 165,
  BTN_TRIGGER: 288,
  BTN_THUMB: 289,
  BTN_THUMB2: 290,
  BTN_TOP: 291,
  BTN_TOP2: 292,
  BTN_PINKIE: 293,
  BTN_BASE: 294,
  BTN_BASE2: 295,
  BTN_BASE3: 296,
  BTN_BASE4: 297,
  BTN_BASE5: 298,
  BTN_BASE6: 299,
  BTN_DEAD: 303,
  BTN_SOUTH: 304,
  BTN_EAST: 305,
  BTN_C: 306,
  BTN_NORTH: 307,
  BTN_WEST: 308,
  BTN_Z: 309,
  BTN_TL: 310,
  BTN_TR: 311,
  BTN_TL2: 312,
  BTN_TR2: 313,
  BTN_SELECT: 314,
  BTN_START: 315,
  BTN_MODE: 316,
  BTN_THUMBL: 317,
  BTN_THUMBR: 318,
  BTN_DPAD_UP: 544,
  BTN_DPAD_DOWN: 545,
  BTN_DPAD_LEFT: 546,
  BTN_DPAD_RIGHT: 547,
};

export const CODE_TO_KEY_NAME = Object.fromEntries(
  Object.entries(KEY_NAME_TO_CODE).map(([name, code]) => [code, name]),
);

export const ABS_AXIS_NAMES = {
  [ABS_X]: 'ABS_X',
  [ABS_Y]: 'ABS_Y',
  [ABS_HAT0X]: 'ABS_HAT0X',
  [ABS_HAT0Y]: 'ABS_HAT0Y',
};

export function getInputEventSize(arch = process.arch) {
  return ARCH_32_BIT.has(arch) ? 16 : 24;
}

/**
 * Parses binary Linux `struct input_event` records from a Buffer chunk.
 * Returns complete events plus any trailing incomplete bytes for stream framing.
 */
export function parseInputEventBuffer(buffer, arch = process.arch) {
  const size = getInputEventSize(arch);
  const events = [];
  let offset = 0;

  while (offset + size <= buffer.length) {
    let sec;
    let usec;
    let type;
    let code;
    let value;

    if (size === 24) {
      sec = Number(buffer.readBigInt64LE(offset));
      usec = Number(buffer.readBigInt64LE(offset + 8));
      type = buffer.readUInt16LE(offset + 16);
      code = buffer.readUInt16LE(offset + 18);
      value = buffer.readInt32LE(offset + 20);
    } else {
      sec = buffer.readInt32LE(offset);
      usec = buffer.readInt32LE(offset + 4);
      type = buffer.readUInt16LE(offset + 8);
      code = buffer.readUInt16LE(offset + 10);
      value = buffer.readInt32LE(offset + 12);
    }

    events.push({ sec, usec, type, code, value });
    offset += size;
  }

  return {
    events,
    remainder: offset < buffer.length ? buffer.subarray(offset) : Buffer.alloc(0),
  };
}

/**
 * Encodes a synthetic `struct input_event` buffer (primarily for tests and tooling).
 */
export function encodeInputEvent({ sec = 0, usec = 0, type, code, value }, arch = process.arch) {
  const size = getInputEventSize(arch);
  const buf = Buffer.alloc(size);
  if (size === 24) {
    buf.writeBigInt64LE(BigInt(sec), 0);
    buf.writeBigInt64LE(BigInt(usec), 8);
    buf.writeUInt16LE(type, 16);
    buf.writeUInt16LE(code, 18);
    buf.writeInt32LE(value, 20);
  } else {
    buf.writeInt32LE(sec, 0);
    buf.writeInt32LE(usec, 4);
    buf.writeUInt16LE(type, 8);
    buf.writeUInt16LE(code, 10);
    buf.writeInt32LE(value, 12);
  }
  return buf;
}

const IGNORED_DEVICE_NAME_RE =
  /\b(power button|sleep button|lid switch|video bus|pc speaker|hda\b|hdmi|displayport|microphone|headphone|webcam|camera|mouse|touchpad|trackpad)\b/i;

/**
 * Parses `/proc/bus/input/devices` and identifies candidate keyboard/gamepad/arcade evdev nodes.
 */
export function parseProcBusInputDevices(text) {
  const blocks = String(text || '')
    .trim()
    .split(/\r?\n\r?\n+/);
  const devices = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    let name = '';
    let handlers = [];
    let evMask = 0n;
    let keyMask = '';
    let absMask = '';

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('N: Name=')) {
        name = line.slice('N: Name='.length).trim().replace(/^"|"$/g, '');
      } else if (line.startsWith('H: Handlers=')) {
        handlers = line.slice('H: Handlers='.length).trim().split(/\s+/).filter(Boolean);
      } else if (line.startsWith('B: EV=')) {
        const hex = line.slice('B: EV='.length).trim();
        try {
          evMask = BigInt('0x' + hex);
        } catch {
          evMask = 0n;
        }
      } else if (line.startsWith('B: KEY=')) {
        keyMask = line.slice('B: KEY='.length).trim();
      } else if (line.startsWith('B: ABS=')) {
        absMask = line.slice('B: ABS='.length).trim();
      }
    }

    const eventHandler = handlers.find((h) => /^event\d+$/.test(h));
    if (!eventHandler) continue;

    const hasEvKey = (evMask & (1n << BigInt(EV_KEY))) !== 0n;
    const hasEvAbs = (evMask & (1n << BigInt(EV_ABS))) !== 0n;
    const isKeyboard = handlers.includes('kbd');
    const isGamepad = handlers.some((h) => /^js\d+$/.test(h)) || (hasEvKey && hasEvAbs && Boolean(absMask));
    const isMouseOnly = handlers.includes('mouse0') || (handlers.some((h) => /^mouse\d+$/.test(h)) && !isKeyboard && !isGamepad);
    const ignoredByName = IGNORED_DEVICE_NAME_RE.test(name);

    devices.push({
      name: name || eventHandler,
      eventHandler,
      devicePath: `/dev/input/${eventHandler}`,
      handlers,
      hasEvKey,
      hasEvAbs,
      hasKeyMask: Boolean(keyMask && keyMask !== '0'),
      isKeyboard,
      isGamepad,
      recommended: !ignoredByName && !isMouseOnly && (isKeyboard || isGamepad),
    });
  }

  return devices;
}

/** Filters candidate input devices according to optional `deviceMatch` substring/regex rules. */
export function selectInputDevices(devices, deviceMatch = []) {
  if (Array.isArray(deviceMatch) && deviceMatch.length > 0) {
    const needles = deviceMatch.map((m) => String(m).toLowerCase()).filter(Boolean);
    return devices.filter((dev) => {
      const hay = `${dev.name} ${dev.devicePath} ${dev.eventHandler}`.toLowerCase();
      return needles.some((n) => hay.includes(n));
    });
  }
  return devices.filter((dev) => dev.recommended);
}

/** Reads `PORT` and `HOST_PIN` safely from `/etc/jkbox/jkbox.env` without executing shell code. */
export function loadJkboxEnv(envFile = process.env.JKBOX_ENV_FILE || '/etc/jkbox/jkbox.env') {
  const result = {};
  if (!envFile || !fs.existsSync(envFile)) return result;
  let content;
  try {
    content = fs.readFileSync(envFile, 'utf8');
  } catch {
    return result;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export function loadDefaultButtonsConfig() {
  const defaultPath = path.resolve(import.meta.dirname, '..', 'buttons.default.json');
  return JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
}

const DEFAULT_LOOPBACK_WS_URLS = new Set([
  'ws://127.0.0.1/ws',
  'ws://127.0.0.1:80/ws',
  'ws://127.0.0.1:3000/ws',
]);

const buildLocalWsUrl = (port) => (port === 80 ? 'ws://127.0.0.1/ws' : `ws://127.0.0.1:${port}/ws`);

/** Merges user config with defaults and flattens the active key/axis -> command map. */
export function resolveButtonsConfig(userConfig = {}, env = loadJkboxEnv()) {
  const base = loadDefaultButtonsConfig();
  const merged = {
    ...base,
    ...userConfig,
    absAxes: { ...base.absAxes, ...(userConfig.absAxes || {}) },
    profiles: { ...base.profiles, ...(userConfig.profiles || {}) },
  };

  const hasCustomWsUrl = Boolean(userConfig.wsUrl && !DEFAULT_LOOPBACK_WS_URLS.has(userConfig.wsUrl));
  const rawPort = env.PORT || process.env.PORT || '';
  if (!hasCustomWsUrl && rawPort) {
    const port = Number.parseInt(rawPort, 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      merged.wsUrl = buildLocalWsUrl(port);
    }
  }

  const keyMap = new Map();
  const addProfileKeys = (profileObj) => {
    if (!profileObj || typeof profileObj !== 'object') return;
    const keys = profileObj.keys || profileObj;
    for (const [token, action] of Object.entries(keys)) {
      const normToken = normalizeToken(token);
      const normAction = String(action || '').trim().toUpperCase();
      if (normToken && ALL_ACTIONS.includes(normAction)) {
        keyMap.set(normToken, normAction);
      }
    }
  };

  if (merged.activeProfile === 'auto') {
    for (const profile of Object.values(merged.profiles)) {
      addProfileKeys(profile);
    }
  } else if (merged.profiles[merged.activeProfile]) {
    addProfileKeys(merged.profiles[merged.activeProfile]);
  }

  if (merged.keys && typeof merged.keys === 'object') {
    addProfileKeys(merged.keys);
  }

  return { config: merged, keyMap };
}

export function normalizeToken(token) {
  const raw = String(token || '').trim().toUpperCase();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) {
    const code = Number.parseInt(raw, 10);
    return CODE_TO_KEY_NAME[code] || `KEY_CODE_${code}`;
  }
  return raw;
}

export function keyCodeToToken(code) {
  return CODE_TO_KEY_NAME[code] || `KEY_CODE_${code}`;
}

/**
 * Classifies an `EV_ABS` reading into `-1`, `0`, or `+1` direction using configured
 * axis center/deadzone or smart auto-detection for Zero Delay (0..255) and HID (-1..1 / -32768..32767).
 */
export function classifyAbsAxisValue(code, value, absAxes = {}, axisState = {}) {
  const cfg = absAxes[String(code)];
  if (cfg && Number.isFinite(cfg.center) && Number.isFinite(cfg.deadzone)) {
    // Auto-adapt if a device reports negative/wide signed values despite default 0..255 config.
    if (value < 0 || value > 255) {
      axisState.sawSignedOrWide = true;
    }
    if (!axisState.sawSignedOrWide) {
      if (value <= cfg.center - cfg.deadzone) return -1;
      if (value >= cfg.center + cfg.deadzone) return 1;
      return 0;
    }
  }

  if (code === ABS_HAT0X || code === ABS_HAT0Y) {
    if (value <= -1) return -1;
    if (value >= 1) return 1;
    return 0;
  }

  if (value < 0 || value > 255) {
    axisState.sawSignedOrWide = true;
  }
  if (axisState.sawSignedOrWide) {
    if (value <= -16000) return -1;
    if (value >= 16000) return 1;
    return 0;
  }

  if (value <= 64) return -1;
  if (value >= 192) return 1;
  return 0;
}

/**
 * Stateful hardware input processor:
 * - Leading-edge + trailing-settle debounce (30-50ms default 40ms)
 * - Long press: SELECT (>= 1000ms) -> BACK, PLAY (>= 1500ms) -> SKIP
 * - Combo: LEFT + RIGHT (>= 2000ms) -> MENU
 * - Directional hold repeat (320ms delay / 110ms interval)
 * - Volume commands routed to `onVolume` (`wpctl`)
 */
export function createButtonProcessor(options) {
  const {
    keyMap,
    absAxes = {},
    debounceMs = 40,
    longPressSelectMs = 1000,
    longPressPlayMs = 1500,
    menuComboHoldMs = 2000,
    repeatDelayMs = 320,
    repeatIntervalMs = 110,
    emitPhases = false,
    onCommand,
    onVolume,
    onPhase,
    now = () => Date.now(),
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = (id) => globalThis.clearTimeout(id),
  } = options;

  const debouncers = new Map();
  const absTrackers = new Map();
  const pressedActions = new Set();
  const repeatTimers = new Map();

  let selectTimer = null;
  let selectLongFired = false;
  let playTimer = null;
  let playLongFired = false;
  let menuTimer = null;
  let menuComboFired = false;

  const clearActionTimer = (ref) => {
    if (ref !== null) clearTimer(ref);
    return null;
  };

  const stopRepeat = (action) => {
    const t = repeatTimers.get(action);
    if (t !== undefined) {
      clearTimer(t);
      repeatTimers.delete(action);
    }
  };

  const startRepeat = (action) => {
    stopRepeat(action);
    if (!DIRECTIONAL_COMMANDS.has(action) || repeatDelayMs <= 0 || repeatIntervalMs <= 0) return;
    const scheduleNext = (delay) => {
      const id = setTimer(() => {
        if (!pressedActions.has(action)) {
          repeatTimers.delete(action);
          return;
        }
        if (!(pressedActions.has('LEFT') && pressedActions.has('RIGHT'))) {
          emitCommand(action);
        }
        scheduleNext(repeatIntervalMs);
      }, delay);
      repeatTimers.set(action, id);
    };
    scheduleNext(repeatDelayMs);
  };

  const emitCommand = (cmd) => {
    if (VOLUME_COMMAND_SET.has(cmd)) {
      onVolume?.(cmd);
      return;
    }
    if (KIOSK_COMMAND_SET.has(cmd)) {
      onCommand?.(cmd);
    }
  };

  const handleActionTransition = (action, isDown) => {
    if (VOLUME_COMMAND_SET.has(action)) {
      if (isDown) onVolume?.(action);
      return;
    }
    if (!KIOSK_COMMAND_SET.has(action)) return;

    if (emitPhases) {
      if (isDown && !pressedActions.has(action)) {
        pressedActions.add(action);
        onPhase?.(action, 'down');
      } else if (!isDown && pressedActions.has(action)) {
        pressedActions.delete(action);
        onPhase?.(action, 'up');
      }
      return;
    }

    if (isDown) {
      if (pressedActions.has(action)) return;
      pressedActions.add(action);

      if (action === 'SELECT') {
        selectLongFired = false;
        selectTimer = clearActionTimer(selectTimer);
        selectTimer = setTimer(() => {
          selectTimer = null;
          selectLongFired = true;
          emitCommand('BACK');
        }, longPressSelectMs);
        return;
      }

      if (action === 'PLAY') {
        playLongFired = false;
        playTimer = clearActionTimer(playTimer);
        playTimer = setTimer(() => {
          playTimer = null;
          playLongFired = true;
          emitCommand('SKIP');
        }, longPressPlayMs);
        return;
      }

      if (action === 'LEFT' || action === 'RIGHT') {
        if (pressedActions.has('LEFT') && pressedActions.has('RIGHT')) {
          menuComboFired = false;
          menuTimer = clearActionTimer(menuTimer);
          stopRepeat('LEFT');
          stopRepeat('RIGHT');
          menuTimer = setTimer(() => {
            menuTimer = null;
            menuComboFired = true;
            emitCommand('MENU');
          }, menuComboHoldMs);
          return;
        }
        emitCommand(action);
        startRepeat(action);
        return;
      }

      emitCommand(action);
      startRepeat(action);
      return;
    }

    // Release (isDown === false)
    if (!pressedActions.has(action)) return;
    pressedActions.delete(action);
    stopRepeat(action);

    if (action === 'SELECT') {
      selectTimer = clearActionTimer(selectTimer);
      const fireShort = !selectLongFired;
      selectLongFired = false;
      if (fireShort) emitCommand('SELECT');
      return;
    }

    if (action === 'PLAY') {
      playTimer = clearActionTimer(playTimer);
      const fireShort = !playLongFired;
      playLongFired = false;
      if (fireShort) emitCommand('PLAY');
      return;
    }

    if (action === 'LEFT' || action === 'RIGHT') {
      menuTimer = clearActionTimer(menuTimer);
      if (!pressedActions.has('LEFT') && !pressedActions.has('RIGHT')) {
        menuComboFired = false;
      }
    }
  };

  const pushDebounced = (physicalKey, action, isDown) => {
    let entry = debouncers.get(physicalKey);
    if (!entry) {
      entry = { accepted: false, latestRaw: false, lastTransitionAt: -Infinity, timer: null };
      debouncers.set(physicalKey, entry);
    }

    entry.latestRaw = isDown;
    const t = now();
    const elapsed = t - entry.lastTransitionAt;

    if (isDown === entry.accepted) {
      return;
    }

    if (elapsed >= debounceMs) {
      if (entry.timer !== null) {
        clearTimer(entry.timer);
        entry.timer = null;
      }
      entry.accepted = isDown;
      entry.lastTransitionAt = t;
      handleActionTransition(action, isDown);
      return;
    }

    if (entry.timer === null) {
      const waitMs = Math.max(1, debounceMs - elapsed);
      entry.timer = setTimer(() => {
        entry.timer = null;
        if (entry.latestRaw !== entry.accepted) {
          entry.accepted = entry.latestRaw;
          entry.lastTransitionAt = now();
          handleActionTransition(action, entry.accepted);
        }
      }, waitMs);
    }
  };

  const processEvent = (deviceId, ev) => {
    if (!ev) return;

    if (ev.type === EV_KEY) {
      if (ev.value === 2) return; // Kernel key auto-repeat is managed via debounce/repeat timers.
      const token = keyCodeToToken(ev.code);
      const action = keyMap.get(token) || keyMap.get(`KEY_CODE_${ev.code}`);
      if (!action) return;
      pushDebounced(`${deviceId}:K:${ev.code}`, action, ev.value !== 0);
      return;
    }

    if (ev.type === EV_ABS) {
      const axisName = ABS_AXIS_NAMES[ev.code];
      if (!axisName) return;
      const trackerKey = `${deviceId}:A:${ev.code}`;
      let tracker = absTrackers.get(trackerKey);
      if (!tracker) {
        tracker = { dir: 0, sawSignedOrWide: false };
        absTrackers.set(trackerKey, tracker);
      }

      const nextDir = classifyAbsAxisValue(ev.code, ev.value, absAxes, tracker);
      if (nextDir === tracker.dir) return;

      const prevDir = tracker.dir;
      tracker.dir = nextDir;

      if (prevDir === -1) {
        const negAction = keyMap.get(`${axisName}_NEG`);
        if (negAction) pushDebounced(`${trackerKey}:NEG`, negAction, false);
      } else if (prevDir === 1) {
        const posAction = keyMap.get(`${axisName}_POS`);
        if (posAction) pushDebounced(`${trackerKey}:POS`, posAction, false);
      }

      if (nextDir === -1) {
        const negAction = keyMap.get(`${axisName}_NEG`);
        if (negAction) pushDebounced(`${trackerKey}:NEG`, negAction, true);
      } else if (nextDir === 1) {
        const posAction = keyMap.get(`${axisName}_POS`);
        if (posAction) pushDebounced(`${trackerKey}:POS`, posAction, true);
      }
    }
  };

  const reset = () => {
    selectTimer = clearActionTimer(selectTimer);
    playTimer = clearActionTimer(playTimer);
    menuTimer = clearActionTimer(menuTimer);
    selectLongFired = false;
    playLongFired = false;
    menuComboFired = false;
    pressedActions.clear();
    for (const id of repeatTimers.values()) clearTimer(id);
    repeatTimers.clear();
    for (const entry of debouncers.values()) {
      if (entry.timer !== null) clearTimer(entry.timer);
    }
    debouncers.clear();
    absTrackers.clear();
  };

  return { processEvent, reset };
}

/** Builds the `wpctl` CLI argument vector for a volume command. */
export function buildWpctlArgs(command, { step = '5%', maxVolume = '1.0', sink = '@DEFAULT_AUDIO_SINK@' } = {}) {
  switch (command) {
    case 'VOL_UP':
      return ['set-volume', '-l', String(maxVolume), sink, `${step}+`];
    case 'VOL_DOWN':
      return ['set-volume', sink, `${step}-`];
    case 'MUTE':
      return ['set-mute', sink, 'toggle'];
    default:
      return null;
  }
}
