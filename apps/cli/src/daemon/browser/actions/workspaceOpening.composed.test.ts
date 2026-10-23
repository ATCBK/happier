import { describe, expect, it } from 'vitest';
import { createActionExecutor, FeaturesResponseSchema, type ActionExecutorDeps, type ApprovalRequest } from '@happier-dev/protocol';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserSidecarCdpControlAdapter } from '../sidecar/controlAdapter';
import { createBrowserDaemonFeatureGate } from '../featureGate';
import { createBrowserDaemonRuntimeActionExecutor } from './runtimeActionExecutor';

describe('Browser opening through Action approval and daemon dispatch', () => {
  it('records a workspace-owned preview refusal as failed, while opening an external page without a UI pane', async () => {
    const opened: string[] = [];
    // CDP is the external browser boundary. Admission, approval, routing, target
    // selection, view ownership and result projection all use production owners.
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'session', sidecarId: 'sidecar',
      transport: {
        openPage: async ({ url }) => { opened.push(url); return { targetId: 'page', sessionId: 'cdp' }; },
        dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
      } });
    const broker = createBrowserDaemonControlBroker();
    const unregister = broker.registerAdapter(adapter);
    // The Home feature snapshot is a network-boundary fixture; gate decisions stay real.
    const features = FeaturesResponseSchema.parse({ features: { browser: { enabled: true,
      viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } } } });
    const featureGate = createBrowserDaemonFeatureGate({ env: { NODE_ENV: 'test' },
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
    await featureGate.refresh();
    const runtimeActionExecute = createBrowserDaemonRuntimeActionExecutor({
      control: createBrowserDaemonControlRoutes({ broker }),
      featureGate,
    });
    let stored: ApprovalRequest | null = null;
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected host boundary'); };
    const deps = {
      executionRunStart: unexpected, executionRunList: unexpected, executionRunGet: unexpected,
      detachedExecutionRunSend: unexpected, executionRunStop: unexpected, executionRunAction: unexpected,
      executionRunWait: unexpected, sessionOpen: unexpected, sessionFork: unexpected, sessionRollback: unexpected,
      sessionSpawnNew: unexpected, pathsListRecent: unexpected, machinesList: unexpected, serversList: unexpected,
      reviewEnginesList: unexpected, agentsBackendsList: unexpected, agentsModelsList: unexpected,
      sessionSendMessage: unexpected, sessionModeSet: unexpected, sessionModesList: unexpected,
      sessionList: unexpected, sessionActivityGet: unexpected, sessionRecentMessagesGet: unexpected,
      resetGlobalVoiceAgent: unexpected, daemonMemorySearch: unexpected, daemonMemoryGetWindow: unexpected,
      daemonMemoryEnsureUpToDate: unexpected, runtimeActionExecute,
      // Account-private Artifact persistence and the human decision are system boundaries.
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'browser-approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'approve', decisionAuthority: 'present_user', request }),
      isApprovalExecutionOriginCurrent: async () => true,
    } satisfies ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const context = { serverId: 'home', runtimeAccountId: 'account', defaultSessionId: 'session',
      actionRequestId: 'browser-open-request',
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      externalActionTarget: { kind: 'machine', machineId: 'machine' } } as const;
    const command = { kind: 'openView', commandId: 'preview-open', browserSessionId: 'session', viewId: 'view', platform: 'web',
      target: { kind: 'localServicePreview', targetId: 'preview', sessionId: 'session', machineId: 'machine' } } as const;
    try {
      expect(await executor.execute('browser.view.open', command, context)).toMatchObject({ ok: false,
        errorCode: 'adapter_unavailable', error: expect.stringContaining('browser.workspace.open'),
        details: { commandId: command.commandId, status: 'failed', completion: 'known' } });
      expect(stored).toMatchObject({ status: 'failed', execution: { ok: false, errorCode: 'adapter_unavailable' } });
      expect(broker.listViews?.('session')).toEqual([]);
      expect(opened).toEqual([]);
      const external = { ...command, commandId: 'external-open', target: { kind: 'externalUrl', targetId: 'external',
        url: 'https://browser.example.test/' } } as const;
      expect(await executor.execute('browser.view.open', external, context)).toMatchObject({ ok: true,
        result: { commandId: external.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar' } });
      expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
      expect(opened).toEqual([external.target.url]);
      expect(broker.listViews?.('session')).toMatchObject([{ browserSessionId: 'session', viewId: 'view' }]);
    } finally { unregister(); adapter.dispose(); }
  });
});
