import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  compareVersions,
  detectRuntimeMode,
  DOCKER_UPDATE_COMMAND,
  resolveInstalledVersion,
  SystemUpdateService,
} from '../src/services/systemUpdate.js';
import { setup } from './helpers.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-sysupd-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('SystemUpdateService & version helpers', () => {
  it('compares SemVer, CalVer, and local versions accurately without offering downgrades', () => {
    expect(compareVersions('v0.1.0', 'v0.2.0')).toBe(-1);
    expect(compareVersions('0.1.0', 'v2026.11.28.1')).toBe(-1);
    expect(compareVersions('v2026.11.28.2', 'v2026.11.28.10')).toBe(-1);
    expect(compareVersions('v2026.11.28.5', '2026.11.28.5')).toBe(0);
    expect(compareVersions('local', 'v2026.11.28.1')).toBe(-1);
    expect(compareVersions('v2026.11.28.5', 'v0.2.0')).toBe(1);
    expect(compareVersions('v0.2.0', 'v0.1.0')).toBe(1);
  });

  it('resolves installed version from env, VERSION file, or fallback', () => {
    const dir = makeTempDir();
    const versionFile = path.join(dir, 'VERSION');
    fs.writeFileSync(versionFile, 'v2026.11.28.3\n');

    expect(resolveInstalledVersion({ envVersion: 'v9.9.9', versionFile, fallbackVersion: '0.1.0' })).toBe('v9.9.9');
    expect(resolveInstalledVersion({ versionFile, fallbackVersion: '0.1.0' })).toBe('v2026.11.28.3');
    expect(resolveInstalledVersion({ versionFile: path.join(dir, 'missing'), fallbackVersion: '0.1.0' })).toBe('0.1.0');
  });

  it('detects runtime mode for docker, kiosk-os, and dev', () => {
    const dir = makeTempDir();
    const dockerFile = path.join(dir, '.dockerenv');
    const versionFile = path.join(dir, 'VERSION');
    const unitFile = path.join(dir, 'jkbox-update.service');
    const missing = path.join(dir, 'missing');

    expect(detectRuntimeMode({ dockerEnvPath: missing, versionFile: missing, updateUnitPath: missing })).toBe('dev');

    fs.writeFileSync(versionFile, 'v2026.11.28.1\n');
    expect(detectRuntimeMode({ dockerEnvPath: missing, versionFile, updateUnitPath: missing })).toBe('kiosk-os');

    fs.writeFileSync(unitFile, '[Service]\n');
    expect(detectRuntimeMode({ dockerEnvPath: missing, versionFile: missing, updateUnitPath: unitFile })).toBe('kiosk-os');

    fs.writeFileSync(dockerFile, '');
    expect(detectRuntimeMode({ dockerEnvPath: dockerFile, versionFile, updateUnitPath: unitFile })).toBe('docker');

    expect(
      detectRuntimeMode({ envMode: 'kiosk-os', dockerEnvPath: dockerFile, versionFile: missing, updateUnitPath: missing }),
    ).toBe('kiosk-os');
  });

  it('queries GitHub /releases/latest, caches results, and refreshes when forced', async () => {
    const dir = makeTempDir();
    const versionFile = path.join(dir, 'VERSION');
    fs.writeFileSync(versionFile, 'v2026.11.28.1\n');

    let tag = 'v2026.11.28.2';
    let calls = 0;
    let clock = 1_000_000;

    const fetchFn = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          tag_name: tag,
          published_at: '2026-11-28T05:00:00Z',
          body: 'Correções OTA e melhorias no Kiosk',
          html_url: `https://github.com/ApenasGabs/jkbox-studio/releases/tag/${tag}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const svc = new SystemUpdateService({
      versionFile,
      dockerEnvPath: path.join(dir, 'no-docker'),
      updateUnitPath: path.join(dir, 'no-unit'),
      fetchFn,
      runSystemctl: async () => ({ stdout: 'inactive\n', stderr: '' }),
      cacheTtlMs: 60_000,
      now: () => clock,
    });

    const first = await svc.check();
    expect(calls).toBe(1);
    expect(first).toMatchObject({
      supported: true,
      mode: 'kiosk-os',
      currentVersion: 'v2026.11.28.1',
      latestVersion: 'v2026.11.28.2',
      updateAvailable: true,
      publishedAt: '2026-11-28T05:00:00Z',
      releaseNotes: 'Correções OTA e melhorias no Kiosk',
      updating: false,
      checkError: null,
    });

    tag = 'v2026.11.28.3';
    clock += 10_000;
    const cached = await svc.check();
    expect(calls).toBe(1);
    expect(cached.latestVersion).toBe('v2026.11.28.2');

    const refreshed = await svc.check({ forceRefresh: true });
    expect(calls).toBe(2);
    expect(refreshed.latestVersion).toBe('v2026.11.28.3');
  });

  it('handles GitHub 404 or network failures gracefully without throwing', async () => {
    const dir = makeTempDir();
    const svc404 = new SystemUpdateService({
      versionFile: path.join(dir, 'missing'),
      dockerEnvPath: path.join(dir, 'missing'),
      updateUnitPath: path.join(dir, 'missing'),
      fetchFn: (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch,
    });
    const res404 = await svc404.check();
    expect(res404.mode).toBe('dev');
    expect(res404.supported).toBe(false);
    expect(res404.updateAvailable).toBe(false);
    expect(res404.latestVersion).toBeNull();
    expect(res404.checkError).toContain('Nenhuma release publicada');

    const svcErr = new SystemUpdateService({
      versionFile: path.join(dir, 'missing'),
      dockerEnvPath: path.join(dir, 'missing'),
      updateUnitPath: path.join(dir, 'missing'),
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const resErr = await svcErr.check();
    expect(resErr.checkError).toContain('Sem conexão com o GitHub');
  });

  it('starts jkbox-update.service asynchronously via systemctl --no-block in kiosk-os mode and guards duplicates', async () => {
    const dir = makeTempDir();
    const versionFile = path.join(dir, 'VERSION');
    fs.writeFileSync(versionFile, 'v2026.11.28.1\n');

    let activeState = 'inactive';
    const calls: string[][] = [];
    const svc = new SystemUpdateService({
      versionFile,
      dockerEnvPath: path.join(dir, 'no-docker'),
      updateUnitPath: path.join(dir, 'no-unit'),
      runSystemctl: async (args) => {
        calls.push(args);
        if (args[0] === 'is-active') {
          return { stdout: `${activeState}\n`, stderr: '' };
        }
        if (args[0] === 'start') {
          activeState = 'activating';
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    const first = await svc.apply();
    expect(first).toMatchObject({
      started: true,
      supported: true,
      mode: 'kiosk-os',
      updating: true,
    });
    expect(calls).toContainEqual(['start', '--no-block', 'jkbox-update.service']);

    const second = await svc.apply();
    expect(second).toMatchObject({
      started: false,
      alreadyRunning: true,
      supported: true,
      mode: 'kiosk-os',
      updating: true,
    });
  });

  it('returns friendly Docker command instead of calling systemctl when running in Docker', async () => {
    const dir = makeTempDir();
    const dockerFile = path.join(dir, '.dockerenv');
    fs.writeFileSync(dockerFile, '');
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));

    const svc = new SystemUpdateService({
      versionFile: path.join(dir, 'missing'),
      dockerEnvPath: dockerFile,
      updateUnitPath: path.join(dir, 'missing'),
      runSystemctl,
    });

    const res = await svc.apply();
    expect(res).toMatchObject({
      started: false,
      supported: false,
      mode: 'docker',
      updating: false,
      command: DOCKER_UPDATE_COMMAND,
    });
    expect(runSystemctl).not.toHaveBeenCalled();
  });
});

describe('HTTP /api/system/update routes (requireHost)', () => {
  it('protects GET /api/system/update and POST /api/system/update/apply with requireHost', async () => {
    const dir = makeTempDir();
    const versionFile = path.join(dir, 'VERSION');
    fs.writeFileSync(versionFile, 'v2026.11.28.1\n');

    const ctx = setup({ HOST_PIN: '1234' });
    const systemctlCalls: string[][] = [];
    const systemUpdate = new SystemUpdateService({
      versionFile,
      dockerEnvPath: path.join(dir, 'no-docker'),
      updateUnitPath: path.join(dir, 'no-unit'),
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v2026.11.28.2',
            published_at: '2026-11-28T06:00:00Z',
            body: 'Nova versão de teste',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
      runSystemctl: async (args) => {
        systemctlCalls.push(args);
        if (args[0] === 'is-active') return { stdout: 'inactive\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
    });
    const app = createApp({ config: ctx.config, jukebox: ctx.jukebox, systemUpdate });

    await request(app).get('/api/system/update').expect(403);
    await request(app).post('/api/system/update/apply').expect(403);
    expect(systemctlCalls).toHaveLength(0);

    const statusRes = await request(app)
      .get('/api/system/update?refresh=1')
      .set('x-host-pin', '1234')
      .expect(200);
    expect(statusRes.body).toMatchObject({
      supported: true,
      mode: 'kiosk-os',
      currentVersion: 'v2026.11.28.1',
      latestVersion: 'v2026.11.28.2',
      updateAvailable: true,
      releaseNotes: 'Nova versão de teste',
      updating: false,
    });

    const applyRes = await request(app)
      .post('/api/system/update/apply')
      .set('x-host-pin', '1234')
      .expect(202);
    expect(applyRes.body).toMatchObject({
      started: true,
      supported: true,
      mode: 'kiosk-os',
      updating: true,
    });
    expect(systemctlCalls).toContainEqual(['start', '--no-block', 'jkbox-update.service']);
  });
});
