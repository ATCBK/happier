import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

export const slackConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { 'bot-tokens': { kind: 'manual', async complete() {
    return { status: 'rejected', diagnostic: { code: 'slack_unimplemented', severity: 'error', message: 'Slack credentials unavailable.' } };
  } } } },
  async refresh() { return { status: 'unavailable' }; },
  async status() { return { status: 'unavailable' }; },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize() { return { kind: 'environment', env: {} }; },
};
