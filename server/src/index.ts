import fs from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createJukebox } from './container.js';
import { normalizePublicUrlForPort, startPort80CompatServers } from './lib/port80Compat.js';
import { attachRealtime } from './realtime.js';
import { scanLibrary } from './services/library.js';
import { HostAuth, memorySettings } from './services/hostAuth.js';
import { MdnsService } from './services/mdns.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const writeStdout = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

async function main() {
  const config = loadConfig();
  const jukebox = createJukebox(config);

  try {
    console.log(`[jkbox] yt-dlp ${await jukebox.media.version()}`);
  } catch (err) {
    console.warn(`[jkbox] AVISO: yt-dlp indisponível — ${(err as Error).message}`);
  }

  const imported = await scanLibrary(jukebox.tracks, config.musicDir);
  if (imported > 0) console.log(`[jkbox] ${imported} arquivo(s) importado(s) do acervo local`);
  void jukebox.autocategorizeLibrary().catch((err) => {
    console.warn(`[jkbox] falha na auto-categorização inicial: ${(err as Error).message}`);
  });
  jukebox.downloads.resumeInterrupted();
  jukebox.queue.advanceIfIdle();
  jukebox.syncStartupPlayback();
  jukebox.startSpotifyImport(config.spotify.importIntervalSec);

  const configuredPort = config.port;
  const listeners = await startPort80CompatServers({
    port: configuredPort,
    legacyRedirectPort: config.legacyRedirectPort,
    kioskPreferPort80: config.kioskPreferPort80,
    log: writeStdout,
    warn: console.warn,
  });

  config.port = listeners.effectivePort;
  config.publicUrl = normalizePublicUrlForPort(config.publicUrl, configuredPort, listeners.effectivePort);

  const mdns = new MdnsService({
    port: listeners.effectivePort,
    defaultHostname: config.mdnsHostname,
    enabled: config.mdnsEnabled,
    hostnameHelper: config.hostnameHelper,
    settings: jukebox.settings,
  });

  const hostAuth = new HostAuth(config.hostPin, jukebox.settings ?? memorySettings(), config.hostPinAuto);
  const hostStatus = hostAuth.status();
  if (hostStatus.source === 'auto') {
    writeStdout(`[jkbox] PIN do Controlador Principal (Host) gerado automaticamente: ${hostStatus.pin} (edite em ⚙︎ Host)`);
  } else if (hostStatus.source === 'none') {
    console.warn('[jkbox] AVISO: PIN do Host desativado — qualquer celular terá controle total');
  }

  const app = createApp({ config, jukebox, mdns, hostAuth, version: pkg.version });
  listeners.attachApp(app);
  attachRealtime(listeners.primaryServer, jukebox, { mdns });
  mdns.start();
  writeStdout(`[jkbox] ouvindo em http://0.0.0.0:${listeners.primaryPort}`);
  writeStdout(`[jkbox] dados em ${config.dataDir}`);
  writeStdout(
    `[jkbox] Spotify: ${jukebox.spotify.configured ? (jukebox.spotify.connected ? 'conectado' : 'configurado (aguardando login)') : 'desativado'}`,
  );

  const shutdown = () => {
    writeStdout('[jkbox] encerrando...');
    mdns.stop();
    jukebox.stop();
    void listeners.closeAll().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
