import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LyricsView } from '../components/LyricsView';
import { VideoLyricsOverlay } from '../components/VideoLyricsOverlay';
import { computeStageLayoutFlags, isImmersiveStageMode } from './immersiveStage';
import type { TrackLyrics } from './types';

function makeLyrics(overrides: Partial<TrackLyrics> = {}): TrackLyrics {
  return {
    trackId: 'track-1',
    source: 'lrclib',
    syncedLrc: '[00:05.00] Primeira linha\n[00:10.00] Segunda linha',
    plainLyrics: 'Primeira linha\nSegunda linha',
    instrumental: false,
    offsetMs: 0,
    fetchedAt: 1700000000000,
    ...overrides,
  };
}

describe('immersiveStage', () => {
  it('identifies lyrics and video as immersive modes only when a track is active', () => {
    expect(isImmersiveStageMode('cover', true)).toBe(false);
    expect(isImmersiveStageMode('lyrics', true)).toBe(true);
    expect(isImmersiveStageMode('video', true)).toBe(true);
    expect(isImmersiveStageMode('lyrics', false)).toBe(false);
    expect(isImmersiveStageMode('video', false)).toBe(false);
  });

  it('collapses sidebar and activates auto-hide automatically on desktop in lyrics/video modes', () => {
    expect(
      computeStageLayoutFlags({
        isDesktop: true,
        cinemaMode: false,
        stageMode: 'lyrics',
        hasTrack: true,
        hasModalOpen: false,
        unlocked: true,
        idle: true,
      }),
    ).toEqual({
      isImmersiveStage: true,
      isDesktopImmersive: true,
      sidebarCollapsed: true,
      autoHideActive: true,
      controlsHidden: true,
    });

    // Cover mode without cinema keeps sidebar visible and controls visible.
    expect(
      computeStageLayoutFlags({
        isDesktop: true,
        cinemaMode: false,
        stageMode: 'cover',
        hasTrack: true,
        hasModalOpen: false,
        unlocked: true,
        idle: true,
      }),
    ).toEqual({
      isImmersiveStage: false,
      isDesktopImmersive: false,
      sidebarCollapsed: false,
      autoHideActive: false,
      controlsHidden: false,
    });

    // Mobile/tablet keeps natural stacked sidebar & disables desktop auto-hide unless cinema is active.
    expect(
      computeStageLayoutFlags({
        isDesktop: false,
        cinemaMode: false,
        stageMode: 'video',
        hasTrack: true,
        hasModalOpen: false,
        unlocked: true,
        idle: true,
      }),
    ).toEqual({
      isImmersiveStage: true,
      isDesktopImmersive: false,
      sidebarCollapsed: false,
      autoHideActive: false,
      controlsHidden: false,
    });

    // Open drawers/modals pause auto-hide immediately.
    expect(
      computeStageLayoutFlags({
        isDesktop: true,
        cinemaMode: false,
        stageMode: 'video',
        hasTrack: true,
        hasModalOpen: true,
        unlocked: true,
        idle: true,
      }),
    ).toMatchObject({
      sidebarCollapsed: true,
      autoHideActive: false,
      controlsHidden: false,
    });
  });

  it('renders LyricsView with enlarged typography and floating auto-hide sync bar in immersive mode', () => {
    const html = renderToStaticMarkup(
      <LyricsView
        variant="kiosk"
        immersive
        controlsHidden
        lyrics={makeLyrics()}
        loading={false}
        error={null}
        currentTimeSec={6}
        onAdjustOffset={() => {}}
        onResetOffset={() => {}}
      />,
    );

    expect(html).toContain('data-kiosk-stage="lyrics"');
    expect(html).toContain('lg:text-5xl');
    expect(html).toContain('pointer-events-none opacity-0');
    expect(html).not.toContain('class="glass');
  });

  it('positions VideoLyricsOverlay above bottom controls when controls are visible in immersive mode', () => {
    const visibleHtml = renderToStaticMarkup(
      <VideoLyricsOverlay lyrics={makeLyrics()} loading={false} currentTimeSec={6} immersive controlsVisible />,
    );
    const hiddenHtml = renderToStaticMarkup(
      <VideoLyricsOverlay lyrics={makeLyrics()} loading={false} currentTimeSec={6} immersive controlsVisible={false} />,
    );

    expect(visibleHtml).toContain('bottom-32');
    expect(visibleHtml).toContain('lg:text-2xl xl:text-3xl');
    expect(hiddenHtml).toContain('bottom-5');
    expect(hiddenHtml).not.toContain('bottom-32');
  });
});
