import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  pluginUiSelectedActionInputMatchesOperation,
  reconstructPluginUiSelectedActionInput,
  type PluginUiSelectedActionInputForReconstructionV1,
  type PluginUiSelectedActionInputV1,
} from './selectedActionInput.js';
import type { PluginUiJsonValueV1 } from '../contributions/ui/json.js';

describe('selected Action input reconstruction', () => {
  const account = {
    service: { pluginId: 'acme.github', localId: 'github' },
    accountId: 'account-a',
  } as const;

  it('passes through zero-field selections and restores only one non-colliding selected Account field', () => {
    expectTypeOf<PluginUiSelectedActionInputForReconstructionV1['input']>()
      .toEqualTypeOf<PluginUiSelectedActionInputV1['input']>();
    expectTypeOf<Parameters<typeof reconstructPluginUiSelectedActionInput>[0]['input']>()
      .toEqualTypeOf<PluginUiJsonValueV1>();
    const input = { repository: 'happier-dev/happier' } as const;

    expect(reconstructPluginUiSelectedActionInput({
      input,
      connectedAccount: { kind: 'none' },
    })).toEqual(input);
    expect(reconstructPluginUiSelectedActionInput({
      input,
      connectedAccount: { kind: 'selected', fieldPath: 'credentialRef', ref: account },
    })).toEqual({
      repository: 'happier-dev/happier',
      credentialRef: account,
    });
  });

  it('refuses a colliding or unsafe selected Account path instead of overwriting input', () => {
    const input = {
      repository: 'happier-dev/happier',
      credentialRef: account,
    } as const;

    expect(reconstructPluginUiSelectedActionInput({
      input,
      connectedAccount: { kind: 'selected', fieldPath: 'credentialRef', ref: account },
    })).toBeNull();
    expect(reconstructPluginUiSelectedActionInput({
      input: { repository: 'happier-dev/happier' },
      connectedAccount: { kind: 'selected', fieldPath: '__proto__.credentialRef', ref: account },
    })).toBeNull();
  });

  it('allows an existing matching Account only for retained-input reconstruction', () => {
    const reconstruct = (input: Parameters<typeof reconstructPluginUiSelectedActionInput>[0]['input'], fieldPath = 'auth.account') => reconstructPluginUiSelectedActionInput({
      input,
      connectedAccount: { kind: 'selected', fieldPath, ref: account },
    }, { allowMatchingConnectedAccount: true });
    const input = { repository: 'acme/project', auth: { account } };

    expect(reconstruct(input)).toEqual(input);
    expect(reconstruct({ repository: 'acme/project' })).toEqual(input);
    expect(reconstruct({ ...input, auth: { account: { ...account, accountId: 'account-b' } } })).toBeNull();
    expect(reconstruct({ repository: 'acme/project', auth: null })).toBeNull();
    expect(reconstruct({}, 'auth.__proto__.account')).toBeNull();
    expect(reconstructPluginUiSelectedActionInput({
      input,
      connectedAccount: { kind: 'selected', fieldPath: 'auth.account', ref: account },
    })).toBeNull();
  });

  it('matches a submitted selection only to the contributor custody that admitted the operation', () => {
    const operation = {
      point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
      contributor: {
        pluginId: 'acme.github',
        contributionId: 'github',
        occurrenceId: 'github-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'github-root-a' },
      },
      role: 'setup',
      action: { pluginId: 'acme.github', localId: 'connection/setup' },
    } as const;
    const selection = {
      kind: 'submitted',
      action: operation.action,
      input: {},
      selection: {
        target: {
          pluginId: 'acme.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-root-a' },
        },
        point: operation.point,
        contributor: {
          pluginId: operation.contributor.pluginId,
          contributionId: operation.contributor.contributionId,
          sourceCustody: operation.contributor.sourceCustody,
        },
      },
      connectedAccount: { kind: 'none' },
      presentation: { connectedAccountLabel: null, machineDisplayName: 'Development Mac' },
    } as const;

    expect(pluginUiSelectedActionInputMatchesOperation(selection, operation)).toBe(true);
    expect(pluginUiSelectedActionInputMatchesOperation({
      ...selection,
      selection: {
        ...selection.selection,
        contributor: {
          ...selection.selection.contributor,
          sourceCustody: { kind: 'development', registeredRootId: 'github-root-b' },
        },
      },
    }, operation)).toBe(false);
  });
});
