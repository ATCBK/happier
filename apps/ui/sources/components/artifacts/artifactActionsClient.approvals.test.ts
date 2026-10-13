import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ApprovalRequestV2Schema,
    ArtifactActionOutputSchemasV1,
} from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createArtifactActionsClient } = await import('./artifactActionsClient');

describe('Artifact surface pending approvals', () => {
    beforeEach(async () => { await homes.reset(); });
    afterEach(() => standardCleanup());

    it.each(['create', 'update', 'restore', 'delete'] as const)('recognizes a durable %s approval before parsing the final acknowledgement', async (operation) => {
        const serverId = await homes.addHome({ name: 'Artifacts', serverUrl: 'https://artifact-surface-approval.test',
            accountId: 'owner-1', currentAccount: true });
        const actionId = operation === 'restore' ? 'artifact.revisions.restore' : `artifact.${operation}`;
        await homes.requireUiApproval(serverId, actionId);
        // The default UI composition owns admission, approval creation, codecs and persistence.
        const client = createArtifactActionsClient({ serverId, accountId: 'owner-1' });
        const input = { artifactId: 'document-1', expectedRevision: { headerVersion: 2, bodyVersion: 3 } };
        const draft = { header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Draft body' };
        const outcome = operation === 'create' ? await client.createArtifact(draft)
            : operation === 'update' ? await client.updateArtifact({ ...input, ...draft })
            : operation === 'restore'
            ? await client.restoreRevision({ ...input, bodyVersion: 1 })
            : await client.deleteArtifact(input);
        const rows = homes.artifacts(serverId).list();
        expect(rows).toHaveLength(1);
        const approvalId = rows[0]!.id;
        const persisted = ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(approvalId)!));
        expect(persisted).toMatchObject({ status: 'open', actionId,
            executionOriginV1: { serverId, accountId: 'owner-1', actionId, authority: 'present_user' },
            actionArgs: operation === 'create' ? draft : operation === 'update' ? { ...input, ...draft }
                : operation === 'restore' ? { ...input, bodyVersion: 1 } : input });
        expect(outcome).toEqual({ approvalId });
        expect(homes.artifacts(serverId).read('document-1')).toBeNull();
    });

    it('carries real create/update acknowledgements through the surface schema and refuses a stale edit without overwriting content', async () => {
        const serverId = await homes.addHome({ name: 'Artifacts', serverUrl: 'https://artifact-surface-cas.test',
            accountId: 'owner-1', currentAccount: true });
        const client = createArtifactActionsClient({ serverId, accountId: 'owner-1' });
        const draft = { header: { kind: 'artifact.legacy', title: 'Draft' }, body: 'Original 🔐' };
        const created = await client.createArtifact(draft);
        if (!('ok' in created) || !created.ok) throw new Error(`Create failed: ${JSON.stringify(created)}`);
        const { artifactId, revision } = ArtifactActionOutputSchemasV1['artifact.create'].parse(created.value);
        expect(homes.artifacts(serverId).readPlainBody(artifactId)).toBe(draft.body);
        const update = { artifactId, expectedRevision: revision, header: draft.header, body: 'Latest content' };
        const updated = await client.updateArtifact(update);
        expect(updated).toEqual({ ok: true, value: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
        expect(homes.artifacts(serverId).readPlainBody(artifactId)).toBe(update.body);
        const stale = await client.updateArtifact({ ...update, body: 'Stale overwrite' });
        expect(stale).toMatchObject({ ok: false, failure: { code: 'version_mismatch' } });
        expect(homes.artifacts(serverId).readPlainBody(artifactId)).toBe(update.body);
    });

});
