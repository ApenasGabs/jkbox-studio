import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QrAccessCard } from '../components/QrAccessCard';
import { formatTime, isLoopback, remoteUrl, resolveRemoteAccessUrls, resolveRemoteQrUrl } from './format';

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(214.7)).toBe('3:34');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(null)).toBe('--:--');
  });

  it('builds the remote URL from PUBLIC_URL or the current origin', () => {
    expect(remoteUrl('http://192.168.0.10:3000/', 'http://localhost:3000')).toBe('http://192.168.0.10:3000/remote');
    expect(remoteUrl(null, 'http://10.0.0.5:3000')).toBe('http://10.0.0.5:3000/remote');
  });

  it('resolves QR URL to .local when enabled and falls back to publicUrl, lanUrl, or non-loopback origin', () => {
    const mdnsOn = { enabled: true, useForQr: true, url: 'http://gabisa.local:3000' };
    const mdnsOff = { enabled: true, useForQr: false, url: 'http://gabisa.local:3000' };
    const mdnsDisabled = { enabled: false, useForQr: true, url: 'http://gabisa.local:3000' };

    expect(resolveRemoteQrUrl({ publicUrl: 'http://192.168.0.10:3000' }, mdnsOn, 'http://localhost:3000')).toBe(
      'http://gabisa.local:3000/remote',
    );
    expect(resolveRemoteQrUrl({ publicUrl: 'http://192.168.0.10:3000' }, mdnsOff, 'http://localhost:3000')).toBe(
      'http://192.168.0.10:3000/remote',
    );
    expect(resolveRemoteQrUrl({ publicUrl: null }, mdnsDisabled, 'http://192.168.1.50:3000')).toBe(
      'http://192.168.1.50:3000/remote',
    );
    expect(resolveRemoteQrUrl(null, null, 'http://192.168.1.50:3000')).toBe('http://192.168.1.50:3000/remote');
  });

  it('never generates a loopback QR URL when lanUrl or mdns.url is available', () => {
    const mdnsOff = { enabled: true, useForQr: false, url: 'http://jkbox.local:3000' };
    const mdnsPort80 = { enabled: true, useForQr: false, url: 'http://jkbox.local' };

    // Uses detected lanUrl instead of 127.0.0.1 / localhost
    expect(
      resolveRemoteQrUrl(
        { publicUrl: null, lanUrl: 'http://192.168.31.42:3000' },
        mdnsOff,
        'http://127.0.0.1:3000',
      ),
    ).toBe('http://192.168.31.42:3000/remote');

    // Port 80 omits :80 cleanly
    expect(
      resolveRemoteQrUrl(
        { publicUrl: null, lanUrl: 'http://192.168.31.42' },
        mdnsPort80,
        'http://127.0.0.1',
      ),
    ).toBe('http://192.168.31.42/remote');

    // Falls back to mdns.url even when useForQr=false if lanUrl is null and browser opened via loopback
    expect(resolveRemoteQrUrl({ publicUrl: null, lanUrl: null }, mdnsOff, 'http://localhost:3000')).toBe(
      'http://jkbox.local:3000/remote',
    );
  });

  it('computes dual .local + direct IP targets and supports 1-click mode switching', () => {
    const config = { publicUrl: null, lanUrl: 'http://192.168.31.42:3000' };
    const mdns = { enabled: true, useForQr: true, url: 'http://jkbox.local:3000' };

    const defaultTargets = resolveRemoteAccessUrls(config, mdns, 'http://127.0.0.1:3000', null);
    expect(defaultTargets).toEqual({
      qrUrl: 'http://jkbox.local:3000/remote',
      activeMode: 'mdns',
      mdnsRemoteUrl: 'http://jkbox.local:3000/remote',
      ipRemoteUrl: 'http://192.168.31.42:3000/remote',
      alternateUrl: 'http://192.168.31.42:3000/remote',
      canToggleMode: true,
    });

    const ipTargets = resolveRemoteAccessUrls(config, mdns, 'http://127.0.0.1:3000', 'ip');
    expect(ipTargets).toEqual({
      qrUrl: 'http://192.168.31.42:3000/remote',
      activeMode: 'ip',
      mdnsRemoteUrl: 'http://jkbox.local:3000/remote',
      ipRemoteUrl: 'http://192.168.31.42:3000/remote',
      alternateUrl: 'http://jkbox.local:3000/remote',
      canToggleMode: true,
    });

    const mdnsOverride = resolveRemoteAccessUrls(
      config,
      { ...mdns, useForQr: false },
      'http://127.0.0.1:3000',
      'mdns',
    );
    expect(mdnsOverride.qrUrl).toBe('http://jkbox.local:3000/remote');
    expect(mdnsOverride.activeMode).toBe('mdns');
    expect(mdnsOverride.alternateUrl).toBe('http://192.168.31.42:3000/remote');
  });

  it('renders QrAccessCard with both .local and LAN IP URLs, 1-click toggle, and publicUrlWarning', () => {
    const targets = resolveRemoteAccessUrls(
      { publicUrl: null, lanUrl: 'http://192.168.31.42:3000' },
      { enabled: true, useForQr: true, url: 'http://jkbox.local:3000' },
      'http://127.0.0.1:3000',
      null,
    );

    const sidebarHtml = renderToStaticMarkup(
      createElement(QrAccessCard, {
        heading: 'Peça sua música',
        targets,
        qrSize: 112,
        variant: 'sidebar',
        publicUrlWarning: 'PUBLIC_URL (http://192.168.0.99:3000) aponta para IP privado ausente.',
        onSelectMode: () => {},
        onToggleMode: () => {},
      }),
    );

    expect(sidebarHtml).toContain('http://jkbox.local:3000/remote');
    expect(sidebarHtml).toContain('http://192.168.31.42:3000/remote');
    expect(sidebarHtml).toContain('IP direto');
    expect(sidebarHtml).toContain('.local');
    expect(sidebarHtml).toContain('PUBLIC_URL de outra rede ignorado');

    const hostHtml = renderToStaticMarkup(
      createElement(QrAccessCard, {
        heading: 'QR Code do Controle Remoto',
        targets,
        qrSize: 68,
        variant: 'host',
        publicUrlWarning: 'PUBLIC_URL (http://192.168.0.99:3000) aponta para IP privado ausente.',
        onSelectMode: () => {},
        onToggleMode: () => {},
      }),
    );

    expect(hostHtml).toContain('QR Code do Controle Remoto');
    expect(hostHtml).toContain('192.168.0.99');
  });

  it('detects loopback URLs that phones cannot reach', () => {
    expect(isLoopback('http://localhost:3000/remote')).toBe(true);
    expect(isLoopback('http://127.0.0.1:3000/remote')).toBe(true);
    expect(isLoopback('http://192.168.0.10:3000/remote')).toBe(false);
  });
});
