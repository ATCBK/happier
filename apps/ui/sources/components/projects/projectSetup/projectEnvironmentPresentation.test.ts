import { describe, expect, it } from 'vitest';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import {
  describeNativeEnvironmentRefusal,
  nativeEnvironmentNameFor,
} from './projectEnvironmentPresentation';
import { presentProjectRun } from './projectScriptPresentation';
import { projectSetupReadinessLine } from './projectSetupReadinessLine';

const native = {
  kind: 'toolchain',
  tool: 'devenv',
  configPath: 'devenv.nix',
} as const;

function operation(patch: Record<string, unknown>): ActionOperationProjection {
  return {
    serverId: 'home',
    observation: 'available',
    isUnavailableProjection: false,
    snapshot: {
      version: 1,
      operationId: 'op',
      revision: 1,
      actionId: 'projects.script.run',
      state: 'running',
      scope: { accountId: 'account', machineId: 'machine' },
      title: 'verify',
      createdAt: 1_000,
      cancellation: 'supported',
      ...patch,
    },
  } as ActionOperationProjection;
}

describe('native environment presentation (plan 24 copy)', () => {
  it('names the environment a manifest selects, and nothing for the host', () => {
    expect(nativeEnvironmentNameFor({ environment: native })).toBe(
      'devenv',
    );
    expect(
      nativeEnvironmentNameFor({ environment: { kind: 'host' } }),
    ).toBeNull();
    expect(nativeEnvironmentNameFor({})).toBeNull();
  });

  it('says a review that evaluates a native environment waits for approval to evaluate it', () => {
    const held = operation({
      state: 'accepted',
      setupReview: { reviewedEffectDigest: 'd', reviewedEffect: {} },
    });
    expect(presentProjectRun(held, 'nl3', '', 'devenv').text).toBe(
      'Waiting for approval to evaluate this environment',
    );
    // A host setup review keeps the generic approval line.
    expect(presentProjectRun(held, 'nl3', '').text).toBe(
      'Waiting for your approval',
    );
  });

  it('names the tool and Machine while a native environment is being prepared', () => {
    const preparing = operation({
      progress: { kind: 'phase', phase: 'preparing', label: 'preparing' },
    });
    expect(presentProjectRun(preparing, 'nl3', '', 'devenv').text).toBe(
      'Preparing devenv on nl3…',
    );
  });

  it('turns a missing native tool into a typed refusal that says nothing ran on the host', () => {
    expect(
      describeNativeEnvironmentRefusal('native_tool_unavailable', 'Nix flake'),
    ).toBe(
      'Nix flake is unavailable on this Machine. Nothing was run in the host environment.',
    );
    expect(
      describeNativeEnvironmentRefusal('native_environment_failed', 'devenv'),
    ).toBe(
      'Native environment preparation failed. View output. Nothing was run in the host environment.',
    );
    // Other failures, and rows without a selected native environment, keep the generic refusal.
    expect(
      describeNativeEnvironmentRefusal('scope_mismatch', 'devenv'),
    ).toBeNull();
    expect(
      describeNativeEnvironmentRefusal('native_tool_unavailable', null),
    ).toBeNull();
  });

  it('asks for a new review of a changed native environment instead of a generic setup change', () => {
    const readiness = { kind: 'needsReview', code: 'setup_changed' } as const;
    expect(projectSetupReadinessLine(readiness, 'devenv')).toBe(
      'Environment inputs changed. Review again.',
    );
    expect(projectSetupReadinessLine(readiness)).toBe(
      'Setup changed. Review it in Scripts',
    );
  });
});
