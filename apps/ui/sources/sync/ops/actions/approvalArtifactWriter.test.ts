import { beforeEach, describe, expect, it } from 'vitest';

import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    buildApprovalRequestArtifactHeaderV1,
    decodePlainArtifactStoredContent,
    encodePlainArtifactStoredContent,
    type ApprovalRequest,
    type ApprovalRequestV2,
} from '@happier-dev/protocol';

import type { ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerFetch } from '@/sync/http/client';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

// Only the Account server's HTTP boundary is
// replaced. The Home's Artifact routes are the testkit's stateful store with
// the Home's versioned compare-and-set; the real Artifact API adapter and
// codec, the real CAS writer (`updateArtifactWithHeaderViaApi`) and the real
// Protocol approval subject/transition owner all run above it.
const home = { artifacts: createArtifactStoreBoundary({ ownerAccountId: () => 'account-1', encryptionMode: 'plain' }) };
const request: ServerFetch = async (path, init) => await home.artifacts.handle(path, init)
    ?? Response.json({ error: 'not_found' }, { status: 404 });

import { fetchArtifactWithBodyFromApi, updateArtifactWithHeaderViaApi } from '@/sync/engine/artifacts/syncArtifacts';
import { writeApprovalRequestArtifact } from './approvalArtifactWriter';
import { approvalArtifactBodyMatchesHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { ApprovalRequestSchema, ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { settleApprovalRequestReplayInputs } from '@happier-dev/protocol/approvals/approvalRequestTransition';

const ARTIFACT_ID = 'approval-1';
const CLIENT_SECRET = 'synthetic-provider-client-secret';

function openRequest(): ApprovalRequestV2 {
    return {
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        requestedSurface: 'ui',
        executionOriginV1: {
            v: 1,
            authority: 'present_user',
            surface: 'ui',
            caller: { kind: 'host' },
            serverId: 'home-1',
            accountId: 'account-1',
            actionId: 'identity.providers.secret.replace',
            requestId: 'request-1',
        },
        actionId: 'identity.providers.secret.replace',
        actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3, clientSecret: CLIENT_SECRET },
        summary: 'Replace the provider secret',
    };
}

/** Creates the approval Artifact through the Home's own create route. */
async function seed(request: ApprovalRequest | TargetActionApprovalRequestV1, header?: ArtifactHeader): Promise<void> {
    const target = TargetActionApprovalRequestV1Schema.safeParse(request);
    const artifactHeader = header ?? (target.success
        ? buildTargetActionApprovalArtifactHeaderV1(target.data)
        : buildApprovalRequestArtifactHeaderV1(ApprovalRequestSchema.parse(request)));
    const created = await home.artifacts.handle('/v1/artifacts', {
        method: 'POST',
        body: JSON.stringify({
            id: ARTIFACT_ID,
            header: encodePlainArtifactStoredContent(artifactHeader),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }),
    });
    expect(created?.status).toBe(200);
}

/** The decoded request body the Home keeps — what a privacy assertion must inspect. */
function storedJson(): string {
    const body = home.artifacts.readPlainBody(ARTIFACT_ID);
    if (body === null) throw new Error('approval_artifact_missing');
    return body;
}

function stored(): ApprovalRequestV2 {
    return JSON.parse(storedJson());
}

const params = { credentials: { token: createAccountTokenForTests('account-1') }, request,
    encryption: null, artifactDataKeys: new Map() } as const;

/** One UI client: the real read and the real CAS writer against the validated read. */
function uiWriter() {
    return async (request: ApprovalRequest | TargetActionApprovalRequestV1) => await writeApprovalRequestArtifact({
        artifactId: ARTIFACT_ID,
        request,
        read: async (artifactId) => await fetchArtifactWithBodyFromApi({ ...params, artifactId }),
        write: async (basis: DecryptedArtifact, header: ArtifactHeader, body: string) => {
            await updateArtifactWithHeaderViaApi({
                ...params, artifactId: ARTIFACT_ID, header, body,
                getArtifact: () => basis,
                updateArtifact: () => {},
            });
        },
    });
}

const approve = (request: ApprovalRequestV2): ApprovalRequestV2 => ({
    ...request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
});
const claim = (request: ApprovalRequestV2): ApprovalRequestV2 => ({ ...request, status: 'executing', updatedAtMs: 3 });

describe('UI approval Artifact writer', () => {
    beforeEach(() => {
        home.artifacts.clear();
    });

    it('keeps target Action subjects immutable and prevents a decision from overwriting a competing CAS', async () => {
        const open = TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli',
            qualifiedActionId: 'acme.account-actions/actions/write', input: { key: 'personal' },
            secretInputPaths: [], approvalInputCustody: 'live_only',
            sourceCustody: { kind: 'account_release', pluginId: 'acme.account-actions', version: '1.0.0',
                archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
            policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'c'.repeat(64), summary: 'Write personal value',
        });
        await seed(open);
        const approved = { ...open, status: 'approved' as const, updatedAtMs: 2,
            decision: { kind: 'approve' as const, decidedAtMs: 2 } };
        const write = uiWriter();
        await expect(write({ ...approved, input: { key: 'different' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
        home.artifacts.beforeNextUpdate(async () => {
            await expect(uiWriter()({ ...open, status: 'rejected', updatedAtMs: 2,
                decision: { kind: 'reject', decidedAtMs: 2 } })).resolves.toEqual({ ok: true });
        });
        await expect(write(approved)).resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch' });
        await expect(write(approved)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
        expect(TargetActionApprovalRequestV1Schema.parse(JSON.parse(storedJson())))
            .toMatchObject({ status: 'rejected', decision: { kind: 'reject' }, input: open.input });
    });

    it.each([undefined, 'future_builtin_extension'])('preserves the retained V1 Home history index and canonical subject projection (kind: %s)', async kind => {
        const request = ApprovalRequestV1Schema.parse({
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system' }, actionId: 'session.model.set',
            actionArgs: {}, summary: 'Change model',
            ...(kind ? { kind } : {}),
        });
        await seed(request, buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: 'legacy-home' }));

        if (kind) {
            // Stored reads drop undeclared fields. Reintroducing one on the
            // proposed write changes the immutable subject, not its family.
            await expect(uiWriter()({ ...request, status: 'canceled', updatedAtMs: 2 }))
                .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
            expect(home.artifacts.read(ARTIFACT_ID)?.bodyVersion).toBe(1);
        }
        const basis = await fetchArtifactWithBodyFromApi({ ...params, artifactId: ARTIFACT_ID });
        const canonical = basis?.header && typeof basis.body === 'string'
            ? approvalArtifactBodyMatchesHeaderV1(basis.header, basis.body) : null;
        if (!canonical || canonical.family !== 'built_in') throw new Error('Expected the canonical built-in approval read');
        await expect(uiWriter()({ ...canonical.request, status: 'canceled', updatedAtMs: 2 })).resolves.toEqual({ ok: true });

        const row = home.artifacts.read(ARTIFACT_ID)!;
        expect(decodePlainArtifactStoredContent(row.header)).toMatchObject({
            serverId: 'legacy-home', approvalStatus: 'canceled',
        });
        expect(JSON.parse(storedJson())).toMatchObject({ v: 1, status: 'canceled' });
        expect(JSON.parse(storedJson()).kind).toBeUndefined();
    });

    it('refuses a V2 header that contradicts its body Home instead of adopting the index as authority', async () => {
        const request = openRequest();
        await seed(request, { ...buildApprovalRequestArtifactHeaderV1(request), serverId: 'other-home' });

        await expect(uiWriter()(approve(request))).resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });

        expect(JSON.parse(storedJson())).toMatchObject({ status: 'open', executionOriginV1: { serverId: 'home-1' } });
        expect(home.artifacts.read(ARTIFACT_ID)?.headerVersion).toBe(1);
    });

    it('lets exactly one of two clients claim approved -> executing', async () => {
        await seed(approve(openRequest()));
        const approved = stored();
        const first = uiWriter();
        const second = uiWriter();

        // Both clients read the approved row; the first commits its claim
        // between the second's validated read and its write.
        home.artifacts.beforeNextUpdate(async () => {
            await expect(first(claim(approved))).resolves.toEqual({ ok: true });
        });
        await expect(second(claim(approved))).resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch' });
        // A client that reads the winner's claim cannot re-claim it either.
        await expect(second(claim(approved))).resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
        expect(stored()).toMatchObject({ status: 'executing' });
    });

    it.each(['approved', 'executing', 'executed'] as const)('does not let an abandoned open intent cancel a raced %s approval', async status => {
        const open = openRequest();
        await seed(open);
        const write = uiWriter();
        home.artifacts.beforeNextUpdate(async () => {
            const approved = approve(open);
            expect(await write(approved)).toEqual({ ok: true });
            if (status === 'approved') return;
            const executing = claim(approved);
            expect(await write(executing)).toEqual({ ok: true });
            if (status === 'executed') expect(await write({ ...settleApprovalRequestReplayInputs(executing),
                status: 'executed', updatedAtMs: 4, execution: { ok: true, executedAtMs: 4, result: { ok: true } },
            })).toEqual({ ok: true });
        });
        const canceled: ApprovalRequest = { ...settleApprovalRequestReplayInputs(open), status: 'canceled', updatedAtMs: 5 };
        expect(await write(canceled)).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
        expect(await write(canceled)).toMatchObject({ ok: false });
        expect(stored().status).toBe(status);
        expect(stored().decision?.kind).toBe('approve');
    });

    it('does not let an approval built from an open read overwrite a committed rejection', async () => {
        const open = openRequest();
        await seed(open);
        const approver = uiWriter();
        const rejecter = uiWriter();
        home.artifacts.beforeNextUpdate(async () => {
            await expect(rejecter({
                ...open, status: 'rejected', updatedAtMs: 2, decision: { kind: 'reject', decidedAtMs: 2 },
                actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3 },
            })).resolves.toEqual({ ok: true });
        });

        await expect(approver(approve(open))).resolves.toMatchObject({ ok: false });
        expect(stored()).toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
        expect(storedJson()).not.toContain(CLIENT_SECRET);
    });

    it('settles only with the declared input projection and keeps operands immutable before settlement', async () => {
        const open = openRequest();
        await seed(open);
        const write = uiWriter();

        await expect(write({ ...approve(open), actionArgs: { ...open.actionArgs as object, id: 'provider-2' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
        await expect(write(approve(open))).resolves.toEqual({ ok: true });
        const executing = claim(stored());
        await expect(write(executing)).resolves.toEqual({ ok: true });
        // Keeping the raw secret on the terminal write is not the declared projection.
        await expect(write({ ...executing, status: 'executed', updatedAtMs: 4, execution: { executedAtMs: 4, ok: true, result: {} } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
        await expect(write({
            ...executing, status: 'executed', updatedAtMs: 4, execution: { executedAtMs: 4, ok: true, result: {} },
            actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3 },
        })).resolves.toEqual({ ok: true });
        expect(stored()).toMatchObject({ status: 'executed' });
        expect(storedJson()).not.toContain(CLIENT_SECRET);
    });
});
