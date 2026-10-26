import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { computeAgentInputDefaultMaxHeight } from './inputMaxHeight';

/**
 * The tallest a composer field grows before it scrolls, when its host gives it no budget of its own.
 * The live `AgentInput` and the static document picture drawn before it is edited both read this one
 * owner, so a long prompt wraps, clips and scrolls identically in both.
 */
export function useAgentInputDefaultMaxHeight(): number {
    const { height: screenHeight } = useWindowDimensions();
    return React.useMemo(
        () => computeAgentInputDefaultMaxHeight({ platform: Platform.OS, screenHeight, keyboardHeight: 0 }),
        [screenHeight],
    );
}
