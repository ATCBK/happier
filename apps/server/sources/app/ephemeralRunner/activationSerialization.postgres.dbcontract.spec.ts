import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { signRunnerClaimV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { signRunnerActivationProgressUpdateV1 } from '@happier-dev/protocol/ephemeralRunner/progressProof';
import { db, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { acquireAccountSessionOwnerMetadataFenceInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { mutateSessionDraft } from '@/app/account/sessionDrafts/sessionDraftService';
import { claimEphemeralRunnerActivation } from './activationClaim';
import { closeDraftEphemeralRunnerActivationsInTx } from './activationLifecycle';
import { storeRunnerActivationPhase } from './activationProgress';
import { createEphemeralRunnerActivation, runnerActivationBinding } from './activationService';
import { createRunnerArtifactPublicationSnapshotStore } from './runnerArtifactAvailability';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

const homeServerIdentityId = 'srv_activation_serialization';

async function fixture() {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const activationKey = tweetnacl.sign.keyPair();
    const row = await db.ephemeralRunnerActivation.create({ data: {
        id: randomUUID(), creatorAccountId: account.id, creatorTokenEpoch: account.tokenEpoch,
        draftId: randomUUID(), sessionId: randomUUID(), machineId: randomUUID(), state: 'pending',
        workspacePolicy: 'choose_on_endpoint', homeServerIdentityId,
        activationSigningPublicKey: encodeBase64(activationKey.publicKey, 'base64url'),
        authoringCommitment: encodeBase64(tweetnacl.randomBytes(32), 'base64url'),
        artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
        endpointFactsRecipient: { mode: 'plain', creatorAccountId: account.id },
    } });
    function endpoint() {
        const installationKey = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        const claim = signRunnerClaimV1({ activationSecretKey: activationKey.secretKey, payload: {
            v: 1, purpose: 'happier.ephemeral-session-runner.claim', binding: runnerActivationBinding(row),
            runnerBoxPublicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'), protocolEpoch: 1,
            installation: { installationId, publicKey: encodeBase64(installationKey.publicKey, 'base64url'),
                proof: signMachineInstallationProof({ payload: {
                    version: 1, installationId, machineId: row.machineId, accountId: account.id,
                }, privateKey: installationKey.secretKey }) },
        } });
        return { claim, installationKey };
    }
    return { account, row, activationKey, endpoint };
}

/** Hold the real row boundary so all competing calls reach the same race window. */
async function whileActivationLocked<T>(
    seeded: Awaited<ReturnType<typeof fixture>>,
    calls: () => readonly Promise<T>[],
    beforeRelease?: (tx: Tx) => Promise<void>,
) {
    const acquired = deferred();
    const release = deferred();
    const holder = inTx(async tx => {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, seeded.account.id, 'content');
        await tx.$queryRawUnsafe('SELECT "id" FROM "EphemeralRunnerActivation" WHERE "id" = $1 FOR NO KEY UPDATE', seeded.row.id);
        acquired.resolve();
        await release.promise;
        await beforeRelease?.(tx);
    });
    await acquired.promise;
    const pending = calls();
    const outcomes = Promise.allSettled(pending);
    let completed = false;
    void outcomes.then(() => { completed = true; });
    let reachedBoundary = false;
    try {
        // Query actual lock waits, without sleeps or internal spies. In RED the
        // callers wait at UPDATE after their stale read; GREEN waits before it.
        while (!completed) {
            const [waiting] = await db.$queryRawUnsafe<Array<{ count: number }>>(
                `SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND query LIKE '%"EphemeralRunnerActivation"%'
                AND cardinality(pg_blocking_pids(pid)) > 0`,
            );
            if (waiting.count >= pending.length) { reachedBoundary = true; break; }
        }
        if (!reachedBoundary) throw new Error('Activation callers completed before reaching the held row boundary');
    } finally {
        release.resolve();
        await holder;
    }
    return (await outcomes).map(outcome => {
        if (outcome.status === 'rejected') throw outcome.reason;
        return outcome.value;
    });
}

describe('Activation resource serialization (PostgreSQL)', () => {
    beforeAll(async () => { initDbPostgres(); await db.$connect(); });
    afterAll(async () => { await db.$disconnect(); });

    it('admits exactly one of two distinct signed endpoint claims and preserves exact replay', async () => {
        const seeded = await fixture();
        const endpoints = [seeded.endpoint(), seeded.endpoint()];
        const results = await whileActivationLocked(seeded, () => endpoints.map(({ claim }) =>
            claimEphemeralRunnerActivation({ activationId: seeded.row.id, claim }, { homeServerIdentityId })));
        expect(results.map(result => result.status).sort()).toEqual(['claimed', 'unavailable']);
        const winner = results.find(result => result.status === 'claimed');
        if (!winner || winner.status !== 'claimed') throw new Error('Missing claim winner');
        expect((await db.ephemeralRunnerActivation.findUniqueOrThrow({ where: { id: seeded.row.id } })).claim).toEqual(winner.claim);
        await expect(claimEphemeralRunnerActivation({ activationId: seeded.row.id, claim: winner.claim }, { homeServerIdentityId }))
            .resolves.toEqual(winner);
    });

    it('does not let an admitted claim reopen a draft cancellation', async () => {
        const seeded = await fixture();
        const { claim } = seeded.endpoint();
        const results = await whileActivationLocked(seeded, () => [
            claimEphemeralRunnerActivation({ activationId: seeded.row.id, claim }, { homeServerIdentityId }),
        ], tx => closeDraftEphemeralRunnerActivationsInTx(tx, { creatorAccountId: seeded.account.id, draftId: seeded.row.draftId }));
        expect(results).toEqual([{ status: 'unavailable' }]);
        expect(await db.ephemeralRunnerActivation.findUniqueOrThrow({ where: { id: seeded.row.id } }))
            .toMatchObject({ state: 'closed', closeReason: 'canceled', claim: null });
    });

    it('refuses signed progress after a concurrent draft cancellation', async () => {
        const seeded = await fixture();
        const endpoint = seeded.endpoint();
        await db.ephemeralRunnerActivation.update({ where: { id: seeded.row.id }, data: { state: 'consented', claim: endpoint.claim } });
        const update = signRunnerActivationProgressUpdateV1({
            payload: { v: 1, purpose: 'happier.ephemeral-session-runner.activation-progress', activationId: seeded.row.id,
                sessionId: seeded.row.sessionId, machineId: seeded.row.machineId, creatorTokenEpoch: seeded.row.creatorTokenEpoch,
                phase: 'checking_ai_access' },
            activationSecretKey: seeded.activationKey.secretKey, installationSecretKey: endpoint.installationKey.secretKey,
        });
        const results = await whileActivationLocked(seeded, () => [storeRunnerActivationPhase({ activationId: seeded.row.id, update })],
            tx => closeDraftEphemeralRunnerActivationsInTx(tx, { creatorAccountId: seeded.account.id, draftId: seeded.row.draftId }));
        expect(results).toEqual([{ status: 'unavailable' }]);
        expect(await db.ephemeralRunnerActivation.findUniqueOrThrow({ where: { id: seeded.row.id } }))
            .toMatchObject({ state: 'closed', closeReason: 'canceled', progressPhase: null });
    });

    it('keeps one active activation per existing draft and accepts exact creation replay', async () => {
        const seeded = await fixture();
        await db.ephemeralRunnerActivation.delete({ where: { id: seeded.row.id } });
        const authentication = { env: process.env, authority: 'present_user' as const, authenticationEvidence: undefined };
        const mutationId = randomUUID();
        const address = { kind: 'newSession' as const, draftId: seeded.row.draftId };
        expect((await mutateSessionDraft({ accountId: seeded.account.id, address, authentication,
            expectedRevision: 'absent', content: { t: 'plain', v: { v: 1, address, document: {
                v: 1, composer: { text: { mutationId, value: 'Inspect the project' },
                    mentions: { mutationId, value: [] }, attachments: { mutationId, value: [] } },
                target: { kind: 'newSession', authoring: {} }, extensions: {},
            } } },
        })).status).toBe('updated');
        const artifact = { product: 'happier-runner' as const, version: '0.3.0', target: 'linux-x64' as const, sha256: 'a'.repeat(64) };
        // Use the existing verified-publication projection boundary, as the
        // SQLite activation suite does; release verification has its own owner.
        const publicationSnapshots = createRunnerArtifactPublicationSnapshotStore();
        publicationSnapshots.write(`${process.env.HAPPIER_GITHUB_REPO ?? 'happier-dev/happier'}\u0000stable\u00000.3.0`, [{
            identity: artifact, channel: 'stable', url: 'https://example.test/happier-runner',
            checksumsUrl: 'https://example.test/checksums', checksumsSignatureUrl: 'https://example.test/checksums.minisig',
            sizeBytes: 100, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
        }]);
        const options = { homeServerIdentityId, artifactSource: { publicationSnapshots } };
        const requests = [0, 1, 2].map(() => ({
            v: 1, activationId: randomUUID(), draftId: seeded.row.draftId, homeServerIdentityId,
            activationSigningPublicKey: seeded.row.activationSigningPublicKey, activationExpiresAt: null,
            authoringCommitment: seeded.row.authoringCommitment, workspace: { kind: 'choose_on_endpoint' },
            artifact, endpointFactsRecipient: { mode: 'plain', creatorAccountId: seeded.account.id },
        }));
        const results = await Promise.all(requests.map(request => createEphemeralRunnerActivation({
            creatorAccountId: seeded.account.id, request, authentication,
        }, options)));
        expect(results.map(result => result.status).sort()).toEqual(['conflict', 'conflict', 'created']);
        expect(await db.ephemeralRunnerActivation.count({ where: { creatorAccountId: seeded.account.id, draftId: seeded.row.draftId } })).toBe(1);
        const winner = results.findIndex(result => result.status === 'created');
        await expect(createEphemeralRunnerActivation({ creatorAccountId: seeded.account.id,
            request: requests[winner], authentication }, options)).resolves.toEqual(results[winner]);
    });
});
