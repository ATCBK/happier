import type {
  ConnectedAccountAuthenticationContext,
  ConnectedAccountAuthCompletionResult,
  ConnectedAccountHealthResult,
  ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { createSlackApi, type SlackApiFailure, type SlackCredentials, type SlackIdentity } from '../slackApi.js';
import { SLACK_APP_TOKEN_ENVIRONMENT_KEY, SLACK_BOT_TOKEN_ENVIRONMENT_KEY } from '../slackPluginConstants.js';

const BOT_TOKEN_KEY = 'botToken';
const APP_TOKEN_KEY = 'appToken';
type ReadContext = Parameters<ConnectedAccountRuntime['status']>[0];
type ProbeFailure = Extract<ConnectedAccountAuthCompletionResult, Readonly<{ status: 'rejected' | 'unavailable' }>>;
type ProbeResult = Readonly<{ status: 'confirmed'; identity: SlackIdentity }> | ProbeFailure;

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

function validCredentials(credentials: SlackCredentials): boolean {
  return /^xoxb-\S+$/.test(credentials.botToken) && /^xapp-\S+$/.test(credentials.appToken);
}

function probeFailure(failure: SlackApiFailure): ProbeFailure {
  return failure.reason === 'credentialInvalid'
    ? { status: 'rejected', diagnostic: diagnostic('slack_credentials_rejected', 'Slack rejected the credentials; reconnect the account.') }
    : { status: 'unavailable', diagnostic: diagnostic('slack_identity_unavailable', 'Slack identity and Socket Mode access could not be confirmed.') };
}

async function confirmCredentials(
  credentials: SlackCredentials,
  context: Pick<ConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ProbeResult> {
  const signal = options?.signal ?? context.signal;
  const api = createSlackApi({ credentials, http: context.services.http });
  const identity = await api.getIdentity({ signal });
  if ('kind' in identity) return probeFailure(identity);
  const connection = await api.openConnection({ signal });
  if ('kind' in connection) return probeFailure(connection);
  // This proves both credentials work. The shared Socket Mode hello verifier
  // proves their app correspondence during provider setup and worker startup.
  return { status: 'confirmed', identity };
}

async function readCredentials(context: Pick<ReadContext, 'credentials'>, options?: Readonly<{ signal?: AbortSignal }>): Promise<SlackCredentials> {
  const [botToken, appToken] = await Promise.all([
    context.credentials.get(BOT_TOKEN_KEY, options), context.credentials.get(APP_TOKEN_KEY, options),
  ]);
  return { botToken: botToken?.trim() ?? '', appToken: appToken?.trim() ?? '' };
}

async function health(context: ReadContext, options?: Readonly<{ signal?: AbortSignal }>): Promise<ConnectedAccountHealthResult> {
  const credentials = await readCredentials(context, options);
  if (!validCredentials(credentials)) {
    return { status: 'unavailable', diagnostic: diagnostic('slack_credentials_unavailable', 'Slack credentials are unavailable; reconnect the account.') };
  }
  const result = await confirmCredentials(credentials, context, options);
  if (result.status === 'confirmed') return { status: 'connected', displayName: result.identity.label, scopes: [] };
  return { status: result.status === 'rejected' ? 'reconnectRequired' : 'unavailable', diagnostic: result.diagnostic };
}

const runtime: ConnectedAccountRuntime = {
  authentication: {
    modes: {
      'bot-tokens': {
        kind: 'manual',
        async complete(input, context, options) {
          const credentials = { botToken: input.fields.botToken?.trim() ?? '', appToken: input.fields.appToken?.trim() ?? '' };
          if (!validCredentials(credentials)) {
            return { status: 'rejected', diagnostic: diagnostic('slack_credentials_invalid', 'Slack requires an xoxb bot token and an xapp app-level token.') };
          }
          const result = await confirmCredentials(credentials, context, options);
          if (result.status !== 'confirmed') return result;
          await context.attemptCredentials.set(BOT_TOKEN_KEY, credentials.botToken, options);
          await context.attemptCredentials.set(APP_TOKEN_KEY, credentials.appToken, options);
          const identity = result.identity;
          return {
            status: 'connected', accountId: `team:${identity.teamId}:app:${identity.appId}:bot:${identity.botUserId}`,
            providerIdentity: { accountId: `${identity.teamId}:${identity.appId}:${identity.botUserId}` },
            displayName: identity.label, scopes: [],
          };
        },
      },
    },
  },
  async refresh(context, options) { return await health(context, options); },
  async status(context, options) { return await health(context, options); },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context, options) {
    if (request.kind !== 'environment') throw new Error('Slack credentials support only environment materialization.');
    const credentials = await readCredentials(context, options);
    if (!validCredentials(credentials)) throw new Error('Slack connected-account credentials are unavailable.');
    const env: Record<string, string> = {};
    if (request.keys.includes(SLACK_BOT_TOKEN_ENVIRONMENT_KEY)) env[SLACK_BOT_TOKEN_ENVIRONMENT_KEY] = credentials.botToken;
    if (request.keys.includes(SLACK_APP_TOKEN_ENVIRONMENT_KEY)) env[SLACK_APP_TOKEN_ENVIRONMENT_KEY] = credentials.appToken;
    return { kind: 'environment', env };
  },
};

export const slackConnectedAccountRuntime = Object.freeze(runtime);
