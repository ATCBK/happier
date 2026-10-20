import { RPC_METHODS } from '../rpc/methods.js';
import { getUsageQueryKey, type UsageQuery } from '../inputs/usageQuery.js';
import { ScmBranchListResponseSchema, type ScmBranchListRequest, type ScmBranchWorkEvidence, ScmPullRequestListResponseSchema, type ScmPullRequestListRequest } from '../scm/index.js';
import type { UsageWorkEvidence } from './usageOutcomeAllocation.js';
import type { UsageAccountingSourceSnapshot, UsageWorkSourceSnapshot } from './resolveUsagePageAggregation.js';

export type SessionWorkSourceResult = Readonly<
    | { status: 'unsupported' | 'error' | 'unknown' }
    | { status: 'partial' | 'unsupported' | 'error'; evidence: readonly UsageWorkEvidence[]; branchEvidence?: readonly ScmBranchWorkEvidence[] }
>;

export async function collectUsageWorkSources(input: Readonly<{
    queries: readonly UsageQuery[];
    accounting: readonly UsageAccountingSourceSnapshot[];
    sessionReads?: Map<string, Promise<SessionWorkSourceResult>>;
    readSession: (sessionId: string) => Promise<((method: string, request: ScmBranchListRequest | ScmPullRequestListRequest) => Promise<unknown>) | null>;
    assertCurrent: () => void | Promise<void>;
}>): Promise<readonly UsageWorkSourceSnapshot[]> {
    const { queries, accounting } = input;
    const sessionReads = input.sessionReads ?? new Map<string, Promise<SessionWorkSourceResult>>();
    const byQuery = new Map(accounting.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
    const sessionIds = new Set(queries.flatMap(query => (byQuery.get(getUsageQueryKey(query))?.contributions ?? [])
        .flatMap(row => row.sessionId && row.turnId ? [row.sessionId] : [])));
    // Generic transport refusals quarantine every private sibling read. Only
    // explicit native failures may retain other independently witnessed graphs.
    const nativeReadFailureCodes = ['COMMAND_FAILED', 'COMMAND_TIMEOUT', 'COMMAND_OUTPUT_LIMIT_EXCEEDED',
        'REMOTE_NETWORK_FAILED', 'REPOSITORY_REFRESH_FAILED'];
    const loadSession = async (sessionId: string): Promise<SessionWorkSourceResult> => {
        const read = await input.readSession(sessionId);
        if (!read) return { status: 'unknown' };
        const states = await Promise.all((['branch', 'open', 'closed', 'merged'] as const).map(async (state): Promise<Readonly<{
            status: 'partial' | 'unsupported' | 'error'; evidence?: readonly UsageWorkEvidence[]; branchEvidence?: readonly ScmBranchWorkEvidence[]; quarantine?: boolean;
        }>> => {
          try {
            await input.assertCurrent();
            if (state === 'branch') {
                const response = ScmBranchListResponseSchema.safeParse(await read(RPC_METHODS.SCM_BRANCH_LIST, { workEvidence: { sessionId } }));
                await input.assertCurrent();
                if (!response.success) return { status: 'error', quarantine: true };
                if (!response.data.success) {
                    if (response.data.errorCode === 'FEATURE_UNSUPPORTED') return { status: 'unsupported' };
                    const nativeFailure = nativeReadFailureCodes.includes(response.data.errorCode ?? '');
                    return { status: 'error', quarantine: !nativeFailure };
                }
                if (!response.data.branchEvidence || response.data.branchEvidenceStatus !== 'partial') return { status: 'unsupported' };
                if (response.data.branchEvidence.some(witness => witness.sessionId !== sessionId)) return { status: 'error', quarantine: true };
                return { status: 'partial', branchEvidence: response.data.branchEvidence };
            }
            const response = ScmPullRequestListResponseSchema.safeParse(await read(RPC_METHODS.SCM_PULL_REQUEST_LIST, { state, workEvidence: { sessionId } }));
            await input.assertCurrent();
            if (!response.success) return { status: 'error', quarantine: true };
            if (!response.data.success) {
                if (response.data.errorCode === 'FEATURE_UNSUPPORTED') return { status: 'unsupported' };
                // The incumbent transport maps generic refusals to BACKEND_UNAVAILABLE.
                // Only explicit native-read failures can retain a sibling state's facts.
                const nativeFailure = nativeReadFailureCodes.includes(response.data.errorCode ?? '');
                return { status: 'error', quarantine: !nativeFailure };
            }
            if (!response.data.workEvidence || !response.data.workEvidenceStatus || response.data.workEvidenceStatus === 'unavailable') {
                return { status: 'unsupported' };
            }
            if (response.data.workEvidence.some(witness => witness.sessionId !== sessionId)) {
                return { status: 'error', quarantine: true };
            }
            // List is current-branch discovery, never proof of complete repository history.
            return { status: 'partial', evidence: response.data.workEvidence };
          } catch {
            await input.assertCurrent();
            return { status: 'error', quarantine: true };
          }
        }));
        // An explicit empty quarantine is an admission withdrawal. A failed
        // replacement supplies no evidence at all, allowing the page's single
        // retention owner to distinguish it from a refusal or real empty read.
        if (states.some(source => source.quarantine)) return { status: 'error', evidence: [], branchEvidence: [] };
        if (states.every(source => source.status === 'error')) return { status: 'error' };
        return { status: states.some(source => source.status === 'partial') ? 'partial' as const
            : states.some(source => source.status === 'error') ? 'error' as const : 'unsupported' as const,
            evidence: states.flatMap(source => source.evidence ?? []), branchEvidence: states.flatMap(source => source.branchEvidence ?? []) };
    };
    const sessions = new Map(await Promise.all([...sessionIds].map(async sessionId => {
        let read = sessionReads.get(sessionId);
        if (!read) { read = loadSession(sessionId); sessionReads.set(sessionId, read); }
        return [sessionId, await read] as const;
    })));
    return queries.map((query): UsageWorkSourceSnapshot => {
        const contributions = byQuery.get(getUsageQueryKey(query))?.contributions;
        if (!contributions) return { query, status: 'unknown' };
        const turns = new Set(contributions.filter(row => row.sessionId && row.turnId).map(row => JSON.stringify([row.sessionId, row.turnId])));
        const selected = [...new Set(contributions.flatMap(row => row.sessionId && row.turnId ? [row.sessionId] : []))]
            .map(sessionId => sessions.get(sessionId)!);
        const evidence = selected.flatMap(source => 'evidence' in source ? source.evidence : [])
            .filter(witness => turns.has(JSON.stringify([witness.sessionId, witness.turnId])));
        const branchEvidence = selected.flatMap(source => 'branchEvidence' in source ? source.branchEvidence ?? [] : [])
            .filter(witness => turns.has(JSON.stringify([witness.sessionId, witness.turnId])));
        const failedReplacement = selected.length > 0 && selected.every(source => source.status === 'error' && !('evidence' in source));
        return { query, ...(failedReplacement ? {} : { evidence, branchEvidence }), status: selected.some(source => source.status === 'partial') ? 'partial'
            : selected.some(source => source.status === 'error') ? 'error' : selected.some(source => source.status === 'unsupported') ? 'unsupported' : 'unknown',
            ...(selected.some(source => source.status === 'error') ? { errorCode: 'work_evidence_failed' } : {}) };
    });
}
