import fs from 'node:fs';
import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createJukebox } from './container.js';
import { attachRealtime } from './realtime.js';
import { scanLibrary } from './services/library.js';
import { MdnsService } from './services/mdns.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

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
  jukebox.downloads.resumeInterrupted();
  jukebox.queue.advanceIfIdle();
  jukebox.syncStartupPlayback();
  jukebox.startSpotifyImport(config.spotify.importIntervalSec);

  const mdns = new MdnsService({
    port: config.port,
    defaultHostname: config.mdnsHostname,
    enabled: config.mdnsEnabled,
    hostnameHelper: config.hostnameHelper,
    settings: jukebox.settings,
  });

  const app = createApp({ config, jukebox, mdns, version: pkg.version });
  const server = http.createServer(app);
  attachRealtime(server, jukebox);

  server.listen(config.port, () => {
    mdns.start();
    console.log(`[jkbox] ouvindo em http://0.0.0.0:${config.port}`);
    console.log(`[jkbox] dados em ${config.dataDir}`);
    console.log(
      `[jkbox] Spotify: ${jukebox.spotify.configured ? (jukebox.spotify.connected ? 'conectado' : 'configurado (aguardando login)') : 'desativado'}`,
    );
  });

  const shutdown = () => {
    console.log('[jkbox] encerrando...');
    mdns.stop();
    jukebox.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
