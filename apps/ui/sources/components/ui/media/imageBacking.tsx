import * as React from 'react';
import Svg, { Defs, Pattern, Rect } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useLocalSetting } from '@/sync/domains/state/storage';

/** One checker square of the transparency board (lab files FV4a: 8 px ink squares). */
const CHECKER_PX = 8;

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

/** The transparency board of every image well; image compare layers draw on the same one. */
export function ImageWellCheckerboard(props: Readonly<{ color: string; testID?: string }>) {
  return (
    <Svg
      {...(props.testID ? { testID: props.testID } : {})}
      width="100%"
      height="100%"
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      <Defs>
        <Pattern
          id="image-well-checker"
          width={CHECKER_PX * 2}
          height={CHECKER_PX * 2}
          patternUnits="userSpaceOnUse"
        >
          <Rect
            width={CHECKER_PX * 2}
            height={CHECKER_PX * 2}
            fill={props.color}
            fillOpacity={0.04}
          />
          <Rect
            width={CHECKER_PX}
            height={CHECKER_PX}
            fill={props.color}
            fillOpacity={0.08}
          />
          <Rect
            x={CHECKER_PX}
            y={CHECKER_PX}
            width={CHECKER_PX}
            height={CHECKER_PX}
            fill={props.color}
            fillOpacity={0.08}
          />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#image-well-checker)" />
    </Svg>
  );
}

