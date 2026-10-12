import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, ActionsSettingsV1Schema, createUnavailableRuntimeActionExecutor, FeaturesResponseSchema } from '@happier-dev/protocol';

import * as persistence from '@/persistence';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createBrowserDiagnosticsActionRoutes } from './browser/diagnostics/actionRoutes';
import { createBrowserDiagnosticsDaemonStore } from './browser/diagnostics/store';
import { createBrowserAutomationCdpAdapter, type BrowserAutomationCdpTransport } from './browser/automation/adapters/cdp';
import { createBrowserDaemonControlBroker } from './browser/control/broker';
import { createBrowserAutomationDaemonService } from './browser/automation/service';
import { createBrowserAutomationRoutes } from './browser/automation/routes';
import { createDaemonControlApp } from './controlServer';
import { createDaemonRuntimeActionExecutor, type DaemonRuntimeActionRouteOwners } from './runtimeActionExecutor';
import { createComputerRoutes } from './computer/routes';
import { createMachineLiveStreamCaptureRegistry } from './peer/mediation/stream/captureRegistry';
import { createBrowserDaemonControlRoutes } from './browser/control/routes';
import { createBrowserSidecarCdpControlAdapter } from './browser/sidecar/controlAdapter';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { createCliBrowserRuntimeActionExecutor } from './browser/actions/controlTransport';

afterEach(() => vi.restoreAllMocks());

function createApp(enabled = true, routes: DaemonRuntimeActionRouteOwners = {}, isShuttingDown?: () => boolean) {
  const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_browser' });
  const runtimeActionExecute = createDaemonRuntimeActionExecutor({
    env: {},
    resolveRouteOwners: () => ({ browserDiagnostics: createBrowserDiagnosticsActionRoutes({ store }), ...routes }),
    resolveServerFeaturesSnapshot: () => ({
      status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        browser: { enabled, viewTargets: { enabled }, internal: { enabled }, sidecar: { enabled }, diagnostics: { enabled }, automation: { enabled } },
      } }),
    }),
  });
  return createDaemonControlApp({
    getChildren: () => [], machineId: 'machine_browser',
    stopSession: async () => ({ status: 'not_found' }),
    spawnSession: async () => ({ type: 'success', sessionId: 'session_browser' }),
    requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'browser-control-token',
    ...(isShuttingDown ? { isShuttingDown } : {}),
    ...{ runtimeActionExecute },
  });
}

function physicalBrowserOwner(transport: BrowserAutomationCdpTransport) {
  const broker = createBrowserDaemonControlBroker();
  broker.registerAdapter({ adapterKind: 'chromiumSidecar', ownsView: transport.ownsView,
    supportsOpenView: () => false, dispatchCommand: transport.dispatchControlCommand });
  return { ownsAutomationView: broker.ownsView, uiAutomation: createUnavailableRuntimeActionExecutor() };
}

describe('default browser runtime Action placement', () => {
  it.each(['before_dispatch', 'after_dispatch', 'acknowledged'] as const)('settles Browser transport cancellation at %s without overwriting acknowledged effects', async phase => {
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: 123, httpPort: 12345,
      controlToken: 'browser-control-token', startedAt: 1, startedWithCliVersion: '0.3.0' });
    const cancellation = new AbortController();
    let requestsIssued = 0;
    const acknowledged = BrowserCommandDispatchResultV1Schema.parse({
      v: 1, commandId: 'open-cancellation', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [],
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      requestsIssued += 1;
      cancellation.abort();
      if (phase === 'after_dispatch') throw cancellation.signal.reason;
      return new Response(JSON.stringify({ result: acknowledged }));
    });
    if (phase === 'before_dispatch') cancellation.abort();
    const execute = createCliBrowserRuntimeActionExecutor({ sessionId: 'session_browser' });
    const result = await execute({ actionId: 'browser.view.open', input: {
      kind: 'openView', commandId: 'open-cancellation', browserSessionId: 'session_browser', viewId: 'view',
      platform: 'web', target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' },
    }, context: { signal: cancellation.signal } });
    expect(result).toEqual(phase === 'acknowledged' ? acknowledged : {
      ok: false, errorCode: phase === 'before_dispatch' ? 'cancelled' : 'outcome_unknown',
      error: phase === 'before_dispatch' ? 'cancelled' : 'outcome_unknown',
    });
    expect(requestsIssued).toBe(phase === 'before_dispatch' ? 0 : 1);
  });

  it.each(['takeControl', 'handBack'] as const)('approves agent browser.control.%s through the real Action and authenticated daemon route', async kind => {
    const view = { browserSessionId: 'session_browser', viewId: 'view_browser' };
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar', transport: {
      openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
      dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
    } });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    await broker.dispatchCommand({ ...view, kind: 'openView', commandId: 'open', focus: true, platform: 'web',
      target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' } });
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
      transport: { ownsView: broker.ownsView, dispatchControlCommand: broker.dispatchCommand,
        dispatchPageQuery: async () => ({ ok: true }),
        dispatchInputCommand: async () => ({ ok: true }) },
    }) });
    const control = createBrowserDaemonControlRoutes({ broker, automation: () => service });
    expect(broker.ownsView(view)).toBe(true);
    const app = createApp(true, { browserControl: control,
      browserUiAutomation: { ownsAutomationView: broker.ownsView, uiAutomation: createUnavailableRuntimeActionExecutor() },
    });
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: 123, httpPort: 12345,
      controlToken: 'browser-control-token', startedAt: 1, startedWithCliVersion: '0.3.0' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname,
        headers: options?.headers as Record<string, string>, payload: String(options?.body) });
      return new Response(response.body, { status: response.statusCode });
    });
    let decision: 'approve' | 'reject' = 'reject';
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: view.browserSessionId, mode: 'plain', ctx: null }, {
      approvalsCreate: async () => ({ artifactId: 'approval' }),
      approvalsGet: async () => null,
      approvalsWaitForDecision: async ({ request }) => ({ decision, request }),
      approvalsUpdate: async () => ({ ok: true }), isApprovalExecutionOriginCurrent: async () => true,
    });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      defaultSessionId: view.browserSessionId, defaultSessionMachineId: 'machine_browser', serverId: 'home', actionRequestId: 'controller-request',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
    try {
      expect(await control.dispatchCommand({ ...view, kind, commandId: 'unapproved' }, { authority: 'account_automation' }))
        .toMatchObject({ status: 'failed', error: { code: 'permission_denied' } });
      if (kind === 'handBack') await control.dispatchCommand({ ...view, kind: 'takeControl', commandId: 'take' }, { authority: 'present_user' });
      const before = service.getStatus(view).controller;
      const rejected = await harness.executor.execute(`browser.control.${kind}`, { ...view, kind, commandId: 'controller' }, context);
      expect(rejected, !rejected.ok ? JSON.stringify({ errorCode: rejected.errorCode, error: rejected.error }) : undefined)
        .toMatchObject({ ok: false, errorCode: 'approval_rejected' });
      expect(service.getStatus(view).controller).toBe(before);
      decision = 'approve';
      const approved = await harness.executor.execute(`browser.control.${kind}`, { ...view, kind, commandId: 'controller' }, context);
      expect(approved, !approved.ok ? JSON.stringify({ errorCode: approved.errorCode, error: approved.error }) : undefined)
        .toMatchObject({ ok: true, result: { status: 'dispatched' } });
      expect(service.getStatus(view).controller).toBe(kind === 'takeControl' ? 'human' : 'none');
      if (kind === 'handBack') {
        const request = { ...view, v: 1 as const, automationRequestId: 'next', navigationGeneration: 0,
          requestedBy: 'agent' as const, requesterRef: { kind: 'agent', id: 'agent' }, timeoutMs: 5000,
          actionKind: 'click' as const, payload: { selector: '#go' } };
        expect(await service.execute(request)).toMatchObject({ errorCode: 'stale_navigation' });
        await service.execute({ ...request, actionKind: 'snapshot', payload: {} });
        expect(await service.execute(request)).toMatchObject({ status: 'succeeded' });
      }
      expect(await harness.executor.execute(`browser.control.${kind}`, { ...view, kind, commandId: 'waived' }, {
        ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
          approvalWaivedSurfaces: { [`browser.control.${kind}`]: ['agent'] } }),
      })).toMatchObject({ ok: true, result: { status: 'dispatched' } });
    } finally { await app.close(); service.dispose(); adapter.dispose(); }
  });

  it('reaches the selected computer owner from the Session harness without disclosing window enumeration', async () => {
    const computer = createComputerRoutes({ machineId: 'machine_browser', machineDisplayName: 'Workstation', registry: createMachineLiveStreamCaptureRegistry() });
    const app = createApp(true, { computer });
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: 123, httpPort: 12345,
      controlToken: 'browser-control-token', startedAt: 1, startedWithCliVersion: '0.3.0' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname,
        headers: options?.headers as Record<string, string>, payload: String(options?.body) });
      return new Response(response.body, { status: response.statusCode });
    });
    const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'session_browser', mode: 'plain', ctx: null });
    try {
      expect(await harness.executor.execute('computer.target.get', { machineId: 'machine_browser' },
        { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session_browser' }))
        .toMatchObject({ ok: true, result: { consentGranted: false,
          approvalDisplay: { machineDisplayName: 'Workstation', requiresTargetSelection: true } } });
    } finally { await app.close(); await computer.dispose(); }
  });
  it.each(['harness', 'MCP'] as const)('reaches the daemon diagnostics owner through the real %s and authenticated control transport', async (entrypoint) => {
    const app = createApp();
    // The filesystem state and HTTP fetch are system boundaries; the harness, daemon executor,
    // feature decisions, route validation and diagnostics owner all run unchanged.
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({
      pid: 123, httpPort: 12345, controlToken: 'browser-control-token',
      startedAt: 1, startedWithCliVersion: '0.3.0',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const response = await app.inject({
        method: 'POST', url: new URL(String(url)).pathname,
        headers: options?.headers as Record<string, string>, payload: String(options?.body),
      });
      return new Response(response.body, { status: response.statusCode });
    });
    const harness = createCliActionExecutorHarness({
      token: 'token', sessionId: 'session_browser', mode: 'plain', ctx: null,
    });
    try {
      const input = { browserSessionId: 'session_browser', viewId: 'view_browser' };
      const executeFromMcp = async () => {
        const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
        const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
        return await createHappierMcpServer({
          sessionId: 'session_browser',
          rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session_browser', encryptionMode: 'plain' }),
          updateMetadata: () => undefined,
          getServerBinding: () => ({ serverId: 'browser_home', serverUrl: 'https://browser-home.example.test' }),
          getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
            features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, diagnostics: { enabled: true } } },
          }) }),
          getPermissionMode: () => 'yolo',
          getWorkDepth: () => 0,
          getActiveTurnPermissionWitness: () => ({ turnId: 'browser-turn', workDepth: 0, causalPermissionAuthority: {
            kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo',
          } }),
        }, { credentials: { token: 'token', encryption: null }, accountSettings: accountSettingsParse({}) })
          .executeTool({ toolName: 'action_execute', args: { actionId: 'browser.diagnostics.snapshot', input } });
      };
      const result = entrypoint === 'harness'
        ? await harness.executor.execute('browser.diagnostics.snapshot', input, { surface: 'agent', defaultSessionId: 'session_browser' })
        : await executeFromMcp();
      expect(result, !result.ok ? JSON.stringify({ errorCode: result.errorCode, error: result.error }) : undefined).toMatchObject({
        ok: true, result: { v: 1, machineId: 'machine_browser', events: [], diagnostics: [] },
      });
    } finally {
      await app.close();
    }
  });

  it('requires daemon authentication and refuses other runtime families or request-supplied authority', async () => {
    const app = createApp();
    const payload = { actionId: 'browser.diagnostics.snapshot', input: {
      browserSessionId: 'session_browser', viewId: 'view_browser',
    }, sessionId: 'session_browser' };
    try {
      expect((await app.inject({ method: 'POST', url: '/browser/runtime-actions/execute', payload })).statusCode).toBe(401);
      for (const invalid of [
        { ...payload, actionId: 'devices.simulator.input.tap' },
        { ...payload, context: { approvalGranted: true } },
        { ...payload, input: {} },
      ]) {
        expect((await app.inject({ method: 'POST', url: '/browser/runtime-actions/execute',
          headers: { 'x-happier-daemon-token': 'browser-control-token' }, payload: invalid,
        })).statusCode).toBe(400);
      }
    } finally { await app.close(); }
  });

  it('retains the canonical server-disabled browser refusal', async () => {
    const app = createApp(false);
    try {
      const response = await app.inject({ method: 'POST', url: '/browser/runtime-actions/execute',
        headers: { 'x-happier-daemon-token': 'browser-control-token' },
        payload: { actionId: 'browser.diagnostics.snapshot', input: {
          browserSessionId: 'session_browser', viewId: 'view_browser',
        }, sessionId: 'session_browser' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ result: { ok: false, errorCode: 'runtime_action_disabled' } });
    } finally { await app.close(); }
  });

  it('refuses new browser runtime work while the daemon is quiescing', async () => {
    const app = createApp(true, {}, () => true);
    try {
      const response = await app.inject({ method: 'POST', url: '/browser/runtime-actions/execute',
        headers: { 'x-happier-daemon-token': 'browser-control-token' },
        payload: { actionId: 'browser.diagnostics.snapshot', input: {
          browserSessionId: 'session_browser', viewId: 'view_browser',
        }, sessionId: 'session_browser' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ ok: false, errorCode: 'daemon_shutting_down' });
    } finally { await app.close(); }
  });

  it('finishes an ordinary authenticated HTTP request without treating the completed body as cancellation', async () => {
    const app = createApp();
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${origin}/browser/runtime-actions/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-happier-daemon-token': 'browser-control-token' },
        body: JSON.stringify({ actionId: 'browser.diagnostics.snapshot', input: {
          browserSessionId: 'session_browser', viewId: 'view_browser',
        }, sessionId: 'session_browser' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { v: 1, machineId: 'machine_browser', events: [], diagnostics: [] },
      });
    } finally { await app.close(); }
  });

  it('does not let an agent claim present-user control through browser request input after human takeover', async () => {
    let navigated = false;
    const transport: BrowserAutomationCdpTransport = {
        ownsView: () => true,
        dispatchControlCommand: async (command) => {
          navigated = true;
          return { v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] };
        },
        dispatchPageQuery: async () => ({ ok: true }),
    };
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport }) });
    const app = createApp(true, { browserAutomation: createBrowserAutomationRoutes({ service }),
      browserUiAutomation: physicalBrowserOwner(transport) });
    const view = { browserSessionId: 'session_browser', viewId: 'view_browser' };
    try {
      await service.recordHumanInput({ ...view, authority: 'present_user' });
      expect(service.getStatus(view).controller).toBe('human');
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({
        pid: 123, httpPort: Number(new URL(origin).port), controlToken: 'browser-control-token',
        startedAt: 1, startedWithCliVersion: '0.3.0',
      });
      const harness = createCliActionExecutorHarness({ token: 'token', sessionId: 'session_browser', mode: 'plain', ctx: null });
      const result = await harness.executor.execute('browser.automation.navigate', {
        v: 1, automationRequestId: 'forged-user-navigation', ...view, navigationGeneration: 0,
        requestedBy: 'user', requesterRef: { kind: 'user', id: 'claimed-user' },
        actionKind: 'navigate', payload: { url: 'https://example.test/claimed-user' }, timeoutMs: 30_000,
      }, { surface: 'agent', callerPermissionMode: 'yolo', bypassApprovals: true, defaultSessionId: 'session_browser' });
      expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      // A truthful agent label reaches the incumbent controller, which still refuses takeover.
      expect(await harness.executor.execute('browser.automation.navigate', {
        v: 1, automationRequestId: 'agent-navigation', ...view, navigationGeneration: 0,
        requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'test-agent' },
        actionKind: 'navigate', payload: { url: 'https://example.test/agent' }, timeoutMs: 30_000,
      }, { surface: 'agent', callerPermissionMode: 'yolo', bypassApprovals: true, defaultSessionId: 'session_browser' }))
        .toMatchObject({ ok: true, result: { status: 'failed', errorCode: 'human_interrupted' } });
      expect(navigated).toBe(false);
      expect(service.getStatus(view).controller).toBe('human');
    } finally {
      service.dispose();
      await app.close();
    }
  });

  it('forwards an actual HTTP disconnect through the canonical automation service to the CDP boundary', async () => {
    let enter: (signal: AbortSignal) => void = () => undefined;
    let releaseQuery: () => void = () => undefined;
    const entered = new Promise<AbortSignal>((resolve) => { enter = resolve; });
    // Only Chromium's network boundary is substituted. The HTTP lifetime, canonical executor,
    // browser routes, single-flight service, action execution and CDP adapter are real.
    const transport: BrowserAutomationCdpTransport = {
        ownsView: () => true,
        dispatchControlCommand: async () => ({ v: 1, commandId: 'unused', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] }),
        dispatchPageQuery: async ({ signal }) => {
          if (!signal) throw new Error('CDP boundary missing containing signal');
          enter(signal);
          await new Promise<void>((resolve) => {
            releaseQuery = resolve;
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: false, errorCode: 'user_canceled' };
        },
    };
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport }) });
    const app = createApp(true, { browserAutomation: createBrowserAutomationRoutes({ service }),
      browserUiAutomation: physicalBrowserOwner(transport) });
    const controller = new AbortController();
    const view = { browserSessionId: 'session_browser', viewId: 'view_browser' };
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const pending = fetch(`${origin}/browser/runtime-actions/execute`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-happier-daemon-token': 'browser-control-token' },
        body: JSON.stringify({ actionId: 'browser.automation.snapshot', sessionId: 'session_browser', input: {
          v: 1, automationRequestId: 'disconnected-snapshot', ...view, navigationGeneration: 0,
          requestedBy: 'agent', requesterRef: { kind: 'agent', id: 'test-agent' },
          actionKind: 'snapshot', payload: {}, timeoutMs: 30_000,
        } }),
      }).catch((error: unknown) => error);
      const boundarySignal = await Promise.race([entered, pending.then(() => {
        throw new Error('HTTP request ended before reaching the CDP boundary');
      })]);
      expect(boundarySignal.aborted).toBe(false);
      controller.abort();
      await pending;
      await vi.waitFor(() => {
        expect(boundarySignal.aborted).toBe(true);
        expect(service.getTimeline(view).entries).toMatchObject([
          { automationRequestId: 'disconnected-snapshot', status: 'canceled' },
        ]);
      });
    } finally {
      controller.abort();
      releaseQuery();
      service.dispose();
      await app.close();
    }
  });

  it('settles a managed Browser open when its actual HTTP caller disconnects', async () => {
    let enter: (signal: AbortSignal | undefined) => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<AbortSignal | undefined>(resolve => { enter = resolve; });
    const adapter = createBrowserSidecarCdpControlAdapter({
      browserSessionId: 'session_browser', sidecarId: 'sidecar', transport: {
        // Chromium is the external boundary. Keep the route, broker, adapter and strict result real.
        openPage: async ({ signal }) => {
          enter(signal);
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return { targetId: 'page' };
        },
        dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
      },
    });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    const control = createBrowserDaemonControlRoutes({ broker });
    let ownerResult: unknown;
    const app = createApp(true, { browserControl: { ...control, dispatchCommand: async (command, context) => {
      ownerResult = await control.dispatchCommand(command, context);
      return BrowserCommandDispatchResultV1Schema.parse(ownerResult);
    } } });
    const controller = new AbortController();
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const pending = fetch(`${origin}/browser/runtime-actions/execute`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-happier-daemon-token': 'browser-control-token' },
        body: JSON.stringify({ actionId: 'browser.view.open', sessionId: 'session_browser', input: {
          kind: 'openView', commandId: 'cancel-open', browserSessionId: 'session_browser', viewId: 'view_browser',
          platform: 'web', target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' },
        } }),
      }).catch((error: unknown) => error);
      const boundarySignal = await Promise.race([entered, pending.then(async (result) => {
        const detail = result instanceof Response ? await result.text() : String(result);
        throw new Error(`Browser HTTP request ended before reaching Chromium: ${detail}`);
      })]);
      expect(boundarySignal).toBeDefined();
      controller.abort();
      await pending;
      await vi.waitFor(() => expect(ownerResult).toMatchObject({
        commandId: 'cancel-open', status: 'failed', completion: 'unknown',
      }));
      expect(broker.listViews('session_browser')).toEqual([]);
    } finally {
      controller.abort(); release(); adapter.dispose(); await app.close();
    }
  });
});
