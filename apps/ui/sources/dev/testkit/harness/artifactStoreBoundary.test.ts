import { describe, expect, it, vi } from 'vitest';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeFormatV1';

import { createArtifactStoreBoundary } from './artifactStoreBoundary';

describe('Artifact store HTTP boundary', () => {
    it('projects seeded Account grants and admits only writable grants through the same CAS owner', async () => {
        let accountId = 'owner';
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
        const input = { id: 'shared', header: 'header', body: 'body', dataEncryptionKey: '' };
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) });
        for (const access of ['edit', 'view', 'admin'] as const) {
            boundary.seedAccountGrant('shared', 'grantee', access);
            accountId = 'grantee';
            const before = boundary.read('shared')!;
            const detail = await boundary.handle('/v1/artifacts/shared');
            expect(detail?.status).toBe(200);
            expect(await detail!.json()).toMatchObject({ ownerAccountId: 'owner', access, body: before.body });
            expect(await (await boundary.handle('/v1/artifacts?includeBody=true'))!.json()).toMatchObject([
                { id: 'shared', ownerAccountId: 'owner', access, body: before.body },
            ]);
            expect(await (await boundary.handle('/v1/artifacts/shared/access/grants'))!.json()).toMatchObject({
                ownerAccountId: 'owner', access, grants: [{ principal: { kind: 'account', accountId: 'grantee' }, accessLevel: access }],
            });
            const write = (revision = before.headerVersion) => boundary.handle('/v1/artifacts/shared', {
                method: 'POST', body: JSON.stringify({ header: access, expectedHeaderVersion: revision }),
            });
            const response = await write();
            expect(response?.status).toBe(access === 'view' ? 404 : 200);
            expect(await response!.json()).toEqual(access === 'view' ? { error: 'Artifact not found' }
                : { success: true, headerVersion: before.headerVersion + 1 });
            if (access === 'view') expect(boundary.read('shared')).toEqual(before);
            else {
                const committed = boundary.read('shared');
                expect(await (await write())!.json()).toMatchObject({ success: false, error: 'version-mismatch' });
                expect(boundary.read('shared')).toEqual(committed);
            }
            expect((await boundary.handle('/v1/artifacts/shared/revision/1/1', { method: 'DELETE' }))?.status).toBe(404);
            expect((await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) }))?.status).toBe(409);
        }
        for (const retire of ['delete', 'clear'] as const) {
            accountId = 'owner';
            if (retire === 'delete') await boundary.handle('/v1/artifacts/shared', { method: 'DELETE' });
            else boundary.clear();
            await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) });
            accountId = 'grantee';
            expect((await boundary.handle('/v1/artifacts/shared'))?.status).toBe(404);
            boundary.seedAccountGrant('shared', 'grantee', 'edit');
        }
        // A semantic E2EE grant is not a recipient key envelope. Never substitute the owner's key.
        accountId = 'owner';
        const encrypted = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'e2ee' });
        await encrypted.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ ...input,
            dataEncryptionKey: Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 1).toString('base64'),
        }) });
        encrypted.seedAccountGrant('shared', 'grantee', 'edit');
        accountId = 'grantee';
        const unavailable = await encrypted.handle('/v1/artifacts/shared');
        expect(unavailable?.status).toBe(409);
        expect(await unavailable!.json()).toEqual({ error: 'artifact_content_unavailable' });
        expect(await (await encrypted.handle('/v1/artifacts?includeBody=true'))!.json()).toEqual([]);
        const census = await encrypted.handle('/v1/artifacts/shared/access/recipients');
        expect(census?.status).toBe(409);
        expect(await census!.json()).toEqual({ error: 'artifact_content_unavailable' });
        expect((await encrypted.handle('/v1/artifacts/shared', { method: 'POST', body: JSON.stringify({
            header: 'changed', expectedHeaderVersion: 1,
        }) }))?.status).toBe(404);
        expect(encrypted.read('shared')?.header).toBe('header');
    });

    it.each(['account-b', null])('refuses addressed operations for caller %s before bytes or mutation', async (caller) => {
        let accountId: string | null = 'account-a';
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
        const createInput = { id: 'artifact-a', header: 'private-header', body: 'private-body', dataEncryptionKey: '' };
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(createInput) });
        const committed = boundary.read('artifact-a');
        if (!committed) throw new Error('Missing created Artifact');
        boundary.replaceStoredRow({ ...committed, headerVersion: 5, bodyVersion: 9 });
        const before = boundary.read('artifact-a');
        accountId = caller;
        const attempts: ReadonlyArray<Readonly<{ path: string; init?: RequestInit; foreignStatus: number; foreignError: string }>> = [
            { path: '/v1/artifacts/artifact-a', foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a/access/grants', foreignStatus: 404, foreignError: 'artifact_not_found' },
            { path: '/v1/artifacts/artifact-a/access/recipients', foreignStatus: 404, foreignError: 'artifact_not_found' },
            { path: '/v1/artifacts/artifact-a', init: { method: 'POST', body: JSON.stringify({
                header: 'changed-header', body: 'changed-body', expectedHeaderVersion: 1, expectedBodyVersion: 1,
            }) }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a', init: { method: 'POST', body: JSON.stringify({
                header: 'changed-header', body: 'changed-body', expectedHeaderVersion: 5, expectedBodyVersion: 9,
            }) }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a/revision/5/9', init: { method: 'DELETE' }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a/revision/1/1', init: { method: 'DELETE' }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a', init: { method: 'DELETE' }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts', init: { method: 'POST', body: JSON.stringify(createInput) },
                foreignStatus: 409, foreignError: 'Artifact with this ID already exists for another account' },
        ];
        for (const attempt of attempts) {
            const response = await boundary.handle(attempt.path, attempt.init);
            expect(response?.status, attempt.path).toBe(caller === null ? 401 : attempt.foreignStatus);
            expect(await response!.json(), attempt.path).toEqual({ error: caller === null ? 'Missing authorization header' : attempt.foreignError });
            expect(boundary.read('artifact-a'), attempt.path).toEqual(before);
        }
        accountId = 'account-a';
        expect(await (await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(createInput) }))!.json()).toEqual(before);
        expect(await (await boundary.handle('/v1/artifacts/artifact-a'))!.json()).toEqual(before);
        expect((await boundary.handle('/v1/artifacts/artifact-a/revision/1/1', { method: 'DELETE' }))?.status).toBe(409);
        expect(boundary.read('artifact-a')).toEqual(before);
        expect(await (await boundary.handle('/v1/artifacts/artifact-a/revision/5/9', { method: 'DELETE' }))!.json()).toEqual({ success: true });
        expect(boundary.read('artifact-a')).toBeNull();
    });

    it('uses a committed server row for CAS and keeps read snapshots detached', async () => {
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'artifact-a', header: 'first-header', body: 'first-body', dataEncryptionKey: '',
        }) });
        const committed = boundary.read('artifact-a');
        if (!committed) throw new Error('Missing created Artifact');
        Object.assign(committed, { header: 'agent-header', body: 'agent-body', headerVersion: 5, bodyVersion: 9 });
        boundary.replaceStoredRow(committed);
        committed.headerVersion = 100;
        const attempt = (headerVersion: number, bodyVersion: number) => boundary.handle('/v1/artifacts/artifact-a', {
            method: 'POST', body: JSON.stringify({ header: 'human-header', body: 'human-body',
                expectedHeaderVersion: headerVersion, expectedBodyVersion: bodyVersion }),
        });
        expect(await (await attempt(1, 1))!.json()).toMatchObject({ success: false, error: 'version-mismatch',
            currentHeaderVersion: 5, currentBodyVersion: 9 });
        expect(await (await attempt(5, 9))!.json()).toEqual({ success: true, headerVersion: 6, bodyVersion: 10 });
        expect(boundary.read('artifact-a')).toMatchObject({ header: 'human-header', body: 'human-body',
            headerVersion: 6, bodyVersion: 10 });
    });

    it('returns only the stored owner census and fences it to that Account', async () => {
        let accountId: string | null = 'account-a';
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'e2ee' });
        // The HTTP boundary stores opaque envelope bytes; opening them belongs to the real codec.
        const dataEncryptionKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 1).toString('base64');
        const provenanceDataEncryptionKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 2).toString('base64');
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'artifact-a', header: 'header', body: 'body', dataEncryptionKey,
            provenance: 'private-metadata', provenanceDataEncryptionKey,
        }) });
        const response = await boundary.handle('/v1/artifacts/artifact-a/access/recipients');
        expect(response?.status).toBe(200);
        expect(await response!.json()).toMatchObject({
            artifactId: 'artifact-a', ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey, callerDataEncryptionKey: dataEncryptionKey,
            provenanceDataEncryptionKey, callerProvenanceDataEncryptionKey: provenanceDataEncryptionKey,
            recipients: [{ recipientAccountId: 'account-a', contentKey: { status: 'unavailable', reason: 'encryption_setup_required' } }],
        });
        expect(await (await boundary.handle('/v1/artifacts/artifact-a?accessProjectionVersion=1'))!.json())
            .toMatchObject({ id: 'artifact-a', ownerAccountId: 'account-a', access: 'owner' });
        expect((await boundary.handle('/v1/artifacts/missing/access/recipients'))?.status).toBe(404);
        accountId = 'account-b';
        expect((await boundary.handle('/v1/artifacts/artifact-a/access/recipients'))?.status).toBe(404);
        accountId = null;
        expect((await boundary.handle('/v1/artifacts/artifact-a/access/recipients'))?.status).toBe(401);
    });

    it('pages headers in the server cursor order without repeating tied timestamps or returning bodies', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1234);
        try {
            const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
            for (const id of ['a', 'b', 'c']) await boundary.handle('/v1/artifacts', { method: 'POST',
                body: JSON.stringify({ id, header: 'header', body: 'body', dataEncryptionKey: '' }) });
            const first = await (await boundary.handle('/v1/artifacts?limit=2'))!.json();
            expect(first.map((row: { id: string }) => row.id)).toEqual(['c', 'b']);
            expect(first[0]).not.toHaveProperty('body');
            const cursor = Buffer.from(JSON.stringify({ updatedAt: 1234, id: 'b' })).toString('base64url');
            const last = await (await boundary.handle(`/v1/artifacts?limit=2&cursor=${cursor}&includeBody=true`))!.json();
            expect(last).toMatchObject([{ id: 'a', body: 'body', bodyVersion: 1 }]);
            expect(last).toHaveLength(1);
        } finally { clock.mockRestore(); }
    });
});
