import { useUnistyles } from 'react-native-unistyles';

import { useLocalSetting } from '@/sync/domains/state/storage';

export type ImageBackingKind = 'image' | 'svg';

/**
 * What sits behind a picture wherever it is shown (well, Media stage): the manual `⋯ > Background`
 * paper, or the ink checkerboard for alpha-capable kinds (lab FV4a; O-P2-1: no automatic paper).
 */
export function useImageBacking(
  kind: ImageBackingKind,
  alphaCapable: boolean,
): Readonly<{ paper: string | null; checkerboard: boolean }> {
  const { theme } = useUnistyles();
  const background =
    useLocalSetting('filesImageBackgroundByKind')[kind] ?? 'checkerboard';
  return {
    paper:
      background === 'light'
        ? theme.colors.overlay.mediaPaper
        : background === 'dark'
          ? theme.colors.overlay.stageImmersive
          : null,
    checkerboard: alphaCapable && background === 'checkerboard',
  };
}
