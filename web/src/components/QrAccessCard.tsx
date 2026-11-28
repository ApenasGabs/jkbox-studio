import { QRCodeSVG } from 'qrcode.react';
import { isLoopback, type QrAddressMode, type RemoteAccessTargets } from '../lib/format';

export interface QrAccessCardProps {
  heading: string;
  targets: RemoteAccessTargets;
  qrSize: number;
  variant?: 'sidebar' | 'host';
  publicUrlWarning?: string | null;
  onSelectMode: (mode: QrAddressMode) => void;
  onToggleMode: () => void;
}

export const QrAccessCard = ({
  heading,
  targets,
  qrSize,
  variant = 'sidebar',
  publicUrlWarning,
  onSelectMode,
  onToggleMode,
}: QrAccessCardProps) => {
  const { qrUrl, activeMode, mdnsRemoteUrl, ipRemoteUrl, alternateUrl, canToggleMode } = targets;
  const isHost = variant === 'host';
  const nextLabel = activeMode === 'mdns' ? 'IP direto' : '.local';
  const alternatePrefix =
    activeMode === 'mdns'
      ? 'IP direto:'
      : activeMode === 'ip'
        ? 'Ou via .local:'
        : ipRemoteUrl && alternateUrl === ipRemoteUrl
          ? 'IP na rede:'
          : 'Rede .local:';

  return (
    <div
      className={`glass flex flex-col gap-2.5 ${isHost ? 'p-3.5' : 'p-4'}`}
      data-testid={`qr-access-card-${variant}`}
    >
      <div className="flex items-center gap-3.5">
        {canToggleMode ? (
          <button
            type="button"
            data-testid={`qr-toggle-box-${variant}`}
            onClick={onToggleMode}
            aria-label={`Alternar QR Code para ${nextLabel}`}
            title={`Clique para alternar o QR Code para ${nextLabel}`}
            className={`shrink-0 rounded-xl bg-white transition hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-accent ${
              isHost ? 'p-1.5' : 'p-2'
            }`}
          >
            <QRCodeSVG value={qrUrl} size={qrSize} />
          </button>
        ) : (
          <div className={`shrink-0 rounded-xl bg-white ${isHost ? 'p-1.5' : 'p-2'}`}>
            <QRCodeSVG value={qrUrl} size={qrSize} />
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            {isHost ? (
              <h3 className="text-sm font-semibold">{heading}</h3>
            ) : (
              <p className="font-semibold">{heading}</p>
            )}

            {canToggleMode && (
              <div
                role="group"
                aria-label="Modo de endereço do QR Code"
                className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5 text-[11px]"
              >
                <button
                  type="button"
                  data-testid={`qr-mode-mdns-${variant}`}
                  aria-pressed={activeMode === 'mdns'}
                  onClick={() => onSelectMode('mdns')}
                  className={`rounded-md px-2 py-0.5 font-semibold transition ${
                    activeMode === 'mdns' ? 'bg-accent text-white' : 'text-zinc-300 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  .local
                </button>
                <button
                  type="button"
                  data-testid={`qr-mode-ip-${variant}`}
                  aria-pressed={activeMode === 'ip'}
                  onClick={() => onSelectMode('ip')}
                  className={`rounded-md px-2 py-0.5 font-semibold transition ${
                    activeMode === 'ip' ? 'bg-accent text-white' : 'text-zinc-300 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  IP direto
                </button>
              </div>
            )}
          </div>

          <p
            data-testid={`qr-primary-url-${variant}`}
            className={`font-mono text-accent-2 [overflow-wrap:anywhere] ${isHost ? 'text-xs' : 'text-sm'}`}
          >
            {qrUrl}
          </p>

          {alternateUrl && canToggleMode && (
            <button
              type="button"
              data-testid={`qr-alt-url-${variant}`}
              onClick={onToggleMode}
              title={`Usar ${alternateUrl} no QR Code`}
              className="self-start text-left text-[11px] text-zinc-400 transition hover:text-zinc-200 [overflow-wrap:anywhere]"
            >
              <span className="font-medium text-zinc-300">{alternatePrefix}</span>{' '}
              <span className="font-mono underline decoration-white/25 underline-offset-2">{alternateUrl}</span>
            </button>
          )}

          {activeMode === 'custom' && (mdnsRemoteUrl || ipRemoteUrl) && (
            <div className="flex flex-col gap-0.5 text-[11px] text-zinc-400">
              {ipRemoteUrl && (
                <p className="[overflow-wrap:anywhere]">
                  <span className="font-medium text-zinc-300">IP LAN:</span>{' '}
                  <span className="font-mono">{ipRemoteUrl}</span>
                </p>
              )}
              {mdnsRemoteUrl && (
                <p className="[overflow-wrap:anywhere]">
                  <span className="font-medium text-zinc-300">Rede .local:</span>{' '}
                  <span className="font-mono">{mdnsRemoteUrl}</span>
                </p>
              )}
            </div>
          )}

          {isLoopback(qrUrl) && (
            <p className="mt-0.5 text-xs text-amber-300">
              Conecte a jukebox ao Wi-Fi ou cabo de rede para exibir o endereço aos celulares.
            </p>
          )}
        </div>
      </div>

      {publicUrlWarning && (
        <p
          data-testid={`qr-public-url-warning-${variant}`}
          className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200"
        >
          {isHost ? publicUrlWarning : 'PUBLIC_URL de outra rede ignorado automaticamente; exibindo endereço ativo da LAN.'}
        </p>
      )}
    </div>
  );
};
