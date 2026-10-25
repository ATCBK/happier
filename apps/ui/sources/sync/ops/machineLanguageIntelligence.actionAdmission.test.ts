import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { subscribeAcknowledgedWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildWorkspaceFileRestoreOperation } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

// Native rendering and navigation are genuine platform boundaries; the shared
// review, admission, captured Account and Artifact continuation stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

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
const { FileRenameEditSet, CodeEditSetPopover } = await import('@/components/workspaces/files/intelligence/CodeEditSetPopover');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { useBoundPluginSurfaceController } = await import('@/components/plugins/surfaces/boundPluginSurfaceController');
const { createPluginActionInputSelectionFactsPublication } = await import('@/components/plugins/surfaces/pluginActionInputSelectionFacts');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { PluginUiJsonValueV1Schema } = await import('@happier-dev/protocol/plugins/ui');
const { RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
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
  // The Action Machine is read by id through the Machine rows reader (a532f4a1e0).
  homes.answer(serverId, `/v1/machines/${boundary.machine.id}`, { body: { machine: boundary.machine } });
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
  await standardCleanup();
  await homes.reset();
});

describe('semantic rename apply from the File page', () => {
  it('continues the shared file/import rename review through Inbox approval, per-file receipts and approved operation-based Undo', async () => {
    const restoreModuleLoader = await installRealActionExecutorModuleLoader();
    await homes.requireUiApproval(serverId, ['code.file.rename.apply', 'workspace.files.replace']);
    const movedReceipt = { ok: true as const, results: [
      { path: 'src/retry.ts', renameTo: 'src/renamed.ts', status: 'replaced' as const, hash: nextHash, edits: [] },
      { path: 'src/importer.ts', status: 'replaced' as const, hash: nextHash, edits: receipt.results[0].edits },
    ] };
    let effectCount = 0;
    let restoreInput: unknown;
    let restoreRequestId: string | undefined;
    await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'alice', machineId: 'machine',
      machineFilesystemEffects: {
        languageIntelligenceApply: async ({ machineId, request, actionId }) => {
          expect({ machineId, actionId, request }).toMatchObject({ machineId: 'machine', actionId: 'code.file.rename.apply',
            request: { rootPath: '/repo', path: 'src/retry.ts', operation: { kind: 'fileRename' } } });
          effectCount++;
          return movedReceipt;
        },
        workspaceFilesReplace: async (input, context) => {
          restoreInput = input;
          restoreRequestId = context.actionRequestId ?? undefined;
          return { operation: { operationId: 'approved-restore' } };
        },
      },
    });
    let releaseTerminal!: () => void;
    const terminalReady = new Promise<void>(resolve => { releaseTerminal = resolve; });
    let terminalReads = 0;
    rpc.call.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
      if (method !== ACTION_OPERATION_RPC_METHODS_V2.get) return { success: false, error: 'fixture_read_unavailable' };
      expect(payload).toEqual({ operationId: 'approved-restore', waitForTerminal: true });
      terminalReads++;
      await terminalReady;
      return { kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'approved-restore', revision: 2,
        actionId: 'workspace.files.replace', requestId: restoreRequestId, state: 'succeeded', scope: { accountId: 'alice', machineId: 'machine' },
        title: 'Undo', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
        result: { ok: true, results: [{ path: 'src/importer.ts', status: 'restored', hash },
          { path: 'src/renamed.ts', renameTo: 'src/retry.ts', status: 'restored', hash }] },
      }) };
    });
    const writes: unknown[] = [];
    const unsubscribes = ['src/retry.ts', 'src/renamed.ts', 'src/importer.ts'].map(path => subscribeAcknowledgedWorkspaceFileWrites(
      { serverId, accountId: 'alice', machineId: 'machine', rootPath: '/repo' }, path, write => writes.push(write)));
    const screen = await renderScreen(React.createElement(FileRenameEditSet, {
      request: { op: 'fileRename', newPath: 'src/renamed.ts', files: [
        { path: 'src/retry.ts', expectedHash: hash, edits: [], renameTo: 'src/renamed.ts' },
        { ...files[0], path: 'src/importer.ts' },
      ] },
      scope: { serverId, machineId: 'machine', rootPath: '/repo' }, accountId: 'alice', filePath: 'src/retry.ts',
      onRenameOnly() {}, onRequestClose() {},
    }));
    try {
      await act(async () => { screen.pressByTestId('code-edit-set-apply'); });
      await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
      expect(Boolean(screen.findByTestId('code-edit-set-note'))).toBe(false);
      expect(Boolean(screen.findByTestId('code-edit-set-review'))).toBe(true);
      // The review says it waits on the person and offers the way to the request.
      await vi.waitFor(() => expect(Boolean(screen.findByTestId('code-edit-set-approval'))).toBe(true), { timeout: 15_000 });
      expect(effectCount).toBe(0);
      const artifactId = homes.artifacts(serverId).list()[0]!.id;
      const decision = await decideApprovalAsInbox(serverId, artifactId, 'approve');
      if (!decision.ok) throw new Error(`Approval refused: ${decision.errorCode}: ${decision.error}; ${JSON.stringify(decision.details)}; status=${JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!).status}; decisionRequests=${homes.requestsFor('/v1/actions/approval.request.decide').length}`);
      expect(decision).toMatchObject({ ok: true, result: { status: 'executed' } });
      await act(async () => { publishHomeAccountChange(serverId, [artifactId]); });
      await waitForHomeGovernance(() => expect(Boolean(screen.findByTestId('code-edit-set-result'))).toBe(true));
      expect(screen.findAllByTestId('code-edit-set-result-file').length).toBeGreaterThanOrEqual(2);
      expect(Boolean(screen.findByTestId('code-edit-set-approval'))).toBe(false);
      expect(effectCount).toBe(1);
      expect(writes).toEqual([{ path: 'src/retry.ts', hash: null }, { path: 'src/renamed.ts', hash: nextHash }, { path: 'src/importer.ts', hash: nextHash }]);
      await act(async () => { screen.pressByTestId('code-edit-set-undo'); });
      await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(2));
      const undoId = homes.artifacts(serverId).list().find(item => item.id !== artifactId)!.id;
      await waitForHomeGovernance(() => expect(Boolean(screen.findByTestId('code-edit-set-approval'))).toBe(true));
      const undoRequest = StoredApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(undoId)!));
      expect(undoRequest).toMatchObject({ status: 'open', actionId: 'workspace.files.replace',
        actionArgs: { machineId: 'machine', rootPath: '/repo', operation: buildWorkspaceFileRestoreOperation(movedReceipt.results) } });
      expect(await decideApprovalAsInbox(serverId, undoId, 'approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
      await act(async () => { publishHomeAccountChange(serverId, [undoId]); });
      await waitForHomeGovernance(() => expect(terminalReads).toBe(1));
      expect(restoreInput).toEqual({ machineId: 'machine', rootPath: '/repo', operation: buildWorkspaceFileRestoreOperation(movedReceipt.results) });
      expect(restoreRequestId).toBe(undoRequest.v === 2 ? undoRequest.executionOriginV1.requestId : undefined);
      expect(Boolean(screen.findByTestId('code-edit-set-undo'))).toBe(true);
      expect(writes).toHaveLength(3);
      await act(async () => { releaseTerminal(); });
      await waitForHomeGovernance(() => expect(Boolean(screen.findByTestId('code-edit-set-undo'))).toBe(false));
      expect(Boolean(screen.findByTestId('code-edit-set-approval'))).toBe(false);
      expect(writes).toEqual([{ path: 'src/retry.ts', hash: null }, { path: 'src/renamed.ts', hash: nextHash }, { path: 'src/importer.ts', hash: nextHash },
        { path: 'src/importer.ts', hash }, { path: 'src/renamed.ts', hash: null }, { path: 'src/retry.ts', hash }]);
      expect(effectCount).toBe(1);
      expect(terminalReads).toBe(1);
    } finally { releaseTerminal(); for (const unsubscribe of unsubscribes) unsubscribe(); restoreModuleLoader(); }
  });

  it('keeps the review after the person declines the apply, saying nothing was changed', async () => {
    const restoreModuleLoader = await installRealActionExecutorModuleLoader();
    await homes.requireUiApproval(serverId, ['code.file.rename.apply']);
    let effectCount = 0;
    await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'alice', machineId: 'machine',
      machineFilesystemEffects: {
        languageIntelligenceApply: async () => { effectCount++; return receipt; },
        workspaceFilesReplace: async () => ({ operation: { operationId: 'unused' } }),
      },
    });
    const screen = await renderScreen(React.createElement(FileRenameEditSet, {
      request: { op: 'fileRename', newPath: 'src/renamed.ts', files: [
        { path: 'src/retry.ts', expectedHash: hash, edits: [], renameTo: 'src/renamed.ts' },
        { ...files[0], path: 'src/importer.ts' },
      ] },
      scope: { serverId, machineId: 'machine', rootPath: '/repo' }, accountId: 'alice', filePath: 'src/retry.ts',
      onRenameOnly() {}, onRequestClose() {},
    }));
    try {
      await act(async () => { screen.pressByTestId('code-edit-set-apply'); });
      await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
      const artifactId = homes.artifacts(serverId).list()[0]!.id;
      expect(await decideApprovalAsInbox(serverId, artifactId, 'reject')).toMatchObject({ ok: true });
      await act(async () => { publishHomeAccountChange(serverId, [artifactId]); });
      await vi.waitFor(() => expect(Boolean(screen.findByTestId('code-edit-set-declined'))).toBe(true), { timeout: 15_000 });
      expect(Boolean(screen.findByTestId('code-edit-set-note'))).toBe(false);
      expect(Boolean(screen.findByTestId('code-edit-set-review'))).toBe(true);
      expect(Boolean(screen.findByTestId('code-edit-set-approval'))).toBe(false);
      const button = screen.findAllByType(RoundButton).find(node => node.props.testID === 'code-edit-set-apply');
      expect(button?.props.loading).toBeFalsy();
      expect(effectCount).toBe(0);
    } finally { restoreModuleLoader(); }
  });

  it.each(['dismiss', 'change target'] as const)('does not issue an Action after %s while pre-apply document sync is pending', async reason => {
    await homes.requireUiApproval(serverId, 'code.codeAction.apply');
    rpc.call.mockResolvedValue({ status: 'ok', kind: 'codeActions', fileHash: hash, actions: [{ serverId: 'fixture/server', title: 'Fix fixture',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, files: [], hasCommand: true }] });
    let release!: () => void;
    const syncing = new Promise<void>(resolve => { release = resolve; });
    let syncCalls = 0;
    const props = {
      request: { op: 'fixes' as const, anchor: null, line: 0, character: 0, symbol: 'value' },
      scope: { serverId, machineId: 'machine', rootPath: '/repo' }, accountId: 'alice', filePath: 'src/retry.ts', languageId: 'typescript',
      readText: () => 'value', isUnsaved: () => false, save: async () => true,
      syncDocument: async () => { syncCalls++; if (syncCalls === 2) await syncing; }, sourceLabel: null, onRequestClose() {},
    };
    const screen = await renderScreen(React.createElement(CodeEditSetPopover, props));
    await waitForHomeGovernance(() => expect(Boolean(screen.findByTestId('code-fix-0'))).toBe(true));
    await act(async () => { screen.pressByTestId('code-fix-0'); });
    const button = screen.findAllByType(RoundButton).find(node => node.props.testID === 'code-edit-set-apply');
    if (!button) throw new Error('Expected the rendered apply control');
    let applying!: Promise<void>;
    await act(async () => { applying = button.props.onPress(); });
    await waitForHomeGovernance(() => expect(syncCalls).toBe(2));
    if (reason === 'dismiss') await act(async () => { screen.unmount(); });
    else await act(async () => { screen.update(React.createElement(CodeEditSetPopover, { ...props, scope: { ...props.scope, machineId: 'other-machine' } })); });
    await act(async () => { release(); await applying; });
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
    expect(homes.requestsFor('/v1/actions/code.codeAction.apply')).toHaveLength(0);
  });

  it.each(['dismiss', 'retire Account'] as const)('releases local approval interest on %s without deciding or replaying its durable request', async reason => {
    await homes.requireUiApproval(serverId, 'code.rename.apply');
    const interest = new AbortController();
    let registered = false;
    const pending = machineLanguageIntelligenceApplyAction('machine', request, { serverId, accountId: 'alice',
      continuationSignal: interest.signal, onApprovalPending: () => { registered = true; } });
    await waitForHomeGovernance(() => expect(registered).toBe(true));
    const artifactId = homes.artifacts(serverId).list()[0]!.id;
    if (reason === 'dismiss') interest.abort();
    else await homes.switchAccount(serverId, 'bob', { currentAccount: true });
    expect(await pending).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(StoredApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!)))
      .toMatchObject({ status: 'open', actionId: 'code.rename.apply' });
    expect(admitted).toEqual([]);
    expect(homes.requestsFor('/v1/actions/code.rename.apply')).toHaveLength(0);
  });

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

describe('ordinary mounted plugin Machine Actions', () => {
  it.each([
    { actionId: 'code.rename.preview', ask: false },
    { actionId: 'code.file.rename.preview', ask: false },
    { actionId: 'code.codeActions.list', ask: false },
    { actionId: 'code.rename.apply', ask: false },
    { actionId: 'code.file.rename.apply', ask: false },
    { actionId: 'code.codeAction.apply', ask: false },
    { actionId: 'workspace.files.replace', ask: false },
    { actionId: 'code.rename.apply', ask: true },
  ] as const)(
    'delivers admitted $actionId (explicit Ask: $ask) with its actual mounted caller and retires the old occurrence', async ({ actionId, ask }) => {
      const restoreModuleLoader = await installRealActionExecutorModuleLoader();
      let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
      try {
        resetScopedHomeActionExecutorsForTests();
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
          actionsSettingsV1: { v: 1, actions: ask ? { [actionId]: { approvalRequiredSurfaces: ['plugin'] } } : {},
            approvalWaivedSurfaces: { [actionId]: ['plugin'] } },
        } }, version: 1 } });
        const input = actionId === 'workspace.files.replace'
          ? { machineId: 'machine', rootPath: '/repo', operation: buildWorkspaceFileRestoreOperation(receipt.results) }
          : actionId === 'code.file.rename.preview'
            ? { machineId: 'machine', rootPath: '/repo', path: 'src/retry.ts', newPath: 'src/attempt.ts' }
          : actionId === 'code.rename.preview' || actionId === 'code.codeActions.list'
            ? { machineId: 'machine', rootPath: '/repo', path: 'src/retry.ts', line: 3, symbol: 'formatRetryLabel',
                ...(actionId === 'code.rename.preview' ? { newName: 'formatAttemptLabel' } : {}) }
          : actionId === 'code.codeAction.apply'
            ? { machineId: 'machine', rootPath: '/repo', path: 'src/retry.ts', operation: { kind: 'codeAction', expectedHash: hash,
                action: { serverId: 'fixture/server', title: 'Rename fixture', hasCommand: false,
                  range: files[0].edits[0].range, files } } }
            : { machineId: 'machine', rootPath: '/repo', path: 'src/retry.ts', files };
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'semantic-fixture-root' };
        const queryKind = actionId === 'code.rename.preview' ? 'rename'
          : actionId === 'code.file.rename.preview' ? 'willRenameFiles'
          : actionId === 'code.codeActions.list' ? 'codeActions' : null;
        const query = queryKind ? { rootPath: '/repo', path: 'src/retry.ts', text: 'disk', kind: queryKind,
          ...(queryKind === 'willRenameFiles' ? { newPath: 'src/attempt.ts' }
            : { position: { line: 2, symbol: 'formatRetryLabel' },
                ...(queryKind === 'rename' ? { newName: 'formatAttemptLabel' } : {}) }) } : null;
        const result = queryKind ? { status: 'ok', kind: queryKind, fileHash: hash,
          ...(queryKind === 'codeActions' ? { actions: [] } : { files }) } : receipt;
        // Only the addressed daemon is scripted. Approval currentness consumes
        // its strict source projection, not a mocked internal origin predicate.
        rpc.call.mockImplementation(async (request: { method: string; payload: unknown; serverId?: string; accountId?: string }) => {
          if (request.method === RPC_METHODS.DAEMON_LSP_QUERY) {
            expect(request).toMatchObject({ machineId: 'machine', serverId, accountId: 'alice', payload: query });
            admitted.push(request.payload);
            return result;
          }
          return request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ
          ? { status: 'current', targetedContributions: { target: {
              pluginId: 'qa.semantic', occurrenceId: 'semantic-occurrence', sourceCustody,
            }, points: [] }, targetedSurfaceMounts: [] }
          : { error: 'action_admission_required' };
        });
        const boundary = await createExternalActionAccountHttpBoundary({
          serverUrl: 'https://rename-action.test', serverIdentityId: 'srv_rename_action', accountId: 'alice',
          machineId: 'machine', actionId, tokenEpoch: 0,
          execute: async (actual, context) => {
            expect(actual).toEqual(input);
            expect(context.invocation).toMatchObject({ surface: 'plugin', authority: 'account_automation',
              caller: { kind: 'plugin', pluginId: 'qa.semantic', contributionLocalId: 'review',
                occurrenceId: 'semantic-occurrence', sourceCustody } });
            expect(context.pluginInvocation).toEqual({ kind: 'mountedPluginSurface', mountedBinding: {
              pluginId: 'qa.semantic', contributionLocalId: 'review', occurrenceId: 'semantic-occurrence', sourceCustody,
            } });
            admitted.push(actual);
            return receipt;
          },
        });
        // The Action Machine is read by id through the Machine rows reader (a532f4a1e0).
        homes.answer(serverId, `/v1/machines/${boundary.machine.id}`, { body: { machine: boundary.machine } });
        for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
          homes.answer(serverId, path, { select: async (_body, http) => {
            const response = await boundary.handle(new URL(http.url), http.init);
            if (!response) throw new Error('Unexpected mounted plugin request');
            return { status: response.status, body: await response.json() };
          } });
        }
        account = await captureLazyActionAccountContext(serverId);
        const facts = {
          pluginId: 'qa.semantic', contributionId: 'review', surfaceId: 'semantic-review',
          placement: 'browserSurface' as const, platform: 'web' as const, channel: 'internal' as const,
          machineId: 'machine', serverId, projectionGeneration: 1,
          executionOrigin: { serverIdentityId: 'srv_rename_action', sourceRef: {
            machineId: 'machine', pluginId: 'qa.semantic', sourceCustody,
          } }, accountLifetime: account.accountOnlyLifetime, interactionEnabled: true, daemonInteractionEnabled: true,
          actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: 'qa.semantic' }),
        };
        const hook = await renderHook(({ occurrenceId }) => useBoundPluginSurfaceController({ facts: { ...facts, occurrenceId } }),
          { initialProps: { occurrenceId: 'semantic-occurrence' } });
        const mounted = hook.getCurrent();
        const request = { version: 1 as const, requestId: 'semantic-plugin-write', surface: mounted.surfaceContext,
          method: 'executeAction' as const, payload: PluginUiJsonValueV1Schema.parse({ action: actionId, input }) };
        const pending = mounted.hostApi.handleRequest(request);
        if (ask) {
          await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
          const artifactId = homes.artifacts(serverId).list()[0]!.id;
          expect(admitted).toEqual([]);
          expect(StoredApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!)))
            .toMatchObject({ status: 'open', actionId, requestedSurface: 'plugin', executionOriginV1: {
              authority: 'account_automation', caller: { kind: 'plugin', pluginId: 'qa.semantic', sourceCustody },
            } });
          // Machine approval replay remains daemon-owned. Declining proves the
          // explicit Ask wins without inventing an app-owned replay fixture.
          expect(await decideApprovalAsInbox(serverId, artifactId, 'reject')).toMatchObject({ ok: true });
          publishHomeAccountChange(serverId, [artifactId]);
        }
        expect(await pending).toEqual(ask
          ? expect.objectContaining({ code: 'unavailable', diagnostics: ['approval_rejected'] })
          : result);
        expect(admitted).toEqual(ask ? [] : [query ?? input]);
        expect(homes.artifacts(serverId).list()).toHaveLength(ask ? 1 : 0);
        // The real mounted owner retires its old controller on occurrence replacement.
        await hook.rerender({ occurrenceId: 'replacement-occurrence' });
        expect(await mounted.hostApi.handleRequest(request)).toMatchObject({ code: 'stale_surface' });
        expect(admitted).toEqual(ask ? [] : [query ?? input]);
        await hook.unmount();
      } finally {
        account?.dispose();
        restoreModuleLoader();
        resetScopedHomeActionExecutorsForTests();
      }
    },
  );
});
