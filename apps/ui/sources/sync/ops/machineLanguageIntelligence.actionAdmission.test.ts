import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { subscribeAcknowledgedWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => ({ call: vi.fn() }));
// HTTP and Machine RPC are genuine transport boundaries; Account capture,
// requester-context crypto, Action settings, admission and schemas stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (request: unknown) => rpc.call(request),
  }),
);
const { machineLanguageIntelligenceApplyAction } =
  await import('./machineLanguageIntelligence');
const hash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);
const files = [
  {
    path: 'src/retry.ts',
    expectedHash: hash,
    edits: [
      {
        range: {
          start: { line: 2, character: 16 },
          end: { line: 2, character: 32 },
        },
        text: 'formatAttemptLabel',
      },
    ],
  },
];
const request = {
  rootPath: '/repo',
  path: 'src/retry.ts',
  operation: { kind: 'rename' as const, files },
};
const receipt = {
  ok: true as const,
  results: [
    {
      path: 'src/retry.ts',
      status: 'replaced' as const,
      hash: nextHash,
      edits: [
        {
          startUtf16: 40,
          deleteLength: 16,
          insertText: 'formatAttemptLabel',
          originalText: 'formatRetryLabel',
        },
      ],
    },
  ],
};
let serverId: string;
let admitted: unknown[];

beforeEach(async () => {
  await homes.reset();
  rpc.call.mockReset();
  admitted = [];
  serverId = await homes.addHome({
    name: 'Rename Home',
    serverUrl: 'https://rename-action.test',
    serverIdentityId: 'srv_rename_action',
    accountId: 'alice',
    currentAccount: true,
    active: false,
  });
  const boundary = await createExternalActionAccountHttpBoundary({
    serverUrl: 'https://rename-action.test',
    serverIdentityId: 'srv_rename_action',
    accountId: 'alice',
    machineId: 'machine',
    actionId: 'code.rename.apply',
    tokenEpoch: 0,
    execute: async (input, context) => {
      expect(context.invocation).toMatchObject({
        surface: 'ui',
        authority: 'present_user',
        caller: { kind: 'host' },
      });
      admitted.push(input);
      return receipt;
    },
  });
  homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
  for (const path of [
    '/v1/actions/code.rename.apply/execution-authorization',
    '/v1/actions/code.rename.apply',
  ]) {
    homes.answer(serverId, path, {
      select: async (_body, http) => {
        const response = await boundary.handle(new URL(http.url), http.init);
        if (!response) throw new Error('Unexpected rename request');
        return { status: response.status, body: await response.json() };
      },
    });
  }
  // The Home refuses the raw mutation method without Action admission (route policy `actionSpecServerRequired`).
  rpc.call.mockImplementation(async () => ({
    error: 'action_admission_required',
  }));
});
afterEach(async () => {
  await homes.reset();
});

describe('semantic rename apply from the File page', () => {
  it('reaches the Machine through the admitted present-user Action and publishes its writes', async () => {
    const writes: unknown[] = [];
    const unsubscribe = subscribeAcknowledgedWorkspaceFileWrites(
      { serverId, accountId: 'alice', machineId: 'machine', rootPath: '/repo' },
      'src/retry.ts',
      (write) => writes.push(write),
    );
    try {
      expect(
        await machineLanguageIntelligenceApplyAction('machine', request, {
          serverId,
          accountId: 'alice',
        }),
      ).toEqual(receipt);
      expect(admitted).toEqual([
        {
          machineId: 'machine',
          rootPath: '/repo',
          path: 'src/retry.ts',
          files,
        },
      ]);
      expect(writes).toEqual([{ path: 'src/retry.ts', hash: nextHash }]);
    } finally {
      unsubscribe();
    }
  });

  it('refuses another Account before anything reaches the Machine', async () => {
    expect(
      await machineLanguageIntelligenceApplyAction('machine', request, {
        serverId,
        accountId: 'bob',
      }),
    ).toMatchObject({ ok: false });
    expect(admitted).toEqual([]);
    expect(homes.requestsFor('/v1/actions/code.rename.apply')).toHaveLength(0);
  });
});
