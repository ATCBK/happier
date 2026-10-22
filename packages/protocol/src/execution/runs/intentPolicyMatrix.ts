import { ExecutionRunIntentSchema, type ExecutionRunIntent, type ExecutionRunRetentionPolicy,
  type ExecutionRunClass, type ExecutionRunIoMode } from './runPrimitives.js';

export type ExecutionRunIntentPolicyConstraint = Readonly<{
  /** The first accepted value is the friendly CLI default. */
  allowedRetentionPolicies: readonly [ExecutionRunRetentionPolicy, ...ExecutionRunRetentionPolicy[]];
  allowedRunClasses: readonly [ExecutionRunClass, ...ExecutionRunClass[]];
  allowedIoModes: readonly [ExecutionRunIoMode, ...ExecutionRunIoMode[]];
  description: string;
  invariant: string;
}>;

export const EXECUTION_RUN_INTENT_POLICY_MATRIX: Readonly<Record<ExecutionRunIntent, ExecutionRunIntentPolicyConstraint>> = Object.freeze({
  review: {
    description: 'Review changes with structured findings and follow-up actions.',
    allowedRetentionPolicies: ['ephemeral', 'resumable'],
    allowedRunClasses: ['bounded', 'long_lived'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep review structured-output semantics and follow-up action behavior.',
  },
  plan: {
    description: 'Produce a bounded structured plan.',
    allowedRetentionPolicies: ['ephemeral'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep plan structured-output semantics and bounded profile behavior.',
  },
  delegate: {
    description: 'Delegate ordinary bounded child work, or retain a child for continued steering.',
    allowedRetentionPolicies: ['ephemeral', 'resumable'],
    allowedRunClasses: ['bounded', 'long_lived'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep delegate structured-output behavior and long-lived steering semantics.',
  },
  agent: {
    description: 'Run a general Agent with optional exact per-turn results.',
    allowedRetentionPolicies: ['ephemeral', 'resumable'],
    allowedRunClasses: ['bounded', 'long_lived'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep general Agent execution on the native runtime with optional exact per-turn results.',
  },
  task: {
    description: 'Execute a bounded non-interactive task, including detached work.',
    allowedRetentionPolicies: ['ephemeral'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response'],
    invariant: 'Keep generic task execution bounded, detached-safe, and non-interactive.',
  },
  voice_agent: {
    description: 'Maintain an ongoing Voice conversation with long-lived streaming interaction.',
    allowedRetentionPolicies: ['resumable'],
    allowedRunClasses: ['long_lived'],
    allowedIoModes: ['streaming'],
    invariant: 'Keep voice-specific long-lived streaming lifecycle and action semantics.',
  },
  memory_hints: {
    description: 'Generate internal read-only memory hints.',
    allowedRetentionPolicies: ['ephemeral'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response'],
    invariant: 'Keep memory_hints constrained/internal with safe permission behavior.',
  },
  scm_commit_message: {
    description: 'Generate a read-only SCM commit message.',
    allowedRetentionPolicies: ['ephemeral'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response'],
    invariant: 'Keep SCM commit-message generation read-only and execution-run-owned.',
  },
  scm_diff_summary: {
    description: 'Retain read-only SCM analysis and publish structured summaries per turn.',
    allowedRetentionPolicies: ['resumable'],
    allowedRunClasses: ['long_lived'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep SCM analysis read-only with structured publication on each retained turn.',
  },
});

/** Discovery and friendly defaults consume the same constraints as runtime admission. */
export const EXECUTION_RUN_INTENT_OPTIONS = ExecutionRunIntentSchema.options.map(value => {
  const policy = EXECUTION_RUN_INTENT_POLICY_MATRIX[value];
  return { value, label: value, description: `${policy.description} retentionPolicy: ${policy.allowedRetentionPolicies.join(' | ')}; runClass: ${policy.allowedRunClasses.join(' | ')}; ioMode: ${policy.allowedIoModes.join(' | ')}.` };
});
