import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { bindHomeDomainActionHttpRequestV1, bindPublicProfilePreparedHttpRequestV1 } from './homeDomainActionFamily.js';
import { bindPublicProfileActionPorts } from './executor/publicProfileActions.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '../account/publicProfile.js';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema, type PublicProfilePreparedAppearanceV1 } from '../account/publicProfilePublication.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { buildPublicProfileSnapshot } from '../account/publicProfileSnapshot.js';
import { resolveUsagePageAggregation } from '../usage/resolveUsagePageAggregation.js';
import { UsageAnalyticsQueryResponseSchema } from '../usage/usageAnalyticsContracts.js';

const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
  'account.public_profile.update': ['cli', 'plugin'], 'account.public_profile.refresh': ['cli'],
} });
const context = { surface: 'cli', authority: 'present_user', serverId: 'home', expectedAccountId: 'account', actionsSettings: settings } as const;
const approvalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx, input) =>
  isApprovalRequiredByActionsSettings(id, ctx.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), ctx, undefined, undefined, input);
const layout = { v: 1, items: [] } as const;
const picturePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
function reviewedPictureAppearance(): PublicProfilePreparedAppearanceV1 {
  return { atmosphere: { source: 'picture', picture: { layout: 'horizon', descriptor: {
    kind: 'photo', title: 'Reviewed image', credit: null, adaptiveHaze: false, horizon: {}, focus: {},
    hour: 0, grades: { light: 0, dusk: 0, night: 0 }, dark: 'night',
    look: { effect: 'mosaic', params: {}, strength: 0.37, dissolve: { style: 'rows', from: 0.58, to: 1 } },
  }, content: { mimeType: 'image/png', base64: picturePng } } }, theme: 'light' };
}
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

  it('retains the exact image Apply through blocking approval without uploading its bytes in the Approval Artifact', async () => {
    let current = owner();
    let stored: ApprovalRequest | null = null;
    let offeredBeforeDecision: unknown;
    const requests: unknown[] = [];
    const candidate: { layout: typeof layout; appearance: PublicProfilePreparedAppearanceV1 } = { layout, appearance: reviewedPictureAppearance() };
    const reviewed = structuredClone(candidate);
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      const request = bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest);
      requests.push(request);
      return { kind: 'updated', record: current.kind === 'ready' ? current.record : null };
    };
    const executor = createActionExecutor({ homeDomainAction,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {} }),
      approvalsCreate: async ({ request }) => {
        offeredBeforeDecision = structuredClone(request);
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'apply-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const next = decideApprovalRequestTransition(stored, request);
        if (!next.ok) return next;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      approvalsWaitForDecision: async ({ request }) => {
        expect(requests).toEqual([]);
        expect(request.preview).toMatchObject({ destination: { serverId: 'home', accountId: 'account' } });
        // The caller's local draft and server policy move while review is open.
        candidate.appearance.atmosphere = { source: 'none' };
        Object.assign(candidate.appearance, { theme: 'dark' });
        current = PublicProfileOwnerReadV1Schema.parse({ ...current, record: { ...(current.kind === 'ready' ? current.record : {}),
          policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } } } });
        return { decision: 'approve', decisionAuthority: 'present_user', request };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as ActionExecutorDeps);
    const result = await executor.execute('account.public_profile.update', candidate, { ...context, surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'account', actionCaller: { kind: 'host' }, actionRequestId: 'apply-request', defaultSessionMachineId: 'machine' });
    // Assert outside the boundary callback so the executor cannot normalize this regression into a generic failure.
    expect(offeredBeforeDecision).toBeDefined();
    expect(JSON.stringify(offeredBeforeDecision)).not.toContain(picturePng);
    expect(result).toMatchObject({ ok: true, result: { kind: 'updated', refresh: 'not_needed', record: { policy: { fields: { tokens: false } } } } });
    expect(requests).toEqual([{ method: 'PUT', path: '/v1/account/public-profile/policy', body: reviewed }]);
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

  it.each(['publish', 'resume', 'refresh', 'preview', 'preview_required'] as const)('keeps the exact computed %s snapshot out of durable approvals and observations', async variant => {
    const operation = variant === 'preview_required' ? 'preview' : variant;
    const current = owner();
    if (current.kind !== 'ready') throw new Error('Expected existing edition');
    current.record.state = operation === 'resume' ? 'paused' : 'published';
    current.record.query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1_000 } });
    let stored: ApprovalRequest | null = null;
    let offered: unknown;
    let observedTokens = 1234567;
    const writes: unknown[] = [];
    const observations: unknown[] = [];
    const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async args => {
      if (args.actionId === 'account.public_profile.get') return current;
      writes.push(bindPublicProfilePreparedHttpRequestV1(args.actionId, args.preparedRequest));
      return { kind: 'updated', record: null };
    };
    const executor = createActionExecutor({ homeDomainAction, isActionApprovalRequired: approvalRequired,
      publicProfileActions: bindPublicProfileActionPorts({ homeDomainAction, assertCurrent: () => {}, buildSnapshot: buildPublicProfileSnapshot,
        usage: { query: async ({ queries }) => resolveUsagePageAggregation({ queries, accounting: queries.map(query => ({ query,
          status: 'available', asOfMs: 1_000, value: UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            totals: { eventCount: 1, tokens: { input: observedTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: observedTokens },
              cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            contributions: [{ id: 'request', observedAtMs: 1, sessionId: null, turnId: null, agentId: 'codex', modelId: null,
              machineId: null, projectKey: null, workspaceId: null, source: 'runtime', eventCount: 1,
              tokens: { input: observedTokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: observedTokens },
              cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }],
          }) })) }) } }),
      approvalsCreate: async ({ request }) => { offered = structuredClone(request); stored = request; return { artifactId: 'snapshot-review' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const next = decideApprovalRequestTransition(stored, request);
        if (!next.ok) return next;
        stored = request; return { ok: true };
      },
      approvalsWaitForDecision: async ({ request }) => {
        observedTokens = 7654321;
        return { decision: 'approve', decisionAuthority: 'present_user', request };
      }, isApprovalExecutionOriginCurrent: async () => true,
      observeActionExecution: observation => { observations.push(observation); },
    } as ActionExecutorDeps);
    const appearance = operation === 'preview' ? reviewedPictureAppearance() : DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1;
    const input = operation === 'publish' || operation === 'preview' ? { ...(operation === 'publish' ? { intent: 'publish' } : {}),
      policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: { bio: 'private-unreviewed-bio', projectSelections: [{
        provider: { id: 'example/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
        repository: { nameWithOwner: 'private-unreviewed-owner/private-repo' }, protocol: 'https',
      }] },
      query: current.record.query, layout, appearance } : {};
    const previewSettings = variant === 'preview_required' ? ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'account.public_profile.preview': { approvalRequiredSurfaces: ['agent'] } } }) : settings;
    const result = await executor.execute(`account.public_profile.${operation}`, input, { ...context, actionsSettings: previewSettings,
      surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'account', actionCaller: { kind: 'host' }, actionRequestId: 'snapshot-request', defaultSessionMachineId: 'machine' });
    if (offered !== undefined) expect(JSON.stringify(offered)).not.toContain('private-unreviewed');
    expect(observations.length).toBeGreaterThan(0);
    expect(JSON.stringify(observations)).not.toContain('private-unreviewed');
    expect(JSON.stringify(observations)).not.toContain('1234567');
    expect(JSON.stringify(observations)).not.toContain(picturePng);
    if (operation === 'preview') {
      if (variant === 'preview_required') {
        expect(offered).toBeDefined();
        expect(JSON.stringify(stored)).not.toContain('1234567');
        expect(JSON.stringify(stored)).not.toContain(picturePng);
      } else expect(offered).toBeUndefined();
      expect(writes).toEqual([]);
      expect(result).toMatchObject({ ok: true, result: { kind: 'ready', view: { appearance, snapshot: { facts: { tokens: 1234567 } } } } });
      return;
    }
    expect(offered).toBeDefined();
    expect(JSON.stringify(offered)).not.toContain('1234567');
    expect(result).toMatchObject({ ok: true, result: { kind: 'updated' } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ body: { snapshot: { facts: { tokens: 1234567 } } } });
    expect(JSON.stringify(writes)).not.toContain('private-unreviewed');
  });

  it('derives the public population before retaining a caller query update without binding a snapshot builder', async () => {
    const current = owner();
    const requests: unknown[] = [];
    const ordinaryQuery = normalizeUsageQuery({ period: { relative: '30days' }, agents: ['claude'] });
    const publicQuery = normalizeUsageQuery({ ...ordinaryQuery, population: 'public_eligible_personal', includeAccounting: true,
      includeActivity: true, activityResolution: 'both', includeSessionEvidence: true, includeWorkEvidence: true,
      includeQuotaHistory: false, includeTranscriptEvidence: false });
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
