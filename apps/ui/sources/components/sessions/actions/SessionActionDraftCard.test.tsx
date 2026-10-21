import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { getActionSpec, resolveEffectiveActionInputFields, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ExecutionRunStartRequestSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { ReviewEngineListItemSchema } from '@happier-dev/protocol/reviews/reviewEngines';
import { changeTextTestInstance, createDeferred, findTestInstanceByTypeContainingText, pressTestInstance, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { ResolveSessionActionFieldOptions } from './sessionActionFieldOptions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput',
        Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default ?? null },
        useWindowDimensions: () => ({ width: 1200, height: 800 }),
    }));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key, params?: Record<string, unknown>) => key === 'session.actionsDraft.validation.requiredField'
            ? String(params?.field ?? 'Field') + ' is required.' : key,
    }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('@/utils/web/reactDomCjs', async () =>
    (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());

let browser = await installBrowserRuntimeForTests({ url: 'https://action-card.test/' });
afterAll(() => browser.restore());
beforeEach(async () => {
    // Package cleanup restores Node globals before each case. The physical
    // browser port must exist before the real Home captures its lifetime.
    browser.restore();
    browser = await installBrowserRuntimeForTests({ url: 'https://action-card.test/' });
});
const { installSessionPaneRuntimeTestHarness } = await import('../panes/sessionPaneRuntimeTestHarness');
const launches: Array<Readonly<{ targetId: string; serverUrl: string | undefined; request: ReturnType<typeof ExecutionRunStartRequestSchema.parse> }>> = [];
const launchReply = vi.fn(async () => ExecutionRunStartResponseSchema.parse({
    runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1',
}));
const reviewEngines = [
    { engineId: 'coderabbit', value: 'coderabbit', label: 'CodeRabbit', enabled: true, capabilities: { structuredNarration: false } },
    { engineId: 'claude', value: 'claude', label: 'Claude', backendId: 'claude', enabled: true, capabilities: { structuredNarration: true } },
    { engineId: 'codex', value: 'codex', label: 'Codex', backendId: 'codex', enabled: true, capabilities: { structuredNarration: true } },
].map(engine => ReviewEngineListItemSchema.parse(engine));
let reviewInventoryBoundary: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | undefined;
const runtime = installSessionPaneRuntimeTestHarness({
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    features: () => {
        const response = createRootLayoutFeaturesResponse();
        tryWriteServerEnabledBitInPlace(response, 'execution.runs', true);
        return response;
    },
    request: async (url, init) => {
        if (new URL(String(url)).pathname === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
        }));
        return await reviewInventoryBoundary?.handle(new URL(String(url)), init) ?? null;
    },
    rpc: async (method, input, targetId, context) => {
        const inventory = createReadyMachineAgentInventoryFixture([{ agentId: 'claude', title: 'Claude' }, { agentId: 'opencode', title: 'OpenCode' }]);
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: inventory.projection });
        }
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return inventory.capabilities;
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_START
            || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
            const request = ExecutionRunStartRequestSchema.parse(method === SESSION_RPC_METHODS.EXECUTION_RUN_START ? input
                : input && typeof input === 'object' && 'start' in input ? input.start : null);
            launches.push({ targetId, serverUrl: context.serverUrl, request });
            return await launchReply();
        }
        throw new RpcError('Daemon method unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    },
});
const { storage } = await import('@/sync/domains/state/storage');
const executorModule = await import('@/sync/ops/actions/defaultActionExecutor');
const createDefaultActionExecutorSpy = vi.spyOn(executorModule, 'createDefaultActionExecutor');
const backendsModule = await import('@/hooks/server/useExecutionRunsBackendsForSession');
const useExecutionRunsBackendsForSessionSpy = vi.spyOn(backendsModule, 'useExecutionRunsBackendsForSession');
const { useSessionActionFieldOptions } = await import('./useSessionActionFieldOptions');
const { sessionAddressKey } = await import('@/sync/domains/session/sessionAddress');
const { SessionActionDraftCard } = await import('./SessionActionDraftCard');
let executeSpy: MockInstance<ReturnType<typeof executorModule.createDefaultActionExecutor>['execute']>;
let updateSessionActionDraftInput = vi.spyOn(storage.getState(), 'updateSessionActionDraftInput');
let setSessionActionDraftStatus = vi.spyOn(storage.getState(), 'setSessionActionDraftStatus');
let deleteSessionActionDraft = vi.spyOn(storage.getState(), 'deleteSessionActionDraft');
let draftScope: Readonly<{ serverId: string; accountId: string }>;
let draftAddress: Readonly<{ serverId: string; sessionId: string }>;
let fieldOptions: ResolveSessionActionFieldOptions | undefined;

function cardExecutorCalls() {
    return createDefaultActionExecutorSpy.mock.calls.filter(([options]) => options?.resolveServerIdForSessionId);
}
function readFieldOptionsResolver() {
    if (!fieldOptions) throw new Error('Expected mounted Action field options');
    return fieldOptions;
}
function readDraft() {
    return storage.getState().sessionActionDraftsByAddressKey[sessionAddressKey(draftAddress)]?.find(draft => draft.id === 'd1');
}
function DraftFixture() {
    const drafts = storage(state => state.sessionActionDraftsByAddressKey[sessionAddressKey(draftAddress)]);
    fieldOptions = useSessionActionFieldOptions('s1', runtime.serverId);
    return drafts?.[0] ? <SessionActionDraftCard draft={drafts[0]} /> : null;
}
async function renderDraft(draft: Omit<SessionActionDraft, 'address' | 'accountId'> & { sessionId?: string }) {
    const produced = storage.getState().createSessionActionDraft(draftScope, draftAddress, draft);
    const { sessionId: _sessionId, ...facts } = draft;
    const scopedDraft: SessionActionDraft = { ...produced, ...facts };
    storage.setState({ sessionActionDraftsByAddressKey: { [sessionAddressKey(draftAddress)]: [scopedDraft] } });
    const screen = await renderScreen(<DraftFixture />, { wrapper: runtime.Wrapper });
    await waitForHomeGovernance(() => {
        const context = { actionId: scopedDraft.actionId, draftInput: scopedDraft.input };
        const targets = scopedDraft.input?.backendTargetKeys;
        const hasOneBackendTarget = typeof scopedDraft.input?.backendTargetKey === 'string'
            || (Array.isArray(targets) && targets.length === 1);
        for (const field of resolveEffectiveActionInputFields(getActionSpec(scopedDraft.actionId as Parameters<typeof getActionSpec>[0]), scopedDraft.input)) {
            if (field.optionsSourceId || field.inputType) {
                const state = readFieldOptionsResolver().state?.(field, context);
                if (field.optionsSourceId === 'teams.credential_models.available') {
                    // The current catalog declares this optional JSON field, but the source
                    // owner explicitly refuses it. Do not replace that refusal with choices.
                    expect(state).toMatchObject({ status: 'failed', errorCode: 'options_source_not_supported', options: [] });
                } else if (!hasOneBackendTarget && (scopedDraft.actionId === 'subagents.plan.start' || scopedDraft.actionId === 'subagents.delegate.start')
                    && ['agents.models.available', 'agents.config_options.available', 'sessions.spawn.connected_services.available'].includes(field.optionsSourceId ?? '')) {
                    // Invalid legacy multi-target drafts remain editable before normalization;
                    // dependent choices cannot be admitted until one target is selected.
                    expect(state).toMatchObject({ status: 'failed', errorCode: 'missing_option_dependency', options: [] });
                } else if (field.optionsSourceId === 'agents.config_options.available' && !scopedDraft.input?.machineId) {
                    // These Session-owned drafts do not carry a Machine selection into
                    // built-in option reads. Config is a Machine probe, unlike the static
                    // model catalog, so its owner refuses the missing target explicitly.
                    expect(state).toMatchObject({ status: 'failed', errorCode: 'invalid_parameters', options: [] });
                } else {
                    expect(state?.status).toBe('ready');
                }
            }
        }
    });
    const executorIndex = createDefaultActionExecutorSpy.mock.calls.reduce((lastIndex, [options], index) =>
        options?.resolveServerIdForSessionId ? index : lastIndex, -1);
    const result = createDefaultActionExecutorSpy.mock.results[executorIndex];
    if (result?.type !== 'return') throw new Error('Expected the actual card Action executor');
    executeSpy = vi.spyOn(result.value, 'execute');
    return screen;
}

beforeEach(async () => {
    launches.length = 0;
    launchReply.mockReset().mockResolvedValue(ExecutionRunStartResponseSchema.parse({ runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' }));
    createDefaultActionExecutorSpy.mockClear();
    useExecutionRunsBackendsForSessionSpy.mockClear();
    updateSessionActionDraftInput = vi.spyOn(storage.getState(), 'updateSessionActionDraftInput');
    setSessionActionDraftStatus = vi.spyOn(storage.getState(), 'setSessionActionDraftStatus');
    deleteSessionActionDraft = vi.spyOn(storage.getState(), 'deleteSessionActionDraft');
    updateSessionActionDraftInput.mockClear();
    setSessionActionDraftStatus.mockClear();
    deleteSessionActionDraft.mockClear();
    draftScope = { serverId: runtime.serverId, accountId: 'account-a' };
    draftAddress = { serverId: runtime.serverId, sessionId: 's1' };
    reviewInventoryBoundary = await createExternalActionAccountHttpBoundary({
        serverUrl: 'https://session-pane.test', serverIdentityId: runtime.serverIdentityId,
        accountId: 'account-a', machineId: 'm1', actionId: 'review.engines.list', tokenEpoch: 0, requesterInvocation: 'none',
        execute: input => {
            getActionSpec('review.engines.list').inputSchema.parse(input);
            return { items: reviewEngines };
        },
    });
    storage.getState().applySessions([createSessionFixture({
        id: 's1', serverId: runtime.serverId, active: true,
        metadata: { path: '/repo', host: 'card-test', machineId: 'm1', flavor: 'claude' },
        agentState: { controlledByUser: true },
    })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() })], true, {
        sourceServerId: runtime.serverId, sourceAccountId: 'account-a',
    });
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'execution.runs': true } });
});
describe('SessionActionDraftCard', () => {
  it('threads the session server id into review backend lookup and default execution routing', async () => {

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: { engineIds: ['coderabbit'], instructions: 'Review this repository.', changeType: 'all', base: { kind: 'none' } },
    } as const;

    await renderDraft(draft);

    expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenCalledWith('s1', runtime.serverId, true);
    expect(cardExecutorCalls()).toHaveLength(1);
    const executorConfig = cardExecutorCalls()[0]?.[0] as {
      resolveServerIdForSessionId: (sessionId: string) => string | null;
    };
    expect(executorConfig.resolveServerIdForSessionId('s1')).toBe(runtime.serverId);
  });

  it('keeps a captured draft on its exact Home when ambient preferred-server focus changes', async () => {

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: { engineIds: ['coderabbit'], instructions: 'Review this repository.', changeType: 'all', base: { kind: 'none' } },
    } as const;

    await renderDraft(draft);

    expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenCalledWith('s1', runtime.serverId, true);
    expect(cardExecutorCalls()).toHaveLength(1);

    await act(async () => {
      // The legacy bare-ID inference changes; the captured draft keeps its exact address.
      storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: 'server-reactive' }) } });
    });

    expect(useExecutionRunsBackendsForSessionSpy).toHaveBeenLastCalledWith('s1', runtime.serverId, true);
    const executorConfig = cardExecutorCalls().at(-1)?.[0] as {
      resolveServerIdForSessionId: (sessionId: string) => string | null;
    };
    expect(executorConfig.resolveServerIdForSessionId('s1')).toBe(runtime.serverId);
  });

  it('submits a valid subagents.plan.start draft via the default action executor', async () => {

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.plan.start',
      createdAt: 1,
      status: 'editing',
      input: { backendTargetKeys: ['agent:claude'], instructions: 'Plan this.' },
    } as const;

    const screen = await renderDraft(draft);
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();

    await pressTestInstanceAsync(start, 'common.start');

    await waitForHomeGovernance(() => expect(readDraft()).toBeUndefined());
    expect(launches).toEqual([expect.objectContaining({ targetId: 's1', serverUrl: 'https://session-pane.test',
      request: expect.objectContaining({ intent: 'plan', instructions: 'Plan this.' }),
    })]);
    expect(buildBackendTargetKeyV2(launches[0]!.request.backendTarget)).toBe(buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }));

    expect(executeSpy).toHaveBeenCalledWith(
      'subagents.plan.start',
      { sessionId: 's1', backendTargetKeys: ['agent:claude'], instructions: 'Plan this.' },
      { defaultSessionId: 's1', surface: 'ui', placement: 'session_action_menu' },
    );

    // Should transition to running then succeeded.
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', 'running', null);
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', 'succeeded', null);
    expect(deleteSessionActionDraft).toHaveBeenCalledWith(draftScope, draftAddress, 'd1');
  });

  it('normalizes stale multi-target single-select draft input before submitting', async () => {

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.plan.start',
      createdAt: 1,
      status: 'editing',
      input: {
        backendTargetKeys: ['agent:claude', 'agent:opencode'],
        instructions: 'Plan this.',
      },
    } as const;

    const screen = await renderDraft(draft);
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();

    await pressTestInstanceAsync(start, 'common.start');

    expect(executeSpy).toHaveBeenCalledWith(
      'subagents.plan.start',
      { sessionId: 's1', backendTargetKeys: ['agent:opencode'], instructions: 'Plan this.' },
      { defaultSessionId: 's1', surface: 'ui', placement: 'session_action_menu' },
    );
    await waitForHomeGovernance(() => expect(readDraft()).toBeUndefined());
    expect(buildBackendTargetKeyV2(launches[0]!.request.backendTarget)).toBe(buildBackendTargetKeyV2({ kind: 'backend', backendId: 'opencode' }));
  });

  it('keeps the draft editable when the action execution fails', async () => {
    launchReply.mockRejectedValueOnce(new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));


    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.delegate.start',
      createdAt: 1,
      status: 'editing',
      input: { backendTargetKeys: ['agent:claude'], instructions: 'Delegate this.' },
    } as const;

    const screen = await renderDraft(draft);
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();

    await pressTestInstanceAsync(start, 'common.start');

    await waitForHomeGovernance(() => expect(readDraft()).toMatchObject({ status: 'editing', error: 'RPC method not available' }));
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', 'running', null);
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', 'editing', 'RPC method not available');
    expect(deleteSessionActionDraft).not.toHaveBeenCalled();
  });

  it('ignores duplicate start presses while an action launch is already in flight', async () => {
    const launch = createDeferred<ReturnType<typeof ExecutionRunStartResponseSchema.parse>>();
    launchReply.mockReturnValueOnce(launch.promise);
    const accepted = ExecutionRunStartResponseSchema.parse({ runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' });

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: {
        engineIds: ['coderabbit'],
        instructions: 'Review this repository.',
        changeType: 'all',
        base: { kind: 'none' },
      },
    } as const;

    const screen = await renderDraft(draft);
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();

    try {
      act(() => pressTestInstance(start, 'first start'));
      await waitForHomeGovernance(() => expect(launches).toHaveLength(1));
      act(() => pressTestInstance(start, 'duplicate start'));
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(launches).toHaveLength(1);
      act(() => launch.resolve(accepted));
      await waitForHomeGovernance(() => expect(readDraft()).toBeUndefined());
      expect(setSessionActionDraftStatus).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', 'running', null);
      expect(setSessionActionDraftStatus).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', 'succeeded', null);
    } finally {
      launch.resolve(accepted);
    }
  });

  it('allows retrying a failed draft without recreating it', async () => {

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.delegate.start',
      createdAt: 1,
      status: 'failed',
      error: 'RPC method not available',
      input: { backendTargetKeys: ['agent:claude'], instructions: 'Delegate this.' },
    } as const;

    const screen = await renderDraft(draft);
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();
    expect(start!.props.disabled).toBe(false);
  });

  it('cancels the exact scoped draft without launching an action', async () => {
    const screen = await renderDraft({ id: 'd1', actionId: 'subagents.plan.start', createdAt: 1,
      status: 'editing', input: { backendTargetKeys: ['agent:claude'], instructions: 'Plan this.' } });
    const cancel = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.cancel');
    await pressTestInstanceAsync(cancel, 'common.cancel');
    expect(readDraft()).toBeUndefined();
    expect(deleteSessionActionDraft).toHaveBeenCalledWith(draftScope, draftAddress, 'd1');
    expect(executeSpy).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
  });

  it('disables start and shows a field-aware validation error when required inputs are missing', async () => {
    setSessionActionDraftStatus.mockClear();


    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.plan.start',
      createdAt: 1,
      status: 'editing',
      input: { backendTargetKeys: ['agent:claude'], instructions: '   ' },
    } as const;

    const screen = await renderDraft(draft);
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();
    expect(start!.props.disabled).toBe(true);

    const texts = screen.tree.findAllByType('Text');
    expect(texts.some((node: any) => node.props?.children === 'Instructions is required.')).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(setSessionActionDraftStatus).not.toHaveBeenCalled();
  });

  it('maps missing review engine selection to a required-field validation message', async () => {
    setSessionActionDraftStatus.mockClear();


    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: { instructions: '', changeType: 'committed', base: { kind: 'none' } },
    } as const;

    const screen = await renderDraft(draft);
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();
    expect(start!.props.disabled).toBe(true);

    const texts = screen.tree.findAllByType('Text');
    expect(texts.some((node: any) => node.props?.children === 'Review engines is required.')).toBe(true);
    expect(
      texts.some((node: any) => String(node.props?.children ?? '').includes('Invalid input: expected array, received undefined')),
    ).toBe(false);
  });

  it('clears stale draft errors when the user edits an input', async () => {
    updateSessionActionDraftInput.mockClear();
    setSessionActionDraftStatus.mockClear();


    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      error: 'Instructions is required.',
      input: { engineIds: ['claude'], instructions: '', changeType: 'committed', base: { kind: 'none' } },
    } as const;

    const screen = await renderDraft(draft);
    const input = screen.tree.findAllByType('TextInput').find(node => node.props.multiline === true)!;
    await act(async () => {
      changeTextTestInstance(input, 'Review this.');
    });

    expect(updateSessionActionDraftInput).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', { instructions: 'Review this.' });
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', 'editing', null);
    expect(readDraft()).toMatchObject({ input: { instructions: 'Review this.' }, status: 'editing', error: null });
  });

  it('hides conditional review base fields when base.kind is none', async () => {
    // Sanity: protocol-level rule evaluation should hide base branch/commit for base.kind=none.
    const spec = getActionSpec('review.start' as any);
    const effective = resolveEffectiveActionInputFields(spec as any, {
      engineIds: ['claude'],
      instructions: 'Review',
      changeType: 'committed',
      base: { kind: 'none' },
    });
    expect(effective.map((f: any) => f.path)).not.toContain('base.baseBranch');


    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: { engineIds: ['claude'], instructions: 'Review', changeType: 'committed', base: { kind: 'none' } },
    } as const;

    const screen = await renderDraft(draft);

    const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
    const paintedPaths = screen.tree.findAllByType(HappierInputField).map(node => node.props.field.path);
    expect(paintedPaths).toContain('instructions');
    expect(paintedPaths).not.toContain('base.baseBranch');
    expect(paintedPaths).not.toContain('base.commitSha');
  });

  it('parses text_list input into a string array patch', async () => {
    updateSessionActionDraftInput.mockClear();


    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'session.target.tracked.set',
      createdAt: 1,
      status: 'editing',
      input: {
        sessionIds: [],
      },
    } as const;

    const screen = await renderDraft(draft);

    const inputs = screen.tree.findAllByType('TextInput');
    expect(inputs.length).toBe(1);

    const listInput = inputs[0]!;
    await act(async () => {
      changeTextTestInstance(listInput, 'a.yml, b.yml');
    });

    expect(updateSessionActionDraftInput).toHaveBeenCalledWith(draftScope, draftAddress, 'd1', { sessionIds: ['a.yml', 'b.yml'] });
  });

  /**
   * F-P6 (2026-08-11) — anti-drift guard for `resolveSessionActionDraftHeightBearingPaint`, which is
   * what `transcriptRowShellSignature` keys this row's height on. The descriptor is only trustworthy
   * while it describes THE PAINT, so this asserts the painted text-field values ARE the descriptor's
   * `textBox.text`, in order, for a draft whose conditional field is open.
   *
   * V-1 (2026-08-11) extends it to the part F-P6 got wrong: `textBox.maxLines` must agree with the
   * painted `multiline` prop of the SAME field. A descriptor that claims a box grows when the card
   * paints a one-line field is exactly how the row's size version came to move on every keystroke.
   */
  it('paints exactly the text and the box shape the height-bearing descriptor reports', async () => {
    const { resolveSessionActionDraftHeightBearingPaint } = await import('./sessionActionDraftPresentation');

    const input = {
      engineIds: ['codex'],
      instructions: 'Review\nthis carefully.',
      changeType: 'committed',
      base: { kind: 'branch', baseBranch: 'release/2026-08-11' },
    };
    const draft = { id: 'd1', sessionId: 's1', actionId: 'review.start', createdAt: 1, status: 'editing', input } as const;

    const screen = await renderDraft(draft);

    const paint = resolveSessionActionDraftHeightBearingPaint({
      draft,
      sessionId: 's1',
      resolveFieldOptions: readFieldOptionsResolver(),
    });
    const textBoxes = paint.fields
      .map((entry) => entry.textBox)
      .filter((box): box is NonNullable<typeof box> => box !== null);

    expect(paint.fields.find(entry => entry.field.path === 'instructions')?.textBox)
      .toMatchObject({ text: 'Review\nthis carefully.', maxLines: null });
    expect(paint.fields.find(entry => entry.field.path === 'base.baseBranch')?.textBox)
      .toMatchObject({ text: 'release/2026-08-11', maxLines: 1 });

    const inputs = screen.tree.findAllByType('TextInput');
    expect(inputs.map((node: any) => node.props.value)).toEqual(textBoxes.map((box) => box.text));
    expect(inputs.map((node: any) => (node.props.multiline === true ? null : 1)))
      .toEqual(textBoxes.map((box) => box.maxLines));
  });

  /**
   * F-4 (2026-08-11) — the other half of the same guard, for the input the size key gained last: the
   * option list. `transcriptRowShellSignature` keys an `action-draft` row on
   * `paint.fields[].options`, and that is only trustworthy while it IS the option rows the card
   * paints. A descriptor that reported option VALUES, or dropped a `select` field, or folded the
   * non-height-bearing `disabled` flag into the label would pass every key-level test and be wrong
   * here.
   */
  it('reports exactly the option rows it paints as the descriptor option list', async () => {
    const { resolveSessionActionDraftHeightBearingPaint } = await import('./sessionActionDraftPresentation');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: { engineIds: ['claude'], instructions: 'Review', changeType: 'all', base: { kind: 'none' } },
    } as const;

    const screen = await renderDraft(draft);

    const paint = resolveSessionActionDraftHeightBearingPaint({
      draft,
      sessionId: 's1',
      resolveFieldOptions: readFieldOptionsResolver(),
    });
    const describedOptionLabels = paint.fields.flatMap((entry) => (entry.options ?? []).map((option) => option.label));

    // `HappierSelect` emits every option row through `HappierPressable` with a `checked` state; the
    // card's own Cancel / Start buttons are plain `Pressable`s with no `accessibilityState` at all,
    // which is what separates option rows from the rest of the pressables.
    // A long or multiple choice is one compact field until it is opened; open each, then read its rows.
    const { act } = await import('react-test-renderer');
    for (const trigger of screen.tree.findAllByType('Pressable').filter((node: any) => (node.props?.accessibilityRole ?? node.props?.role) === 'button'
      && /^[^:]+: /.test(String(node.props?.accessibilityLabel ?? '')))) {
      await act(async () => { trigger.props.onPress?.(); });
    }
    const paintedOptionLabels = screen.tree
      .findAllByType('Pressable')
      .filter((node: any) => node.props?.accessibilityState?.checked !== undefined)
      .map((node: any) => node.findAllByType('Text').map((text: any) => text.props.children).join(''));

    expect(paintedOptionLabels.length).toBeGreaterThan(0);
    // The choice field seats rows it cannot offer (a sole required selection) after the others; that moves
    // no row, so the descriptor must report the same rows, not their seating.
    expect([...describedOptionLabels].sort()).toEqual([...paintedOptionLabels].sort());
  });

  /**
   * F-P3 (2026-08-10) — this is the invariant `buildActionDraftPresentationKey` depends on when it
   * leaves `draft.status` OUT of the transcript row's structural key. Status currently reaches only
   * `editable`, `disabled` and `opacity`, none of which moves a box; if that ever stops being true,
   * this test fails first and the key must grow a height-bearing descriptor.
   *
   * The comparison strips exactly the three non-height-bearing channels and keeps everything that
   * can move the card: node structure, text content, and every layout style field.
   */
  it('paints byte-identical in-flow chrome for every draft status', async () => {

    const heightBearingShape = (node: any): any => {
      if (node === null || node === undefined || typeof node === 'boolean') return null;
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(heightBearingShape);

      const style = Array.isArray(node.props?.style)
        ? Object.assign({}, ...node.props.style.filter(Boolean))
        : (node.props?.style ?? null);
      const layoutStyle = style
        ? Object.fromEntries(
          Object.entries(style)
            // `opacity` is the one status-driven style, and it cannot change a layout.
            .filter(([key, value]) => key !== 'opacity' && typeof value !== 'function')
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        )
        : null;

      return {
        type: node.type,
        // `editable` / `disabled` are the other two status-driven props; both are interaction-only.
        multiline: node.props?.multiline ?? null,
        numberOfLines: node.props?.numberOfLines ?? null,
        style: layoutStyle,
        children: (node.children ?? []).map(heightBearingShape),
      };
    };

    const shapeForStatus = async (status: SessionActionDraft['status']) => {
      const draft = {
        id: 'd1',
        sessionId: 's1',
        actionId: 'subagents.delegate.start',
        createdAt: 1,
        status,
        input: { backendTargetKeys: ['agent:claude'], instructions: 'Delegate this.' },
      };
    const screen = await renderDraft(draft);
      return JSON.stringify(heightBearingShape(screen.tree.toJSON()));
    };

    const editing = await shapeForStatus('editing');
    for (const status of ['running', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(await shapeForStatus(status), status).toBe(editing);
    }
  });
});
