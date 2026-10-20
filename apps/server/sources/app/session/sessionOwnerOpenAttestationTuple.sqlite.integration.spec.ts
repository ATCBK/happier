import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionPatchRoute } from '@/app/api/routes/session/registerSessionPatchRoute';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../cli/src/api/clientCompatibility/cliClientCompatibility';
import { buildSessionMetadataEnvelopeFields } from '../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { updateSessionMetadataWithRetry } from '../../../../cli/src/session/metadata/updateSessionMetadataWithRetry';

describe('owner open-attestation metadata tuple (SQLite)', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-owner-open-attestation-',
            initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' },
        });
    }, 180_000);

    afterAll(async () => {
        await harness?.close();
    });

    it('keeps an unrelated owner PATCH predecessor-compatible and still refuses an Account-mode mismatch', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const credentials = { token: 'fixture', encryption: null };
        const fields = buildSessionMetadataEnvelopeFields({
            credentials,
            accountEncryptionMode: 'plain',
            storedContentMode: 'plain',
            metadata: { path: '/repo', host: 'runner' },
            agentState: {},
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: randomUUID(),
                encryptionMode: 'plain',
                active: true,
                metadataLayoutVersion: 1,
                metadata: fields.sharedMetadata.ciphertext,
                ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(fields.ownerMetadata),
                agentState: fields.agentState,
            },
        });
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async request => {
            request.headers['x-test-user-id'] = owner.id;
        });
        let observedPatch: unknown;
        app.addHook('preValidation', async request => {
            observedPatch = request.body;
        });
        registerSessionPatchRoute(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            await runWithServerHttpBaseUrl(origin, async () => {
                const raw = await db.session.findUniqueOrThrow({ where: { id: session.id } });
                await expect(updateSessionMetadataWithRetry({
                    token: credentials.token,
                    credentials,
                    accountEncryptionCurrentness: {
                        mode: 'plain',
                        version: 1,
                        signingKeyFingerprint: null,
                        contentKeyFingerprint: null,
                        updatedAt: 1,
                        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
                    },
                    sessionId: session.id,
                    rawSession: { ...raw, ownerMetadata: fields.ownerMetadata },
                    updater: metadata => ({ ...metadata, codexSessionId: 'native-session-1' }),
                    maxAttempts: 1,
                })).resolves.toMatchObject({ version: 1 });
            });
            expect(observedPatch).toMatchObject({ mode: 'owner', metadataLayoutVersion: 1 });
            expect(observedPatch).not.toHaveProperty('sharedActionConfirmationSummaryV1');

            await db.session.update({
                where: { id: session.id },
                data: { ownerMetadata: JSON.stringify({ t: 'encrypted', c: 'account-mode-mismatch' }) },
            });
            const incompatible = await app.inject({
                method: 'PATCH',
                url: `/v2/sessions/${session.id}`,
                headers: {
                    'x-test-user-id': owner.id,
                    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                },
                payload: observedPatch,
            });
            expect(incompatible.statusCode).toBe(409);
            expect(incompatible.json()).toEqual({
                error: 'Session metadata privacy upgrade required',
                code: 'metadata_privacy_upgrade_required',
            });
        } finally {
            await app.close();
        }
    });
});
