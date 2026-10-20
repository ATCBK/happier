import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ApprovalRequestV2Schema,
    ArtifactActionOutputSchemasV1,
    normalizeActionsSettingsV1,
} from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ confirmResult: true }).module);

const { createArtifactActionsClient } = await import('./artifactActionsClient');
let served: Awaited<ReturnType<typeof serveActionHomes>> | undefined;

async function serveArtifactAccount(serverUrl: string, actionId?: string) {
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner-1', encryptionMode: 'plain' });
    served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl, accountId: 'owner-1', currentAccount: true,
        ...(actionId ? { settings: { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) } } : {}),
    }], route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
        ? Response.json(createRootLayoutFeaturesResponse())
        : artifacts.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined });
    await served.restoreActiveConnection();
    if (actionId) await vi.waitFor(() => expect(
        storage.getState().settings.actionsSettingsV1.actions[actionId]?.approvalRequiredSurfaces,
    ).toContain('ui'));
    return { serverId: served.homes.owner!.id, artifacts };
}

describe('Artifact surface pending approvals', () => {
    afterEach(async () => {
        standardCleanup();
        await served?.dispose();
        served = undefined;
    });

    it.each(['create', 'update', 'restore', 'delete'] as const)('recognizes a durable %s approval before parsing the final acknowledgement', async (operation) => {
        const actionId = operation === 'restore' ? 'artifact.revisions.restore' : `artifact.${operation}`;
        const { serverId, artifacts } = await serveArtifactAccount(`https://artifact-surface-${operation}-approval.test`, actionId);
        // The default UI composition owns admission, approval creation, codecs and persistence.
        const client = createArtifactActionsClient({ serverId, accountId: 'owner-1' });
        const input = { artifactId: 'document-1', expectedRevision: { headerVersion: 2, bodyVersion: 3 } };
        const draft = { header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Draft body' };
        const outcome = operation === 'create' ? await client.createArtifact(draft)
            : operation === 'update' ? await client.updateArtifact({ ...input, ...draft })
            : operation === 'restore'
            ? await client.restoreRevision({ ...input, bodyVersion: 1 })
            : await client.deleteArtifact(input);
        const rows = artifacts.list();
        expect(rows).toHaveLength(1);
        const approvalId = rows[0]!.id;
        const persisted = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(approvalId)!));
        expect(persisted).toMatchObject({ status: 'open', actionId,
            executionOriginV1: { serverId, accountId: 'owner-1', actionId, authority: 'present_user' },
            actionArgs: operation === 'create' ? draft : operation === 'update' ? { ...input, ...draft }
                : operation === 'restore' ? { ...input, bodyVersion: 1 } : input });
        expect(outcome).toEqual({ approvalId });
        expect(artifacts.read('document-1')).toBeNull();
    });

    it('carries real create/update acknowledgements through the surface schema and refuses a stale edit without overwriting content', async () => {
        const { serverId, artifacts } = await serveArtifactAccount('https://artifact-surface-cas.test');
        const client = createArtifactActionsClient({ serverId, accountId: 'owner-1' });
        const draft = { header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Original 🔐' };
        const created = await client.createArtifact(draft);
        if (!('ok' in created) || !created.ok) throw new Error(`Create failed: ${JSON.stringify(created)}`);
        const { artifactId, revision } = ArtifactActionOutputSchemasV1['artifact.create'].parse(created.value);
        expect(artifacts.readPlainBody(artifactId)).toBe(draft.body);
        const update = { artifactId, expectedRevision: revision, header: draft.header, body: 'Latest content' };
        const updated = await client.updateArtifact(update);
        expect(updated).toEqual({ ok: true, value: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
        expect(artifacts.readPlainBody(artifactId)).toBe(update.body);
        const stale = await client.updateArtifact({ ...update, body: 'Stale overwrite' });
        expect(stale).toMatchObject({ ok: false, failure: { code: 'version_mismatch' } });
        expect(artifacts.readPlainBody(artifactId)).toBe(update.body);
    });

});
