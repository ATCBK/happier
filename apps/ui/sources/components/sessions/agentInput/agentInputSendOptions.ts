import type { PendingResetStartBindingV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { SessionComposerMessageIntent } from '@/components/sessions/composer/sessionComposerMessaging';

import type { MessageSendMode } from '@/sync/domains/session/control/submitMode';

export type AgentInputSendOptions = Readonly<{
    forceImmediate?: boolean;
    sendNextQueued?: boolean;
    deliveryIntent?: MessageSendMode;
    structuredInputMetaOverrides?: Record<string, unknown>;
    inputTextOverride?: string;
    resetStart?: PendingResetStartBindingV1;
    sessionMessage?: SessionComposerMessageIntent;
}>;

export type AgentInputSendIntentOptions = Readonly<Pick<AgentInputSendOptions, 'forceImmediate' | 'deliveryIntent' | 'resetStart' | 'sessionMessage'>>;
