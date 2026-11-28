import { EventEmitter } from 'node:events';
import type { Socket } from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type os from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import {
  buildLanUrl,
  isPrivateIpv4,
  listLanIpv4Addresses,
  parseDefaultRouteInterfaces,
  resolveEffectivePublicUrl,
} from '../src/lib/networkUrl.js';
import { attachRealtime, type ServerMessage } from '../src/realtime.js';
import { MdnsService } from '../src/services/mdns.js';
import { setup } from './helpers.js';

const ipv4Entry = (address: string, internal = false): os.NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:11:22:33:44:55',
  internal,
  cidr: `${address}/24`,
});

const ipv6Entry = (address: string): os.NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:11:22:33:44:55',
  internal: false,
  scopeid: 0,
  cidr: `${address}/64`,
});

const waitForWsMessage = <T extends ServerMessage>(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => msg is T,
): Promise<T> =>
  new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(String(raw)) as ServerMessage;
      if (predicate(parsed)) {
        ws.off('message', onMessage);
        resolve(parsed);
      }
    };
    ws.on('message', onMessage);
  });

let activeServer: http.Server | null = null;
afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (!activeServer) {
        resolve();
        return;
      }
      const srv = activeServer;
      activeServer = null;
      srv.close(() => resolve());
    }),
);

describe('networkUrl — dynamic LAN IPv4 detection & PUBLIC_URL validation', () => {
  it('filters virtual/bridge/loopback/APIPA interfaces and prioritizes physical LAN/Wi-Fi over VPN overlays', () => {
    const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      lo: [ipv4Entry('127.0.0.1', true)],
      docker0: [ipv4Entry('172.17.0.1')],
      'br-8f91c2a0': [ipv4Entry('172.18.0.1')],
      veth9a1b2c: [ipv4Entry('172.18.0.14')],
      virbr0: [ipv4Entry('192.168.122.1')],
      cni0: [ipv4Entry('10.244.0.1')],
      'flannel.1': [ipv4Entry('10.244.1.0')],
      tailscale0: [ipv4Entry('100.101.102.103')],
      wlan0: [ipv6Entry('fe80::1'), ipv4Entry('169.254.12.34'), ipv4Entry('192.168.31.42')],
      enp3s0: [ipv4Entry('192.168.31.10')],
    };

    const ips = listLanIpv4Addresses({ interfaces, routeTable: null });
    expect(ips).toEqual(['192.168.31.10', '192.168.31.42', '100.101.102.103']);
  });

  it('prioritizes the active Linux default-route interface from /proc/net/route by lowest metric', () => {
    const routeTable = [
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
      'docker0\t0011AC00\t00000000\t0001\t0\t0\t0\t00FFFF00\t0\t0\t0',
      'enp3s0\t00000000\t011FA8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
      'wlp2s0\t00000000\t011FA8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    ].join('\n');

    expect(parseDefaultRouteInterfaces(routeTable)).toEqual(['wlp2s0', 'enp3s0']);

    const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      enp3s0: [ipv4Entry('192.168.31.10')],
      wlp2s0: [ipv4Entry('192.168.31.77')],
      docker0: [ipv4Entry('172.17.0.1')],
    };

    expect(listLanIpv4Addresses({ interfaces, routeTable })).toEqual(['192.168.31.77', '192.168.31.10']);
  });

  it('formats lanUrl with :port and omits :80 when running on port 80', () => {
    expect(buildLanUrl('192.168.31.42', 3000)).toBe('http://192.168.31.42:3000');
    expect(buildLanUrl('192.168.31.42', 80)).toBe('http://192.168.31.42');
    expect(buildLanUrl(null, 80)).toBeNull();
    expect(buildLanUrl('', 3000)).toBeNull();
  });

  it('identifies RFC 1918 private IPv4 literals accurately', () => {
    expect(isPrivateIpv4('10.0.0.1')).toBe(true);
    expect(isPrivateIpv4('172.16.0.1')).toBe(true);
    expect(isPrivateIpv4('172.31.255.254')).toBe(true);
    expect(isPrivateIpv4('192.168.15.99')).toBe(true);

    expect(isPrivateIpv4('172.15.255.1')).toBe(false);
    expect(isPrivateIpv4('172.32.0.1')).toBe(false);
    expect(isPrivateIpv4('100.64.1.2')).toBe(false);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(isPrivateIpv4('jkbox.local')).toBe(false);
  });

  it('discards orphan RFC 1918 PUBLIC_URL in favor of detected lanUrl and emits publicUrlWarning', () => {
    const orphan192 = resolveEffectivePublicUrl({
      publicUrl: 'http://192.168.0.99:3000/',
      port: 3000,
      lanIps: ['192.168.31.42'],
    });
    expect(orphan192).toEqual({
      publicUrl: 'http://192.168.31.42:3000',
      lanIps: ['192.168.31.42'],
      lanUrl: 'http://192.168.31.42:3000',
      publicUrlWarning: expect.stringContaining('192.168.0.99'),
    });

    const orphanPort80 = resolveEffectivePublicUrl({
      publicUrl: 'http://10.0.0.55:3000',
      port: 80,
      lanIps: ['192.168.15.20'],
    });
    expect(orphanPort80.publicUrl).toBe('http://192.168.15.20');
    expect(orphanPort80.lanUrl).toBe('http://192.168.15.20');
    expect(orphanPort80.publicUrlWarning).toContain('10.0.0.55');

    const orphanOffline = resolveEffectivePublicUrl({
      publicUrl: 'http://172.20.10.2:3000',
      port: 3000,
      lanIps: [],
    });
    expect(orphanOffline.publicUrl).toBeNull();
    expect(orphanOffline.lanUrl).toBeNull();
    expect(orphanOffline.publicUrlWarning).toContain('172.20.10.2');
  });

  it('preserves PUBLIC_URL when pointing to an external domain, .local host, or an active host IP', () => {
    const externalHttps = resolveEffectivePublicUrl({
      publicUrl: 'https://jukebox.apenasgabs.dev/',
      port: 3000,
      lanIps: ['192.168.31.42'],
    });
    expect(externalHttps).toEqual({
      publicUrl: 'https://jukebox.apenasgabs.dev',
      lanIps: ['192.168.31.42'],
      lanUrl: 'http://192.168.31.42:3000',
      publicUrlWarning: null,
    });

    const localDomain = resolveEffectivePublicUrl({
      publicUrl: 'http://meuhost.local:3000',
      port: 3000,
      lanIps: ['192.168.31.42'],
    });
    expect(localDomain.publicUrl).toBe('http://meuhost.local:3000');
    expect(localDomain.publicUrlWarning).toBeNull();

    const activeHostIp = resolveEffectivePublicUrl({
      publicUrl: 'http://192.168.31.88:3000',
      port: 3000,
      lanIps: ['192.168.31.42', '192.168.31.88'],
    });
    expect(activeHostIp.publicUrl).toBe('http://192.168.31.88:3000');
    expect(activeHostIp.publicUrlWarning).toBeNull();
  });

  it('exposes lanIps, lanUrl, and publicUrlWarning in GET /api/config and logs warning', async () => {
    const { config, jukebox } = setup({ PUBLIC_URL: 'http://192.168.99.200:3000', PORT: '80' });
    const warnings: string[] = [];
    const app = createApp({
      config,
      jukebox,
      getLanIps: () => ['192.168.31.55'],
      warn: (msg) => warnings.push(msg),
    });

    try {
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.lanIps).toEqual(['192.168.31.55']);
      expect(res.body.lanUrl).toBe('http://192.168.31.55');
      expect(res.body.publicUrl).toBe('http://192.168.31.55');
      expect(res.body.publicUrlWarning).toContain('192.168.99.200');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('192.168.99.200');
    } finally {
      jukebox.stop();
    }
  });

  it('broadcasts live WebSocket network updates and re-announces mDNS when Wi-Fi connects after boot', async () => {
    const { config, jukebox } = setup({ PUBLIC_URL: 'http://192.168.0.123:3000', PORT: '3000' });
    let currentIps: string[] = [];
    const sentMulticastPackets: Buffer[] = [];

    const createSocket = vi.fn(() => {
      const sock = Object.assign(new EventEmitter(), {
        bind: vi.fn((_port: number, cb?: () => void) => cb?.()),
        close: vi.fn(),
        send: vi.fn((buf: Buffer, _offset: number, _len: number, _port: number, _addr: string, cb?: (err: Error | null) => void) => {
          sentMulticastPackets.push(Buffer.from(buf));
          cb?.(null);
        }),
        addMembership: vi.fn(),
        setMulticastTTL: vi.fn(),
        setMulticastLoopback: vi.fn(),
      });
      return sock as unknown as Socket;
    });

    const mdns = new MdnsService({
      port: 3000,
      defaultHostname: 'jkbox',
      enabled: true,
      ipPollIntervalMs: 0,
      log: () => {
        // silent test logger
      },
      warn: () => {
        // silent test warning logger
      },
      getIpv4Addresses: () => currentIps,
      detectDockerBridge: () => false,
      createSocket,
    });

    const app = createApp({ config, jukebox, mdns });
    activeServer = http.createServer(app);
    const wss = attachRealtime(activeServer, jukebox, { mdns });
    await new Promise<void>((resolve) => activeServer!.listen(0, resolve));
    mdns.start();

    const wsUrl = `ws://127.0.0.1:${(activeServer.address() as AddressInfo).port}/ws`;
    const kioskWs = new WebSocket(wsUrl);

    try {
      const initialNet = await waitForWsMessage(
        kioskWs,
        (m): m is Extract<ServerMessage, { type: 'network' }> => m.type === 'network',
      );
      expect(initialNet.network).toEqual({
        lanIps: [],
        lanUrl: null,
        publicUrl: null,
        publicUrlWarning: expect.stringContaining('192.168.0.123'),
      });
      expect(sentMulticastPackets).toHaveLength(0);

      // Simulate Wi-Fi connecting and receiving DHCP IP 192.168.31.42
      const updatedNetPromise = waitForWsMessage(
        kioskWs,
        (m): m is Extract<ServerMessage, { type: 'network' }> =>
          m.type === 'network' && m.network.lanUrl === 'http://192.168.31.42:3000',
      );
      currentIps = ['192.168.31.42'];
      expect(mdns.checkNetworkChange()).toBe(true);

      const updatedNet = await updatedNetPromise;
      expect(updatedNet.network).toEqual({
        lanIps: ['192.168.31.42'],
        lanUrl: 'http://192.168.31.42:3000',
        publicUrl: 'http://192.168.31.42:3000',
        publicUrlWarning: expect.stringContaining('192.168.31.42:3000'),
      });

      // Verify mDNS immediately re-announced the newly acquired IPv4 A record
      expect(sentMulticastPackets.length).toBeGreaterThanOrEqual(1);
      const lastPacket = sentMulticastPackets[sentMulticastPackets.length - 1]!;
      expect([...lastPacket.subarray(lastPacket.length - 4)]).toEqual([192, 168, 31, 42]);
    } finally {
      kioskWs.close();
      wss.close();
      mdns.stop();
      jukebox.stop();
    }
  });
});
