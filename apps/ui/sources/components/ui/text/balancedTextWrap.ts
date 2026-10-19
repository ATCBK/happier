import { Platform, type TextStyle } from 'react-native';

/**
 * Short centred or capsule copy that needs two lines splits them evenly ("Opening primary on /
 * NLDW4-5-40-40…") instead of leaving one word, or half a hyphenated Machine name, alone on the last
 * line. Web only: native Text has no balanced wrapping, so it is null there.
 */
export const BALANCED_TEXT_WRAP: (TextStyle & { textWrap: 'balance' }) | null =
    Platform.OS === 'web' ? { textWrap: 'balance' } : null;
