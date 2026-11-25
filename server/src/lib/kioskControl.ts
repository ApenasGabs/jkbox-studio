/** Remote control of the TV (Kiosk `/`) from the Main Controller phone (`/remote`). */
export const KIOSK_STAGE_VIEWS = ['cover', 'lyrics', 'video', 'cinema'] as const;
export type KioskStageView = (typeof KIOSK_STAGE_VIEWS)[number];

export type KioskControl =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'toggle' }
  | { action: 'volume'; value: number }
  | { action: 'stage'; value: KioskStageView }
  | { action: 'reactions'; value: boolean };

const STAGE_VIEWS = new Set<string>(KIOSK_STAGE_VIEWS);

export type ParseKioskControlResult = { ok: true; control: KioskControl } | { ok: false; error: string };

export function parseKioskControl(body: unknown): ParseKioskControlResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Corpo inválido' };
  const { action, value } = body as { action?: unknown; value?: unknown };
  switch (action) {
    case 'play':
    case 'pause':
    case 'toggle':
      return { ok: true, control: { action } };
    case 'volume':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        return { ok: false, error: 'value deve ser um número entre 0 e 100' };
      }
      return { ok: true, control: { action, value: Math.round(value) } };
    case 'stage':
      if (typeof value !== 'string' || !STAGE_VIEWS.has(value)) {
        return { ok: false, error: `value deve ser ${KIOSK_STAGE_VIEWS.join(', ')}` };
      }
      return { ok: true, control: { action, value: value as KioskStageView } };
    case 'reactions':
      if (typeof value !== 'boolean') return { ok: false, error: 'value deve ser booleano' };
      return { ok: true, control: { action, value } };
    default:
      return { ok: false, error: 'action deve ser play, pause, toggle, volume, stage ou reactions' };
  }
}
