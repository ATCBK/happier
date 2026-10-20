import { Platform } from 'react-native';

/**
 * Short centred or capsule copy that needs two lines splits them evenly ("Opening primary on /
 * NLDW4-5-40-40…") instead of leaving one word, or half a hyphenated Machine name, alone on the last
 * line. Web only: native Text has no balanced wrapping, so it is null there.
 *
 * The shared centred state ({@link HappierInfoTile}) and the floating capsules' title runs apply it
 * themselves; a host that draws its own text into those slots spreads it into that text's style.
 */
export const HAPPIER_BALANCED_TEXT_WRAP: Readonly<{ textWrap: 'balance' }> | null =
  Platform.OS === 'web' ? Object.freeze({ textWrap: 'balance' as const }) : null;
