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
      'os/jkbox-hostname.sh',
    ];
    for (const rel of scripts) {
      const full = path.join(REPO_ROOT, rel);
      const { stderr } = await execFileAsync('bash', ['-n', full]);
      expect(stderr).toBe('');
    }
  });

  it('runs os/install-kiosk.sh --dry-run with PORT=80 default and rejects invalid arguments', async () => {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.PORT;
    const { stdout } = await execFileAsync('bash', [path.join(REPO_ROOT, 'os', 'install-kiosk.sh'), '--dry-run'], {
      env: cleanEnv,
    });
    expect(stdout).toContain('porta=80');
    expect(stdout).toContain('http://jkbox.local ');
    expect(stdout).not.toContain('http://jkbox.local:80');
    expect(stdout).not.toContain('http://jkbox.local:3000');
    expect(stdout).toContain('non-free-firmware');
    expect(stdout).toContain('zram');
    expect(stdout).toContain('NetworkManager');
    expect(stdout).toContain('PipeWire');
    expect(stdout).toContain('udev');
    expect(stdout).toContain('/etc/polkit-1/rules.d/50-jkbox-update.rules');

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

    await expect(
      execFileAsync('bash', [path.join(REPO_ROOT, 'os', 'install-kiosk.sh'), '--dry-run', '--hostname', 'a']),
    ).rejects.toThrow();

    await expect(
      execFileAsync('bash', [path.join(REPO_ROOT, 'os', 'install-kiosk.sh'), '--dry-run', '--hostname', '-bad']),
    ).rejects.toThrow();

    const { stdout: normalizedOut } = await execFileAsync('bash', [
      path.join(REPO_ROOT, 'os', 'install-kiosk.sh'),
      '--dry-run',
      '--hostname',
      'Gabisa.local',
      '--port',
      '3000',
    ]);
    expect(normalizedOut).toContain('http://gabisa.local:3000');
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
    const mainUnit = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox.service'), 'utf8');
    const buttonsUnit = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox-buttons.service'), 'utf8');
    const usbUnit = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox-usb-mount@.service'), 'utf8');
    const wifiUnit = fs.readFileSync(path.join(REPO_ROOT, 'os', 'systemd', 'jkbox-wifi-fallback.service'), 'utf8');
    const udevRule = fs.readFileSync(path.join(REPO_ROOT, 'os', 'udev', '99-jkbox-usb-music.rules'), 'utf8');
    const buttonsCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'os', 'buttons.default.json'), 'utf8'));
    const kioskBrowserScript = fs.readFileSync(path.join(REPO_ROOT, 'os', 'jkbox-kiosk-browser.sh'), 'utf8');
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'os', 'README.md'), 'utf8');

    expect(mainUnit).toContain('User=jkbox');
    expect(mainUnit).toContain('Environment=PORT=80');
    expect(mainUnit).toContain('Environment=LEGACY_REDIRECT_PORT=3000');
    expect(mainUnit).toContain('Environment=KIOSK_PREFER_PORT_80=true');
    expect(mainUnit).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE');
    expect(mainUnit).toContain('CapabilityBoundingSet=CAP_NET_BIND_SERVICE');
    expect(mainUnit).toContain('NoNewPrivileges=true');
    expect(mainUnit).not.toContain('PrivateUsers=true');
    expect(buttonsUnit).toContain('/opt/jkbox/current/os/jkbox-buttons');
    expect(buttonsUnit).toContain('SupplementaryGroups=input audio');
    expect(usbUnit).toContain('/opt/jkbox/current/os/jkbox-usb-mount.sh add %i');
    expect(wifiUnit).toContain('/opt/jkbox/current/os/jkbox-wifi-fallback.sh');
    expect(udevRule).toContain('jkbox-usb-mount@%k.service');
    expect(kioskBrowserScript).toContain('--use-fake-ui-for-media-stream');
    expect(buttonsCfg.wsUrl).toBe('ws://127.0.0.1/ws');
    expect(buttonsCfg.profiles['usb-keyboard']).toBeTruthy();
    expect(buttonsCfg.profiles['zero-delay-arcade']).toBeTruthy();
    expect(readme).toContain('--calibrate');
    expect(readme).toContain('/data/music/usb-');
    expect(readme).toContain('http://jkbox.local');
  });

  it('supports PORT=80 across jkbox-kiosk-browser.sh, jkbox-update.sh, jkbox-wifi-fallback.sh, jkbox-hostname.sh, and buttons config (server/test/jkboxOsScripts.test.ts)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-os-port80-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const env80 = path.join(tmp, 'jkbox80.env');
    fs.writeFileSync(env80, 'PORT=80\nLEGACY_REDIRECT_PORT=3000\nKIOSK_PREFER_PORT_80=true\n');

    const env3000 = path.join(tmp, 'jkbox3000.env');
    fs.writeFileSync(env3000, 'PORT=3000\n');

    const envCopiedWithPrefer80 = path.join(tmp, 'jkbox-copied.env');
    fs.writeFileSync(envCopiedWithPrefer80, 'PORT=3000\nKIOSK_PREFER_PORT_80=true\n');

    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.PORT;
    delete cleanEnv.JKBOX_KIOSK_URL;
    delete cleanEnv.KIOSK_PREFER_PORT_80;
    delete cleanEnv.LEGACY_REDIRECT_PORT;

    const browserScript = path.join(REPO_ROOT, 'os', 'jkbox-kiosk-browser.sh');
    const { stdout: out80 } = await execFileAsync('bash', [browserScript, '--dry-run'], {
      env: { ...cleanEnv, JKBOX_ENV_FILE: env80 },
    });
    expect(out80).toContain('KIOSK_URL=http://127.0.0.1/');
    expect(out80).toContain('HEALTH_URL=http://127.0.0.1/api/health');

    const { stdout: outCopied } = await execFileAsync('bash', [browserScript, '--dry-run'], {
      env: { ...cleanEnv, JKBOX_ENV_FILE: envCopiedWithPrefer80 },
    });
    expect(outCopied).toContain('KIOSK_URL=http://127.0.0.1/');

    const { stdout: out3000 } = await execFileAsync('bash', [browserScript, '--dry-run'], {
      env: { ...cleanEnv, JKBOX_ENV_FILE: env3000 },
    });
    expect(out3000).toContain('KIOSK_URL=http://127.0.0.1:3000/');
    expect(out3000).toContain('HEALTH_URL=http://127.0.0.1:3000/api/health');

    // Verify jkbox-hostname.sh updates /etc/avahi/services/jkbox.service with PORT=80
    const etcHostname = path.join(tmp, 'hostname');
    const etcHosts = path.join(tmp, 'hosts');
    const avahiService = path.join(tmp, 'avahi', 'jkbox.service');
    fs.mkdirSync(path.dirname(avahiService), { recursive: true });
    fs.writeFileSync(etcHosts, '127.0.0.1 localhost\n127.0.1.1 old.local old\n');
    const noopBin = path.join(tmp, 'noop');
    fs.writeFileSync(noopBin, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    const hostnameScript = path.join(REPO_ROOT, 'os', 'jkbox-hostname.sh');
    const { stdout: hostOut } = await execFileAsync('bash', [hostnameScript, 'Festa.local'], {
      env: {
        ...cleanEnv,
        JKBOX_ENV_FILE: env80,
        JKBOX_ETC_HOSTNAME: etcHostname,
        JKBOX_ETC_HOSTS: etcHosts,
        JKBOX_AVAHI_SERVICE_FILE: avahiService,
        JKBOX_HOSTNAMECTL: noopBin,
        JKBOX_SYSTEMCTL: noopBin,
      },
    });
    expect(hostOut.trim()).toBe('festa.local');
    expect(fs.readFileSync(etcHostname, 'utf8').trim()).toBe('festa');
    expect(fs.readFileSync(etcHosts, 'utf8')).toContain('127.0.1.1 festa.local festa');
    expect(fs.readFileSync(avahiService, 'utf8')).toContain('<port>80</port>');

    // Verify jkbox-wifi-fallback.sh omits :80 and :3000 when PORT=80
    const stateFile = path.join(tmp, 'dev-state');
    const mockNmcli = path.join(tmp, 'mock-nmcli');
    fs.writeFileSync(stateFile, 'wifi:disconnected\nethernet:unavailable\n');
    fs.writeFileSync(
      mockNmcli,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$*" = "-t -f NAME con show --active" ]; then exit 0; fi
if [ "$*" = "-t -f TYPE,STATE dev" ]; then cat "${stateFile}"; exit 0; fi
if [ "$*" = "-t -f DEVICE,TYPE dev" ]; then printf 'wlan0:wifi\\n'; exit 0; fi
exit 0
`,
      { mode: 0o755 },
    );
    const { stdout: wifiOut } = await execFileAsync('bash', [path.join(REPO_ROOT, 'os', 'jkbox-wifi-fallback.sh')], {
      env: {
        ...cleanEnv,
        JKBOX_ENV_FILE: env80,
        JKBOX_NMCLI: mockNmcli,
        JKBOX_SLEEP_CMD: noopBin,
        JKBOX_WIFI_WAIT_SEC: '1',
      },
    });
    expect(wifiOut).toContain('http://10.42.0.1.');
    expect(wifiOut).not.toContain(':3000');
    expect(wifiOut).not.toContain(':80');
  });

  it('rejects invalid or command-injection hostnames in os/jkbox-hostname.sh', async () => {
    const script = path.join(REPO_ROOT, 'os', 'jkbox-hostname.sh');
    for (const bad of ['', 'a', '-bad', 'bad-', 'foo;id', 'foo$(whoami)', 'sub.domain']) {
      await expect(execFileAsync('bash', [script, bad])).rejects.toThrow();
    }
    await expect(execFileAsync('bash', [script])).rejects.toThrow();
  });

  it('configures Polkit rule for jkbox-update.service in os/install-kiosk.sh and os/polkit/50-jkbox-update.rules', () => {
    const installer = fs.readFileSync(path.join(REPO_ROOT, 'os', 'install-kiosk.sh'), 'utf8');
    const polkitRule = fs.readFileSync(path.join(REPO_ROOT, 'os', 'polkit', '50-jkbox-update.rules'), 'utf8');

    expect(installer).toContain('/etc/polkit-1/rules.d/50-jkbox-update.rules');
    expect(installer).toContain('subject.user === "${JKBOX_USER}"');
    expect(installer).toContain('jkbox-update.service');
    expect(polkitRule).toContain('org.freedesktop.systemd1.manage-units');
    expect(polkitRule).toContain('jkbox-update.service');
    expect(polkitRule).toContain('polkit.Result.YES');
  });
});
