import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell';

const NOOP = () => {};

/**
 * The one shell of every public Team entry step: the invitation and Team sign-in pages, the method form
 * a person picks there, their loading, failure and "you've joined" states. Each starts at the top of the
 * workflow pane under the same mark, so moving between them changes what sits there and never where it
 * starts; a state card does not drift to the middle of the pane.
 */
export function TeamEntryShell(props: Readonly<{
    testID: string;
    /** Identifies the step; a change fades one step into the next. */
    stepId: string;
    onBack?: () => void;
    children: React.ReactNode;
}>) {
    return (
        <UnauthenticatedSplitShell
            testID={props.testID}
            stepId={props.stepId}
            isWelcomeStep={false}
            showMobileWordmark
            allowMobileBrandHero={false}
            onOpenRelayCustomFlow={NOOP}
            onBrandHeroGetStarted={NOOP}
            onBack={props.onBack}
        >
            {/* Natural height: a state's own centering has nothing to centre in, so it sits at the top. */}
            <View style={styles.top}>{props.children}</View>
        </UnauthenticatedSplitShell>
    );
}

const styles = StyleSheet.create(() => ({
    top: {
        width: '100%',
    },
}));
