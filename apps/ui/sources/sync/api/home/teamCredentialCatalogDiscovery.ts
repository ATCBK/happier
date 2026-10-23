import {
    TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1,
    TeamCredentialResourceDiscoveryPageV1Schema,
    teamCredentialErrorHttpStatusV1,
    type TeamCredentialErrorCodeV1,
    type TeamCredentialResourceCatalogEntryV1,
    type TeamCredentialResourceEntitledPageV1,
    type TeamCredentialResourceReadInputV1,
} from '@happier-dev/protocol/teams';

import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { homeDomainFailureKindForHttpStatus, requestHomeDomain,
    type HomeDomainFailure, type HomeDomainResult } from './homeServerActionTransport';

type CatalogRead = Readonly<{
    scope: ServerAccountScope;
    input: TeamCredentialResourceReadInputV1;
    shouldContinue: () => boolean;
    signal?: AbortSignal;
}>;
type CatalogResult = HomeDomainResult<TeamCredentialResourceEntitledPageV1>;
type PendingRead = Readonly<{
    request: CatalogRead;
    resolve: (result: CatalogResult) => void;
    reject: (error: unknown) => void;
}>;

// Only undispatched, already Action-admitted demand is retained. Snapshot
// loaders still own observation, single flight, currentness and refresh.
const pendingByScopeApplication = new Map<string, PendingRead[]>();

function teamFailure(code: TeamCredentialErrorCodeV1): HomeDomainFailure {
    const status = teamCredentialErrorHttpStatusV1(code);
    return { kind: homeDomainFailureKindForHttpStatus(status, code), retryable: status >= 500, code };
}

async function readGathered(pending: readonly PendingRead[]): Promise<void> {
    const first = pending[0]!.request;
    const teamIds = [...new Set(pending.map(read => read.request.input.teamId))];
    const resourcesByTeam = new Map<string, TeamCredentialResourceCatalogEntryV1[]>();
    const failures = new Map<string, HomeDomainFailure>();
    const settle = (failure?: HomeDomainFailure) => {
        for (const read of pending) {
            const teamId = read.request.input.teamId;
            const refusal = failures.get(teamId) ?? failure;
            read.resolve(refusal ? { ok: false, failure: refusal } : {
                ok: true, value: { resources: resourcesByTeam.get(teamId) ?? [], nextCursor: null },
            });
        }
    };
    let cursor: string | null = null;
    do {
        // Stop an abandoned walk between pages. A remaining caller still needs
        // the same set/cursor, including that page's per-Team refusals.
        if (!pending.some(read => read.request.shouldContinue() && !read.request.signal?.aborted)) break;
        const result = await requestHomeDomain({
            scope: first.scope, method: 'POST', path: TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1,
            input: { teamIds, limit: first.input.limit,
                ...(first.input.application ? { application: first.input.application } : {}), ...(cursor ? { cursor } : {}) },
            schema: TeamCredentialResourceDiscoveryPageV1Schema, effect: 'read',
        });
        if (!result.ok) {
            settle(result.failure);
            return;
        }
        for (const refusal of result.value.failures) failures.set(refusal.teamId, teamFailure(refusal.error));
        for (const resource of result.value.resources) {
            const rows = resourcesByTeam.get(resource.teamId) ?? [];
            rows.push(resource);
            resourcesByTeam.set(resource.teamId, rows);
        }
        cursor = result.value.nextCursor;
    } while (cursor !== null);
    settle();
}

/** Gather only admitted snapshot discovery; finite probes retain their own pages. */
export function requestTeamCredentialCatalogDiscovery(request: CatalogRead): Promise<CatalogResult> {
    const key = JSON.stringify([serverAccountScopeKeySuffix(request.scope), request.input.application ?? null, request.input.limit]);
    return new Promise((resolve, reject) => {
        const pending = pendingByScopeApplication.get(key);
        const read = { request, resolve, reject };
        if (pending) {
            pending.push(read);
            return;
        }
        const gathered = [read];
        pendingByScopeApplication.set(key, gathered);
        queueMicrotask(() => {
            pendingByScopeApplication.delete(key);
            void readGathered(gathered).catch(error => { for (const read of gathered) read.reject(error); });
        });
    });
}
