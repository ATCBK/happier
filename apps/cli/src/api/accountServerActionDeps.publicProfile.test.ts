import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { PublicProfileOwnerReadV1Schema, DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';

let app: ReturnType<typeof fastify>;
let restore: () => void;
beforeEach(() => {
  app = fastify();
  restore = installAxiosFastifyAdapter({ app, origin: 'http://profile-home.test' });
});
afterEach(async () => { restore(); await app.close(); });

describe('public-profile CLI captured Account binding', () => {
  it.each(['restrict', 'restore'] as const)('requires consent for operator %s and never turns a waiver into Home privilege', async operation => {
    const actionId = ActionIdSchema.parse(`home.public_profiles.${operation}`);
    const received: unknown[] = [];
    let permitted = false;
    app.post(`/v1/home/public-profiles/:accountId/${operation}`, async (request, reply) => {
      expect(request.headers.authorization).toBe('Bearer captured');
      received.push({ params: request.params, body: request.body });
      return permitted ? { kind: 'updated', record: null }
        : reply.code(403).send({ error: 'home_governance_forbidden' });
    });
    const deps = createAccountServerActionDeps({ token: 'captured', serverId: 'home', serverHttpBaseUrl: 'http://profile-home.test',
      isCredentialCurrent: async () => true });
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: (id, context, input) =>
      isApprovalRequiredByActionsSettings(id, context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), context, undefined, undefined, input),
    } as ActionExecutorDeps);
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
    const input = { accountId: 'account/target', reason: '  Reviewed operator reason  ' };
    await expect(executor.execute(actionId, input, context)).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(received).toEqual([]);
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] } });
    await expect(executor.execute(actionId, { ...input, isAdmin: true }, { ...context, actionsSettings }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(executor.execute(actionId, { ...input, reason: ' ' }, { ...context, actionsSettings }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(received).toEqual([]);
    await expect(executor.execute(actionId, input, { ...context, actionsSettings }))
      .resolves.toMatchObject({ ok: false, errorCode: 'home_governance_forbidden' });
    expect(received).toEqual([{ params: { accountId: 'account/target' }, body: { reason: 'Reviewed operator reason' } }]);
    // Only the answering Home can change this authorization outcome.
    permitted = true;
    await expect(executor.execute(actionId, input, { ...context, actionsSettings }))
      .resolves.toEqual({ ok: true, result: { kind: 'updated', record: null } });
  });

  it('runs layout-only Apply through shared preparation and the exact declared HTTP effect', async () => {
    const layout = { v: 1, items: [] } as const;
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: {},
      service: null, urls: null }, record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: {}, projectSelections: [], query: normalizeUsageQuery({}), snapshot: null, layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null,
    } });
    const requests: unknown[] = [];
    app.get('/v1/account/public-profile', async () => owner);
    app.put('/v1/account/public-profile/policy', async request => {
      expect(request.headers.authorization).toBe('Bearer captured');
      requests.push(request.body);
      return { kind: 'updated', record: owner.kind === 'ready' ? owner.record : null };
    });
    const deps = createAccountServerActionDeps({ token: 'captured', serverId: 'home', serverHttpBaseUrl: 'http://profile-home.test',
      isCredentialCurrent: async () => true });
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'account.public_profile.update': ['cli'], 'account.public_profile.refresh': ['cli'] } });
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: (id, context, input) =>
      isApprovalRequiredByActionsSettings(id, actionsSettings, context, undefined, undefined, input),
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { layout }, {
      surface: 'cli', authority: 'present_user', serverId: 'home',
    })).resolves.toMatchObject({ ok: true, result: { kind: 'updated', refresh: 'not_needed' } });
    expect(requests).toEqual([{ layout }]);
    await expect(executor.execute('account.public_profile.refresh', {}, {
      surface: 'cli', authority: 'present_user', serverId: 'home',
    })).resolves.toMatchObject({ ok: false, errorCode: 'public_profile_preparation_unavailable' });
    expect(requests).toHaveLength(1);
  });
});
