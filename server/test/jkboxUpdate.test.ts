import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const UPDATE_SCRIPT = path.join(REPO_ROOT, 'os', 'jkbox-update.sh');

interface Fixture {
  root: string;
  baseDir: string;
  releasesDir: string;
  currentLink: string;
  systemctlLog: string;
  systemctlBin: string;
  server: http.Server;
  baseUrl: string;
  tarDownloads: number;
  healthHandler: (currentTarget: string) => { status: number; body: unknown };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function makeTarball(destDir: string, tag: string, extraFileContent = 'console.log("ok");\n') {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-tar-src-'));
  fs.mkdirSync(path.join(srcDir, 'server', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(srcDir, 'web', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(srcDir, 'os'), { recursive: true });

  fs.writeFileSync(path.join(srcDir, 'VERSION'), `${tag}\n`);
  fs.writeFileSync(path.join(srcDir, 'server', 'package.json'), JSON.stringify({ name: '@jkbox/server', version: tag.replace(/^v/, '') }));
  fs.writeFileSync(path.join(srcDir, 'server', 'dist', 'index.js'), extraFileContent);
  fs.writeFileSync(path.join(srcDir, 'web', 'dist', 'index.html'), '<html><body>jkbox</body></html>\n');
  fs.writeFileSync(path.join(srcDir, 'os', 'jkbox-update.sh'), '#!/usr/bin/env bash\nexit 0\n');

  const tarName = `jkbox-studio-${tag}.tar.gz`;
  const tarPath = path.join(destDir, tarName);
  await execFileAsync('tar', ['-czf', tarPath, '-C', srcDir, '.']);
  fs.rmSync(srcDir, { recursive: true, force: true });

  const sha256 = createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');
  return { tarName, tarPath, sha256 };
}

function seedInstalledRelease(releasesDir: string, currentLink: string, tag: string): string {
  const dir = path.join(releasesDir, tag);
  fs.mkdirSync(path.join(dir, 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'VERSION'), `${tag}\n`);
  fs.writeFileSync(path.join(dir, 'server', 'dist', 'index.js'), `// ${tag}\n`);
  fs.symlinkSync(dir, currentLink);
  return dir;
}

async function createFixture(options: {
  latestTag?: string;
  corruptChecksum?: boolean;
  initialInstalledTag?: string;
  overrideTagName?: string;
}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-upd-test-'));
  const baseDir = path.join(root, 'opt', 'jkbox');
  const releasesDir = path.join(baseDir, 'releases');
  const currentLink = path.join(baseDir, 'current');
  const artifactsDir = path.join(root, 'artifacts');
  const systemctlLog = path.join(root, 'systemctl.log');
  const systemctlState = path.join(root, 'systemctl.count');
  const systemctlBin = path.join(root, 'mock-systemctl');

  fs.mkdirSync(releasesDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  if (options.initialInstalledTag) {
    seedInstalledRelease(releasesDir, currentLink, options.initialInstalledTag);
  }

  const latestTag = options.latestTag ?? 'v0.2.0';
  const apiTag = options.overrideTagName ?? latestTag;
  const tar = await makeTarball(artifactsDir, latestTag);
  const checksumValue = options.corruptChecksum ? '0'.repeat(64) : tar.sha256;
  const sha256SumsPath = path.join(artifactsDir, 'SHA256SUMS');
  fs.writeFileSync(sha256SumsPath, `${checksumValue}  ${tar.tarName}\n`);

  const fixture: Fixture = {
    root,
    baseDir,
    releasesDir,
    currentLink,
    systemctlLog,
    systemctlBin,
    server: null as unknown as http.Server,
    baseUrl: '',
    tarDownloads: 0,
    healthHandler: () => ({ status: 200, body: { ok: true, version: latestTag.replace(/^v/, '') } }),
  };

  // Mock systemctl tracks invocations and active symlink target.
  const behaviorFile = path.join(root, 'systemctl-fail-first');
  fs.writeFileSync(
    systemctlBin,
    `#!/usr/bin/env bash
set -euo pipefail
COUNT=0
if [ -f "${systemctlState}" ]; then
  COUNT="$(cat "${systemctlState}")"
fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${systemctlState}"
TARGET=""
if [ -L "${currentLink}" ]; then
  TARGET="$(readlink -f "${currentLink}" || true)"
fi
printf '%s %s target=%s\\n' "$COUNT" "$*" "$TARGET" >> "${systemctlLog}"
if [ -f "${behaviorFile}" ] && [ "$COUNT" -eq 1 ]; then
  exit 1
fi
exit 0
`,
    { mode: 0o755 },
  );

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: apiTag,
          assets: [
            { name: tar.tarName, browser_download_url: `${fixture.baseUrl}/download/${tar.tarName}` },
            { name: 'SHA256SUMS', browser_download_url: `${fixture.baseUrl}/download/SHA256SUMS` },
          ],
        }),
      );
      return;
    }
    if (urlPath === `/download/${tar.tarName}`) {
      fixture.tarDownloads += 1;
      res.writeHead(200, { 'content-type': 'application/gzip' });
      fs.createReadStream(tar.tarPath).pipe(res);
      return;
    }
    if (urlPath === '/download/SHA256SUMS') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      fs.createReadStream(sha256SumsPath).pipe(res);
      return;
    }
    if (urlPath === '/api/health') {
      const target = fs.existsSync(currentLink) ? fs.realpathSync(currentLink) : '';
      const result = fixture.healthHandler(target);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }
    res.writeHead(404).end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind mock server');

  fixture.server = server;
  fixture.baseUrl = `http://127.0.0.1:${addr.port}`;

  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  return fixture;
}

async function runUpdater(
  fixture: Fixture,
  args: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JKBOX_BASE_DIR: fixture.baseDir,
    JKBOX_RELEASES_DIR: fixture.releasesDir,
    JKBOX_CURRENT_LINK: fixture.currentLink,
    JKBOX_API_URL: `${fixture.baseUrl}/releases/latest`,
    JKBOX_HEALTH_URL: `${fixture.baseUrl}/api/health`,
    JKBOX_HEALTH_TIMEOUT: '1',
    JKBOX_HEALTH_INTERVAL: '0.1',
    JKBOX_SYSTEMCTL: fixture.systemctlBin,
    JKBOX_LOCK_FILE: path.join(fixture.root, 'update.lock'),
    JKBOX_ENV_FILE: path.join(fixture.root, 'nonexistent.env'),
  };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  try {
    const { stdout, stderr } = await execFileAsync('bash', [UPDATE_SCRIPT, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('os/jkbox-update.sh', () => {
  it('upgrades from v0.1.0 to v0.2.0, verifies SHA256SUMS, swaps symlink atomically, and passes healthcheck', async () => {
    const fx = await createFixture({ initialInstalledTag: 'v0.1.0', latestTag: 'v0.2.0' });

    const res = await runUpdater(fx);

    expect(res.code).toBe(0);
    expect(fx.tarDownloads).toBe(1);
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.2.0')));
    expect(fs.readFileSync(path.join(fx.currentLink, 'VERSION'), 'utf8').trim()).toBe('v0.2.0');
    const logLines = fs.readFileSync(fx.systemctlLog, 'utf8').trim().split('\n');
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('restart jkbox.service');
    expect(logLines[0]).toContain(path.join('releases', 'v0.2.0'));
  });

  it('skips download and restart when already on the latest version', async () => {
    const fx = await createFixture({ initialInstalledTag: 'v0.2.0', latestTag: 'v0.2.0' });

    const res = await runUpdater(fx);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Já atualizado');
    expect(fx.tarDownloads).toBe(0);
    expect(fs.existsSync(fx.systemctlLog)).toBe(false);
  });

  it('supports --dry-run without modifying filesystem or restarting service', async () => {
    const fx = await createFixture({ initialInstalledTag: 'v0.1.0', latestTag: 'v0.2.0' });

    const res = await runUpdater(fx, ['--dry-run']);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[dry-run]');
    expect(res.stdout).toContain('v0.2.0');
    expect(fx.tarDownloads).toBe(0);
    expect(fs.existsSync(path.join(fx.releasesDir, 'v0.2.0'))).toBe(false);
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.1.0')));
    expect(fs.existsSync(fx.systemctlLog)).toBe(false);
  });

  it('aborts on SHA256SUMS mismatch without touching current symlink or service', async () => {
    const fx = await createFixture({
      initialInstalledTag: 'v0.1.0',
      latestTag: 'v0.2.0',
      corruptChecksum: true,
    });

    const res = await runUpdater(fx);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('Checksum SHA256 inválido');
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.1.0')));
    expect(fs.existsSync(path.join(fx.releasesDir, 'v0.2.0'))).toBe(false);
    expect(fs.existsSync(fx.systemctlLog)).toBe(false);
  });

  it('automatically rolls back symlink and restarts service when healthcheck fails', async () => {
    const fx = await createFixture({ initialInstalledTag: 'v0.1.0', latestTag: 'v0.2.0' });
    fx.healthHandler = () => ({ status: 503, body: { ok: false } });

    const res = await runUpdater(fx);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('Healthcheck falhou');
    expect(res.stdout).toContain('rollback');
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.1.0')));
    expect(fs.existsSync(path.join(fx.releasesDir, 'v0.2.0'))).toBe(false);

    const logLines = fs.readFileSync(fx.systemctlLog, 'utf8').trim().split('\n');
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toContain(path.join('releases', 'v0.2.0'));
    expect(logLines[1]).toContain(path.join('releases', 'v0.1.0'));
  });

  it('automatically rolls back if systemctl restart fails for the new release', async () => {
    const fx = await createFixture({ initialInstalledTag: 'v0.1.0', latestTag: 'v0.2.0' });
    fs.writeFileSync(path.join(fx.root, 'systemctl-fail-first'), '1');

    const res = await runUpdater(fx);

    expect(res.code).not.toBe(0);
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.1.0')));
    expect(fs.existsSync(path.join(fx.releasesDir, 'v0.2.0'))).toBe(false);

    const logLines = fs.readFileSync(fx.systemctlLog, 'utf8').trim().split('\n');
    expect(logLines).toHaveLength(2);
    expect(logLines[1]).toContain(path.join('releases', 'v0.1.0'));
  });

  it('rejects unsafe tag_name with path traversal', async () => {
    const fx = await createFixture({
      initialInstalledTag: 'v0.1.0',
      latestTag: 'v0.2.0',
      overrideTagName: '../escape',
    });

    const res = await runUpdater(fx);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('Tag de release inválida');
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.1.0')));
  });

  it('rejects unsafe CLI --tag ../escape before building API URL', async () => {
    const fx = await createFixture({
      initialInstalledTag: 'v0.1.0',
      latestTag: 'v0.2.0',
    });

    const res = await runUpdater(fx, ['--tag', '../escape'], { JKBOX_API_URL: undefined });

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('Tag alvo inválida');
    expect(fx.tarDownloads).toBe(0);
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.1.0')));
  });

  it('rejects unsafe JKBOX_HEALTH_URL', async () => {
    const fx = await createFixture({
      initialInstalledTag: 'v0.1.0',
      latestTag: 'v0.2.0',
    });

    const res = await runUpdater(fx, [], { JKBOX_HEALTH_URL: 'http://example.com/api/health' });

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('URL de healthcheck inválida');
    expect(fx.tarDownloads).toBe(0);
  });

  it('cleanly rolls back --force on the same tag without leaving .bak-* or broken symlink', async () => {
    const fx = await createFixture({ initialInstalledTag: 'v0.2.0', latestTag: 'v0.2.0' });
    fx.healthHandler = () => ({ status: 503, body: { ok: false } });

    const res = await runUpdater(fx, ['--force']);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('Healthcheck falhou');
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.2.0')));
    expect(fs.readFileSync(path.join(fx.currentLink, 'server', 'dist', 'index.js'), 'utf8')).toBe('// v0.2.0\n');
    expect(fs.readdirSync(fx.releasesDir)).toEqual(['v0.2.0']);

    const logLines = fs.readFileSync(fx.systemctlLog, 'utf8').trim().split('\n');
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toContain(`target=${fs.realpathSync(path.join(fx.releasesDir, 'v0.2.0'))}`);
    expect(logLines[1]).toContain(`target=${fs.realpathSync(path.join(fx.releasesDir, 'v0.2.0'))}`);
  });

  it('reads PORT from JKBOX_ENV_FILE when JKBOX_HEALTH_URL is not set in environment', async () => {
    const fx = await createFixture({ initialInstalledTag: 'v0.1.0', latestTag: 'v0.2.0' });
    const mockPort = new URL(fx.baseUrl).port;
    const envFile = path.join(fx.root, 'jkbox.env');
    fs.writeFileSync(envFile, `# custom port\nPORT=${mockPort}\n`);

    const res = await runUpdater(fx, [], {
      JKBOX_HEALTH_URL: undefined,
      PORT: undefined,
      JKBOX_ENV_FILE: envFile,
    });

    expect(res.code).toBe(0);
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.2.0')));
  });

  it('preserves rollback target during pruning even when JKBOX_RELEASES_DIR traverses a symlink', async () => {
    const fx = await createFixture({ initialInstalledTag: 'v0.1.0', latestTag: 'v0.4.0' });
    // Create older releases so JKBOX_KEEP_RELEASES=1 forces pruning, while v0.1.0 is PREV_TARGET
    const oldDir = path.join(fx.releasesDir, 'v0.0.1');
    fs.mkdirSync(oldDir, { recursive: true });
    const olderDir = path.join(fx.releasesDir, 'v0.0.2');
    fs.mkdirSync(olderDir, { recursive: true });

    // Point a symlink to releasesDir so JKBOX_RELEASES_DIR is non-canonical
    const symlinkReleasesDir = path.join(fx.root, 'releases-link');
    fs.symlinkSync(fx.releasesDir, symlinkReleasesDir);

    // Ensure v0.0.1 and v0.0.2 have older mtimes than v0.1.0
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(oldDir, past, past);
    fs.utimesSync(olderDir, past, past);

    const res = await runUpdater(fx, [], {
      JKBOX_RELEASES_DIR: symlinkReleasesDir,
      JKBOX_KEEP_RELEASES: '1',
    });

    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(fx.releasesDir, 'v0.4.0'))).toBe(true);
    expect(fs.existsSync(path.join(fx.releasesDir, 'v0.1.0'))).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(olderDir)).toBe(false);
  });

  it('supports --no-restart bootstrap mode without calling systemctl or healthcheck', async () => {
    const fx = await createFixture({ latestTag: 'v0.2.0' });
    fx.healthHandler = () => ({ status: 503, body: { ok: false } });

    const res = await runUpdater(fx, ['--no-restart']);

    expect(res.code).toBe(0);
    expect(fs.realpathSync(fx.currentLink)).toBe(fs.realpathSync(path.join(fx.releasesDir, 'v0.2.0')));
    expect(fs.existsSync(fx.systemctlLog)).toBe(false);
  });
});

describe('release pipeline & systemd manifests', () => {
  it('defines release workflow with tag trigger, workflow_dispatch, SHA256SUMS, and GitHub Release upload', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("'v*'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('npm run typecheck');
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('npm run build');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('jkbox-studio-${TAG}.tar.gz');
    expect(workflow).toContain('gh release');
  });

  it('provides systemd service and timer units pointing to /opt/jkbox/current', () => {
    const appService = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox.service'), 'utf8');
    const updService = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox-update.service'), 'utf8');
    const updTimer = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox-update.timer'), 'utf8');

    expect(appService).toContain('WorkingDirectory=/opt/jkbox/current');
    expect(appService).toContain('/opt/jkbox/current/server/dist/index.js');
    expect(updService).toContain('Type=oneshot');
    expect(updService).toContain('/opt/jkbox/current/os/jkbox-update.sh');
    expect(updTimer).toContain('[Timer]');
    expect(updTimer).toContain('WantedBy=timers.target');
  });
});
