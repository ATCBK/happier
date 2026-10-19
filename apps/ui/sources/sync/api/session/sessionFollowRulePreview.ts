import { evaluateFollowRulePreviewV1, type FollowRulePreviewCandidateV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import { equalFollowRuleReceiverV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { FollowReceiverRefV1Schema } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import type { FollowPreviewActionInputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { listSessionListLookupServerSessions } from '@/sync/domains/session/listing/sessionListLookupState';
import { isSessionListRenderableNewerThanSession } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { buildSessionListRowFilterFacts, buildWorkflowRunFilterFacts } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import type { SessionFollowRulesSnapshot } from './sessionFollowRulesApi';

/** Current loaded facts only. Neither a loaded page nor an empty page proves a full inventory. */
export function previewLoadedSessionFollowRule(input: Readonly<{
    serverId: string;
    accountId: string;
    request: FollowPreviewActionInputV1;
    rules: SessionFollowRulesSnapshot;
    assertCurrent(): void;
}>) {
    const receiver = FollowReceiverRefV1Schema.parse(input.request.receiver);
    const rules = input.rules;
    input.assertCurrent();
    const state = getStorage().getState();
    const scope = state.profileScope;
    const readable = rules.status === 'ready' && rules.accountId === input.accountId && state.isDataReady
        && scope?.accountId === input.accountId && areServerProfileIdentifiersEquivalent(scope.serverId, input.serverId);
    const candidates: FollowRulePreviewCandidateV1[] = [];
    if (readable) {
        const nowMs = Date.now();
        const workspaceRefs = readProjectAccountWorkspaceRefs(state);
        const seen = new Set<string>();
        const add = (row: Parameters<typeof buildSessionListRowFilterFacts>[0]) => {
            if (!row || row.archivedAt != null || !isUserFacingSession(row) || seen.has(row.id)) return;
            seen.add(row.id);
            const readableRow = isSessionContentReadable(readSessionContentAvailability(row))
                ? row : { ...row, metadata: null, ownerMetadataView: null, metadataUnavailable: true };
            candidates.push({ source: { kind: 'session', sessionId: row.id }, facts: buildSessionListRowFilterFacts(
                readableRow, input.serverId, { nowMs, viewerAccountId: input.accountId, workspaceRefs,
                    includeStatus: Boolean(input.request.filter.statuses?.length), includeSource: input.request.filter.source !== 'all',
                    tagIds: state.sessionOrganizationTagAssignmentsBySessionKey[buildSessionOrganizationSessionKey(input.serverId, row.id)]?.tagIds,
                }),
            });
        };
        for (const entry of listSessionListLookupServerSessions(state)) {
            if (!areServerProfileIdentifiersEquivalent(entry.serverId, input.serverId)) continue;
            const hydrated = state.sessions[entry.session.id];
            add(hydrated && hydrated.serverId && areServerProfileIdentifiersEquivalent(hydrated.serverId, input.serverId)
                && !isSessionListRenderableNewerThanSession(entry.session, hydrated) ? hydrated : entry.session);
        }
        for (const session of Object.values(state.sessions)) {
            if (session.serverId && areServerProfileIdentifiersEquivalent(session.serverId, input.serverId)) add(session);
        }
        for (const [key, row] of Object.entries(state.workflowRunsById)) {
            if (key !== workflowRunStoreKey(row.id, scope) || !row.summary) continue;
            candidates.push({ source: { kind: 'workflow_run', runId: row.id }, facts: buildWorkflowRunFilterFacts(row.summary, input.serverId, input.accountId) });
        }
    }
    return evaluateFollowRulePreviewV1({ filter: input.request.filter, candidates,
        coverage: readable ? 'partial' : 'unavailable', otherRules: rules.status !== 'ready' ? [] : rules.rules
            .filter(rule => rule.receiver.kind === 'session' && !equalFollowRuleReceiverV1(rule.receiver, receiver))
            .map(rule => ({ ruleId: rule.ruleId, enabled: rule.definition.enabled, filter: rule.definition.filter })),
    });
}
