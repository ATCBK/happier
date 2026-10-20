import { definePlugin } from '@happier-dev/plugin-sdk';

// Keep the discovered workspace package loadable while its consumed provider
// vertical is assembled. Runtime roles are published together by this owner.
const slackPlugin = definePlugin({
  id: 'happier.channel.slack',
  version: '0.0.0',
  displayName: 'Slack Channels',
  description: 'Connects Slack conversations to Happier Channels.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
});

export const { manifest: PLUGIN_MANIFEST, activate } = slackPlugin;
export const manifest = PLUGIN_MANIFEST;
