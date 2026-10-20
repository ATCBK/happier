import { describe, expect, it } from 'vitest';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows';

import {
  resolveWorkflowConversationBinding,
  resolveWorkflowConversationSelection,
  workflowConversationAdmissionKey,
} from './workflowConversation';

const invocation = {
  kind: 'happier.workflow-progress.v1', blockKind: 'step',
  invocationPath: { blockId: 'tail', scope: [] }, attempt: '1', logicalInvocationRecordId: 'logical-tail',
} satisfies WorkflowProgressEnvelopeV1;

describe('workflow authored conversation binding', () => {
  it('binds inherited sharing to the concurrent body, and only explicit sharing to the root', () => {
    const scope = { inheritedOwnerKey: 'item-body', rootOwnerKey: 'root', targetClass: 'session' as const };
    const inherited = resolveWorkflowConversationBinding({ ...scope, execution: { conversation: { kind: 'shared_run' } } });
    const explicit = resolveWorkflowConversationBinding({ ...scope,
      execution: { conversation: { kind: 'shared_run' } }, authoredConversation: { kind: 'shared_run' } });
    expect(inherited).toEqual({ kind: 'shared', scopeOwnerKey: 'item-body', targetClass: 'session' });
    expect(explicit).toEqual({ kind: 'shared', scopeOwnerKey: 'root', targetClass: 'session' });
    expect(resolveWorkflowConversationBinding({ ...scope, execution: { conversation: { kind: 'fresh' } } }))
      .toEqual({ kind: 'fresh' });
  });

  it('keeps one gate per scope and class before and after native identity publication', () => {
    const detached = { kind: 'shared' as const, scopeOwnerKey: 'item-body', targetClass: 'detached_run' as const };
    expect(workflowConversationAdmissionKey(detached)).toBe(workflowConversationAdmissionKey(detached, 'new-native-run'));
    expect(workflowConversationAdmissionKey(detached)).not.toBe(workflowConversationAdmissionKey({ ...detached, targetClass: 'session' }));
    expect(workflowConversationAdmissionKey(detached)).not.toBe(workflowConversationAdmissionKey({ ...detached, scopeOwnerKey: 'other-item' }));
    expect(workflowConversationAdmissionKey({ kind: 'fresh' }, 'new-native-run')).toBeUndefined();
  });
});

describe('workflow exact input and recovery precedence', () => {
  const previous = { kind: 'detached_run' as const, runId: 'previous-native', localInputId: 'previous-input', runtimeSelection: {},
    providerResumeIdentity: { kind: 'provider_session.v1' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'claude' }, providerSessionId: 'provider-exact' } };
  const params = { runId: 'workflow-run', invocation, execution: {}, recoveryPreviousExecution: previous };

  it('observes an admitted current input even with fresh recovery and a different prior target', () => {
    const current = { kind: 'session' as const, sessionId: 'current-session', localInputId: 'current-input' };
    expect(resolveWorkflowConversationSelection({ ...params,
      invocation: { ...invocation, execution: current, recovery: { conversation: 'fresh_agent', input: { kind: 'original' } } },
      execution: { conversation: { kind: 'fresh' } },
    })).toEqual({ kind: 'observe', execution: current });
  });

  it('fresh recovery overrides shared selection, while same recovery preserves the entire native correspondence', () => {
    const shared = { kind: 'shared' as const, scopeOwnerKey: 'item-body', targetClass: 'detached_run' as const };
    expect(resolveWorkflowConversationSelection({ ...params, conversationBinding: shared,
      invocation: { ...invocation, recovery: { conversation: 'fresh_agent', input: { kind: 'original' } } },
    })).toEqual({ kind: 'select', binding: { kind: 'fresh' } });
    expect(resolveWorkflowConversationSelection({ ...params, conversationBinding: { kind: 'fresh' },
      execution: { conversation: { kind: 'fresh' } },
      invocation: { ...invocation, recovery: { conversation: 'same_conversation', input: { kind: 'original' } } },
    })).toEqual({ kind: 'retained', execution: previous });
  });

  it('refuses missing same-conversation evidence without falling back to a fresh or shared target', () => {
    expect(resolveWorkflowConversationSelection({ runId: 'workflow-run', execution: { conversation: { kind: 'fresh' } },
      invocation: { ...invocation, recovery: { conversation: 'same_conversation', input: { kind: 'original' } } },
    })).toEqual({ kind: 'unavailable' });
  });

  it('refuses an unmaterialized conversation input before either execution target can select a fresh conversation', () => {
    for (const kind of ['session', 'detached_run'] as const) {
      expect(resolveWorkflowConversationSelection({ runId: 'workflow-run', invocation,
        execution: { conversation: { kind: 'input', name: 'selected-session' } }, executionTarget: { kind },
      })).toEqual({ kind: 'unavailable' });
    }
  });
});
