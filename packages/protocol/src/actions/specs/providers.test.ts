import { describe, expect, it } from 'vitest';
import { PROVIDER_ACTION_SPECS_V1 } from './providers.js';
import { isProviderActionMachineRequiredV1 } from '../../providers/providerActionsV1.js';
import { createProviderErrorV1, ProviderErrorV1Schema } from '../../providers/errors.js';

describe('Provider Action placement declarations', () => {
  it('retains strict typed refusals in observations without disclosing private Provider payloads', () => {
    const spec = PROVIDER_ACTION_SPECS_V1.find(spec => spec.id === 'providers.probe')!;
    const error = createProviderErrorV1('provider_endpoint_rate_limited', {
      connectionId: 'gateway', machineId: 'hub', retryAfterMs: 1000,
    });
    const privatePayload = { baseUrl: 'https://private.example', credential: 'secret', models: ['private-model'] };
    const observed = spec.projectObservationOutput?.({ status: 'error', error, ...privatePayload });
    expect(observed).toEqual({ status: 'error', error });
    expect(ProviderErrorV1Schema.safeParse((observed as { error: unknown }).error).success).toBe(true);
    expect(spec.projectObservationOutput?.({ status: 'success', error, ...privatePayload }))
      .toEqual({ status: 'success' });
    for (const invalid of [{ ...error, ...privatePayload }, { ...error, retryable: false }, 'private failure prose']) {
      expect(spec.projectObservationOutput?.({ status: 'error', error: invalid, ...privatePayload }))
        .toEqual({ status: 'error' });
    }
  });
  it('classifies validated display-only updates as safe while consequential and malformed updates stay dangerous', () => {
    const spec = PROVIDER_ACTION_SPECS_V1.find(spec => spec.id === 'providers.connections.update')!;
    const rename = { action: 'update', connectionId: 'connection', expectedRevision: 1, displayName: 'Gateway' };
    expect(spec.safetyForInput?.(rename) ?? spec.safety).toBe('safe');
    for (const input of [undefined, { ...rename, gatewayPlacement: null }, { ...rename, claudeHelperModels: {} },
      { ...rename, template: {} }, { ...rename, unknown: true }]) {
      expect(spec.safetyForInput?.(input) ?? spec.safety).toBe('danger');
    }
  });
  it('places Account configuration separately from exact machine observations and effects', () => {
    const cases = [
      ['providers.connections.describe', {}, 'account'],
      ['providers.connections.describe', { machineId: 'machine' }, 'machine'],
      ['providers.connections.create_contribution', { action: 'createContribution', connectionId: 'connection',
        contributionKey: 'happier.provider.cliproxyapi/cliproxyapi', displayName: 'Main gateway', savedSecretId: null,
        enable: true, deployment: { kind: 'managedLocal', purposeBindingDefaults: {} } }, 'account'],
      ['providers.connections.update', { action: 'update', connectionId: 'connection', expectedRevision: 1,
        gatewayPlacement: { kind: 'machine', machineId: 'hub' } }, 'account'],
      ['providers.connections.update', { action: 'update', machineId: 'machine', connectionId: 'connection', expectedRevision: 1 }, 'account'],
      ['providers.connections.enabled.set', { action: 'setEnabled', connectionId: 'connection', enabled: true, scope: 'account' }, 'account'],
      ['providers.connections.enabled.set', { action: 'setEnabled', machineId: 'machine', connectionId: 'connection', enabled: true, scope: 'machine' }, 'machine'],
      ['providers.connections.secrets.bind', { action: 'bindSecret', connectionId: 'connection', credentialSlotId: 'apiKey', savedSecretId: null, scope: 'account' }, 'account'],
      ['providers.connections.secrets.bind', { action: 'bindSecret', machineId: 'machine', connectionId: 'connection', credentialSlotId: 'apiKey', savedSecretId: null, scope: 'machine' }, 'machine'],
      ['providers.models.list', { connectionId: 'connection' }, 'account'],
      ['providers.models.list', { connectionId: 'connection', machineId: 'machine' }, 'machine'],
      ['providers.models.projection', { agentTargetKey: 'agent:com.acme.agent/acme' }, 'account'],
      ['providers.models.projection', { agentTargetKey: 'agent:com.acme.agent/acme', machineId: 'machine' }, 'machine'],
      ['providers.models.manual.remove', { action: 'manualRemove', connectionId: 'connection', modelId: 'model', expectedConnectionRevision: 1 }, 'account'],
      ['providers.models.visibility.set', { action: 'setVisibility', ref: { scope: 'agent', agentTargetKey: 'agent:com.acme.agent/acme', providerConnectionId: 'connection', modelId: 'model' }, hidden: true }, 'account'],
      ['providers.models.source_visibility.set', { action: 'setConnectionVisibility', connectionId: 'connection', shown: false }, 'account'],
      ['providers.defaults.set', { agentTargetKey: 'agent:codex', selection: null }, 'account'],
      ['providers.connections.start_local', { action: 'startLocal', machineId: 'machine', contributionKey: 'example.gateway/gateway' }, 'machine'],
      ['providers.probe', { machineId: 'machine', connectionId: 'connection' }, 'machine'],
    ] as const;
    for (const [id, raw, expected] of cases) {
      const spec = PROVIDER_ACTION_SPECS_V1.find(spec => spec.id === id);
      if (!spec) throw new Error(`Missing Provider Action: ${id}`);
      const input = spec.inputSchema.parse(raw);
      expect(spec.executionPlacementForInput?.(input) ?? spec.executionPlacement, id).toBe(expected);
    }
    expect(PROVIDER_ACTION_SPECS_V1.find(spec => spec.id === 'providers.connections.update')?.executionPlacement).toBe('account');
    expect(PROVIDER_ACTION_SPECS_V1.find(spec => spec.id === 'providers.probe')?.executionPlacement).toBe('machine');
    expect(PROVIDER_ACTION_SPECS_V1.find(spec => spec.id === 'providers.models.experimental.confirm')?.executionPlacement).toBe('account');
    for (const spec of PROVIDER_ACTION_SPECS_V1) {
      expect(spec.executionPlacement, spec.id).toBe(isProviderActionMachineRequiredV1({ actionId: spec.id }) ? 'machine' : 'account');
    }
  });
});
