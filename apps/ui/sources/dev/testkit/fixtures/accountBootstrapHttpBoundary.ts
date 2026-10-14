import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountPetListResponseV1Schema } from '@happier-dev/protocol/pets/accountLibrary';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';

/** Explicit empty-Account fixtures only; callers resolve the Home and apply their overrides first. */
export function createEmptyAccountBootstrapHttpResponse(path: string, init?: RequestInit): Response | null {
    const pathname = path.split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
        if (pathname === '/v2/sessions' || pathname === '/v2/sessions/active') {
            return Response.json(V2SessionListResponseSchema.parse({
                sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            }));
        }
        if (pathname === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
        if (pathname === '/v2/session-organization') {
            return Response.json(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
                schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0,
                pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } }));
        }
        if (pathname === '/v1/account/pets') {
            return Response.json(AccountPetListResponseV1Schema.parse({ ok: true, pets: [] }));
        }
    }
    if (method === 'POST') {
        if (pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
            return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({
                availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [],
            }));
        }
        if (pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
            return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 0, snapshots: [] }));
        }
    }
    return null;
}
