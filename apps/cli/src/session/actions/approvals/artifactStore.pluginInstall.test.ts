import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactBodyEnvelopeV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';

import { createCliApprovalsArtifactStore } from './artifactStore';

// Only the Account HTTP boundary is replaced; the real Artifact codec, header
// binding, approval parser, and lifecycle transition owner remain in the path.
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: http }));
vi.mock('@/configuration', () => ({ configuration: {
  apiServerUrl: 'http://plugin-approval.invalid', activeServerId: 'home-1',
  activeServerDir: '/tmp/happier-plugin-approval-test',
} }));

const pendingChangeId = '00000000-0000-4000-8000-000000000051';
const rows = new Map<string, Record<string, unknown>>();

function installRequest() {
  return ApprovalRequestV2Schema.parse({
    v: 2, actionId: 'plugins.install', status: 'open', summary: 'Review plugin install',
    createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' }, requestedSurface: 'cli',
    executionOriginV1: {
      v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home-1', serverIdentityId: 'home-identity', accountId: 'account-1',
      machineId: 'machine-1', target: { kind: 'machine', machineId: 'machine-1' },
      actionId: 'plugins.install', requestId: 'observer-request',
    },
    actionArgs: { kind: 'path', path: '/tmp/example' },
    preview: { pluginInstall: { pendingReview: {
      kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId,
      reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
      review: createPluginInstallationReviewFixture(),
    } } },
  });
}

function createStore() {
  return createCliApprovalsArtifactStore({ credentials: { token: 'synthetic-token', encryption: null },
    getAccountEncryptionMode: async () => 'plain' });
}

function persist(body: Record<string, unknown>) {
  rows.set(String(body.id), { ...body, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
  return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
}

beforeEach(() => {
  rows.clear();
  http.get.mockReset();
  http.post.mockReset();
  http.get.mockImplementation(async (url: string) => {
    const id = url.split('/').at(-1)!;
    return { status: rows.has(id) ? 200 : 404, data: rows.get(id) };
  });
  http.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
    if (url.endsWith('/v1/artifacts')) {
      if (rows.has(String(body.id))) return { status: 409, data: { error: 'conflict' } };
      return persist(body);
    }
    const id = url.split('/').at(-1)!;
    const row = rows.get(id)!;
    rows.set(id, { ...row, header: body.header, body: body.body,
      headerVersion: Number(row.headerVersion) + 1, bodyVersion: Number(row.bodyVersion) + 1 });
    return { status: 200, data: { success: true,
      headerVersion: Number(row.headerVersion) + 1, bodyVersion: Number(row.bodyVersion) + 1 } };
  });
});

describe('plugin install approval Artifact rejoin', () => {
  it('rejoins the retained review across observers without replacing its approved body', async () => {
    const store = createStore();
    const request = installRequest();
    const first = await store.approvalsCreate({ request, serverId: 'home-1' });
    expect(first.artifactId).toBe(pendingChangeId);
    const approved = ApprovalRequestV2Schema.parse({ ...request, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } });
    expect(await store.approvalsUpdate({ ...first, request: approved, serverId: 'home-1' })).toEqual({ ok: true });
    const retained = { ...rows.get(pendingChangeId) };
    const cliRequest = ApprovalRequestV2Schema.parse({ ...request,
      createdBy: { surface: 'cli' }, createdAtMs: 3, updatedAtMs: 3,
      executionOriginV1: { ...request.executionOriginV1, serverId: 'home-alias',
        authority: 'present_user', requestId: 'cli-request' } });
    expect(await createStore().approvalsCreate({ request: cliRequest, serverId: 'home-alias' })).toEqual(first);
    expect(rows.size).toBe(1);
    expect(rows.get(pendingChangeId)).toEqual(retained);
    expect(await store.approvalsGet({ ...first, serverId: 'home-1' })).toEqual(approved);
  });

  it('rejoins the winning Artifact after a concurrent create conflict without another write', async () => {
    const store = createStore();
    http.post.mockImplementationOnce(async (_url: string, body: Record<string, unknown>) => {
      persist(body);
      return { status: 409, data: { error: 'conflict' } };
    });
    expect(await store.approvalsCreate({ request: installRequest(), serverId: 'home-1' }))
      .toEqual({ artifactId: pendingChangeId });
    expect(rows.size).toBe(1);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'executed'] as const)(
    'creates a fresh approval after the retained review Artifact is %s', async (status) => {
      const store = createStore();
      const request = installRequest();
      const first = await store.approvalsCreate({ request, serverId: 'home-1' });
      if (status === 'executed') {
        const approved = ApprovalRequestV2Schema.parse({ ...request, status: 'approved', updatedAtMs: 2,
          decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } });
        expect(await store.approvalsUpdate({ ...first, request: approved, serverId: 'home-1' })).toEqual({ ok: true });
        const executing = ApprovalRequestV2Schema.parse({ ...approved, status: 'executing', updatedAtMs: 3 });
        expect(await store.approvalsUpdate({ ...first, request: executing, serverId: 'home-1' })).toEqual({ ok: true });
      }
      const terminal = ApprovalRequestV2Schema.parse(status === 'rejected'
        ? { ...request, status, updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 } }
        : { ...request, status, updatedAtMs: 4,
            decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
            execution: { executedAtMs: 4, ok: true, result: { kind: 'committed' } } });
      expect(await store.approvalsUpdate({ ...first, request: terminal, serverId: 'home-1' })).toEqual({ ok: true });

      const nextRequest = ApprovalRequestV2Schema.parse({
        ...request,
        createdAtMs: 5,
        updatedAtMs: 5,
        executionOriginV1: { ...request.executionOriginV1, requestId: `request-after-${status}` },
      });
      const next = await createStore().approvalsCreate({ request: nextRequest, serverId: 'home-1' });

      expect(next.artifactId).not.toBe(first.artifactId);
      expect(rows.size).toBe(2);
      expect(await store.approvalsGet({ ...first, serverId: 'home-1' })).toEqual(terminal);
      expect(await store.approvalsGet({ ...next, serverId: 'home-1' })).toEqual(nextRequest);
      const recreated = createStore();
      expect(await recreated.approvalsCreate({ request: nextRequest, serverId: 'home-1' })).toEqual(next);
      expect(await createStore().approvalsCreate({ request: nextRequest, serverId: 'home-1' })).toEqual(next);
      expect(rows.size).toBe(2);
    },
  );

  it('concurrent rejoin after terminal history creates one exact successor', async () => {
    const request = installRequest();
    const store = createStore();
    const first = await store.approvalsCreate({ request, serverId: 'home-1' });
    const rejected = ApprovalRequestV2Schema.parse({ ...request, status: 'rejected', updatedAtMs: 2,
      decision: { kind: 'reject', decidedAtMs: 2 } });
    expect(await store.approvalsUpdate({ ...first, request: rejected, serverId: 'home-1' })).toEqual({ ok: true });

    const joined = await Promise.all([createStore(), createStore()].map(observer =>
      observer.approvalsCreate({ request, serverId: 'home-1' })));
    expect(joined[0]).toEqual(joined[1]);
    expect(rows.size).toBe(2);
    expect(await store.approvalsGet({ ...first, serverId: 'home-1' })).toEqual(rejected);
    expect(await store.approvalsGet({ ...joined[0]!, serverId: 'home-1' })).toEqual(request);
  });

  it('refuses a successor whose retained subject belongs to another Home', async () => {
    const request = installRequest();
    const store = createStore();
    const first = await store.approvalsCreate({ request, serverId: 'home-1' });
    const rejected = ApprovalRequestV2Schema.parse({ ...request, status: 'rejected', updatedAtMs: 2,
      decision: { kind: 'reject', decidedAtMs: 2 } });
    await store.approvalsUpdate({ ...first, request: rejected, serverId: 'home-1' });
    const next = await createStore().approvalsCreate({ request, serverId: 'home-1' });
    const foreign = ApprovalRequestV2Schema.parse({ ...request,
      executionOriginV1: { ...request.executionOriginV1, serverIdentityId: 'other-home' } });
    const row = rows.get(next.artifactId)!;
    rows.set(next.artifactId, { ...row,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(foreign)),
      body: encodePlainArtifactStoredContent(ArtifactBodyEnvelopeV1Schema.parse({ body: JSON.stringify(foreign) })) });

    await expect(createStore().approvalsCreate({ request, serverId: 'home-1' }))
      .rejects.toThrow('approval_request_subject_mismatch');
    expect(rows.size).toBe(2);
  });

  it.each(['review', 'machine', 'home', 'account', 'family', 'access'] as const)(
    'refuses to rejoin a pending id with a different %s', async (mismatch) => {
      const store = createStore();
      const request = installRequest();
      const first = await store.approvalsCreate({ request, serverId: 'home-1' });
      if (mismatch === 'access') rows.get(first.artifactId)!.access = 'view';
      let next: ApprovalRequest = request;
      if (mismatch === 'review') next = ApprovalRequestV2Schema.parse({ ...request, preview: {
        pluginInstall: { pendingReview: { ...readPluginInstallApprovalPendingReview(request.preview),
          review: createPluginInstallationReviewFixture({ version: '2.0.0' }) } },
      } });
      if (mismatch === 'machine') next = ApprovalRequestV2Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, machineId: 'machine-2',
          target: { kind: 'machine', machineId: 'machine-2' } } });
      if (mismatch === 'home') next = ApprovalRequestV2Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, serverIdentityId: 'other-home' } });
      if (mismatch === 'account') next = ApprovalRequestV2Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, accountId: 'other-account' } });
      if (mismatch === 'family') {
        rows.clear();
        const other = ApprovalRequestV2Schema.parse({ ...request, actionId: 'session.message.send',
          actionArgs: { sessionId: 'session-1', message: 'hello' },
          executionOriginV1: { ...request.executionOriginV1, actionId: 'session.message.send' } });
        await store.approvalsCreate({ request: other, serverId: 'home-1' });
        const row = [...rows.values()][0]!;
        rows.clear(); rows.set(pendingChangeId, { ...row, id: pendingChangeId });
      }
      const retained = [...rows.entries()].map(([id, row]) => [id, { ...row }]);
      await expect(store.approvalsCreate({ request: next, serverId: 'home-1' }))
        .rejects.toThrow('approval_request_subject_mismatch');
      expect([...rows.entries()]).toEqual(retained);
    },
  );
});
