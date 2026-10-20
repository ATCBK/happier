import type {
    Metadata,
} from '@/api/types';
import type { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';

import type { SessionUsageObservationPublisher } from '../usagePublishing';

export type PostSendReactionPort = Readonly<{
    sessionId: string;
    getAgentStateRequestStore?: () => AgentStateRequestStore | null;
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
    getMetadataSnapshot: () => Metadata | null;
    usageObservationPublisher: SessionUsageObservationPublisher;
}>;
