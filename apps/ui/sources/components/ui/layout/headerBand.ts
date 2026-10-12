import { Platform } from 'react-native';

import { Typography } from '@/constants/Typography';

/**
 * The top band a column opens with: the session header over the transcript and the header of a
 * side pane beside it. Both take their height from `useHeaderHeight()` and their text and inset
 * from here, so side by side they read as one band with one baseline.
 */
export const HEADER_BAND_HORIZONTAL_PADDING_PX = Platform.OS === 'ios' ? 8 : 16;

export const HEADER_BAND_TITLE_TEXT = {
    ...Typography.variant('heading'),
} as const;

export const HEADER_BAND_SUBTITLE_TEXT = {
    ...Typography.variant('meta'),
    marginTop: 1,
} as const;
