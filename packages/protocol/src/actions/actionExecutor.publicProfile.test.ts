import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { bindHomeDomainActionHttpRequestV1, bindPublicProfilePreparedHttpRequestV1 } from './homeDomainActionFamily.js';
import { bindPublicProfileActionPorts } from './executor/publicProfileActions.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '../account/publicProfile.js';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema } from '../account/publicProfilePublication.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
  'account.public_profile.update': ['cli', 'plugin'], 'account.public_profile.refresh': ['cli'],
} });
const context = { surface: 'cli', authority: 'present_user', serverId: 'home', expectedAccountId: 'account', actionsSettings: settings } as const;
const approvalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx, input) =>
  isApprovalRequiredByActionsSettings(id, ctx.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), ctx, undefined, undefined, input);
const layout = { v: 1, items: [] } as const;
function owner() {
  return PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: { name: 'Ada' },
    service: { displayName: 'Home', publicBaseUrl: 'https://home.test' }, urls: {
      page: 'https://home.test/@ada', json: 'https://home.test/@ada/json', badgeBase: 'https://home.test/@ada/badge',
      card: 'https://home.test/@ada/card.svg', og: 'https://home.test/@ada/og.png', report: 'mailto:operator@home.test',
    } }, record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
    query: normalizeUsageQuery({ period: { relative: '90days' } }), snapshot: null, layout,
    appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null,
  } });
}

describe('public-profile Actions through the shared executor', () => {
  it.each(['publish', 'resume', 'update', 'refresh'] as const)('requires a declared public population in the prepared %s HTTP grammar', operation => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1 } });
    const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 1,
      period: { startMs: 0, endMs: 1, timeZoneOffsetMinutes: 0 }, coverage: { status: 'unknown', method: 'unknown' },
      fieldCoverage: {}, facts: {},
    });
    const body = operation === 'update' ? { query } : operation === 'publish'
      ? { query, snapshot, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [], layout,
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 }
      : { query, snapshot };
    const actionId = `account.public_profile.${operation}` as const;
    expect(() => bindPublicProfilePreparedHttpRequestV1(actionId, { operation, body })).toThrow();
    const { population: _privatePopulation, ...unspecifiedQuery } = query;
    expect(() => bindPublicProfilePreparedHttpRequestV1(actionId, { operation, body: { ...body, query: unspecifiedQuery } })).toThrow();
    expect(bindPublicProfilePreparedHttpRequestV1(actionId, { operation,
      body: { ...body, query: { ...query, population: 'public_eligible_personal' } },
    }).body).toMatchObject({ query: { population: 'public_eligible_personal' } });
  });

  it('keeps public Action intents distinct from strict prepared HTTP effects', () => {
    const body = { metadata: { bio: 'Explicit reviewed bio' } };
    expect(getActionSpec('account.public_profile.update').inputSchema.safeParse(body).success).toBe(false);
    expect(bindPublicProfilePreparedHttpRequestV1('account.public_profile.update', { operation: 'update', body }))
      .toEqual({ method: 'PUT', path: '/v1/account/public-profile/policy', body });
    expect(() => bindPublicProfilePreparedHttpRequestV1('account.public_profile.refresh', { operation: 'update', body })).toThrow();
    expect(() => bindPublicProfilePreparedHttpRequestV1('account.public_profile.update', {
      operation: 'update', body: { ...body, state: 'published', confirmed: true },
    })).toThrow();
  });
  it.each(['cli', 'plugin'] as const)('applies a layout from %s without reading Usage and acknowledges the applied edition', async surface => {
    const current = owner();
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      const request = args.preparedRequest ? bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest)
        : bindHomeDomainActionHttpRequestV1(args.actionId, args.input);
      requests.push(request);
      return args.actionId === 'account.public_profile.get' ? current : { kind: 'updated', record: current.kind === 'ready' ? current.record : null };
    };
    const executor = createActionExecutor({
      isActionApprovalRequired: approvalRequired,
      homeDomainAction,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { layout }, { ...context, surface,
      ...(surface === 'plugin' ? { actionCaller: { kind: 'plugin' as const, pluginId: 'example.profiles', contributionLocalId: 'surface' } } : {}) }))
      .resolves.toMatchObject({ ok: true, result: { kind: 'updated', refresh: 'not_needed' } });
    expect(requests).toEqual([{ method: 'GET', path: '/v1/account/public-profile', body: undefined },
      { method: 'PUT', path: '/v1/account/public-profile/policy', body: { layout } }]);
  });

  it('refuses raw snapshots and caller confirmation before any Account transport', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({ homeDomainAction: async args => { requests.push(args); return {}; } } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.refresh', { snapshot: {}, confirmed: true }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(requests).toEqual([]);
  });

  it('reports unavailable eligible source preparation without uploading preview data', async () => {
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      requests.push(args.actionId); return owner();
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.preview', { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {},
      query: normalizeUsageQuery({ period: { relative: '90days' } }), layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 }, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'usage_unavailable' } });
    expect(requests).toEqual(['account.public_profile.get']);
  });

  it('retains the exact prepared Apply through blocking approval and a moving owner response', async () => {
    let current = owner();
    let stored: ApprovalRequest | null = null;
    const requests: unknown[] = [];
    const candidate = { layout: { v: 1 as const, items: [] }, appearance: { atmosphere: { source: 'none' as const }, theme: 'light' as const } };
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      const request = bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest);
      requests.push(request);
      return { kind: 'updated', record: current.kind === 'ready' ? current.record : null };
    };
    const executor = createActionExecutor({ homeDomainAction,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'apply-approval' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const next = decideApprovalRequestTransition(stored, request);
        if (!next.ok) return next;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      approvalsWaitForDecision: async ({ request }) => {
        expect(request.preview).toMatchObject({ publicProfileRequest: { operation: 'update', body: candidate } });
        // The caller's local draft and server policy move while review is open.
        candidate.appearance.atmosphere = { source: 'none' };
        Object.assign(candidate.appearance, { theme: 'dark' });
        current = PublicProfileOwnerReadV1Schema.parse({ ...current, record: { ...(current.kind === 'ready' ? current.record : {}),
          policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } } } });
        return { decision: 'approve', decisionAuthority: 'present_user', request };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', candidate, { ...context, surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'account', actionCaller: { kind: 'host' }, actionRequestId: 'apply-request', defaultSessionMachineId: 'machine' }))
      .resolves.toMatchObject({ ok: true, result: { kind: 'updated', refresh: 'not_needed', record: { policy: { fields: { tokens: false } } } } });
    expect(requests).toEqual([{ method: 'PUT', path: '/v1/account/public-profile/policy', body: {
      layout, appearance: { atmosphere: { source: 'none' }, theme: 'light' },
    } }]);
  });

  it('retains a confirmed policy narrowing when the optional refresh cannot build an eligible snapshot', async () => {
    const current = owner();
    const requests: unknown[] = [];
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } };
    const record = current.kind === 'ready' ? { ...current.record, policy } : null;
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      requests.push(args.actionId);
      return args.actionId === 'account.public_profile.get' ? current : { kind: 'updated', record };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { policy }, context)).resolves.toMatchObject({ ok: true,
      result: { kind: 'updated', record: { policy: { fields: { tokens: false } } }, refresh: 'unavailable' } });
    expect(requests).not.toContain('account.public_profile.refresh');
  });

  it('derives the public population before retaining a caller query update without binding a snapshot builder', async () => {
    const current = owner();
    const requests: unknown[] = [];
    const ordinaryQuery = normalizeUsageQuery({ period: { relative: '30days' }, agents: ['claude'] });
    const publicQuery = normalizeUsageQuery({ ...ordinaryQuery, population: 'public_eligible_personal' });
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      const request = args.preparedRequest ? bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest)
        : bindHomeDomainActionHttpRequestV1(args.actionId, args.input);
      requests.push(request);
      return args.actionId === 'account.public_profile.get' ? current
        : { kind: 'updated', record: current.kind === 'ready' ? { ...current.record, query: publicQuery } : null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { query: ordinaryQuery }, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'updated', refresh: 'unavailable' } });
    expect(requests).toContainEqual({ method: 'PUT', path: '/v1/account/public-profile/policy', body: { query: publicQuery } });
    expect(ordinaryQuery.population).toBe('all_personal_history');
  });

  it('refuses a retired Account after preparation and never retargets the retained Apply', async () => {
    let current = true;
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return owner();
      requests.push(args); return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {
        if (!current) throw Object.assign(new Error('Account retired'), { code: 'action_account_scope_changed' });
      } }),
    } as ActionExecutorDeps);
    const prepared = await executor.prepare('account.public_profile.update', { layout }, context);
    expect(prepared.kind).toBe('ready');
    current = false;
    if (prepared.kind !== 'ready') throw new Error('Expected a prepared Apply');
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(requests).toEqual([]);
  });

  it('cancels after the captured Account read before retaining or dispatching any prepared write', async () => {
    const controller = new AbortController();
    const requests: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      requests.push(args.actionId);
      controller.abort();
      return owner();
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { layout }, { ...context, signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(requests).toEqual(['account.public_profile.get']);
  });

  it('keeps UI approval waivers separate from CLI consent and honors Off before preparation', async () => {
    const requests: string[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      requests.push(args.actionId); return owner();
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
    } as ActionExecutorDeps);
    const uiOnly = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'account.public_profile.update': ['ui'] } });
    await expect(executor.execute('account.public_profile.update', { layout }, { ...context, actionsSettings: uiOnly }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(requests).toEqual(['account.public_profile.get']);
    requests.length = 0;
    const off = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'account.public_profile.update': { disabledSurfaces: ['cli'] } } });
    await expect(executor.execute('account.public_profile.update', { layout }, { ...context, actionsSettings: off }))
      .resolves.toMatchObject({ ok: false });
    expect(requests).toEqual([]);
  });
});
