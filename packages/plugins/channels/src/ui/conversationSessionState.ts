import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';

/** Module-stable selector shared by the row consumer and the 2,000-Session owner measurement. */
export function selectChannelsConversationSessionState(state: SessionStateV1) {
  return {
    workStatus: state.workStatus,
    hasUnreadMessages: state.hasUnreadMessages,
    latestActivity: state.latestActivity ?? { kind: 'unavailable' as const },
  };
}

export type ChannelsConversationSessionState = ReturnType<typeof selectChannelsConversationSessionState>;
