export const SLACK_PLUGIN_ID = 'happier.channel.slack';
export const SLACK_CONNECTED_ACCOUNT_ID = 'slack-bot';
export const SLACK_CREDENTIAL_PURPOSE = 'slack-credentials';
export const SLACK_BOT_TOKEN_ENVIRONMENT_KEY = 'SLACK_BOT_TOKEN';
export const SLACK_APP_TOKEN_ENVIRONMENT_KEY = 'SLACK_APP_TOKEN';
export const SLACK_SOCKET_BACKGROUND_SERVICE_ID = 'socket-supervisor';
export const SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID = 'slack/socket-worker-attempt';
export const SLACK_CHANNEL_ACTION_IDS = Object.freeze({
  setup: 'slack/prepare-bot',
  connectionTest: 'slack/inspect-connection',
  endpointResolve: 'slack/choose-channel',
  principalResolve: 'slack/resolve-user',
  messageDeliver: 'slack/post-message',
  connectionStop: 'slack/halt-socket',
});

export function createSlackChannelEndpointId(teamId: string, channelId: string): string {
  return `slack:${teamId}:channel:${channelId}`;
}

export function createSlackThreadEndpointId(teamId: string, channelId: string, threadTs: string): string {
  return `${createSlackChannelEndpointId(teamId, channelId)}:thread:${threadTs}`;
}

export function createSlackPrincipalId(teamId: string, userId: string): string {
  return `slack:${teamId}:user:${userId}`;
}

export function readSlackEndpointId(value: string): Readonly<{ teamId: string; channelId: string; threadTs?: string }> | null {
  const match = /^slack:([A-Z0-9]+):channel:([A-Z0-9]+)(?::thread:([0-9]+\.[0-9]+))?$/.exec(value);
  if (!match) return null;
  return { teamId: match[1], channelId: match[2], ...(match[3] === undefined ? {} : { threadTs: match[3] }) };
}
