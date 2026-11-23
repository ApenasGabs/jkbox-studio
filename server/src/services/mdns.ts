import { execFile } from 'node:child_process';
import dgram, { type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { Settings } from '../db.js';
import {
  buildMdnsAResponse,
  buildMdnsServiceResponse,
  buildMdnsUrl,
  DEFAULT_MDNS_HOSTNAME,
  isValidMdnsHostname,
  matchesMdnsQuery,
  MdnsError,
  normalizeMdnsHostname,
  parseMdnsQuestions,
} from '../lib/mdns.js';

const execFileAsync = promisify(execFile);

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

export type MdnsMode = 'os-helper' | 'embedded' | 'disabled';

export interface MdnsStatus {
  hostname: string;
  fqdn: string;
  url: string;
  enabled: boolean;
  active: boolean;
  mode: MdnsMode;
  useForQr: boolean;
  dockerBridgeHint: boolean;
  lastError: string | null;
}

export interface MdnsOptions {
  port: number;
  defaultHostname?: string;
  enabled?: boolean;
  hostnameHelper?: string;
  settings?: Settings;
  log?: (msg: string) => void;
  /** Overridable for tests. */
  getIpv4Addresses?: () => string[];
  /** Overridable for tests. */
  runHelper?: (helperPath: string, hostname: string) => Promise<void>;
  /** Overridable for tests. */
  detectDockerBridge?: () => boolean;
  /** Overridable for tests. */
  createSocket?: () => Socket;
}

export const listLanIpv4Addresses = (): string[] => {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        ips.push(entry.address);
      }
    }
  }
  return [...new Set(ips)];
};

export const detectDockerBridgeNetwork = (ips: string[] = listLanIpv4Addresses()): boolean => {
  if (!fs.existsSync('/.dockerenv')) return false;
  if (ips.length === 0) return true;
  // Default Docker bridge subnets live in 172.17.0.0/16 - 172.31.0.0/16 with a single veth.
  return ips.length === 1 && /^172\.(1[6-9]|2\d|3[0-1])\./.test(ips[0]!);
};

const defaultRunHelper = async (helperPath: string, hostname: string): Promise<void> => {
  const safe = normalizeMdnsHostname(hostname);
  const useSudo = typeof process.getuid === 'function' && process.getuid() !== 0;
  if (useSudo) {
    await execFileAsync('sudo', ['-n', helperPath, safe], { timeout: 10_000 });
  } else {
    await execFileAsync(helperPath, [safe], { timeout: 10_000 });
  }
};

export interface MdnsEvents {
  change: [status: MdnsStatus];
}

/**
 * Announces `<hostname>.local` and `_http._tcp.local` on the LAN via embedded
 * RFC 6762/6763 mDNS responder and/or delegates OS updates to `os/jkbox-hostname.sh`.
 */
export class MdnsService extends EventEmitter<MdnsEvents> {
  private hostname: string;
  private useForQr: boolean;
  private socket: Socket | null = null;
  private active = false;
  private lastError: string | null = null;
  private readonly enabled: boolean;
  private readonly port: number;
  private readonly hostnameHelper: string;
  private readonly settings?: Settings;
  private readonly log: (msg: string) => void;
  private readonly getIpv4Addresses: () => string[];
  private readonly runHelper: (helperPath: string, hostname: string) => Promise<void>;
  private readonly detectDockerBridge: () => boolean;
  private readonly createSocket: () => Socket;

  constructor(options: MdnsOptions) {
    super();
    this.port = options.port;
    this.enabled = options.enabled ?? true;
    this.hostnameHelper = (options.hostnameHelper ?? '').trim();
    this.settings = options.settings;
    this.log = options.log ?? console.log;
    this.getIpv4Addresses = options.getIpv4Addresses ?? listLanIpv4Addresses;
    this.runHelper = options.runHelper ?? defaultRunHelper;
    this.detectDockerBridge = options.detectDockerBridge ?? (() => detectDockerBridgeNetwork(this.getIpv4Addresses()));
    this.createSocket = options.createSocket ?? (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));

    const saved = this.settings?.get<string>('mdns_hostname');
    const fallback = isValidMdnsHostname(options.defaultHostname)
      ? normalizeMdnsHostname(options.defaultHostname)
      : DEFAULT_MDNS_HOSTNAME;
    this.hostname = isValidMdnsHostname(saved) ? normalizeMdnsHostname(saved) : fallback;
    this.useForQr = this.settings?.get<boolean>('mdns_use_for_qr') ?? false;
  }

  get mode(): MdnsMode {
    if (!this.enabled) return 'disabled';
    if (this.hostnameHelper) return 'os-helper';
    return 'embedded';
  }

  status(): MdnsStatus {
    const fqdn = `${this.hostname}.local`;
    return {
      hostname: this.hostname,
      fqdn,
      url: buildMdnsUrl(this.hostname, this.port),
      enabled: this.enabled,
      active: this.active,
      mode: this.mode,
      useForQr: this.useForQr,
      dockerBridgeHint: this.mode === 'embedded' && this.detectDockerBridge(),
      lastError: this.lastError,
    };
  }

  private cleanupSocket(sock: Socket): void {
    if (this.socket === sock) this.socket = null;
    try {
      sock.close();
    } catch {
      // ignore close errors during cleanup
    }
  }

  start(): void {
    if (!this.enabled) {
      this.active = false;
      return;
    }
    if (this.hostnameHelper) {
      this.active = true;
      this.lastError = null;
      return;
    }
    if (this.socket) return;

    let sock: Socket | null = null;
    try {
      sock = this.createSocket();
      this.socket = sock;
      sock.on('error', (err) => {
        this.lastError = err.message;
        this.active = false;
        this.cleanupSocket(sock!);
        this.log(`[jkbox] mDNS aviso: ${err.message}`);
      });
      sock.on('message', (msg) => {
        const questions = parseMdnsQuestions(msg);
        const match = matchesMdnsQuery(questions, this.hostname);
        if (match === 'service') {
          this.announceService();
        } else if (match === 'a') {
          this.announce();
        }
      });
      sock.bind(MDNS_PORT, () => {
        try {
          sock!.addMembership(MDNS_ADDR);
          sock!.setMulticastTTL(255);
          sock!.setMulticastLoopback(true);
          this.active = true;
          this.lastError = null;
          this.announceService();
          this.log(`[jkbox] mDNS ativo: ${buildMdnsUrl(this.hostname, this.port)}`);
        } catch (err) {
          this.lastError = (err as Error).message;
          this.active = false;
          this.cleanupSocket(sock!);
          this.log(`[jkbox] mDNS multicast indisponível: ${this.lastError}`);
        }
      });
    } catch (err) {
      if (sock) this.cleanupSocket(sock);
      else this.socket = null;
      this.lastError = (err as Error).message;
      this.active = false;
      this.log(`[jkbox] mDNS indisponível: ${this.lastError}`);
    }
  }

  private sendMulticast(packet: Buffer): void {
    if (!this.socket || !this.active) return;
    this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, (err) => {
      if (err) this.lastError = err.message;
    });
  }

  announce(): void {
    if (!this.socket || !this.active) return;
    const ips = this.getIpv4Addresses();
    if (ips.length === 0) return;
    this.sendMulticast(buildMdnsAResponse(`${this.hostname}.local`, ips));
  }

  announceService(): void {
    if (!this.socket || !this.active) return;
    const ips = this.getIpv4Addresses();
    if (ips.length === 0) return;
    this.sendMulticast(buildMdnsServiceResponse(this.hostname, this.port, ips));
  }

  async update(patch: { hostname?: unknown; useForQr?: unknown }): Promise<MdnsStatus> {
    let nextHostname = this.hostname;
    let hostnameChanged = false;
    let useForQrChanged = false;

    if (patch.hostname !== undefined) {
      nextHostname = normalizeMdnsHostname(patch.hostname);
      hostnameChanged = nextHostname !== this.hostname;
    }

    if (patch.useForQr !== undefined) {
      if (typeof patch.useForQr !== 'boolean') {
        throw new MdnsError('useForQr deve ser booleano');
      }
      useForQrChanged = patch.useForQr !== this.useForQr;
    }

    if (hostnameChanged && this.hostnameHelper) {
      try {
        await this.runHelper(this.hostnameHelper, nextHostname);
        this.lastError = null;
        this.active = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = message;
        throw new MdnsError(`Falha ao aplicar hostname no sistema: ${message}`, 500);
      }
    }

    if (hostnameChanged) {
      this.hostname = nextHostname;
      this.settings?.set('mdns_hostname', nextHostname);
      if (this.active && this.socket) {
        this.announceService();
      }
    }

    if (typeof patch.useForQr === 'boolean') {
      this.useForQr = patch.useForQr;
      this.settings?.set('mdns_use_for_qr', patch.useForQr);
    }

    const nextStatus = this.status();
    if (hostnameChanged || useForQrChanged) {
      this.emit('change', nextStatus);
    }
    return nextStatus;
  }

  stop(): void {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch {
      // ignore close errors during shutdown
    }
    this.socket = null;
    this.active = false;
  }
}

export { MdnsError };
