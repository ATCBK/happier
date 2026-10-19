import * as React from 'react';
import type { DiscussionParticipantsListResponseV1 } from '@happier-dev/protocol/discussions/participants';
import type { ExecutableParticipantPickerOption } from '@/components/sessions/authoring/executableParticipantPicker';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { SessionAccessCandidateRowModel, SessionAccessGrantOperationModel } from '@/components/sessions/access/sessionAccessEditorTypes';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionListRowsByServerId } from '@/sync/domains/state/storage';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { buildDiscussionInviteCandidates } from './discussionInviteCandidates';

const NO_OPERATIONS: Readonly<Record<string, SessionAccessGrantOperationModel>> = Object.freeze({});
const NO_TEAMS = Object.freeze([]);
const ACCOUNT_ONLY = Object.freeze(['account'] as const);
const NO_MODELS: readonly ExecutableParticipantPickerOption[] = Object.freeze([]);

/**
 * Mount only while Invite/New participant selection is demanded. Home people search and optional
 * Team roster reuse the shared collaboration directory; existing Sessions/Bots use the ordinary
 * exact-Home listing owner. Models arrive from U4's ordinary authoring picker after user setup,
 * never a separate model inventory. This hook performs reads only, not invitation or setup.
 * Build that optional model choice with buildExecutableModelParticipantSelectionFromAuthoringDraft
 * and buildExecutableParticipantPickerOption, preserving the ordinary selected setup/readiness.
 * People resolve(query, signal) and both loadMore/retry pairs keep their source owner's pagination;
 * `sessions.complete` is required before treating the loaded Session choices as the whole roster.
 */
export function useDiscussionInviteCandidates(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    availability: SessionCollaborationAvailability;
    enabled: boolean;
    roster?: DiscussionParticipantsListResponseV1 | null;
    teamAddress?: TeamAddress;
    modelOptions?: readonly ExecutableParticipantPickerOption[];
}>) {
    const { accountLifetime, availability } = input;
    const { scope } = accountLifetime;
    const subscribe = React.useCallback((notify: () => void) => {
        const registration = accountLifetime.onRetire(notify);
        return () => registration.dispose();
    }, [accountLifetime]);
    const current = React.useSyncExternalStore(subscribe, accountLifetime.isCurrent, accountLifetime.isCurrent);
    const enabled = input.enabled && current && availability === 'available';
    const teamMatches = !input.teamAddress || areServerProfileIdentifiersEquivalent(input.teamAddress.serverId, scope.serverId);
    const directory = useSessionAccessDirectory({ scope, availability, enabled: enabled && teamMatches,
        contextTeams: NO_TEAMS, operations: NO_OPERATIONS, revision: 0,
        principalKinds: ACCOUNT_ONLY, ...(input.teamAddress ? { teamAddress: input.teamAddress } : {}) });
    const homes = React.useMemo(() => enabled ? [{ serverId: scope.serverId, queryMembership: 'rowOnly' as const,
        query: { v: 1 as const, storage: 'active' as const, includeInactive: true, scope: 'all_accessible' as const,
            attention: 'any' as const, audiences: [], tagIds: [] } }] : [], [enabled, scope.serverId]);
    const source = useSessionListQuerySourceState({ enabled, homes });
    const homeIds = React.useMemo(() => enabled ? [scope.serverId] : [], [enabled, scope.serverId]);
    const rowsByHome = useSessionListRowsByServerId(homeIds);
    const rows = readSessionListRowsForServerId(rowsByHome, scope.serverId);
    const addresses = React.useMemo(() => (source.byServerId[scope.serverId] ?? []).flatMap(item =>
        item.type === 'session' ? [{ serverId: scope.serverId, sessionId: item.sessionId }] : []), [scope.serverId, source.byServerId]);
    const labels = useSessionDisplayTitles(addresses);
    const sessions = React.useMemo(() => addresses.map((address, index) => ({ address, label: labels[index] ?? null,
        access: rows?.[address.sessionId]?.access ?? null })), [addresses, labels, rows]);
    const modelOptions = input.modelOptions ?? NO_MODELS;
    const project = React.useCallback((people: readonly SessionAccessCandidateRowModel[]) => accountLifetime.isCurrent()
        ? buildDiscussionInviteCandidates({ scope, people, sessions, modelOptions, roster: input.roster }) : [],
    [accountLifetime, input.roster, modelOptions, scope, sessions]);
    const peopleSource = directory.sections.find(section => section.kind === 'account');
    const resolvePeople = React.useCallback(async (query: string, signal: AbortSignal) => {
        if (!enabled || !teamMatches || !accountLifetime.isCurrent() || signal.aborted || !peopleSource?.resolveCandidates) return [];
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        const retirement = accountLifetime.onRetire(abort);
        try {
            const rows = await peopleSource.resolveCandidates(query, controller.signal);
            return controller.signal.aborted || !accountLifetime.isCurrent() ? [] : project(rows).filter(candidate => candidate.kind === 'account');
        } catch (error) {
            if (controller.signal.aborted || !accountLifetime.isCurrent()) return [];
            throw error;
        } finally {
            retirement.dispose();
            signal.removeEventListener('abort', abort);
        }
    }, [accountLifetime, enabled, peopleSource, project, teamMatches]);
    const candidates = React.useMemo(() => enabled ? project(peopleSource?.candidates ?? []) : [], [enabled, peopleSource?.candidates, project]);
    return React.useMemo(() => ({ candidates,
        people: { status: peopleSource?.status ?? 'idle', error: peopleSource?.error, hasMore: enabled && (peopleSource?.hasMore ?? false),
            loadingMore: peopleSource?.loadingMore ?? false, resolverKey: peopleSource?.resolverKey,
            resolve: resolvePeople, loadMore: () => { if (enabled && accountLifetime.isCurrent()) directory.loadMore('account'); },
            retry: () => { if (enabled && accountLifetime.isCurrent()) directory.retry('account'); } },
        sessions: { state: source.statesByServerId[scope.serverId] ?? null, complete: enabled && source.coverageComplete,
            loadMore: async () => { if (enabled && accountLifetime.isCurrent()) await source.loadNext(); },
            retry: async () => { if (enabled && accountLifetime.isCurrent()) await source.refresh(); } },
    }), [accountLifetime, candidates, directory, enabled, peopleSource, resolvePeople, scope.serverId, source]);
}

export type DiscussionInviteCandidateSource = ReturnType<typeof useDiscussionInviteCandidates>;
