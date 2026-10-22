import { describe, expect, it } from 'vitest';

import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';

import {
  areExecutionRunBackendTargetsEqual,
  resolveExecutionRunRuntimeBackendTarget,
} from './backendTargets';

const canonicalOpenCodeTargetKey = buildBackendTargetKeyV2({
  kind: 'agent',
  identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
});

describe('areExecutionRunBackendTargetsEqual', () => {
  it('equates the canonical contributed-Agent key with its executable built-in target', () => {
    expect(areExecutionRunBackendTargetsEqual(
      canonicalOpenCodeTargetKey,
      { kind: 'builtInAgent', agentId: 'opencode' },
    )).toBe(true);
  });

  it.each([
    ['different Agent', 'agent:happier.agent.codex/codex'],
    ['malformed key', 'not-a-target-key'],
  ])('fails closed for a %s', (_label, candidate) => {
    expect(areExecutionRunBackendTargetsEqual(
      candidate as Parameters<typeof areExecutionRunBackendTargetsEqual>[0],
      { kind: 'builtInAgent', agentId: 'opencode' },
    )).toBe(false);
  });

  it('does not equate a configured target with the built-in Agent of the same backend family', () => {
    expect(areExecutionRunBackendTargetsEqual(
      canonicalOpenCodeTargetKey,
      { kind: 'configuredAcpBackend', backendId: 'opencode' },
    )).toBe(false);
  });
});

describe('resolveExecutionRunRuntimeBackendTarget', () => {
  it('resolves a canonical installed Agent identity to the retained runtime target', () => {
    expect(resolveExecutionRunRuntimeBackendTarget({
      kind: 'agent',
      identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
    })).toEqual({ kind: 'builtInAgent', agentId: 'opencode' });
  });

  it('rejects a malformed target rather than inventing an executable identity', () => {
    expect(resolveExecutionRunRuntimeBackendTarget('not-a-target-key')).toBeNull();
  });

  it('lowers an authored Agent without a runner-local installed catalog; snapshot admission remains separate', () => {
    expect(resolveExecutionRunRuntimeBackendTarget({
      kind: 'agent',
      identity: { pluginId: 'acme.review-plugin', localId: 'review-agent' },
    })).toEqual({
      kind: 'builtInAgent',
      agentId: 'acme.review-plugin/review-agent',
    });
  });
});
