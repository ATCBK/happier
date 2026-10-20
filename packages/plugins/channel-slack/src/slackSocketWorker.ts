import type { ConversationProviderFailureV1, ConversationProviderObservationIngestInputV1 } from '@happier-dev/channels-protocol/v1';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { createSlackApi, SlackIdentity } from './slackApi.js';

/** Inert test-first scaffold; no transport behavior is implemented or activated. */
export type SlackSocketWorkerResult =
  | Readonly<{ kind: 'stopped'; unprovenContinuity?: true }>
  | Readonly<{ kind: 'historyGap'; reason: 'applicationAdmissionLost' | 'providerHistoryUnavailable' }>
  | Readonly<{ kind: 'notReady'; failure: ConversationProviderFailureV1 }>;
export type SlackSocketWorkerInput = Readonly<{
  connection: Readonly<{ connectionId: string; authorityEpoch: number; identity: SlackIdentity }>;
  api: Pick<ReturnType<typeof createSlackApi>, 'openConnection' | 'getChannel'>;
  webSockets: Pick<HttpService, 'openWebSocket'>;
  admitObservation(value: ConversationProviderObservationIngestInputV1, options: Readonly<{ signal: AbortSignal }>): Promise<void>;
  reportConnectionStatus?(status: 'ready'): void | Promise<void>;
  signal: AbortSignal;
}>;
export type SlackSocketWorker = Readonly<{ result: Promise<SlackSocketWorkerResult>; stop(): void }>;
export function startSlackSocketWorker(_input: SlackSocketWorkerInput): SlackSocketWorker {
  return { result: Promise.resolve({ kind: 'stopped' }), stop() {} };
}
export async function verifySlackSocketIdentity(_input: Readonly<{
  api: Pick<ReturnType<typeof createSlackApi>, 'openConnection'>;
  webSockets: Pick<HttpService, 'openWebSocket'>;
  identity: SlackIdentity;
  signal: AbortSignal;
}>): Promise<ConversationProviderFailureV1 | null> {
  return { kind: 'notReady', reason: 'invalidConfiguration' };
}
