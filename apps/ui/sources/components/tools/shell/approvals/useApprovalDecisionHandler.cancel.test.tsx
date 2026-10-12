import { beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createUiApprovalRequest } from '@/dev/testkit/harness/approvalInbox';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER, buildApprovalRequestArtifactHeaderV1, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { t } from '@/text';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { getApprovalDecisionErrorMessage, useApprovalDecisionHandler } = await import('./useApprovalDecisionHandler');

describe('built-in approval decisions through the canonical owner', () => {
    beforeEach(async () => { standardCleanup(); await harness.reset(); });
    it('reports a durably stale execution instead of accepting it as a successful answer', async () => {
        const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://stale-approval.test', accountId: 'bob' });
        const request = ApprovalRequestSchema.parse({
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'mcp' }, requestedSurface: 'mcp',
            actionId: 'session.spawn_new', summary: 'Create session', serverId,
            actionArgs: { creationKey: 'api:stale-directory', executionTarget: { serverId, machineId: 'machine' },
                directory: '/repo/new', organizationPlacement: { folderId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                initialInput: { text: 'Inspect this repository.' } },
            sessionCreationDirectoryApproval: { v: 1, executionTarget: { serverId, machineId: 'machine' }, directory: '/repo/new' },
        });
        const artifact = { id: 'stale-approval', header: buildApprovalRequestArtifactHeaderV1(request) };
        const response = await harness.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            ...artifact, header: encodePlainArtifactStoredContent(artifact.header),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        expect(response?.ok).toBe(true);
        const hook = await renderHook(() => useApprovalDecisionHandler(artifact, request, '', serverId));
        const decision = hook.getCurrent()('approve');
        await expect(decision).rejects.toMatchObject({ code: 'approval_stale', canTryAgain: false });
        const failure: unknown = await decision.catch((error: unknown) => error);
        expect(getApprovalDecisionErrorMessage(failure)).toBe(t('approvals.staleFailure'));
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifact.id) ?? 'null')).toMatchObject({
            status: 'failed', decision: { kind: 'approve' }, execution: { ok: false, errorCode: 'approval_stale' },
        });
        expect(harness.requests.filter(({ path }) => path.includes('/rpc'))).toEqual([]);
        await hook.unmount();
    });
    it('cancels a real pending Machine open without running the physical effect', async () => {
        const serverId = await harness.addHome({ name: 'Terminal Home', serverUrl: 'https://terminal-cancel.test', accountId: 'bob' });
        await harness.requireUiApproval(serverId, 'machines.terminal.open');
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'machines.terminal.open',
            actionInput: { serverId, machineId: 'machine', terminalKey: 'owned-member', cwd: '/accepted' }, actionRequestId: 'open-own-member' });
        const context = await captureActionAccountContext(serverId);
        try {
            const artifact = await context.fetchArtifact(artifactId);
            if (!artifact || typeof artifact.body !== 'string') throw new Error('Expected actual pending Artifact');
            const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
            if (parsed?.family !== 'built_in') throw new Error('Expected built-in approval');
            const hook = await renderHook(() => useApprovalDecisionHandler(artifact, parsed.request, '', serverId));
            expect(await hook.getCurrent()('cancel')).toBe(true);
            const canceled = harness.artifacts(serverId).readPlainBody(artifactId);
            expect(canceled && JSON.parse(canceled)).toMatchObject({ status: 'canceled' });
            expect(canceled && JSON.parse(canceled)).not.toHaveProperty('decision');
            expect(harness.requests.filter(request => request.path.includes('/rpc'))).toEqual([]);
            await hook.unmount();
        } finally { context.dispose(); }
    });
});
