import type { PendingResetStartBindingV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';

export type AgentInputSendOptions = Readonly<{
    forceImmediate?: boolean;
    deliveryIntent?: 'server_pending';
    structuredInputMetaOverrides?: Record<string, unknown>;
    inputTextOverride?: string;
    resetStart?: PendingResetStartBindingV1;
}>;

export type AgentInputSendIntentOptions = Readonly<Pick<AgentInputSendOptions, 'forceImmediate' | 'deliveryIntent' | 'resetStart'>>;
