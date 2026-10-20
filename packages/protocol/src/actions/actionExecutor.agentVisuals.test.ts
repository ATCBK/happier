import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from './actionExecutor.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { normalizeUiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { SessionBoardAuthoredItemUpsertInputV1Schema } from '../sessions/board/actions.js';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '../sessions/board/item.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';
import { describeApprovalRequestFields } from './actionApprovalPresentation.js';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const note: SessionSurfaceItemV1 = { v: 1, title: 'Result', frame: 'frameless',
  height: { mode: 'auto', fallback: 'regular' },
  source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Result' } } } };
const html = (request: unknown) => ({ ...note, source: { kind: 'hostedHtml',
  source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPlJlc3VsdDwvaDE+' } } },
  requestedCapabilities: request } });
const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home',
  defaultSessionId: 'session', defaultSessionMachineId: 'machine', runtimeAccountId: 'account', actionRequestId: 'show',
  actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 } };

function harness(initialSetting: unknown = 'allowed', extraDeps: Partial<ActionExecutorDeps> = {}) {
  let setting = initialSetting;
  let stored: { item: SessionSurfaceItemV1; revision: string; creator: unknown } | null = null;
  let approval: ApprovalRequest | null = null;
  let executor: ReturnType<typeof createActionExecutor>;
  const deps: Partial<ActionExecutorDeps> = {
    // Exact Account settings and sealed Session record transports are boundaries;
    // parsing, consequences, preparation and approval replay stay real.
    readAgentHtmlNetworkPolicy: async () => setting,
    sessionBoardAction: async ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['sessionBoardAction']>>[0]) => {
      if (actionId === 'session.board.get') return { v: 1, serverId: 'home', sessionId: 'session',
        capabilities: { readTranscript: true, editSessionRecords: true }, layout: null,
        items: stored ? [{ itemId: 'visual', ...stored, title: stored.item.title, sourceKind: stored.item.source.kind }] : [],
        incomplete: false, page: { cursor: null, hasNext: false } };
      const request = SessionBoardAuthoredItemUpsertInputV1Schema.parse(input);
      stored = { item: SessionSurfaceItemV1Schema.parse(request.item), revision,
        creator: stored?.creator ?? { kind: 'session', sessionId: 'session' } };
      return { v: 1, serverId: 'home', sessionId: 'session', itemDestination: 'transcript', destination: null,
        result: { operation: 'upsert_item', itemId: 'visual', outcome: request.expectedItemRevision ? 'updated' : 'created', itemRevision: revision } };
    },
    approvalsCreate: async ({ request }: { request: ApprovalRequest }) => { approval = request; return { artifactId: 'approval' }; },
    approvalsGet: async () => approval,
    approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => { approval = request; return { ok: true }; },
    isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home'
      && origin.machineId === 'machine' && origin.sessionId === 'session',
    // The app's replay transport reaches the exact originating daemon, whose
    // real executor consumes only the already-approved Artifact.
    approvalRequestApprovedReplay: async ({ artifactId, request, context, signal }) => {
      expect(request.status).toBe('approved');
      expect(approval).toEqual(request);
      return executor.replayApprovedApprovalRequest({ artifactId, ...(signal ? { signal } : {}), callerAuthority: context.authority ?? 'account_automation' });
    },
    ...extraDeps,
  };
  executor = createActionExecutor(deps);
  return { executor, get stored() { return stored; }, get approval() { return approval; },
    setSetting(value: unknown) { setting = value; },
    setStored(value: typeof stored) { stored = value; },
    show(item: unknown, expectedItemRevision: string | null = null, ctx = context) {
      return executor.execute('session.board.item.upsert', { itemId: 'visual', expectedItemRevision, item }, ctx);
    },
    decide(decision: 'approve' | 'reject') { return executor.execute('approval.request.decide', { artifactId: 'approval', decision },
      { surface: 'ui', authority: 'present_user', serverId: 'home' }); },
  };
}

describe('agent visuals through canonical Action admission', () => {
  it('applies reversible present-user visual content directly but confirms outward network effects', async () => {
    const ui = { ...context, surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const host = harness();
    expect(await host.show(note, null, ui)).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(host.approval).toBeNull();
    expect(await host.show({ ...note, title: 'Updated' }, revision, ui))
      .toMatchObject({ ok: true, result: { result: { outcome: 'updated' } } });
    expect(host.approval).toBeNull();
    expect(await host.show(html({ network: 'open' }), revision, ui))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const ask = harness();
    expect(await ask.show(note, null, { ...ui, actionsSettings: normalizeActionsSettingsV1({ v: 1,
      actions: { 'session.board.item.upsert': { approvalRequiredSurfaces: ['ui'] } },
    }) })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  });
  it.each(['hostedHtml', 'inlineHtmlWidget'] as const)('refuses unrenderable %s before asking for approval', async kind => {
    const host = harness('ask');
    const source = { v: 1, entrypoint: 'index.html', files: {
      'index.html': { mime: 'text/html', contentBase64: Buffer.from('<script src="missing.js"></script>').toString('base64') },
    } };
    const content = kind === 'hostedHtml' ? { ...note, source: { kind, source, requestedCapabilities: { network: 'open' } } }
      : { ...note, source: { kind: 'widget', instance: { v: 1, id: 'visual', bindings: {}, definition: { kind: 'inline', definition: {
        v: 1, id: 'definition', name: 'HTML', body: { kind: 'html', source, requestedCapabilities: { network: 'open' } },
        inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, provenance: { source: { kind: 'authored' } },
      } } } } };
    expect(await host.show(content)).toMatchObject({ ok: false, errorCode: 'invalid_parameters',
      details: { reason: 'source_invalid' } });
    expect(host.approval).toBeNull();
    expect(host.stored).toBeNull();
  });
  it('uses the Account default for absent data, asks for malformed data, and preserves host admission', async () => {
    const defaultHost = harness(); defaultHost.setSetting(undefined);
    expect(await defaultHost.show(html({ network: 'open' }))).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(await harness('invalid').show(html({ network: 'open' }))).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await harness().show(note, null, { ...context, bypassApprovals: true })).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
  });
  it.each(['allowed', 'ask', 'off'] as const)('%s admits none, exact and open at creation with the stored effect', async setting => {
    for (const request of [{}, { networkOrigins: ['https://cdn.example.com'] }, { network: 'open' }]) {
      const host = harness(setting);
      const declared = normalizeUiSurfaceCapabilityRequestV1(request)!;
      const networkRequested = declared.networkOrigins.length > 0 || 'network' in request && request.network === 'open';
      const result = await host.show(html(request));
      if (setting === 'ask' && networkRequested) {
        expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({
          title: 'Network', value: declared.network === 'open' ? 'Any site' : `Only ${declared.networkOrigins.join(', ')}`,
        }));
        expect(host.stored).toBeNull();
        expect(await host.decide('approve')).toMatchObject({ ok: true });
        expect(host.approval?.execution).toEqual(expect.objectContaining({ ok: true }));
      } else expect(result).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
      expect(host.stored?.item.source.kind).toBe('hostedHtml');
      const source = host.stored?.item.source;
      expect(source?.kind === 'hostedHtml' && normalizeUiSurfaceCapabilityRequestV1(source.requestedCapabilities))
        .toMatchObject(setting === 'off' ? { networkOrigins: [], network: 'none' } : declared);
      if (setting === 'off' && networkRequested) expect(result).toMatchObject({ result: {
        effectiveNetwork: { network: 'none', networkOrigins: [] }, notices: [{ code: 'agent_html_network_off' }] } });
    }
  });

  it.each(['host_action', 'stricter_policy'] as const)('describes the admitted off-policy consequence for %s approval and rejects a changed setting', async reason => {
    const item = html({ network: 'open', ...(reason === 'host_action'
      ? { actions: ['session.board.get'], hostMethods: ['executeAction'] } : {}) });
    const approvalContext = reason === 'stricter_policy' ? { ...context,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
        'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] },
      } }),
    } : context;
    const host = harness('off');
    expect(await host.show(item, null, approvalContext)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(host.approval?.actionArgs).toMatchObject({ reviewedVisual: { networkSetting: 'off' },
      item: { source: { requestedCapabilities: { network: 'open' } } } });
    expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({
      title: 'Network', value: 'No network access',
    }));
    expect(await host.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed', execution: {
      ok: true, result: { effectiveNetwork: { network: 'none', networkOrigins: [] }, notices: [{ code: 'agent_html_network_off' }] },
    } } });
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'none', networkOrigins: [] } });

    const stale = harness('off');
    await stale.show(item, null, approvalContext);
    stale.setSetting('allowed');
    expect(await stale.decide('approve')).toMatchObject({ ok: true, result: {
      status: 'failed', execution: { ok: false, errorCode: 'approval_stale' },
    } });
    expect(stale.stored).toBeNull();
  });

  it('admits own Session notes, resumed own-created updates, and respects stricter user policy', async () => {
    const host = harness();
    expect(await host.show(note)).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(await host.show({ ...note, title: 'Updated' }, revision, { ...context, actionRequestId: 'resumed' })).toMatchObject({ ok: true, result: { result: { outcome: 'updated' } } });
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: { 'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] } } });
    expect(await host.show(note, revision, { ...context, actionsSettings })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  });

  it.each([{ kind: 'user' }, { kind: 'plugin' }, { kind: 'unknown' }, undefined, { kind: 'session', sessionId: 'foreign' }])(
    'asks for an edit with creator %j', async creator => {
      const host = harness(); host.setStored({ item: note, revision, creator });
      expect(await host.show(note, revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    });

  it('asks for any existing network change and host Actions, while rejection leaves content untouched', async () => {
    const host = harness(); await host.show(html({}));
    expect(await host.show(html({ network: 'open' }), revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({ title: 'Network', value: 'Any site' }));
    await host.decide('reject');
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'none' } });
    const actionHost = harness();
    expect(await actionHost.show(html({ actions: ['session.board.get'], hostMethods: ['executeAction'] })))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  });

  it('asks by default for changed network and honors an explicit generic Action waiver', async () => {
    const host = harness();
    await host.show(html({ network: 'none' }));
    host.setSetting('off');
    expect(await host.show(html({ network: 'open' }), revision))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({ title: 'Network', value: 'Any site' }));
    await host.decide('reject');
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'none' } });
    const actionsSettings = normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'session.board.item.upsert': ['agent'] } });
    expect(await host.show(html({ network: 'open' }), revision, { ...context, actionsSettings }))
      .toMatchObject({ ok: true, result: { result: { outcome: 'updated' }, effectiveNetwork: { network: 'open' } } });
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'open' } });
  });

  it.each(['installed', 'inline'] as const)('retains %s renderer admission and asks before switching an existing explicit override to inheritance', async kind => {
    const surface = { pluginId: 'acme.visuals', localId: 'report' };
    const installed = SessionSurfaceItemV1Schema.parse({ ...note, source: { kind: 'widget', instance: {
      v: 1, id: 'visual', definition: kind === 'installed' ? { kind, surface } : { kind, definition: {
        v: 1, id: 'definition', name: 'Report', body: { kind: 'installed', surface },
        inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, provenance: { source: { kind: 'authored' } },
      } }, bindings: {},
    } } });
    const host = harness('allowed', {
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      // Installed plugin descriptor and viewer selection are host boundaries;
      // the real widget input resolver and Action admission remain in use.
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async () => ({ inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false } }), readContext: async () => ({}),
        readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    const created = await host.show(installed);
    expect(created).toMatchObject({ ok: true, result: { result: { outcome: 'created' } } });
    expect(host.stored?.item.source).toEqual(installed.source);
    expect(created.ok && created.result).not.toHaveProperty('effectiveNetwork');
    const explicitNone = SessionSurfaceItemV1Schema.parse({ ...installed, source: { ...installed.source,
      instance: { ...(installed.source.kind === 'widget' ? installed.source.instance : {}), networkOverride: { network: 'none' } } } });
    expect(await host.show(explicitNone, revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    await host.decide('approve');
    expect(host.stored?.item.source).toMatchObject({ instance: { networkOverride: { network: 'none' } } });
    expect(await host.show(installed, revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    await host.decide('reject');
    expect(host.stored?.item.source).toMatchObject({ instance: { networkOverride: { network: 'none' } } });
  });

  it('does not trust caller-authored attribution or omit caller proof', async () => {
    const host = harness();
    expect(await host.show({ ...note, creator: { kind: 'session', sessionId: 'session' } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(host.stored).toBeNull();
    expect(await host.show(note, null, { ...context, actionCaller: undefined }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(host.stored).toBeNull();
  });

  it('admits a promoted inline HTML copy with its stored network choice and asks before changing it', async () => {
    const bundle = html({}).source.source;
    const definition = { v: 1, id: 'saved', name: 'Saved HTML', body: { kind: 'html', source: bundle,
      requestedCapabilities: { network: 'open' } }, networkOverride: { network: 'none' }, inputs: { fields: [] },
      inputSchema: { type: 'object', additionalProperties: false }, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      provenance: { source: { kind: 'authored' } } };
    const item = { ...note, source: { kind: 'widget', instance: { v: 1, id: 'visual',
      definition: { kind: 'inline', definition }, bindings: {} } } };
    const host = harness('allowed', {
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async request => request.instance.definition.kind === 'inline'
        ? request.instance.definition.definition : null,
        readContext: async () => ({}), readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [] }),
    });
    expect(await host.show(item)).toMatchObject({ ok: true, result: { effectiveNetwork: { network: 'none' } } });
    expect(host.stored?.item.source).toMatchObject({ instance: { networkOverride: { network: 'none' } } });
    expect(await host.show({ ...item, source: { ...item.source, instance: { ...item.source.instance,
      networkOverride: { network: 'open' } } } }, revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  });

  it('binds installed inheritance to the reviewed policy even when normalized origins remain empty', async () => {
    const installed = SessionSurfaceItemV1Schema.parse({ ...note, source: { kind: 'widget', instance: {
      v: 1, id: 'visual', definition: { kind: 'installed', surface: { pluginId: 'acme.visuals', localId: 'report' } }, bindings: {},
    } } });
    const explicitNone = SessionSurfaceItemV1Schema.parse({ ...installed, source: { ...installed.source,
      instance: { ...(installed.source.kind === 'widget' ? installed.source.instance : {}), networkOverride: { network: 'none' } } } });
    const host = harness();
    const creator = { kind: 'session', sessionId: 'session' };
    host.setStored({ item: explicitNone, revision, creator });
    expect(await host.show(installed, revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    host.setStored({ item: installed, revision, creator });
    expect(await host.decide('approve')).toMatchObject({ ok: true, result: {
      status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
    expect(host.stored?.item).toEqual(installed);
  });

  it('preserves existing effective egress when the Account default changes and asks even to narrow it', async () => {
    const host = harness(); await host.show(html({ network: 'open' })); host.setSetting('off');
    expect(await host.show({ ...html({ network: 'open' }), title: 'Continued' }, revision))
      .toMatchObject({ ok: true, result: { result: { outcome: 'updated' }, effectiveNetwork: { network: 'open' } } });
    expect(await host.show(html({ network: 'none' }), revision)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(describeApprovalRequestFields(host.approval!).rows).toContainEqual(expect.objectContaining({ title: 'Network', value: 'No network access' }));
    await host.decide('reject');
    expect(host.stored?.item.source).toMatchObject({ requestedCapabilities: { network: 'open' } });
  });

  it('fails closed with a typed result when the exact Account policy cannot be read', async () => {
    let mutationRan = false;
    const executor = createActionExecutor({ readAgentHtmlNetworkPolicy: async () => { throw new Error('ACCOUNT_TRANSPORT_PRIVATE'); },
      sessionBoardAction: async () => { mutationRan = true; return { ok: false, errorCode: 'session_board_invalid', error: 'session_board_invalid' }; } });
    const result = await executor.execute('session.board.item.upsert', { itemId: 'visual', expectedItemRevision: null,
      item: html({ network: 'open' }) }, context);
    expect(result).toEqual({ ok: false, errorCode: 'action_failed', error: 'action_failed' });
    expect(mutationRan).toBe(false);
  });

  it('does not write after cancellation while reading admission policy', async () => {
    const controller = new AbortController();
    let mutationRan = false;
    const executor = createActionExecutor({ readAgentHtmlNetworkPolicy: async () => { controller.abort(); return 'allowed'; },
      sessionBoardAction: async () => { mutationRan = true; return { v: 1, serverId: 'home', sessionId: 'session',
        itemDestination: 'transcript', destination: null,
        result: { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision } }; } });
    expect(await executor.execute('session.board.item.upsert', { itemId: 'visual', expectedItemRevision: null,
      item: html({ network: 'open' }) }, { ...context, signal: controller.signal }))
      .toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(mutationRan).toBe(false);
  });

  it('rechecks Account preference and current record after preparation before writing', async () => {
    const host = harness();
    const prepared = await host.executor.prepare('session.board.item.upsert', { itemId: 'visual', expectedItemRevision: null, item: html({ network: 'open' }) }, context);
    expect(prepared.kind).toBe('ready'); host.setSetting('off');
    if (prepared.kind === 'ready') expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(host.stored).toBeNull();
    const pending = harness('ask'); await pending.show(html({ network: 'open' })); pending.setSetting('allowed');
    await pending.decide('approve'); expect(pending.stored).toBeNull();
  });

  it.each(['revision', 'source', 'policy', 'creator'] as const)('refuses a pending update after its stored %s changes', async change => {
    const host = harness(); await host.show(html({}));
    await host.show(html({ network: 'open' }), revision);
    const current = host.stored!;
    host.setStored({ ...current,
      ...(change === 'revision' ? { revision: 'ssr1.AAAACHN5c3JlY18xAAAAAg' } : {}),
      ...(change === 'creator' ? { creator: { kind: 'user' } } : {}),
      ...(change === 'source' ? { item: SessionSurfaceItemV1Schema.parse({ ...current.item, source: {
        kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgyPkNoYW5nZWQ8L2gyPg==' } } }, requestedCapabilities: {} } }) } : {}),
      ...(change === 'policy' ? { item: SessionSurfaceItemV1Schema.parse(html({ networkOrigins: ['https://other.example.com'] })) } : {}),
    });
    const changed = host.stored;
    expect(await host.decide('approve')).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
    expect(host.stored).toEqual(changed);
  });
});
