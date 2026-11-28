import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(currentDir, '..');
const repoRoot = resolve(webRoot, '..');

const candidateWasmDirs = [
  resolve(webRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
  resolve(repoRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
];

const targetBaseDir = resolve(webRoot, 'public', 'mediapipe');
const targetWasmDir = resolve(targetBaseDir, 'wasm');
const targetModelPath = resolve(targetBaseDir, 'gesture_recognizer.task');

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const MIN_EXPECTED_MODEL_BYTES = 1_000_000;

const prepareMediaPipeAssets = async () => {
  mkdirSync(targetWasmDir, { recursive: true });

  const wasmSource = candidateWasmDirs.find((dir) => existsSync(dir));
  if (wasmSource) {
    cpSync(wasmSource, targetWasmDir, { recursive: true });
    process.stdout.write('[mediapipe] Runtime WASM copiado para web/public/mediapipe/wasm.\n');
  } else {
    process.stdout.write('[mediapipe] Aviso: wasm nao encontrado em node_modules.\n');
  }

  if (existsSync(targetModelPath) && statSync(targetModelPath).size >= MIN_EXPECTED_MODEL_BYTES) {
    process.stdout.write('[mediapipe] Modelo gesture_recognizer.task ja presente localmente.\n');
    return;
  }

  if (process.env.JKBOX_SKIP_MEDIAPIPE_DOWNLOAD === '1') {
    process.stdout.write('[mediapipe] Download do modelo ignorado via JKBOX_SKIP_MEDIAPIPE_DOWNLOAD=1.\n');
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(MODEL_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength < MIN_EXPECTED_MODEL_BYTES) {
      throw new Error(`Arquivo incompleto (${buffer.byteLength} bytes)`);
    }

    writeFileSync(targetModelPath, buffer);
    process.stdout.write(
      `[mediapipe] Modelo offline salvo em web/public/mediapipe/gesture_recognizer.task (${(buffer.byteLength / (1024 * 1024)).toFixed(1)} MB).\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `[mediapipe] Aviso: nao foi possivel baixar gesture_recognizer.task no build (${msg}).\n`,
    );
  }
}

await prepareMediaPipeAssets();
