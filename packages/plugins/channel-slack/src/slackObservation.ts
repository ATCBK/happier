import type { ConversationNormalizedIngressV1 } from '@happier-dev/channels-protocol/v1';
import type { SlackChannel, SlackIdentity } from './slackApi.js';

/** Inert test-first scaffold; dependency admission blocked RED, so this is not wired into the plugin. */
export function mapSlackEventToIngress(_input: Readonly<{ payload: unknown; identity: SlackIdentity; channel: SlackChannel }>): ConversationNormalizedIngressV1 | null {
  return null;
}
