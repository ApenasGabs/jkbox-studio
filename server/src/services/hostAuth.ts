import { randomInt, timingSafeEqual } from 'node:crypto';
export interface HostAuthSettings {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

/** In-memory fallback (tests / jukebox without persistent settings). */
export function memorySettings(): HostAuthSettings {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => (map.has(key) ? (map.get(key) as T) : null),
    set: (key: string, value: unknown) => void map.set(key, value),
  };
}

export const HOST_PIN_KEY = 'host_pin';
export const HOST_PIN_ENABLED_KEY = 'host_pin_enabled';
export const HOST_PIN_RE = /^\d{4,8}$/;

export type HostPinSource = 'env' | 'auto' | 'none';

export interface HostPinStatus {
  /** Effective PIN ('' when Host protection is off). */
  pin: string;
  source: HostPinSource;
  enabled: boolean;
  /** false when the PIN comes from HOST_PIN in the environment (read-only in the UI). */
  editable: boolean;
}

export class HostAuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const generateHostPin = (): string => String(randomInt(0, 10_000)).padStart(4, '0');

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Separates the Main Controller (Host) from Guests.
 * - HOST_PIN set in the env always wins (never overwritten).
 * - Otherwise a 4-digit PIN is generated once and persisted in `settings`, so guests scanning the
 *   default QR (`/remote`) never get Host powers by accident. The Host can edit or disable it.
 */
export class HostAuth {
  constructor(
    private readonly envPin: string,
    private readonly settings: HostAuthSettings,
    private readonly autoGenerate = true,
    private readonly generate: () => string = generateHostPin,
  ) {
    if (!this.envPin && this.autoGenerate && this.enabled && !this.storedPin()) {
      this.settings.set(HOST_PIN_KEY, this.generate());
    }
  }

  private storedPin(): string {
    const value = this.settings.get<string>(HOST_PIN_KEY);
    return typeof value === 'string' && HOST_PIN_RE.test(value) ? value : '';
  }

  get source(): HostPinSource {
    if (this.envPin) return 'env';
    return this.enabled && this.storedPin() ? 'auto' : 'none';
  }

  get enabled(): boolean {
    if (this.envPin) return true;
    if (!this.autoGenerate) return Boolean(this.storedPin()) && this.settings.get<boolean>(HOST_PIN_ENABLED_KEY) !== false;
    return this.settings.get<boolean>(HOST_PIN_ENABLED_KEY) !== false;
  }

  /** Effective PIN; '' means every client is treated as Host (legacy behaviour, opt-in only). */
  get pin(): string {
    if (this.envPin) return this.envPin;
    return this.enabled ? this.storedPin() : '';
  }

  get required(): boolean {
    return Boolean(this.pin);
  }

  verify(candidate: unknown): boolean {
    const pin = this.pin;
    if (!pin) return true;
    return typeof candidate === 'string' && safeEqual(candidate, pin);
  }

  status(): HostPinStatus {
    return { pin: this.pin, source: this.source, enabled: this.enabled, editable: !this.envPin };
  }

  update(patch: { pin?: unknown; enabled?: unknown }): HostPinStatus {
    if (this.envPin) throw new HostAuthError('PIN definido por HOST_PIN no .env — edite o arquivo para alterá-lo', 409);
    const { pin, enabled } = patch;
    if (pin === undefined && enabled === undefined) throw new HostAuthError('Informe pin ou enabled');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new HostAuthError('enabled deve ser booleano');
    if (pin !== undefined && (typeof pin !== 'string' || !HOST_PIN_RE.test(pin.trim()))) {
      throw new HostAuthError('PIN deve ter de 4 a 8 dígitos numéricos');
    }
    if (typeof pin === 'string') this.settings.set(HOST_PIN_KEY, pin.trim());
    if (enabled !== undefined) {
      this.settings.set(HOST_PIN_ENABLED_KEY, enabled);
      if (enabled && !this.storedPin()) this.settings.set(HOST_PIN_KEY, this.generate());
    }
    return this.status();
  }
}
