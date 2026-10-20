import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    resolveSessionContextLine,
    projectSessionContextPresentation,
    resolveSessionHomeLastUpdatedLabel,
    type SessionContextFacts,
    type SessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { t } from '@/text';
import { SessionContextChips } from '@/components/sessions/context/SessionContextChips';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { readApprovalSessionEndpointLabels } from './approvalEndpointLabels';
import { useWorkClockSnapshot } from '@/components/sessions/agents/presentation/agentActivityClock';
import type { ApprovalSessionReadingStatus } from './useApprovalSessionReading';
import {
    describeApprovalAgent,
    describeApprovalOrigin,
    describeUnnamedApprovalRequester,
    resolveApprovalHomeSentenceName,
} from './approvalRequesterLabels';

const ApprovalContextLine = React.memo(function ApprovalContextLine(props: Readonly<{
    context: SessionContextPresentation | null;
    facts?: SessionContextFacts | null;
    showWorkspace: boolean;
}>) {
    const snapshotAt = React.useCallback((nowMs: number) => {
        const context = props.facts ? projectSessionContextPresentation({ ...props.facts, freshness: {
            ...props.facts.freshness,
            lastUpdatedLabel: resolveSessionHomeLastUpdatedLabel(props.facts.freshness, nowMs),
        } }) : props.context;
        return resolveSessionContextLine(context ? { segments: context.segments.filter((segment) => segment.kind !== 'home') } : null,
            { showWorkspace: props.showWorkspace });
    }, [props.context, props.facts, props.showWorkspace]);
    const line = useWorkClockSnapshot(snapshotAt);
    return line ? <Text style={styles.homeLabel}>{line}</Text> : null;
});

/**
 * The "Requested by" section of an approval page: the requesting session, where it runs, and the
 * agent and surface that asked. Renders nothing when none of that is known.
 */
export const ApprovalSessionContextCard = React.memo(function ApprovalSessionContextCard(props: Readonly<{
    session: Session | SessionListRenderableSession | null;
    machine: Machine | null;
    serverId: string | null;
    context: SessionContextPresentation | null;
    /** Source facts let the context-line leaf date an unavailable Home without repainting this card. */
    contextFacts?: SessionContextFacts | null;
    /** The Home's own name, when this device knows the Home that asked; never its address. */
    homeName?: string | null;
    /**
     * Immutable, secret-free Home origin, for a Home this device has no profile for (or whose saved
     * route no longer matches): its exact identity is then the only truthful thing to show.
     */
    homeDisplayId?: string | null;
    /** The requester's name from `useApprovalSessionReading`, its one readable-name gate; null while locked or unknown. */
    sessionName: string | null;
    /** The session the request names; when this device does not have it, it reads by where it lives. */
    requesterSessionId?: string | null;
    requesterStatus?: ApprovalSessionReadingStatus;
    requesterAgentId: string | null;
    requesterSurface: string;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const homeName = props.homeName?.trim() || null;
    const namedSession = props.sessionName?.trim() || null;
    // A session this device cannot name is never shown by its id: it reads by where it lives.
    const sentenceHome = homeName ?? resolveApprovalHomeSentenceName(props.serverId);
    const sessionTitle = namedSession
        ?? (props.requesterSessionId?.trim() && props.requesterStatus !== 'resolving' ? describeUnnamedApprovalRequester(props.requesterSurface, sentenceHome) : null);
    const agentLabel = describeApprovalAgent(props.requesterAgentId);
    const originLabel = describeApprovalOrigin(props.requesterSurface);
    const endpointLabels = readApprovalSessionEndpointLabels({
        session: props.session,
        machine: props.machine,
    });
    const machineLabel = endpointLabels.machineLabel;
    const pathLabel = props.serverId ? props.context?.workspace?.label ?? null : endpointLabels.pathLabel;
    // Each fact once: the chips carry the machine and the folder, so the context line leaves the
    // folder out. The Home is named by this section's own Home line (the app's name for it, not the address the
    // session context falls back to), so the context line carries only what else is known.
    const contextLine = resolveSessionContextLine(
        props.context ? { segments: props.context.segments.filter((segment) => segment.kind !== 'home') } : null,
        { showWorkspace: !pathLabel },
    );
    // While the asking session is read, its line is held by a neutral placeholder: nothing claims it is
    // elsewhere, and nothing else takes the lead only to be replaced when the name lands.
    const sessionResolving = !namedSession && props.requesterStatus === 'resolving' && Boolean(props.requesterSessionId?.trim());
    const homeLabel = namedSession || (!sessionTitle && !sessionResolving)
        ? homeName ?? props.homeDisplayId?.trim() ?? null
        // "A session on <Home>" already names the Home.
        : sentenceHome ? null : props.homeDisplayId?.trim() ?? null;

    if (!sessionTitle && !sessionResolving && !pathLabel && !machineLabel && !agentLabel && !originLabel && !homeLabel) {
        return null;
    }
    // The section always leads with one main line: the session, else the Home that asked (by its
    // name, so it is not also repeated as a "Home: …" fact), else who asked and how.
    const homeLeads = !sessionTitle && !sessionResolving && Boolean(homeLabel);
    const requesterFacts = agentLabel || originLabel ? joinHappierFacts(agentLabel, originLabel) : null;
    const factsLead = !sessionTitle && !sessionResolving && !homeLeads;
    const mainLine = sessionTitle ?? (homeLeads ? homeLabel : requesterFacts);

    return (
        <ItemGroup
            title={t('detailPages.approval.contextTitle')}
            description={t('detailPages.approval.contextDescription')}
        >
        <SectionContentRow>
        <View style={styles.card}>
            <View style={styles.headerRow}>
                <View style={styles.titleColumn}>
                    {sessionResolving ? (
                        <HappierSkeletonBlock testID="approvals.requester-title-resolving" width={180}
                            height={REQUESTER_TITLE_LINE_PX} color={theme.colors.surface.skeleton} />
                    ) : mainLine ? <Text testID="approvals.requester-title" numberOfLines={2} style={styles.title}>{mainLine}</Text> : null}
                    {machineLabel || pathLabel ? (
                        <View style={mainLine || sessionResolving ? styles.contextChips : null}>
                            <SessionContextChips machineLabel={machineLabel} pathLabel={pathLabel} />
                        </View>
                    ) : null}
                    {contextLine || props.contextFacts ? <ApprovalContextLine context={props.context}
                        facts={props.contextFacts} showWorkspace={!pathLabel} /> : null}
                    {homeLabel && !homeLeads ? (
                        <Text style={styles.homeLabel}>{t('actionConfirmations.homeTarget', { serverId: homeLabel })}</Text>
                    ) : null}
                </View>

                {props.session?.id ? (
                    <Pressable
                        testID="approvals.open-session"
                        accessibilityRole="button"
                        accessibilityLabel={t('runs.openSession')}
                        onPress={() => router.push(buildScopedSessionRouteHref({
                            sessionId: props.session!.id,
                            serverId: props.serverId,
                        }))}
                        style={({ pressed }) => [styles.openButton, pressed && styles.openButtonPressed]}
                    >
                        <Icon name="arrow-square-out" size={16} color={theme.colors.text.primary} />
                    </Pressable>
                ) : null}
            </View>

            {requesterFacts && !factsLead ? (
                // Who asked and how it arrived, as one quiet line of words (never the stored enum).
                <Text testID="approvals.requester-origin" style={styles.metaText}>
                    {requesterFacts}
                </Text>
            ) : null}
        </View>
        </SectionContentRow>
        </ItemGroup>
    );
});

/** The session line's height at its 15 pt title, so the name lands without moving the card. */
const REQUESTER_TITLE_LINE_PX = 20;

const styles = StyleSheet.create((theme) => ({
    // Sheet content of the "Requested by" section: the section owns the chrome.
    card: {
        gap: theme.space.s12,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('medium'),
        fontSize: 15,
        color: theme.colors.text.primary,
    },
    contextChips: {
        marginTop: theme.space.s8,
    },
    homeLabel: {
        marginTop: theme.space.s8,
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    metaText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        lineHeight: 18,
    },
    openButton: {
        width: 32,
        height: 32,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    openButtonPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));
