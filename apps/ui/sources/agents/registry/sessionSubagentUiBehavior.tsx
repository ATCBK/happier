import * as React from 'react';
import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveAgentUiBehaviorFromSessionMetadata } from '@/agents/registry/registryUiBehavior';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { AgentInlineSurface } from './agentUiBehavior/AgentInlineSurface';

function readInlineDetailsResource(tab: DetailsTab): Readonly<{
    pluginId: string;
    agentId: string;
    surfaceId: string;
    iconName: string | null;
    mode: string | null;
    initialTeamId: string | null;
    teamIds: readonly string[];
}> | null {
    const resource = tab.resource;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return null;
    const marker = (resource as Record<string, unknown>).pluginInlineSurface;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
    const value = marker as Record<string, unknown>;
    const read = (entry: unknown) => typeof entry === 'string' && entry.trim() ? entry.trim() : null;
    const pluginId = read(value.pluginId);
    const agentId = read(value.agentId);
    const surfaceId = read(value.surfaceId);
    if (!pluginId || !agentId || !surfaceId) return null;
    return {
        pluginId,
        agentId,
        surfaceId,
        iconName: read(value.iconName),
        mode: read((resource as Record<string, unknown>).mode),
        initialTeamId: read((resource as Record<string, unknown>).initialTeamId),
        teamIds: readStringList((resource as Record<string, unknown>).teamIds),
    };
}

function readStringList(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => (typeof entry === 'string' && entry.trim() ? [entry.trim()] : []));
}

/** The launch surface a Details tab presents instead of the teammate launcher (`mode: 'launch'`). */
const LAUNCH_DETAILS_MODE = 'launch';

function resolveAgentUiBehaviorFromSession(session: Session) {
    return resolveAgentUiBehaviorFromSessionMetadata(readSessionOwnerMetadataView(session));
}

export function hasSessionSubagentLaunchCards(session: Session | null): boolean {
    if (!session) return false;
    const behavior = resolveAgentUiBehaviorFromSession(session);
    return typeof behavior?.sessionSubagents?.renderLaunchCards === 'function';
}

export function createSessionTeammateLauncherDetailsTab(params: Readonly<{
    session: Session | null;
    teamId: string;
}>): DetailsTab | null {
    if (!params.session) return null;
    const behavior = resolveAgentUiBehaviorFromSession(params.session);
    const createTab = behavior?.sessionSubagents?.createTeammateLauncherDetailsTab;
    if (!createTab) return null;
    return createTab({
        session: params.session,
        teamId: params.teamId,
    });
}

/**
 * The Agent's launch surface as a Details tab, for a host that offers launching from a menu (the
 * Agents pane's "+") rather than as a card. `null` when the Agent contributes none.
 */
export function createSessionSubagentLaunchDetailsTab(params: Readonly<{
    session: Session | null;
    subagents: readonly SessionSubagent[];
}>): DetailsTab | null {
    if (!params.session) return null;
    const behavior = resolveAgentUiBehaviorFromSession(params.session);
    const createTab = behavior?.sessionSubagents?.createLaunchDetailsTab;
    if (!createTab) return null;
    return createTab({ session: params.session, subagents: params.subagents });
}

export function hasSessionTeammateLauncher(session: Session | null): boolean {
    if (!session) return false;
    const behavior = resolveAgentUiBehaviorFromSession(session);
    return typeof behavior?.sessionSubagents?.createTeammateLauncherDetailsTab === 'function';
}

const launchTabStyles = StyleSheet.create((theme) => ({
    content: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
    },
}));

/**
 * A launch surface is `content`: the host owns its bounds, gutters and scroll. In a Details tab that
 * host is this frame, so the plugin's buttons never sit on the pane edge.
 */
function SessionSubagentLaunchTabFrame(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    return (
        <ScrollView contentContainerStyle={launchTabStyles.content} keyboardShouldPersistTaps="handled">
            {props.children}
        </ScrollView>
    );
}

export function renderProviderSessionDetailsTab(params: Readonly<{
    sessionId: string;
    scopeId: string;
    serverId?: string | null;
    tab: DetailsTab;
}>): React.ReactNode | null {
    const inline = readInlineDetailsResource(params.tab);
    if (inline && inline.mode === LAUNCH_DETAILS_MODE) {
        return (
            <SessionSubagentLaunchTabFrame>
                <AgentInlineSurface
                    pluginId={inline.pluginId}
                    surfaceId={inline.surfaceId}
                    sessionId={params.sessionId}
                    serverId={params.serverId}
                    agentId={inline.agentId}
                    inlineMount={{ role: 'sessionSubagentLaunch', presentation: 'content' }}
                    launchInput={{ teamIds: inline.teamIds }}
                />
            </SessionSubagentLaunchTabFrame>
        );
    }
    if (inline) {
        return (
            <AgentInlineSurface
                pluginId={inline.pluginId}
                surfaceId={inline.surfaceId}
                sessionId={params.sessionId}
                serverId={params.serverId}
                agentId={inline.agentId}
                inlineMount={{ role: 'sessionSubagentDetails', presentation: 'fill' }}
                launchInput={{ mode: inline.mode, initialTeamId: inline.initialTeamId }}
            />
        );
    }
    return null;
}

export function resolveProviderSessionDetailsTabIconName(tab: DetailsTab): string | null {
    const inline = readInlineDetailsResource(tab);
    if (inline) return inline.iconName;
    return null;
}
