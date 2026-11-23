import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyTextToClipboard', () => {
  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyTextToClipboard('http://gabisa.local:3000')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('http://gabisa.local:3000');
  });

  it('falls back to document.execCommand("copy") when navigator.clipboard is unavailable (HTTP LAN)', async () => {
    const textarea = {
      value: '',
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
    };
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const execCommand = vi.fn(() => true);

    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      body: { appendChild, removeChild },
      createElement: vi.fn(() => textarea),
      execCommand,
    });

    await expect(copyTextToClipboard('http://jkbox.local:3000')).resolves.toBe(true);
    expect(textarea.value).toBe('http://jkbox.local:3000');
    expect(textarea.select).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(removeChild).toHaveBeenCalledWith(textarea);
  });
});
