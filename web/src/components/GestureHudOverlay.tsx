import type { RefObject } from 'react';
import {
  formatGestureActionLabel,
  type GestureAction,
  type GestureContextMode,
  type GestureHudMode,
  type GesturePowerMode,
} from '../lib/gestureEngine';
import type { WebcamGestureStatus } from '../lib/useWebcamKioskInput';

export interface GestureHudOverlayProps {
  enabled: boolean;
  hudMode: GestureHudMode;
  context: GestureContextMode;
  status: WebcamGestureStatus;
  error: string | null;
  powerMode: GesturePowerMode;
  wakeProgress: number;
  dwellProgress: number;
  pendingAction: GestureAction | null;
  tooFar: boolean;
  fps: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

/**
 * Discreet PiP HUD for Kiosk hand-gesture navigation.
 * Defaults to privacy-first skeleton mode (renders 21 landmarks without showing raw camera video).
 */
export const GestureHudOverlay = ({
  enabled,
  hudMode,
  context,
  status,
  error,
  powerMode,
  wakeProgress,
  dwellProgress,
  pendingAction,
  tooFar,
  fps,
  videoRef,
  canvasRef,
}: GestureHudOverlayProps) => {
  if (!enabled) return null;

  const showPreviewBox =
    hudMode !== 'compact' && status === 'ready' && (powerMode === 'active' || wakeProgress > 0);
  const showRawVideo = hudMode === 'video' && showPreviewBox;
  const isSkipWarning = pendingAction === 'SKIP';

  return (
    <aside
      aria-label="Indicador de controle por gestos"
      data-kiosk-gesture-hud={powerMode}
      className="pointer-events-none fixed bottom-4 left-4 z-40 flex max-w-[220px] flex-col gap-1.5"
    >
      <div
        className={`relative overflow-hidden rounded-2xl border border-white/15 bg-zinc-950/85 shadow-2xl backdrop-blur-md transition-all ${
          showPreviewBox ? 'h-28 w-40 opacity-100' : 'h-0 w-0 border-0 opacity-0'
        }`}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          aria-hidden="true"
          className={`h-full w-full -scale-x-100 object-cover transition-opacity ${
            showRawVideo ? 'opacity-80' : 'opacity-0'
          }`}
        />
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className=" absolute inset-0 h-full w-full -scale-x-100 object-cover"
        />
        {showPreviewBox && (
          <div className="absolute inset-x-2 top-1.5 flex items-center justify-between text-[10px] font-semibold text-zinc-300">
            <span className="rounded-full bg-black/60 px-1.5 py-0.5">
              {context === 'stage' ? 'Palco' : 'Catálogo'}
            </span>
            <span className="rounded-full bg-black/60 px-1.5 py-0.5 font-mono">
              {hudMode === 'skeleton' ? 'Privado' : 'Vídeo'} · {fps}fps
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1 rounded-2xl border border-white/15 bg-zinc-950/85 px-3 py-2 text-xs text-zinc-100 shadow-xl backdrop-blur-md">
        {status === 'loading' && (
          <span className="text-[11px] text-zinc-300">🖐️ Iniciando sensor offline…</span>
        )}

        {status === 'error' && (
          <span className="text-[11px] text-amber-300" role="status">
            ⚠️ Câmera indisponível{error ? `: ${error}` : ''}
          </span>
        )}

        {status === 'ready' && powerMode === 'standby' && (
          <>
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="font-medium text-zinc-300">
                {tooFar
                  ? '🖐️ Aproxime a mão da tela'
                  : wakeProgress > 0
                    ? '🖐️ Despertando gestos…'
                    : '🖐️ Gestos em espera (4 fps)'}
              </span>
              {wakeProgress > 0 && <span className="font-mono text-accent-2">{wakeProgress}%</span>}
            </div>
            {wakeProgress > 0 ? (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-75"
                  style={{ width: `${wakeProgress}%` }}
                />
              </div>
            ) : (
              <span className="text-[10px] text-zinc-400">
                Segure ✋ ou 🤟 perto da tela p/ ativar
              </span>
            )}
          </>
        )}

        {status === 'ready' && powerMode === 'active' && (
          <>
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className={`font-semibold ${isSkipWarning ? 'text-amber-300' : 'text-emerald-300'}`}>
                {tooFar
                  ? 'Aproxime a mão (anti-festa)'
                  : pendingAction
                    ? isSkipWarning
                      ? '✌️ Segure p/ Pular…'
                      : `🖐️ ${formatGestureActionLabel(pendingAction)}`
                    : '🟢 Gestos ativos'}
              </span>
              {pendingAction && !tooFar && (
                <span className="font-mono text-[10px] text-zinc-300">{dwellProgress}%</span>
              )}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full transition-all duration-75 ${
                  isSkipWarning ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
                style={{ width: `${tooFar ? 0 : dwellProgress}%` }}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  );
};
