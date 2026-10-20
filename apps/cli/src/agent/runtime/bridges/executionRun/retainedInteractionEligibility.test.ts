import { describe, expect, it } from 'vitest';

import {
    selectExecutionRunSessionAdapter,
    type ExecutionRunSessionAdapterInput,
} from './retainedInteractionEligibility';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';

const sessionCapable: AgentSessionCapabilities = {
    open: ['create', 'resume'],
    delivery: ['newTurn', 'steer'],
    cancel: true,
};

function input(overrides: Partial<ExecutionRunSessionAdapterInput> = {}): ExecutionRunSessionAdapterInput {
    return {
        scope: 'session_owned',
        hasParentSessionCustody: true,
        agentExposesSessionRuntime: true,
        agentExposesDetachedConversation: true,
        sessionCapabilities: sessionCapable,
        intent: 'delegate',
        runClass: 'long_lived',
        retentionPolicy: 'resumable',
        ...overrides,
    };
}

describe('selectExecutionRunSessionAdapter', () => {
    const cases: readonly (readonly [string, ExecutionRunSessionAdapterInput, ReturnType<typeof selectExecutionRunSessionAdapter>])[] = [
        [
            'a non-Voice Session-owned long-lived resumable delegate selects the retained interaction',
            input(),
            'retained_agent_session',
        ],
        [
            'Voice keeps the retained interaction it already uses',
            input({ intent: 'voice_agent', runClass: 'long_lived', retentionPolicy: 'resumable' }),
            'retained_agent_session',
        ],
        [
            'a bounded Review keeps its Session available for host repair turns',
            input({ intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral' }),
            'retained_agent_session',
        ],
        [
            'a long-lived ephemeral run retains input until host settlement',
            input({ retentionPolicy: 'ephemeral' }),
            'retained_agent_session',
        ],
        [
            'a detached long-lived ephemeral run retains its conversation',
            input({ scope: 'detached', hasParentSessionCustody: false, retentionPolicy: 'ephemeral' }),
            'retained_agent_conversation',
        ],
        [
            'a resumable bounded run keeps its Session until host settlement',
            input({ runClass: 'bounded' }),
            'retained_agent_session',
        ],
        [
            'a detached long-lived run retains its provider-native Session without parent custody',
            input({ scope: 'detached', hasParentSessionCustody: false }),
            'retained_agent_conversation',
        ],
        [
            'a Session-owned long-lived run without exact parent custody stays finite',
            input({ scope: 'session_owned', hasParentSessionCustody: false }),
            'finite_agent_session',
        ],
        [
            'a detached run never consumes accidentally supplied parent custody',
            input({ scope: 'detached', hasParentSessionCustody: true }),
            'retained_agent_conversation',
        ],
        [
            'a finite-only detached facet completes work without requiring a retained conversation',
            input({ scope: 'detached', hasParentSessionCustody: false, agentExposesDetachedConversation: false }),
            'finite_agent_session',
        ],
        [
            'an Agent without declared Session capabilities cannot be retained',
            input({ sessionCapabilities: null }),
            'finite_agent_session',
        ],
        [
            'an Agent that cannot create a Session cannot be retained',
            input({ sessionCapabilities: { ...sessionCapable, open: ['fork'] } }),
            'finite_agent_session',
        ],
        [
            'an Agent that cannot take a new turn cannot be retained',
            input({ sessionCapabilities: { ...sessionCapable, delivery: ['followUp'] } }),
            'finite_agent_session',
        ],
        [
            'an Agent whose genuine owner is native execution runs keeps that adapter',
            input({ agentExposesSessionRuntime: false }),
            'native_execution_run',
        ],
        [
            'a detached run on an execution-primary Agent keeps the native adapter',
            input({ scope: 'detached', agentExposesSessionRuntime: false, hasParentSessionCustody: false }),
            'native_execution_run',
        ],
    ];

    for (const [name, value, expected] of cases) {
        it(name, () => {
            expect(selectExecutionRunSessionAdapter(value)).toBe(expected);
        });
    }

    it('does not select retained interaction from an intent allowlist', () => {
        // The former Voice-only special case must not come back as a longer list of
        // intent names: lifecycle plus declared capability is the whole rule.
        expect(selectExecutionRunSessionAdapter(input({ intent: 'voice_agent', runClass: 'bounded' })))
            .toBe('retained_agent_session');
        expect(selectExecutionRunSessionAdapter(input({ intent: 'scm_commit_message', runClass: 'long_lived' })))
            .toBe('retained_agent_session');
    });
});
