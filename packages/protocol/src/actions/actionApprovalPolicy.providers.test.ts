import { describe, expect, it } from 'vitest';
import type { ActionId } from './actionIds.js';

describe('Provider Settings present-user approval policy', () => {
  it('uses the same safe label-write approval floor for connected-account rename and labels.set', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const { ActionsSettingsV1Schema } = await import('./actionSettings.js');
    for (const actionId of ['connectedServices.accounts.rename', 'connectedServices.labels.set'] as const) {
      for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
        const spec = getActionSpec(actionId);
        const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const };
        expect(resolveActionApprovalRouting({ actionId, spec, context }).required, `${actionId}/${surface}`).toBe(false);
        const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required).toBe(true);
      }
    }
  }, 60_000);
  it('keeps the reached preference and experimental approvals configurable and waivable', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const { ActionsSettingsV1Schema } = await import('./actionSettings.js');
    for (const actionId of ['settings.set', 'providers.connections.update', 'models.favorite.set',
      'session.model.unarm', 'providers.models.experimental.confirm'] as const) {
      for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
        const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const };
        const spec = getActionSpec(actionId);
        const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, settings: waived }).required, `${actionId}/${surface}`).toBe(false);
        const ask = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, settings: ask }).required, `${actionId}/${surface}`).toBe(true);
      }
    }
  }, 60_000);
  it('keeps display-only updates safe but fails malformed or consequential updates closed', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const actionId = 'providers.connections.update';
    const spec = getActionSpec(actionId);
    const rename = { action: 'update', connectionId: 'pc_gateway', expectedRevision: 2, displayName: 'My gateway' };
    for (const surface of ['agent', 'ui', 'cli', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, input: rename, context }).required).toBe(false);
      for (const input of [undefined, { ...rename, gatewayPlacement: null }, { ...rename, claudeHelperModels: {} },
        { ...rename, template: {} }, { ...rename, unexpected: true }]) {
        expect(resolveActionApprovalRouting({ actionId, spec, input, context }).required).toBe(true);
      }
    }
  }, 60_000);
  it('exposes every Provider and routing action family to agents with approval on credential and subscription mutations', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const dangerous = [
      'providers.connections.create_contribution', 'providers.connections.create_custom',
      'providers.connections.update', 'providers.connections.delete',
      'providers.connections.endpoint.set', 'providers.connections.secrets.bind',
      'providers.connections.enabled.set', 'connectedServices.configuration.replace',
    ] as const satisfies readonly ActionId[];
    const preferencesAndReads = [
      'providers.models.manual.add', 'providers.models.manual.remove',
      'providers.models.visibility.set', 'providers.models.source_visibility.set',
      'providers.defaults.set', 'connectedServices.configuration.get', 'session.model.set',
      'execution.run.start', 'review.start', 'subagents.plan.start',
      'subagents.delegate.start', 'voice_agent.start',
    ] as const satisfies readonly ActionId[];
    for (const id of [...dangerous, ...preferencesAndReads]) {
      const spec = getActionSpec(id);
      expect(spec.surfaces.agent, id).toBe(true);
      expect(spec.surfaces.cli, id).toBe(true);
      expect(spec.surfaces.mcp, id).toBe(true);
    }
    for (const id of dangerous) {
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'agent', authority: 'account_automation' } }), id)
        .toMatchObject({ required: true });
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'ui', authority: 'present_user' } }), id)
        .toMatchObject({ required: true });
    }
    for (const id of preferencesAndReads) {
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'agent', authority: 'account_automation' } }), id)
        .toMatchObject({ required: false });
    }
  }, 60_000);

  it('requires approval for gateway routing changes and honors the existing per-surface waiver', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const { ActionsSettingsV1Schema } = await import('./actionSettings.js');
    const actionId = 'providers.connections.update';
    const spec = getActionSpec(actionId);
    const input = spec.inputSchema.parse({ action: 'update', connectionId: 'pc_gateway', expectedRevision: 2,
      deployment: { kind: 'managedLocal', purposeBindingDefaults: {
        upstream: { kind: 'group', service: { pluginId: 'example.auth', localId: 'subscription' }, groupId: 'pool' },
      } }, gatewayPlacement: { kind: 'machine', machineId: 'hub' }, claudeHelperModels: { fast: 'fast-model' } });
    const context = { surface: 'agent', authority: 'account_automation' } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, input, context }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, input,
      context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ required: true, flow: 'deferred' });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['agent'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings }).required).toBe(false);
  }, 60_000);

  it('routes dangerous Provider operations through the canonical UI approval owner', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    for (const id of ['providers.connections.enabled.set', 'providers.connections.delete', 'providers.probe',
      'providers.connections.start_local', 'providers.models.load', 'providers.models.experimental.confirm',
      'launch_profiles.legacy.convert', 'launch_profiles.legacy.resolve_conflict'] as const satisfies readonly ActionId[]) {
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ required: true, flow: 'deferred' });
    }
  }, 60_000);
});
