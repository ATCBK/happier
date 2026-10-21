import type * as React from 'react';

import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/**
 * The existing mounted Session composer's render contract. A host seats `content` once,
 * in the screen or its sheet; it never creates another controller or copies its draft.
 * The mounted Session retains the controller and its Account/context lifetime.
 */
export type SessionComposerModel = Readonly<{
    content: React.ReactNode;
    ref: ComposerRefV1;
    address: SessionAddress;
    sending: boolean;
    focus: () => void;
}>;

export type SessionComposerRenderer = (composer: SessionComposerModel) => React.ReactNode;
