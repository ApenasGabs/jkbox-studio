export type NavDirection = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SpatialCandidate {
  rect: RectLike;
}

const DIRECTION_TOLERANCE_PX = 2;
const PERP_OVERLAP_TOLERANCE_PX = 4;
const NON_OVERLAP_PENALTY = 10_000;

function centerOf(rect: RectLike): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

/**
 * Picks the best spatial navigation candidate from `currentRect` in `direction`.
 * Candidates overlapping along the perpendicular axis (same row or column) always
 * take priority over off-axis candidates.
 */
export function findNextSpatialCandidate<T extends SpatialCandidate>(
  currentRect: RectLike,
  candidates: readonly T[],
  direction: NavDirection,
): T | null {
  const origin = centerOf(currentRect);
  const horizontal = direction === 'LEFT' || direction === 'RIGHT';

  let best: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const r = candidate.rect;
    if (r.width <= 0 && r.height <= 0) continue;
    const target = centerOf(r);

    const dx = target.x - origin.x;
    const dy = target.y - origin.y;

    if (direction === 'RIGHT' && dx <= DIRECTION_TOLERANCE_PX) continue;
    if (direction === 'LEFT' && dx >= -DIRECTION_TOLERANCE_PX) continue;
    if (direction === 'DOWN' && dy <= DIRECTION_TOLERANCE_PX) continue;
    if (direction === 'UP' && dy >= -DIRECTION_TOLERANCE_PX) continue;

    const primaryDist = horizontal ? Math.abs(dx) : Math.abs(dy);
    const perpDist = horizontal ? Math.abs(dy) : Math.abs(dx);

    const perpOverlap = horizontal
      ? Math.min(currentRect.bottom, r.bottom) - Math.max(currentRect.top, r.top)
      : Math.min(currentRect.right, r.right) - Math.max(currentRect.left, r.left);

    const aligned = perpOverlap > -PERP_OVERLAP_TOLERANCE_PX;
    const score = aligned
      ? primaryDist + perpDist * 0.3
      : NON_OVERLAP_PENALTY + primaryDist + perpDist * 2.0;

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[data-kiosk-focus="true"]',
].join(', ');

/** Collects visible, enabled, non-skipped interactive elements within `scope`. */
export function getFocusableElements(scope: ParentNode | null): HTMLElement[] {
  if (!scope) return [];
  const all = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return all.filter((el) => {
    if (el.dataset.kioskFocus === 'skip') return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

/** Triggers the currently focused element (focuses text fields or clicks controls). */
export function activateFocusedElement(el: HTMLElement | null): void {
  if (!el || !el.isConnected) return;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    const type = input.type.toLowerCase();
    if (!['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type)) {
      input.focus();
      input.select?.();
      return;
    }
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') {
    el.focus();
    return;
  }
  el.click();
}
