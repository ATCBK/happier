import type { ConversationDeliveryLinkPreviewPolicyV1 } from '@happier-dev/channels-protocol/v1';

export type SlackMessagePayload = Readonly<{
  channel: string; text: string; thread_ts?: string; mrkdwn: false; parse: 'none'; link_names: false;
  unfurl_links: boolean; unfurl_media: boolean;
}>;

export function createSlackMessagePayload(input: Readonly<{
  channelId: string; text: string; threadTs?: string; linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1;
}>): SlackMessagePayload {
  return { channel: input.channelId, text: input.text, mrkdwn: false, parse: 'none', link_names: false,
    unfurl_links: false, unfurl_media: false };
}
