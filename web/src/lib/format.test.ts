import { describe, expect, it } from 'vitest';
import { formatTime, isLoopback, remoteUrl, resolveRemoteQrUrl } from './format';

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

  it('resolves QR URL to .local when enabled and falls back to publicUrl or origin', () => {
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

  it('detects loopback URLs that phones cannot reach', () => {
    expect(isLoopback('http://localhost:3000/remote')).toBe(true);
    expect(isLoopback('http://127.0.0.1:3000/remote')).toBe(true);
    expect(isLoopback('http://192.168.0.10:3000/remote')).toBe(false);
  });
});
