import { afterEach, describe, expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { backfillArtifactKinds } from './backfillArtifactKinds';

afterEach(() => resetServerFeaturesClientForTests());
describe('Artifact kind metadata backfill', () => {
    it.each([true, false])('repairs only writable unclassified readable headers, preserving bytes and failures (support=%s)', async supported => {
        primeServerFeaturesSnapshot({ serverId: 'kind-backfill-home', snapshot: { status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { artifacts: { kindFiltering: { enabled: supported } } }, capabilities: {} }) } });
        const wire = (id: string, changes?: Partial<Artifact>): Artifact => ({ id, ownerAccountId: 'account', access: 'owner',
            encryptionMode: 'plain', header: 'unchanged-header', body: 'unchanged-body', headerVersion: 7, bodyVersion: 9,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, createdAt: 1, updatedAt: 2, seq: 0, ...changes });
        const opened = (id: string, header: Record<string, unknown>): DecryptedArtifact => ({ id, isDecrypted: true, rawHeader: header,
            title: null, headerVersion: 7, bodyVersion: 9, createdAt: 1, updatedAt: 2, seq: 0 });
        const artifacts = [wire('skill'), wire('known', { kind: 'prompt' }), wire('locked'), wire('view', { access: 'view' }), wire('other')];
        const reads = [opened('skill', { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }),
            opened('known', { kind: 'prompt_doc.v2' }), null, opened('view', { kind: 'prompt_doc.v2' }), opened('other', { kind: 'future_kind' })];
        const headers = artifacts.flatMap((artifact, index) => reads[index]
            ? [{ ...reads[index]!, access: artifact.access, kind: artifact.kind }] : []);
        const writes: Array<{ path: string; input: unknown }> = [];
        await expect(backfillArtifactKinds({ credentials: { token: 't' }, artifacts: headers, serverId: 'kind-backfill-home',
            shouldContinue: () => true, request: async (path, init) => {
                writes.push({ path, input: JSON.parse(String(init?.body)) });
                return path.endsWith('/skill') ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json({ success: true });
            } })).resolves.toBeUndefined();
        expect(writes).toEqual(supported ? [
            { path: '/v1/artifacts/skill', input: { kind: 'skill', expectedHeaderVersion: 7 } },
            { path: '/v1/artifacts/other', input: { kind: 'other', expectedHeaderVersion: 7 } },
        ] : []);
        expect(artifacts[0]).toMatchObject({ header: 'unchanged-header', body: 'unchanged-body', headerVersion: 7, bodyVersion: 9 });
        if (supported) {
            headers[0] = { ...headers[0]!, kind: 'skill' };
            headers[3] = { ...headers[3]!, kind: 'other' };
            let repeatedWrites = 0;
            await backfillArtifactKinds({ credentials: { token: 't' }, artifacts: headers, serverId: 'kind-backfill-home',
                shouldContinue: () => true, request: async () => { repeatedWrites += 1; return Response.json({ success: true }); } });
            expect(repeatedWrites).toBe(0);
        }
    });
    it('stops the sequential pass when its captured inventory is retired during a request', async () => {
        primeServerFeaturesSnapshot({ serverId: 'kind-backfill-home', snapshot: { status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { artifacts: { kindFiltering: { enabled: true } } }, capabilities: {} }) } });
        const controller = new AbortController();
        const artifacts: DecryptedArtifact[] = ['first', 'second'].map(id => ({ id, access: 'owner', isDecrypted: true,
            rawHeader: { kind: 'prompt_doc.v2' }, title: null, headerVersion: 1, createdAt: 1, updatedAt: 1, seq: 1 }));
        const paths: string[] = [];
        await backfillArtifactKinds({ credentials: { token: 't' }, artifacts, serverId: 'kind-backfill-home',
            signal: controller.signal, shouldContinue: () => !controller.signal.aborted, request: async path => {
                paths.push(path); controller.abort(); return Response.json({ success: true });
            } });
        expect(paths).toEqual(['/v1/artifacts/first']);
    });
});
