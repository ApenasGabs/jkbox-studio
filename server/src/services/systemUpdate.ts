import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SystemUpdateMode = 'kiosk-os' | 'docker' | 'dev';

export interface SystemUpdateStatus {
  supported: boolean;
  mode: SystemUpdateMode;
  repo: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  publishedAt: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  updating: boolean;
  checkedAt: number | null;
  checkError: string | null;
  dockerCommand: string | null;
}

export interface SystemUpdateApplyResult {
  started: boolean;
  alreadyRunning?: boolean;
  supported: boolean;
  mode: SystemUpdateMode;
  updating: boolean;
  message: string;
  command?: string;
}

export class SystemUpdateError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

export const DOCKER_UPDATE_COMMAND = 'docker compose pull && docker compose up -d';
const DEFAULT_REPO = 'ApenasGabs/jkbox-studio';
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTTED_NUMERIC_RE = /^\d+(?:\.\d+)*$/;

export function normalizeVersionTag(value: string): string {
  return value.trim().replace(/^v/i, '');
}

/**
 * Compares two version tags (supports SemVer, CalVer `vYYYY.MM.DD.N`, and `local`).
 * Returns -1 when `current < latest` (update available), 0 when equal, 1 when `current > latest`.
 */
export function compareVersions(current: string, latest: string): number {
  const latestNorm = normalizeVersionTag(latest);
  if (!latestNorm) return 0;

  const currentNorm = normalizeVersionTag(current);
  if (!currentNorm || currentNorm.toLowerCase() === 'local') return -1;
  if (currentNorm === latestNorm) return 0;

  if (DOTTED_NUMERIC_RE.test(currentNorm) && DOTTED_NUMERIC_RE.test(latestNorm)) {
    const curParts = currentNorm.split('.').map((n) => Number.parseInt(n, 10));
    const latParts = latestNorm.split('.').map((n) => Number.parseInt(n, 10));
    const len = Math.max(curParts.length, latParts.length);
    for (let i = 0; i < len; i += 1) {
      const a = curParts[i] ?? 0;
      const b = latParts[i] ?? 0;
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  }

  return -1;
}

export function resolveInstalledVersion(options: {
  envVersion?: string;
  versionFile?: string;
  fallbackVersion?: string;
} = {}): string {
  const fromEnv = options.envVersion?.trim();
  if (fromEnv) return fromEnv;

  if (options.versionFile) {
    try {
      if (fs.existsSync(options.versionFile)) {
        const fromFile = fs.readFileSync(options.versionFile, 'utf8').trim();
        if (fromFile) return fromFile;
      }
    } catch {
      // Ignore unreadable version file and fall back to package.json version.
    }
  }

  return options.fallbackVersion?.trim() || '0.1.0';
}

export function detectRuntimeMode(options: {
  envMode?: string;
  dockerEnvPath?: string;
  versionFile?: string;
  updateUnitPath?: string;
} = {}): SystemUpdateMode {
  const override = options.envMode?.trim().toLowerCase();
  if (override === 'kiosk-os' || override === 'docker' || override === 'dev') {
    return override;
  }
  const dockerPath = options.dockerEnvPath ?? '/.dockerenv';
  if (fs.existsSync(dockerPath)) {
    return 'docker';
  }
  const versionFile = options.versionFile ?? '/opt/jkbox/current/VERSION';
  const unitPath = options.updateUnitPath ?? '/etc/systemd/system/jkbox-update.service';
  if (fs.existsSync(versionFile) || fs.existsSync(unitPath)) {
    return 'kiosk-os';
  }
  return 'dev';
}

interface CachedRelease {
  latestVersion: string;
  publishedAt: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  fetchedAt: number;
}

export type SystemctlRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface SystemUpdateOptions {
  repo?: string;
  fallbackVersion?: string;
  versionFile?: string;
  updateUnitPath?: string;
  updateServiceName?: string;
  dockerEnvPath?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  runSystemctl?: SystemctlRunner;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

const defaultRunSystemctl: SystemctlRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync('systemctl', args, { timeout: 10_000 });
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
};

function summarizeNotes(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > 2000 ? `${trimmed.slice(0, 1997)}…` : trimmed;
}

export class SystemUpdateService {
  private readonly repo: string;
  private readonly fallbackVersion: string;
  private readonly versionFile: string;
  private readonly updateUnitPath: string;
  private readonly updateServiceName: string;
  private readonly dockerEnvPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly runSystemctl: SystemctlRunner;
  private readonly cacheTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private cache: CachedRelease | null = null;
  private updatingStartedAt: number | null = null;

  constructor(options: SystemUpdateOptions = {}) {
    this.env = options.env ?? process.env;
    const rawRepo = (options.repo ?? this.env.JKBOX_REPO ?? DEFAULT_REPO).trim();
    this.repo = REPO_RE.test(rawRepo) ? rawRepo : DEFAULT_REPO;
    this.fallbackVersion = options.fallbackVersion ?? '0.1.0';
    const baseDir = this.env.JKBOX_BASE_DIR || '/opt/jkbox';
    this.versionFile = options.versionFile ?? this.env.JKBOX_VERSION_FILE ?? path.join(baseDir, 'current', 'VERSION');
    this.updateUnitPath = options.updateUnitPath ?? '/etc/systemd/system/jkbox-update.service';
    this.updateServiceName = options.updateServiceName ?? 'jkbox-update.service';
    this.dockerEnvPath = options.dockerEnvPath ?? '/.dockerenv';
    this.fetchFn = options.fetchFn ?? fetch;
    this.runSystemctl = options.runSystemctl ?? defaultRunSystemctl;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
  }

  getMode(): SystemUpdateMode {
    return detectRuntimeMode({
      envMode: this.env.JKBOX_RUNTIME_MODE,
      dockerEnvPath: this.dockerEnvPath,
      versionFile: this.versionFile,
      updateUnitPath: this.updateUnitPath,
    });
  }

  getCurrentVersion(): string {
    return resolveInstalledVersion({
      envVersion: this.env.JKBOX_VERSION,
      versionFile: this.versionFile,
      fallbackVersion: this.fallbackVersion,
    });
  }

  async isUpdating(): Promise<boolean> {
    if (this.getMode() !== 'kiosk-os') {
      this.updatingStartedAt = null;
      return false;
    }

    const nowMs = this.now();
    const recentlyTriggered =
      this.updatingStartedAt !== null && nowMs - this.updatingStartedAt < 300_000;

    try {
      const { stdout } = await this.runSystemctl(['is-active', this.updateServiceName]);
      const state = stdout.trim().toLowerCase();
      if (state === 'active' || state === 'activating') {
        return true;
      }
      if (this.updatingStartedAt !== null && nowMs - this.updatingStartedAt < 3_000) {
        return true;
      }
      this.updatingStartedAt = null;
      return false;
    } catch {
      if (recentlyTriggered && nowMs - (this.updatingStartedAt ?? 0) < 15_000) {
        return true;
      }
      if (this.updatingStartedAt !== null && nowMs - this.updatingStartedAt >= 300_000) {
        this.updatingStartedAt = null;
      }
      return false;
    }
  }

  async check(options: { forceRefresh?: boolean } = {}): Promise<SystemUpdateStatus> {
    const mode = this.getMode();
    const supported = mode === 'kiosk-os';
    const currentVersion = this.getCurrentVersion();
    const updating = await this.isUpdating();
    const dockerCommand = supported ? null : DOCKER_UPDATE_COMMAND;
    const nowMs = this.now();

    if (!options.forceRefresh && this.cache && nowMs - this.cache.fetchedAt < this.cacheTtlMs) {
      return {
        supported,
        mode,
        repo: this.repo,
        currentVersion,
        latestVersion: this.cache.latestVersion,
        updateAvailable: compareVersions(currentVersion, this.cache.latestVersion) < 0,
        publishedAt: this.cache.publishedAt,
        releaseNotes: this.cache.releaseNotes,
        releaseUrl: this.cache.releaseUrl,
        updating,
        checkedAt: this.cache.fetchedAt,
        checkError: null,
        dockerCommand,
      };
    }

    const apiUrl = `https://api.github.com/repos/${this.repo}/releases/latest`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'jkbox-studio-updater',
    };
    const token = this.env.JKBOX_GITHUB_TOKEN?.trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const res = await this.fetchFn(apiUrl, { headers, signal: controller.signal });
      if (!res.ok) {
        const message =
          res.status === 404
            ? 'Nenhuma release publicada ainda no GitHub.'
            : res.status === 403 || res.status === 429
              ? 'Limite de requisições da API do GitHub atingido; tente novamente em instantes.'
              : `Falha ao consultar releases (HTTP ${res.status}).`;
        return {
          supported,
          mode,
          repo: this.repo,
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
          publishedAt: null,
          releaseNotes: null,
          releaseUrl: null,
          updating,
          checkedAt: nowMs,
          checkError: message,
          dockerCommand,
        };
      }

      const data = (await res.json()) as {
        tag_name?: unknown;
        published_at?: unknown;
        body?: unknown;
        html_url?: unknown;
      };

      const latestVersion = typeof data.tag_name === 'string' ? data.tag_name.trim() : '';
      if (!latestVersion) {
        return {
          supported,
          mode,
          repo: this.repo,
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
          publishedAt: null,
          releaseNotes: null,
          releaseUrl: null,
          updating,
          checkedAt: nowMs,
          checkError: 'Resposta de release inválida do GitHub.',
          dockerCommand,
        };
      }

      const cached: CachedRelease = {
        latestVersion,
        publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
        releaseNotes: summarizeNotes(data.body),
        releaseUrl: typeof data.html_url === 'string' ? data.html_url : null,
        fetchedAt: nowMs,
      };
      this.cache = cached;

      return {
        supported,
        mode,
        repo: this.repo,
        currentVersion,
        latestVersion: cached.latestVersion,
        updateAvailable: compareVersions(currentVersion, cached.latestVersion) < 0,
        publishedAt: cached.publishedAt,
        releaseNotes: cached.releaseNotes,
        releaseUrl: cached.releaseUrl,
        updating,
        checkedAt: cached.fetchedAt,
        checkError: null,
        dockerCommand,
      };
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      return {
        supported,
        mode,
        repo: this.repo,
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        publishedAt: null,
        releaseNotes: null,
        releaseUrl: null,
        updating,
        checkedAt: nowMs,
        checkError: isTimeout
          ? 'Tempo esgotado ao consultar atualizações no GitHub.'
          : 'Sem conexão com o GitHub para verificar atualizações.',
        dockerCommand,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async apply(): Promise<SystemUpdateApplyResult> {
    const mode = this.getMode();
    if (mode !== 'kiosk-os') {
      return {
        started: false,
        supported: false,
        mode,
        updating: false,
        message: `Atualização automática disponível apenas no Kiosk OS. Execute no host: ${DOCKER_UPDATE_COMMAND}`,
        command: DOCKER_UPDATE_COMMAND,
      };
    }

    if (await this.isUpdating()) {
      return {
        started: false,
        alreadyRunning: true,
        supported: true,
        mode,
        updating: true,
        message: 'Atualização já está em andamento. Aguarde a reconexão automática.',
      };
    }

    try {
      await this.runSystemctl(['start', '--no-block', this.updateServiceName]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SystemUpdateError(
        `Falha ao iniciar ${this.updateServiceName} (verifique a regra Polkit): ${detail}`,
        500,
      );
    }

    this.updatingStartedAt = this.now();
    return {
      started: true,
      supported: true,
      mode,
      updating: true,
      message: 'Baixando e aplicando atualização… aguarde a reconexão automática.',
    };
  }
}
