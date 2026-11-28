import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  normalizeVersion,
  shouldReloadAfterHealth,
  SystemUpdatePanel,
} from '../components/SystemUpdatePanel';
import type { SystemUpdateStatus } from './types';

function makeStatus(overrides: Partial<SystemUpdateStatus> = {}): SystemUpdateStatus {
  return {
    supported: true,
    mode: 'kiosk-os',
    repo: 'ApenasGabs/jkbox-studio',
    currentVersion: 'v2026.11.28.1',
    latestVersion: 'v2026.11.28.1',
    updateAvailable: false,
    publishedAt: '2026-11-28T04:00:00Z',
    releaseNotes: null,
    releaseUrl: null,
    updating: false,
    checkedAt: 1_700_000_000_000,
    checkError: null,
    dockerCommand: null,
    ...overrides,
  };
}

describe('SystemUpdatePanel', () => {
  it('renders current version and check button when up-to-date on Kiosk OS', () => {
    const html = renderToStaticMarkup(
      <SystemUpdatePanel initialStatus={makeStatus()} onToast={() => {}} />,
    );
    expect(html).toContain('Atualização do Sistema');
    expect(html).toContain('v2026.11.28.1');
    expect(html).toContain('Procurar atualizações');
    expect(html).toContain('Atualizado');
    expect(html).not.toContain('Atualizar agora');
  });

  it('renders new version badge, release notes, and Atualizar agora button when update is available on Kiosk OS', () => {
    const html = renderToStaticMarkup(
      <SystemUpdatePanel
        initialStatus={makeStatus({
          latestVersion: 'v2026.11.28.2',
          updateAvailable: true,
          releaseNotes: 'Novo botão OTA + releases contínuas.',
        })}
        onToast={() => {}}
      />,
    );
    expect(html).toContain('Nova: v2026.11.28.2');
    expect(html).toContain('Novo botão OTA + releases contínuas.');
    expect(html).toContain('Atualizar agora');
  });

  it('renders friendly Docker instructions instead of Atualizar agora when running in Docker', () => {
    const html = renderToStaticMarkup(
      <SystemUpdatePanel
        initialStatus={makeStatus({
          supported: false,
          mode: 'docker',
          latestVersion: 'v2026.11.28.2',
          updateAvailable: true,
          dockerCommand: 'docker compose pull && docker compose up -d',
        })}
        onToast={() => {}}
      />,
    );
    expect(html).toContain('Docker');
    expect(html).toContain('docker compose pull &amp;&amp; docker compose up -d');
    expect(html).not.toContain('Atualizar agora');
  });

  it('renders updating status banner while downloading/applying update', () => {
    const html = renderToStaticMarkup(
      <SystemUpdatePanel
        initialStatus={makeStatus({
          latestVersion: 'v2026.11.28.2',
          updateAvailable: true,
          updating: true,
        })}
        onToast={() => {}}
      />,
    );
    expect(html).toContain('Baixando e aplicando atualização… aguarde a reconexão automática');
    expect(html).toContain('Atualizando…');
  });
});

describe('health reconnect helpers', () => {
  it('normalizes version tags and reloads only when server returns healthy with new version or after disconnect', () => {
    expect(normalizeVersion(' v2026.11.28.2 ')).toBe('2026.11.28.2');
    expect(shouldReloadAfterHealth({ ok: false, version: 'v2026.11.28.2' }, 'v2026.11.28.1', false)).toBe(false);
    expect(shouldReloadAfterHealth({ ok: true, version: 'v2026.11.28.1' }, 'v2026.11.28.1', false)).toBe(false);
    expect(shouldReloadAfterHealth({ ok: true, version: 'v2026.11.28.2' }, 'v2026.11.28.1', false)).toBe(true);
    expect(shouldReloadAfterHealth({ ok: true, version: 'v2026.11.28.1' }, 'v2026.11.28.1', true)).toBe(true);
  });
});
