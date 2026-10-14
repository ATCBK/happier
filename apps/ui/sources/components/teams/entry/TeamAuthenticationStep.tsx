import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell';

import type { TeamAuthEntrySelection } from './TeamAuthEntrySurface';
import { TeamEntryIdentity } from './TeamEntryIdentity';

const NOOP = () => {};

/**
 * The sign-in step a person reaches by choosing a method on a Team entry page.
 * It stays in the same split shell and under the same Team identity as the
 * entry page and the joined card; only the method's own form changes.
 */
export function TeamAuthenticationStep(props: Readonly<{
    selection: TeamAuthEntrySelection;
    onBack: () => void;
    children: React.ReactNode;
}>) {
    const { selection } = props;
    return (
        <UnauthenticatedSplitShell
            testID="team-auth-step-shell"
            stepId={`team-auth-step:${selection.action.methodId}:${selection.action.action}`}
            isWelcomeStep={false}
            showMobileWordmark
            allowMobileBrandHero={false}
            onOpenRelayCustomFlow={NOOP}
            onBrandHeroGetStarted={NOOP}
            onBack={props.onBack}
        >
            <View style={styles.content}>
                <TeamEntryIdentity
                    testIDPrefix="team-auth-step"
                    teamId={selection.teamId}
                    teamName={selection.teamName}
                    logo={selection.teamLogo ?? null}
                />
                {props.children}
            </View>
        </UnauthenticatedSplitShell>
    );
}

const styles = StyleSheet.create(() => ({
    content: {
        width: '100%',
        gap: 22,
    },
}));
