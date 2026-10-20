import type {
    AutomationRunCause as ProtocolAutomationRunCause,
    AutomationRunCauseDeclarationV1 as ProtocolAutomationRunCauseDeclarationV1,
    PluginSourceCustodyV1,
} from '@happier-dev/protocol';
import { describe, expectTypeOf, it } from 'vitest';

import type {
    MessageActionAvailableSnapshotV1,
    PluginAutomationRunCause,
    PluginInvocationCaller,
    PluginInvocationContext,
    PluginInvocationSurface,
} from './invocation.js';
import type { MessageActionAvailableSnapshotV1 as PublicMessageActionAvailableSnapshotV1 } from './index.js';
import type { PluginInvocationContributionIdentity } from './identity.js';
import type { PluginMachineMaterializationRefV1, PluginMachineExecutionOriginV1 } from './executionOrigin.js';

type IsRequired<TValue, TKey extends keyof TValue> = {} extends Pick<TValue, TKey>
    ? false
    : true;

type ExpectedMessageActionAvailableSnapshotV1 = Readonly<{
    sessionId: string;
    messageId: string;
    observedRevision: string;
    role: 'user' | 'agent' | 'event' | 'unknown';
    contentCategory: 'text' | 'structured';
    seq: number;
    visibleText: string | null;
    structuredPresentationSummary: string | null;
    provenanceCategory:
        | 'owner'
        | 'collaborator'
        | 'plugin'
        | 'external_human'
        | 'automation'
        | 'voice'
        | 'terminal'
        | 'recovered_history'
        | 'unknown';
}>;

describe('Plugin invocation context', () => {
    it('makes the executing surface and host-stamped caller explicit', () => {
        const surfaceIsRequired: IsRequired<PluginInvocationContext, 'surface'> = true;
        const invokedAtMsIsRequired: IsRequired<PluginInvocationContext, 'invokedAtMs'> = true;
        void surfaceIsRequired;
        void invokedAtMsIsRequired;

        expectTypeOf<PluginInvocationContext['invokedAtMs']>().toEqualTypeOf<number>();

        expectTypeOf<PluginInvocationSurface>().toEqualTypeOf<
            'cli' | 'mcp' | 'agent' | 'ui' | 'voice' | 'background' | 'api' | 'plugin'
        >();
        expectTypeOf<PluginInvocationCaller>().toEqualTypeOf<
            | Readonly<{
                kind: 'plugin';
                pluginId: string;
                contribution: PluginInvocationContributionIdentity;
                occurrenceId: string;
                sourceCustody: PluginSourceCustodyV1;
                materialization?: PluginMachineMaterializationRefV1;
                executionOrigin?: PluginMachineExecutionOriginV1;
                originSurface?: 'cli' | 'mcp' | 'agent' | 'ui' | 'voice' | 'background' | 'api';
            }>
            | Readonly<{
                kind: 'host';
                domain: 'ingress';
                originSurface: 'webhook';
                contribution: PluginInvocationContributionIdentity;
            }>
            | Readonly<{
                kind: 'automationRun';
                runId: string;
                automationId: string;
                cause: PluginAutomationRunCause;
            }>
        >();
        expectTypeOf<PluginInvocationContext['caller']>()
            .toEqualTypeOf<PluginInvocationCaller | undefined>();
        // Protocol owns the canonical parsed cause and its single
        // declaration-neutral projection; the SDK name is an exact alias of
        // that projection. Bidirectional equality is the contract, so a
        // restated structural copy (readonly wrappers, unbranded identities)
        // fails here instead of passing assignability.
        expectTypeOf<PluginAutomationRunCause>()
            .toEqualTypeOf<ProtocolAutomationRunCauseDeclarationV1>();
        expectTypeOf<ProtocolAutomationRunCauseDeclarationV1>()
            .toEqualTypeOf<PluginAutomationRunCause>();
        expectTypeOf<ProtocolAutomationRunCause>()
            .toMatchTypeOf<PluginAutomationRunCause>();
        expectTypeOf<PluginInvocationContext['ui']>()
            .toEqualTypeOf<import('./interactions.js').PresentationService | undefined>();
        expectTypeOf<MessageActionAvailableSnapshotV1>()
            .toEqualTypeOf<ExpectedMessageActionAvailableSnapshotV1>();
        expectTypeOf<PluginInvocationContext['messageAction']>()
            .toEqualTypeOf<ExpectedMessageActionAvailableSnapshotV1 | undefined>();
        expectTypeOf<PluginInvocationContext['operation']>()
            .toEqualTypeOf<Readonly<{
                update(progress: Readonly<{
                    label?: string;
                    phase?: string;
                    current?: number;
                    total?: number;
                }>): void;
            }> | undefined>();
        expectTypeOf<PublicMessageActionAvailableSnapshotV1>()
            .toEqualTypeOf<ExpectedMessageActionAvailableSnapshotV1>();
    });
});
