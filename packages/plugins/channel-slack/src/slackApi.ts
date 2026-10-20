import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { ConversationDeliveryResultV1, ConversationProviderFailureV1 } from '@happier-dev/channels-protocol/v1';
import type { SlackMessagePayload } from './slackDelivery.js';
export type SlackCredentials = Readonly<{ botToken: string; appToken: string }>;
export type SlackIdentity = Readonly<{ teamId: string; appId: string; botUserId: string; botId: string; label: string }>;
export type SlackChannel = Readonly<{ id: string; isIm: boolean; isMpim: boolean; isPrivate: boolean; name?: string; isArchived: boolean }>;
export type SlackApiFailure = ConversationProviderFailureV1;
export function createSlackApi(_input: Readonly<{ credentials: SlackCredentials; http: Pick<HttpService, 'request'> }>) {
  const failure: SlackApiFailure = { kind: 'notReady', reason: 'invalidConfiguration' };
  return {
    async getIdentity(_options?: { signal?: AbortSignal }): Promise<SlackIdentity | SlackApiFailure> { return failure; },
    async openConnection(_options?: { signal?: AbortSignal }): Promise<{ url: string } | SlackApiFailure> { return failure; },
    async getChannel(_id: string, _options?: { signal?: AbortSignal }): Promise<SlackChannel | SlackApiFailure> { return failure; },
    async getUser(_id: string, _options?: { signal?: AbortSignal }): Promise<{ id: string; teamId: string; isBot: boolean; deleted: boolean; label: string } | SlackApiFailure> { return failure; },
    async postMessage(_payload: SlackMessagePayload, _options?: { signal?: AbortSignal }): Promise<ConversationDeliveryResultV1> { return failure; },
  };
}
