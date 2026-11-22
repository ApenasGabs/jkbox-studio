import { describe, expect, it } from 'vitest';
import { formatTime, isLoopback, remoteUrl } from './format';

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

  it('detects loopback URLs that phones cannot reach', () => {
    expect(isLoopback('http://localhost:3000/remote')).toBe(true);
    expect(isLoopback('http://127.0.0.1:3000/remote')).toBe(true);
    expect(isLoopback('http://192.168.0.10:3000/remote')).toBe(false);
  });
});
