import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { resolveButtonsConfig } from '../../os/lib/buttons-core.mjs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  buildLegacyRedirectLocation,
  normalizePublicUrlForPort,
  shouldRedirectLegacyRequest,
  startPort80CompatServers,
} from '../src/lib/port80Compat.js';
import { attachRealtime } from '../src/realtime.js';
import { MdnsService } from '../src/services/mdns.js';
import { setup } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

const reserveEphemeralPort = async (): Promise<number> => {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
};

describe('Port 80 Kiosk defaults, URL normalization, and legacy :3000 compatibility', () => {
  it('parses LEGACY_REDIRECT_PORT and KIOSK_PREFER_PORT_80 in loadConfig', () => {
    const defaults = loadConfig({});
    expect(defaults.port).toBe(3000);
    expect(defaults.legacyRedirectPort).toBeNull();
    expect(defaults.kioskPreferPort80).toBe(false);

    const kioskCfg = loadConfig({
      PORT: '80',
      LEGACY_REDIRECT_PORT: '3000',
      KIOSK_PREFER_PORT_80: 'true',
      PUBLIC_URL: 'http://jkbox.local:80/',
    });
    expect(kioskCfg.port).toBe(80);
    expect(kioskCfg.legacyRedirectPort).toBe(3000);
    expect(kioskCfg.kioskPreferPort80).toBe(true);
    expect(kioskCfg.publicUrl).toBe('http://jkbox.local');
    expect(kioskCfg.spotify.redirectUri).toBe('http://jkbox.local/api/spotify/callback');

    const disabledCfg = loadConfig({ LEGACY_REDIRECT_PORT: '0', KIOSK_PREFER_PORT_80: 'false' });
    expect(disabledCfg.legacyRedirectPort).toBeNull();
    expect(disabledCfg.kioskPreferPort80).toBe(false);
  });

  it('normalizes PUBLIC_URL and legacy redirect URLs safely without open-redirect vulnerabilities', () => {
    expect(normalizePublicUrlForPort('http://192.168.1.50:3000/', 3000, 80)).toBe('http://192.168.1.50');
    expect(normalizePublicUrlForPort('http://jkbox.local:80', 80, 80)).toBe('http://jkbox.local');
    expect(normalizePublicUrlForPort('https://jukebox.apenasgabs.dev:8443/', 3000, 80)).toBe(
      'https://jukebox.apenasgabs.dev:8443',
    );
    expect(normalizePublicUrlForPort('http://192.168.1.50:3000/', 3000, 3000)).toBe('http://192.168.1.50:3000');

    expect(buildLegacyRedirectLocation('jkbox.local:3000', '/remote?pin=1234', 80)).toBe(
      'http://jkbox.local/remote?pin=1234',
    );
    expect(buildLegacyRedirectLocation('192.168.31.10:3000', '/', 80)).toBe('http://192.168.31.10/');
    expect(buildLegacyRedirectLocation('[::1]:3000', '/remote', 80)).toBe('http://[::1]/remote');

    // Prevent protocol-relative //evil.com and invalid Host header injection
    expect(buildLegacyRedirectLocation('jkbox.local:3000', '//evil.example.com/phish', 80)).toBe(
      'http://jkbox.local/evil.example.com/phish',
    );
    expect(buildLegacyRedirectLocation('evil.com/path', '/remote', 80)).toBeNull();
    expect(buildLegacyRedirectLocation('user@evil.com:3000', '/remote', 80)).toBeNull();
    expect(buildLegacyRedirectLocation(undefined, '/remote', 80)).toBeNull();

    expect(shouldRedirectLegacyRequest({ method: 'GET', url: '/remote', headers: {} })).toBe(true);
    expect(shouldRedirectLegacyRequest({ method: 'GET', url: '/api/health', headers: {} })).toBe(false);
    expect(shouldRedirectLegacyRequest({ method: 'POST', url: '/api/library/rescan', headers: {} })).toBe(false);
    expect(shouldRedirectLegacyRequest({ method: 'GET', url: '/ws', headers: { upgrade: 'websocket' } })).toBe(false);
  });

  it('Upgrades legacy buttons.json wsUrl to clean port 80 while preserving custom wsUrls', () => {
    const migrated = resolveButtonsConfig({ wsUrl: 'ws://127.0.0.1:3000/ws' }, { PORT: '80' });
    expect(migrated.config.wsUrl).toBe('ws://127.0.0.1/ws');

    const preserved = resolveButtonsConfig({ wsUrl: 'ws://192.168.1.99:9000/ws' }, { PORT: '80' });
    expect(preserved.config.wsUrl).toBe('ws://192.168.1.99:9000/ws');
  });

  it('serves clean URLs without :3000 in /api/config and mDNS when port 80 is active', async () => {
    const { config, jukebox } = setup({
      PORT: '3000',
      PUBLIC_URL: 'http://192.168.1.42:3000',
      KIOSK_PREFER_PORT_80: 'true',
      HOST_PIN: '1234',
    });
    cleanups.push(() => jukebox.stop());

    // Simulate successful port 80 promotion on Kiosk OS
    const configuredPort = config.port;
    config.port = 80;
    config.publicUrl = normalizePublicUrlForPort(config.publicUrl, configuredPort, 80);

    const mdns = new MdnsService({
      port: config.port,
      defaultHostname: 'jkbox',
      enabled: true,
      hostnameHelper: '/usr/local/bin/jkbox-hostname',
      settings: jukebox.settings,
      detectDockerBridge: () => false,
      getIpv4Addresses: () => ['192.168.1.42'],
    });
    mdns.start();
    cleanups.push(() => mdns.stop());

    const app = createApp({ config, jukebox, mdns });
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.publicUrl).toBe('http://192.168.1.42');
    expect(res.body.mdns.url).toBe('http://jkbox.local');
    expect(res.body.mdns.url).not.toContain(':3000');
    expect(res.body.mdns.url).not.toContain(':80');
  });

  it('binds primary and legacy compatibility ports, redirects browser URLs, serves /api, and shares /ws input', async () => {
    const { config, jukebox } = setup({ HOST_PIN: '1234' });
    cleanups.push(() => jukebox.stop());

    const mockPort80 = await reserveEphemeralPort();
    const mockPort3000 = await reserveEphemeralPort();

    const listeners = await startPort80CompatServers({
      port: mockPort80,
      preferredPort: mockPort80,
      legacyRedirectPort: mockPort3000,
      kioskPreferPort80: true,
      host: '127.0.0.1',
      log: () => {},
      warn: () => {},
    });
    cleanups.push(() => listeners.closeAll());

    expect(listeners.effectivePort).toBe(mockPort80);
    expect(listeners.secondaryPort).toBe(mockPort3000);

    const app = createApp({ config, jukebox });
    listeners.attachApp(app);
    const wss = attachRealtime(listeners.primaryServer, jukebox);
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));

    // 1. Legacy browser GET /remote?pin=1234 redirects 302 to primary port
    const redirectRes = await fetch(`http://127.0.0.1:${mockPort3000}/remote?pin=1234`, {
      redirect: 'manual',
    });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get('location')).toBe(`http://127.0.0.1:${mockPort80}/remote?pin=1234`);

    // 2. Legacy /api/health responds 200 directly without redirect
    const healthRes = await fetch(`http://127.0.0.1:${mockPort3000}/api/health`, {
      redirect: 'manual',
    });
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as { ok: boolean };
    expect(healthBody.ok).toBe(true);

    // 3. WebSocket evdev client on legacy :3000 delivers input to Kiosk WebSocket client on primary port
    const kioskWs = new WebSocket(`ws://127.0.0.1:${mockPort80}/ws`);
    const legacyButtonsWs = new WebSocket(`ws://127.0.0.1:${mockPort3000}/ws`);
    cleanups.push(() => {
      kioskWs.close();
      legacyButtonsWs.close();
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        kioskWs.once('open', () => resolve());
        kioskWs.once('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        legacyButtonsWs.once('open', () => resolve());
        legacyButtonsWs.once('error', reject);
      }),
    ]);

    const receivedInput = new Promise<{ type: string; command: string; source?: string }>((resolve) => {
      kioskWs.on('message', (raw) => {
        const parsed = JSON.parse(String(raw)) as { type: string; command?: string; source?: string };
        if (parsed.type === 'input' && parsed.command) {
          resolve({ type: parsed.type, command: parsed.command, source: parsed.source });
        }
      });
    });

    legacyButtonsWs.send(JSON.stringify({ type: 'input', command: 'SELECT', source: 'evdev' }));
    await expect(receivedInput).resolves.toEqual({ type: 'input', command: 'SELECT', source: 'evdev' });
  });

  it('opportunistically binds preferred port when PORT=3000 comes from copied .env in Kiosk OS', async () => {
    const mockPort80 = await reserveEphemeralPort();
    const mockPort3000 = await reserveEphemeralPort();

    const listeners = await startPort80CompatServers({
      port: mockPort3000,
      preferredPort: mockPort80,
      kioskPreferPort80: true,
      host: '127.0.0.1',
      log: () => {},
      warn: () => {},
    });
    cleanups.push(() => listeners.closeAll());

    expect(listeners.effectivePort).toBe(mockPort80);
    expect(listeners.primaryPort).toBe(mockPort80);
    expect(listeners.secondaryPort).toBe(mockPort3000);
  });

  it('falls back gracefully without crashing on EACCES or EADDRINUSE on port 80 or legacy port', async () => {
    const warnings: string[] = [];
    const fallbackPort = await reserveEphemeralPort();

    // Case 1: PORT=80 fails with EACCES -> falls back to 3000
    const listenersEacces = await startPort80CompatServers({
      port: 80,
      preferredPort: 80,
      legacyRedirectPort: fallbackPort,
      kioskPreferPort80: true,
      host: '127.0.0.1',
      log: () => {},
      warn: (msg) => warnings.push(msg),
      listenServer: async (srv, targetPort, host) => {
        if (targetPort === 80) {
          throw Object.assign(new Error('listen EACCES: permission denied 0.0.0.0:80'), { code: 'EACCES' });
        }
        await new Promise<void>((resolve) => srv.listen(targetPort, host, resolve));
        return (srv.address() as AddressInfo).port;
      },
    });
    cleanups.push(() => listenersEacces.closeAll());

    expect(listenersEacces.effectivePort).toBe(fallbackPort);
    expect(listenersEacces.secondaryPort).toBeNull();
    expect(warnings.some((w) => w.includes('EACCES'))).toBe(true);

    // Case 2: Occupied legacy redirect port (EADDRINUSE) -> primary stays online, logs warning
    const blocker = http.createServer((_req, res) => res.end('busy'));
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const occupiedLegacyPort = (blocker.address() as AddressInfo).port;
    const primaryPort = await reserveEphemeralPort();

    const warnSpy = vi.fn();
    const listenersBusyLegacy = await startPort80CompatServers({
      port: primaryPort,
      preferredPort: primaryPort,
      legacyRedirectPort: occupiedLegacyPort,
      kioskPreferPort80: true,
      host: '127.0.0.1',
      log: () => {},
      warn: warnSpy,
    });
    cleanups.push(() => listenersBusyLegacy.closeAll());

    expect(listenersBusyLegacy.effectivePort).toBe(primaryPort);
    expect(listenersBusyLegacy.secondaryPort).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('EADDRINUSE');
  });
});
