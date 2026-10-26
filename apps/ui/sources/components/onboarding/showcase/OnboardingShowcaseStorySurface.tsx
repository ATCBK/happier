import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { AskHappierNote } from '@/components/sessions/bots/AskHappierOfferCard';
import type { OnboardingShowcaseManifest } from '@/onboarding/showcase/types';
import { t } from '@/text';
import { StoryDeckSurface, StorySheetFrame } from '@/components/ui/storyDeck';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    skip: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s8,
    },
    skipText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body', 'semiBold'),
    },
}));

export type OnboardingShowcaseStorySurfaceProps = Readonly<{
    manifest: OnboardingShowcaseManifest;
    onComplete: () => void;
    onDismiss: () => void;
    /** The last card's secondary action: Ask Happier sets things up with the person (never auto-starts). */
    onAskHappier?: () => void;
    testID?: string;
}>;

export function OnboardingShowcaseStorySurface(props: OnboardingShowcaseStorySurfaceProps) {
    useUnistyles();
    const styles = stylesheet;
    const testID = props.testID ?? 'onboarding-showcase-story';
    return (
        <StorySheetFrame
            testID={testID}
            onDismiss={props.onDismiss}
            topRightAction={(
                <HappierPressable
                    testID={`${testID}-skip`}
                    onPress={props.onDismiss}
                    style={styles.skip}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.skip')}
                >
                    <Text style={styles.skipText}>{t('common.skip')}</Text>
                </HappierPressable>
            )}
        >
            <StoryDeckSurface
                cards={props.manifest.cards}
                onComplete={props.onComplete}
                onDismiss={props.onDismiss}
                {...(props.onAskHappier ? { onSecondaryAction: props.onAskHappier, secondaryActionLabel: t('bots.guide.offer'), secondaryActionNote: <AskHappierNote testID={`${testID}-ask-happier-note`} /> } : {})}
                slideAnimation="softBlur"
                alternateWideMediaPlacement
                testID={`${testID}-deck`}
            />
        </StorySheetFrame>
    );
}
