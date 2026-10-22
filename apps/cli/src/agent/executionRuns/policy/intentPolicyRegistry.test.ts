import { describe, expect, it } from 'vitest';

import { ExecutionRunIntentSchema, ExecutionRunStartRequestSchema } from '@happier-dev/protocol';
import { EXECUTION_RUN_INTENT_POLICY_MATRIX } from '@happier-dev/protocol/execution/runs/index';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { defaultExecutionRunClass, defaultExecutionRunIoMode, defaultExecutionRunRetention } from '@happier-dev/protocol/actions/specs/executionRunCli';

import {
  EXECUTION_RUN_INTENT_POLICY_REGISTRY,
  isSafePermissionModeForIntent,
  validateExecutionRunStartIntentPolicy,
  resolveExecutionRunIntentPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
} from './intentPolicyRegistry';

describe('executionRun intent policy registry', () => {
  it('admits the discoverable examples and friendly defaults for every intent', () => {
    for (const intent of ExecutionRunIntentSchema.options) {
      expect(validateExecutionRunStartIntentPolicy({ intent, permissionMode: 'read_only',
        retentionPolicy: defaultExecutionRunRetention(intent), runClass: defaultExecutionRunClass(intent),
        ioMode: defaultExecutionRunIoMode(intent) }), intent).toEqual({ ok: true });
    }
    const spec = getActionSpec('execution.run.start');
    for (const example of [spec.examples?.mcp, spec.examples?.voice]) {
      const input = ExecutionRunStartRequestSchema.parse(spec.inputSchema.parse(JSON.parse(example?.argsExample ?? '{}')));
      expect(validateExecutionRunStartIntentPolicy(input)).toEqual({ ok: true });
    }
  });
  it('admits native Voice streaming with resumable retention and rejects ephemeral run retention', () => {
    const voiceStart = { intent: 'voice_agent' as const, permissionMode: 'read_only',
      runClass: 'long_lived' as const, ioMode: 'streaming' as const };
    expect(validateExecutionRunStartIntentPolicy({ ...voiceStart, retentionPolicy: 'resumable' })).toEqual({ ok: true });
    expect(validateExecutionRunStartIntentPolicy({ ...voiceStart, retentionPolicy: 'ephemeral' })).toMatchObject({
      ok: false, errorCode: 'execution_run_not_allowed',
    });
  });

  it('admits a read-only retained review for findings-first narration', () => {
    expect(validateExecutionRunStartIntentPolicy({ intent: 'review', permissionMode: 'read_only',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' })).toEqual({ ok: true });
  });
  it('admits a read-only retained SCM generator through the existing session runtime', () => {
    expect(validateExecutionRunStartIntentPolicy({
      intent: 'scm_diff_summary', permissionMode: 'read_only', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'streaming',
    })).toEqual({ ok: true });
  });
  it('keeps policy coverage aligned with the protocol intent surface and the bridge policy matrix', () => {
    for (const intent of ExecutionRunIntentSchema.options) {
      const policy = resolveExecutionRunIntentPolicy(intent);
      expect(policy.intent).toBe(intent);
      expect(policy.allowedRunClasses).toEqual(EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedRunClasses);
      expect(policy.allowedIoModes).toEqual(EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedIoModes);
      expect(policy.allowedRetentionPolicies).toEqual(EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedRetentionPolicies);
    }
  });

  it('keeps general Agent, delegate, and voice-agent permission-intent capable while bounded evidence/read intents stay safe-only', () => {
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.review.permissionModePolicy).toBe('safe_only');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.plan.permissionModePolicy).toBe('safe_only');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.delegate.permissionModePolicy).toBe('permissive');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.agent.permissionModePolicy).toBe('permissive');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.voice_agent.permissionModePolicy).toBe('permissive');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.memory_hints.permissionModePolicy).toBe('safe_only');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.scm_commit_message.permissionModePolicy).toBe('safe_only');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.scm_diff_summary.permissionModePolicy).toBe('safe_only');

    expect(isSafePermissionModeForIntent('review', 'workspace_write')).toBe(false);
    expect(isSafePermissionModeForIntent('plan', 'read_only')).toBe(true);
    expect(isSafePermissionModeForIntent('delegate', 'workspace_write')).toBe(true);
    expect(isSafePermissionModeForIntent('agent', 'workspace_write')).toBe(true);
    expect(isSafePermissionModeForIntent('voice_agent', 'read-only')).toBe(true);
    expect(isSafePermissionModeForIntent('voice_agent', 'safe-yolo')).toBe(true);
    expect(isSafePermissionModeForIntent('voice_agent', 'yolo')).toBe(true);
    expect(isSafePermissionModeForIntent('memory_hints', 'workspace_write')).toBe(false);
    expect(isSafePermissionModeForIntent('scm_commit_message', 'workspace_write')).toBe(false);
    expect(isSafePermissionModeForIntent('scm_diff_summary', 'workspace_write')).toBe(false);
  });

  it('gates voice-agent execution through the canonical voice.agent feature decision', () => {
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.voice_agent.requiredFeatureId).toBe('voice.agent');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.task.requiredFeatureId).toBeUndefined();
  });

  it('uses the review bounded timeout override only for review runs', () => {
    expect(resolveExecutionRunStartBoundedTimeoutMs({
      policy: { boundedTimeoutMs: 30, reviewBoundedTimeoutMs: 60 },
      intent: 'review',
    })).toBe(60);
    expect(resolveExecutionRunStartBoundedTimeoutMs({
      policy: { boundedTimeoutMs: 30, reviewBoundedTimeoutMs: 60 },
      intent: 'delegate',
    })).toBe(30);
  });

  it('rejects retention, run-class, and io-mode combinations outside the intent policy matrix', () => {
    expect(validateExecutionRunStartIntentPolicy({
      intent: 'plan',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    })).toEqual({
      ok: false,
      error: 'Unsupported retentionPolicy',
      errorCode: 'execution_run_not_allowed',
      details: { issues: [{ code: 'invalid_value', path: ['retentionPolicy'], acceptedValues: ['ephemeral'] }] },
    });

    expect(validateExecutionRunStartIntentPolicy({
      intent: 'plan',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).toEqual({
      ok: false,
      error: 'Unsupported runClass',
      errorCode: 'execution_run_not_allowed',
      details: { issues: [{ code: 'invalid_value', path: ['runClass'], acceptedValues: ['bounded'] }] },
    });

    expect(validateExecutionRunStartIntentPolicy({
      intent: 'task',
      permissionMode: 'no_tools',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).toEqual({
      ok: false,
      error: 'Unsupported runClass',
      errorCode: 'execution_run_not_allowed',
      details: { issues: [{ code: 'invalid_value', path: ['runClass'], acceptedValues: ['bounded'] }] },
    });

    expect(validateExecutionRunStartIntentPolicy({
      intent: 'voice_agent',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).toEqual({
      ok: false,
      error: 'Unsupported ioMode',
      errorCode: 'execution_run_not_allowed',
      details: { issues: [{ code: 'invalid_value', path: ['ioMode'], acceptedValues: ['streaming'] }] },
    });
  });

  it('allows delegate combinations that remain inside the intent policy matrix', () => {
    expect(validateExecutionRunStartIntentPolicy({
      intent: 'delegate',
      permissionMode: 'workspace_write',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).toEqual({ ok: true });
  });

  it('allows the general Agent profile to declare bounded or retained native execution', () => {
    expect(validateExecutionRunStartIntentPolicy({
      intent: 'agent',
      permissionMode: 'workspace_write',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    })).toEqual({ ok: true });
  });
});
