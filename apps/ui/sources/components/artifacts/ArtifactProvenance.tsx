import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HappierProvenanceChip } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useMachineDisplayNamesById, useSessionDisplayNameSource } from '@/sync/store/hooks';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import type { ArtifactProvenance as Provenance } from './artifactBrowserModel';

/** The session and machine names a provenance names, from the store's narrow display projections. */
function useProvenanceNames(provenance: Provenance): Readonly<{ session: string; machine: string | null }> {
    const source = useSessionDisplayNameSource(provenance.sessionId);
    const machineIds = React.useMemo(() => [provenance.machineId], [provenance.machineId]);
    const machines = useMachineDisplayNamesById(machineIds);
    const fileName = provenance.path.split(/[\\/]/).filter(Boolean).pop() ?? provenance.path;
    return {
        session: source ? getSessionName(source) : t('artifacts.browser.provenance.fromFile', { name: fileName }),
        machine: machines[provenance.machineId] ?? null,
    };
}

/**
 * Where an artifact came from: "session · machine". `line` sits under a card or row title;
 * `chip` heads the artifact view and opens the session it came from.
 */
export const ArtifactProvenanceLabel = React.memo(function ArtifactProvenanceLabel(props: Readonly<{
    provenance: Provenance | null;
    /** What to say when no producer recorded a source (an artifact someone wrote by hand). */
    fallback: string;
    presentation: 'line' | 'chip';
    testID?: string;
}>) {
    if (props.provenance === null) return <ProvenanceText icon="user-circle" session={props.fallback} machine={null} presentation={props.presentation} testID={props.testID} />;
    return <SourcedProvenance provenance={props.provenance} presentation={props.presentation} testID={props.testID} />;
});

function SourcedProvenance(props: Readonly<{ provenance: Provenance; presentation: 'line' | 'chip'; testID?: string }>) {
    const names = useProvenanceNames(props.provenance);
    const router = useRouter();
    return <ProvenanceText icon="chat-circle" session={names.session} machine={names.machine}
        presentation={props.presentation} chevron={props.presentation === 'chip'} testID={props.testID}
        {...(props.presentation === 'chip' ? {
            accessibilityLabel: t('artifacts.browser.provenance.openSession', { session: names.session }),
            onPress: () => router.push(buildScopedSessionRouteHref({ sessionId: props.provenance.sessionId }) as never),
        } : {})} />;
}

function ProvenanceText(props: Readonly<{
    icon: 'chat-circle' | 'user-circle';
    session: string;
    machine: string | null;
    presentation: 'line' | 'chip';
    chevron?: boolean;
    testID?: string;
    accessibilityLabel?: string;
    onPress?: () => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const chip = props.presentation === 'chip';
    if (chip) return <HappierProvenanceChip testID={props.onPress && props.testID ? `${props.testID}:open` : props.testID}
        label={[props.session, props.machine].filter(Boolean).join(' · ')}
        accessibilityLabel={props.accessibilityLabel} onPress={props.onPress} style={styles.chipPress}
        colors={{ foreground: theme.colors.text.primary, background: theme.colors.surface.elevated,
            focus: theme.colors.border.focus }}
        badgeStyle={[styles.chip, { paddingVertical: 0 }]}
        leading={<Icon name={props.icon} size={13} color={theme.colors.text.tertiary} />}
        trailing={props.chevron ? <Icon name="caret-right" size={11} color={theme.colors.text.tertiary} /> : undefined}
        labelContent={<View style={styles.row} testID={props.onPress ? props.testID : undefined}>
            <Text numberOfLines={1} style={[styles.session, styles.chipText]}>{props.session}</Text>
            {props.machine ? <Text numberOfLines={1} style={styles.machine}>{`· ${props.machine}`}</Text> : null}
        </View>} />;
    return (
        <View style={styles.row} testID={props.testID}>
            <Icon name={props.icon} size={12} color={theme.colors.text.tertiary} />
            <Text numberOfLines={1} style={styles.session}>{props.session}</Text>
            {props.machine ? <Text numberOfLines={1} style={styles.machine}>{`· ${props.machine}`}</Text> : null}
            {props.chevron ? <Icon name="caret-right" size={11} color={theme.colors.text.tertiary} /> : null}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
        flexShrink: 1,
    },
    chip: {
        alignSelf: 'flex-start',
        height: 26,
        paddingLeft: 8,
        paddingRight: 9,
        borderRadius: 13,
        backgroundColor: theme.colors.surface.elevated,
    },
    chipPress: {
        alignSelf: 'flex-start',
        borderRadius: 13,
    },
    session: {
        flexShrink: 1,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    chipText: {
        color: theme.colors.text.primary,
    },
    machine: {
        flexShrink: 0,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.tertiary,
    },
}));
