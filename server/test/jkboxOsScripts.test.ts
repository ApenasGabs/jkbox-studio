import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

describe('Phase 2 Etapa 3 OS scripts & manifests', () => {
  it('passes bash -n syntax check for all OS shell scripts', async () => {
    const scripts = [
      'os/install-kiosk.sh',
      'os/jkbox-update.sh',
      'os/jkbox-usb-mount.sh',
      'os/jkbox-wifi-fallback.sh',
      'os/jkbox-kiosk-browser.sh',
    ];
    for (const rel of scripts) {
      const full = path.join(REPO_ROOT, rel);
      const { stderr } = await execFileAsync('bash', ['-n', full]);
      expect(stderr).toBe('');
    }
  });

  it('runs os/install-kiosk.sh --dry-run and rejects invalid arguments', async () => {
    const { stdout } = await execFileAsync('bash', [path.join(REPO_ROOT, 'os', 'install-kiosk.sh'), '--dry-run']);
    expect(stdout).toContain('non-free-firmware');
    expect(stdout).toContain('zram');
    expect(stdout).toContain('NetworkManager');
    expect(stdout).toContain('PipeWire');
    expect(stdout).toContain('udev');

    await expect(
      execFileAsync('bash', [path.join(REPO_ROOT, 'os', 'install-kiosk.sh'), '--dry-run', '--port', '99999']),
    ).rejects.toThrow();

    await expect(
      execFileAsync('bash', [
        path.join(REPO_ROOT, 'os', 'install-kiosk.sh'),
        '--dry-run',
        '--hotspot-password',
        'short',
      ]),
    ).rejects.toThrow();
  });

  it('automounts USB drive read-only into /data/music/usb-* and triggers /api/library/rescan with HOST_PIN', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-usb-test-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const devDir = path.join(tmp, 'dev');
    const musicDir = path.join(tmp, 'data', 'music');
    const mountLog = path.join(tmp, 'mount.log');
    const mountedFlag = path.join(tmp, 'is-mounted');
    const envFile = path.join(tmp, 'jkbox.env');

    fs.mkdirSync(devDir, { recursive: true });
    fs.mkdirSync(musicDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'sdb1'), '');

    let rescanPin: string | undefined;
    let rescanCalls = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/library/rescan') {
        rescanCalls += 1;
        rescanPin = req.headers['x-host-pin'] as string | undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ added: 3 }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const addr = server.address() as { port: number };

    fs.writeFileSync(envFile, `PORT=${addr.port}\nHOST_PIN=4321\nMUSIC_DIR=${musicDir}\n`);

    const mockBin = (name: string, body: string) => {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
      return p;
    };

    const mockMount = mockBin(
      'mock-mount',
      `printf 'mount %s\\n' "$*" >> "${mountLog}"\ntouch "${mountedFlag}"`,
    );
    const mockUmount = mockBin(
      'mock-umount',
      `printf 'umount %s\\n' "$*" >> "${mountLog}"\nrm -f "${mountedFlag}"`,
    );
    const mockMountpoint = mockBin('mock-mountpoint', `[ -f "${mountedFlag}" ]`);
    const mockBlkid = mockBin('mock-blkid', `printf 'vfat\\n'`);

    const scriptEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JKBOX_ENV_FILE: envFile,
      JKBOX_DEV_DIR: devDir,
      JKBOX_MOUNT_CMD: mockMount,
      JKBOX_UMOUNT_CMD: mockUmount,
      JKBOX_MOUNTPOINT_CMD: mockMountpoint,
      JKBOX_BLKID_CMD: mockBlkid,
    };
    delete scriptEnv.PORT;
    delete scriptEnv.HOST_PIN;
    delete scriptEnv.MUSIC_DIR;
    delete scriptEnv.DATA_DIR;

    const usbScript = path.join(REPO_ROOT, 'os', 'jkbox-usb-mount.sh');

    // Reject path traversal
    await expect(execFileAsync('bash', [usbScript, 'add', '../evil'], { env: scriptEnv })).rejects.toThrow();

    // Add USB drive
    await execFileAsync('bash', [usbScript, 'add', 'sdb1'], { env: scriptEnv });
    expect(fs.existsSync(path.join(musicDir, 'usb-sdb1'))).toBe(true);
    expect(rescanCalls).toBe(1);
    expect(rescanPin).toBe('4321');
    const logAfterAdd = fs.readFileSync(mountLog, 'utf8');
    expect(logAfterAdd).toContain('ro,nosuid,nodev,noexec');
    expect(logAfterAdd).toContain(path.join(musicDir, 'usb-sdb1'));

    // Remove USB drive
    await execFileAsync('bash', [usbScript, 'remove', 'sdb1'], { env: scriptEnv });
    expect(fs.existsSync(path.join(musicDir, 'usb-sdb1'))).toBe(false);
    expect(fs.readFileSync(mountLog, 'utf8')).toContain('umount');
  });

  it('starts jkbox-setup hotspot only when no ethernet/wifi connection is active', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-wifi-test-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const nmcliLog = path.join(tmp, 'nmcli.log');
    const stateFile = path.join(tmp, 'dev-state');
    const mockNmcli = path.join(tmp, 'mock-nmcli');
    const mockSleep = path.join(tmp, 'mock-sleep');

    fs.writeFileSync(mockSleep, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(
      mockNmcli,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$*" = "-t -f NAME con show --active" ]; then
  exit 0
fi
if [ "$*" = "-t -f TYPE,STATE dev" ]; then
  cat "${stateFile}"
  exit 0
fi
if [ "$*" = "-t -f DEVICE,TYPE dev" ]; then
  printf 'wlan0:wifi\\neth0:ethernet\\n'
  exit 0
fi
printf '%s\\n' "$*" >> "${nmcliLog}"
exit 0
`,
      { mode: 0o755 },
    );

    const wifiScript = path.join(REPO_ROOT, 'os', 'jkbox-wifi-fallback.sh');
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JKBOX_ENV_FILE: path.join(tmp, 'missing.env'),
      JKBOX_NMCLI: mockNmcli,
      JKBOX_SLEEP_CMD: mockSleep,
      JKBOX_WIFI_WAIT_SEC: '1',
    };

    // Case 1: wifi already connected -> hotspot not started
    fs.writeFileSync(stateFile, 'wifi:connected\nethernet:unavailable\n');
    await execFileAsync('bash', [wifiScript], { env: baseEnv });
    expect(fs.existsSync(nmcliLog)).toBe(false);

    // Case 2: disconnected -> starts jkbox-setup hotspot
    fs.writeFileSync(stateFile, 'wifi:disconnected\nethernet:unavailable\n');
    await execFileAsync('bash', [wifiScript], { env: baseEnv });
    const log = fs.readFileSync(nmcliLog, 'utf8');
    expect(log).toContain('dev wifi hotspot ifname wlan0 con-name jkbox-setup ssid jkbox-setup');
    expect(log).toContain('connection.autoconnect no');
  });

  it('provides systemd units, udev rules, default buttons config, and README documentation', () => {
    const buttonsUnit = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox-buttons.service'), 'utf8');
    const usbUnit = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox-usb-mount@.service'), 'utf8');
    const wifiUnit = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox-wifi-fallback.service'), 'utf8');
    const udevRule = fs.readFileSync(path.join(REPO_ROOT, 'os', 'udev', '99-jkbox-usb-music.rules'), 'utf8');
    const buttonsCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'os', 'buttons.default.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'os', 'README.md'), 'utf8');

    expect(buttonsUnit).toContain('/opt/jkbox/current/os/jkbox-buttons');
    expect(buttonsUnit).toContain('SupplementaryGroups=input audio');
    expect(usbUnit).toContain('/opt/jkbox/current/os/jkbox-usb-mount.sh add %i');
    expect(wifiUnit).toContain('/opt/jkbox/current/os/jkbox-wifi-fallback.sh');
    expect(udevRule).toContain('jkbox-usb-mount@%k.service');
    expect(buttonsCfg.profiles['usb-keyboard']).toBeTruthy();
    expect(buttonsCfg.profiles['zero-delay-arcade']).toBeTruthy();
    expect(readme).toContain('--calibrate');
    expect(readme).toContain('/data/music/usb-');
  });
});
