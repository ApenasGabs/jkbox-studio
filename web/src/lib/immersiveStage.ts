export type StageMode = 'cover' | 'lyrics' | 'video';

export interface StageLayoutInput {
  isDesktop: boolean;
  cinemaMode: boolean;
  stageMode: StageMode;
  hasTrack: boolean;
  hasModalOpen: boolean;
  unlocked: boolean;
  idle: boolean;
}

export interface StageLayoutFlags {
  isImmersiveStage: boolean;
  isDesktopImmersive: boolean;
  sidebarCollapsed: boolean;
  autoHideActive: boolean;
  controlsHidden: boolean;
}

/** Returns true when the current stage mode warrants an expanded immersive canvas. */
export function isImmersiveStageMode(stageMode: StageMode, hasTrack: boolean): boolean {
  return hasTrack && (stageMode === 'lyrics' || stageMode === 'video');
}

/** Computes immersive layout, sidebar collapse, and auto-hide flags for the Kiosk stage. */
export function computeStageLayoutFlags(input: StageLayoutInput): StageLayoutFlags {
  const isImmersiveStage = isImmersiveStageMode(input.stageMode, input.hasTrack);
  const isDesktopImmersive = input.isDesktop && isImmersiveStage;
  const sidebarCollapsed = input.cinemaMode || isDesktopImmersive;
  const autoHideActive = (input.cinemaMode || isDesktopImmersive) && !input.hasModalOpen && input.unlocked;
  const controlsHidden = autoHideActive && input.idle;

  return {
    isImmersiveStage,
    isDesktopImmersive,
    sidebarCollapsed,
    autoHideActive,
    controlsHidden,
  };
}
