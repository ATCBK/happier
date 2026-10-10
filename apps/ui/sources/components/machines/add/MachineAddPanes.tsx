import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SetupSteps, setupStepTestID, type SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { hapticsSuccess } from '@/components/ui/theme/haptics';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

/** The pane's title and one-paragraph lead (what this way does, in the person's words). */
export function MachineAddPaneHeader(props: Readonly<{ title: string; lead: string; testID?: string }>) {
    const styles = stylesheet;
    return (
        <View testID={props.testID} style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>{props.title}</Text>
            <Text style={styles.lead}>{props.lead}</Text>
        </View>
    );
}

function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The elapsed time of a wait, ticking in its own leaf so nothing else re-renders each second. */
function Elapsed(props: Readonly<{ sinceMs: number }>) {
    const styles = stylesheet;
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    return <Text style={styles.elapsed}>{formatElapsed(now - props.sinceMs)}</Text>;
}

/**
 * "Watching for devbox on Personal Home… 0:42": the one live line while the flow waits for a machine
 * to join (lab MX 1). The watch itself is the arrival owner's; this only says it is happening.
 */
export const MachineWatchLine = React.memo(function MachineWatchLine(props: Readonly<{
    testID: string;
    subject: string;
    homeName: string;
    startedAtMs: number | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} style={styles.watch} accessibilityRole="text" accessibilityLiveRegion="polite">
            <StatusDot color={theme.colors.status.connecting} isPulsing size={8} />
            <Text style={styles.watchText}>
                {t('addFlows.machineWatching', { subject: props.subject })}
                <Text style={styles.watchHome}>{props.homeName}</Text>
                {'…'}
            </Text>
            {props.startedAtMs !== null ? <Elapsed sinceMs={props.startedAtMs} /> : null}
        </View>
    );
});

/** After a long quiet wait (the flow's timer): the likely causes, while watching goes on (lab MX "Not seeing it"). */
export const MachineNotSeeingNotice = React.memo(function MachineNotSeeingNotice(props: Readonly<{
    testID: string;
    subject: string;
    homeName: string;
}>) {
    return (
        <AttentionBanner
            testID={props.testID}
            tone="warning"
            title={t('addFlows.machineNotSeeingTitle', { subject: props.subject })}
            description={t('addFlows.machineNotSeeingBody', { home: props.homeName })}
            accessibilityLiveRegion="polite"
        />
    );
});

export type MachineAddStep = Readonly<{
    id: string;
    label: string;
    state: 'done' | 'running' | 'pending' | 'failed';
    elapsedMs: number | null;
}>;

/** A running setup's steps, as the system task reports them (lab MS "setting up", MS2 "running"). */
export const MachineAddStepList = React.memo(function MachineAddStepList(props: Readonly<{
    testID: string;
    steps: readonly MachineAddStep[];
}>) {
    const steps = React.useMemo(() => props.steps.map((step): SetupStep => {
        const state = step.state === 'pending' ? 'upcoming' : step.state;
        return {
            key: step.id,
            title: step.label,
            state,
            ...(step.elapsedMs !== null && step.state !== 'pending' ? { meta: formatElapsed(step.elapsedMs) } : {}),
            testID: setupStepTestID(props.testID, step.id, state),
        };
    }), [props.steps, props.testID]);
    const styles = stylesheet;
    return (
        <View style={styles.steps}>
            <SetupSteps variant="checklist" steps={steps} />
        </View>
    );
});

export type MachineAddFailure = Readonly<{
    title: string;
    body: string;
    details: string | null;
}>;

/**
 * A setup that stopped: the cause and one recovery, where the eye already is; the inputs stay as they
 * were (lab MS "failed", MX "sign-in refused"). Same notice as every other failure in the app.
 */
export const MachineAddFailureNotice = React.memo(function MachineAddFailureNotice(props: Readonly<{
    testID: string;
    failure: MachineAddFailure;
    onRetry?: () => void;
    secondary?: Readonly<{ label: string; onPress: () => void }> | null;
}>) {
    return (
        <AttentionBanner
            testID={props.testID}
            tone="warning"
            title={props.failure.title}
            description={props.failure.body}
            details={props.failure.details ? [props.failure.details] : undefined}
            announce="alert"
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry, testID: `${props.testID}.retry` } : null}
            secondaryAction={props.secondary ? { ...props.secondary, testID: `${props.testID}.secondary` } : null}
        />
    );
});

/**
 * The machine that just joined (lab MX 3, the Git SX grammar): one quiet success line, the machine's card
 * with one soft ring, and the next step. Phones get one light success haptic.
 */
export const MachineArrivedCard = React.memo(function MachineArrivedCard(props: Readonly<{
    testID: string;
    machineId: string;
    serverId: string;
    name: string;
    facts: string;
    onStartSession: () => void;
    onAddAnother: () => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const ring = useSharedValue(reducedMotion ? 0 : 1);
    React.useEffect(() => {
        void hapticsSuccess();
        if (!reducedMotion) ring.value = withTiming(0, { duration: 900 });
    }, [reducedMotion, ring]);
    const ringStyle = useAnimatedStyle(() => ({ opacity: ring.value * 0.6 }));

    return (
        <View testID={props.testID} style={styles.arrived}>
            <SurfaceStateCard
                testID={`${props.testID}.line`}
                kind="success"
                size="line"
                title={t('addFlows.machineArrived', { machine: props.name })}
                accessibilitySemantics="status"
            />
            <View style={styles.cardFrame}>
                <Animated.View pointerEvents="none" style={[styles.ring, { borderColor: theme.colors.status.connected }, ringStyle]} />
                <SurfaceCard testID={`${props.testID}.card`} padding="sm">
                    <View style={styles.cardRow}>
                        <Icon name="desktop" size={22} color={theme.colors.text.secondary} />
                        <View style={styles.cardCopy}>
                            <Text style={styles.cardName} numberOfLines={1}>{props.name}</Text>
                            <View style={styles.cardFacts}>
                                <StatusDot color={theme.colors.status.connected} size={6} />
                                <Text style={styles.cardFact} numberOfLines={1}>{props.facts}</Text>
                            </View>
                        </View>
                        <MachineCliGlyphs machineId={props.machineId} serverId={props.serverId} isOnline />
                    </View>
                </SurfaceCard>
            </View>
            <View style={styles.actions}>
                <RoundButton
                    testID={`${props.testID}.startSession`}
                    size="small"
                    title={t('addFlows.machineStartSession', { machine: props.name })}
                    onPress={props.onStartSession}
                />
                <RoundButton
                    testID={`${props.testID}.addAnother`}
                    size="small"
                    display="inverted"
                    title={t('addFlows.machineAddAnother')}
                    leading={<Icon name="plus" size={14} color={theme.colors.text.primary} />}
                    onPress={props.onAddAnother}
                />
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    header: {
        gap: 6,
        paddingRight: 28,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        lineHeight: 24,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
    },
    lead: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    watch: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    watchText: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    watchHome: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    elapsed: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        fontVariant: ['tabular-nums'],
        color: theme.colors.text.tertiary,
    },
    steps: {
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        overflow: 'hidden',
        paddingHorizontal: 12,
    },
    arrived: {
        gap: 12,
    },
    cardFrame: {
        position: 'relative',
    },
    ring: {
        position: 'absolute',
        top: -3,
        left: -3,
        right: -3,
        bottom: -3,
        borderRadius: 14,
        borderWidth: 3,
    },
    cardRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    cardCopy: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    cardName: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.text.primary,
    },
    cardFacts: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    cardFact: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
}));
