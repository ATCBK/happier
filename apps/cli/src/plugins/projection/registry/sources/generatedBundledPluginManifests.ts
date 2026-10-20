/* eslint-disable @typescript-eslint/naming-convention */
/**
 * GENERATED FILE CONTRACT (WS1.T3)
 *
 * Data-only locator and provenance records.
 * Contribution declarations are ingested from generator-normalized manifest
 * data by the same canonical path used for installed plugins.
 */

import type { PluginSourceSpecV1 } from '@happier-dev/protocol/plugins/source-spec';

export type BundledFirstPartyPluginMetadata = Readonly<{
  agentId?: string;
  pluginId: string;
  pluginPackageId: string;
  packageName: string;
  packageVersion: string;
  manifestPath: string;
}>;

export type BundledFirstPartyPluginLocator = Readonly<{
  pluginId: string;
  manifestRelativePath: string;
  manifestPath: string;
  daemonEntryPath: string | null;
  devDaemonEntryPath?: string | null;
  sourceSpec: PluginSourceSpecV1;
}>;

export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([
  "@happier-dev/plugins-antigravity",
  "@happier-dev/plugins-app-context",
  "@happier-dev/plugins-auggie",
  "@happier-dev/plugins-channel-discord",
  "@happier-dev/plugins-channel-email",
  "@happier-dev/plugins-channel-slack",
  "@happier-dev/plugins-channel-telegram",
  "@happier-dev/plugins-channels",
  "@happier-dev/plugins-claude",
  "@happier-dev/plugins-cliproxyapi",
  "@happier-dev/plugins-codebuddy",
  "@happier-dev/plugins-codex",
  "@happier-dev/plugins-copilot",
  "@happier-dev/plugins-cursor",
  "@happier-dev/plugins-custom-acp",
  "@happier-dev/plugins-deepseek",
  "@happier-dev/plugins-devin",
  "@happier-dev/plugins-droid",
  "@happier-dev/plugins-elevenlabs",
  "@happier-dev/plugins-fx",
  "@happier-dev/plugins-gemini",
  "@happier-dev/plugins-google",
  "@happier-dev/plugins-grok",
  "@happier-dev/plugins-inspector",
  "@happier-dev/plugins-jira",
  "@happier-dev/plugins-kilo",
  "@happier-dev/plugins-kimi",
  "@happier-dev/plugins-kiro",
  "@happier-dev/plugins-lang-typescript",
  "@happier-dev/plugins-linear",
  "@happier-dev/plugins-lmstudio",
  "@happier-dev/plugins-machine-boat",
  "@happier-dev/plugins-machine-crabbox",
  "@happier-dev/plugins-machine-cua",
  "@happier-dev/plugins-machine-digitalocean",
  "@happier-dev/plugins-machine-docker-sandboxes",
  "@happier-dev/plugins-machine-fly",
  "@happier-dev/plugins-machine-hetzner",
  "@happier-dev/plugins-machine-lima",
  "@happier-dev/plugins-machine-lume",
  "@happier-dev/plugins-machine-modal",
  "@happier-dev/plugins-minimax",
  "@happier-dev/plugins-ohmypi",
  "@happier-dev/plugins-ollama",
  "@happier-dev/plugins-openai",
  "@happier-dev/plugins-openai-compat",
  "@happier-dev/plugins-openai-models",
  "@happier-dev/plugins-opencode",
  "@happier-dev/plugins-openrouter",
  "@happier-dev/plugins-pi",
  "@happier-dev/plugins-posthog",
  "@happier-dev/plugins-qwen",
  "@happier-dev/plugins-review-coderabbit",
  "@happier-dev/plugins-review-deepsec",
  "@happier-dev/plugins-scm-azure-devops",
  "@happier-dev/plugins-scm-bitbucket",
  "@happier-dev/plugins-scm-git",
  "@happier-dev/plugins-scm-github",
  "@happier-dev/plugins-scm-gitlab",
  "@happier-dev/plugins-scm-sapling",
  "@happier-dev/plugins-sentry",
  "@happier-dev/plugins-triage",
  "@happier-dev/plugins-xai",
  "@happier-dev/plugins-zai",
]);

export const BUNDLED_FIRST_PARTY_PLUGIN_METADATA: readonly BundledFirstPartyPluginMetadata[] = Object.freeze(
[
  {
    "agentId": "antigravity",
    "manifestPath": "bundled:happier.agent.antigravity",
    "packageName": "@happier-dev/plugins-antigravity",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.antigravity",
    "pluginPackageId": "antigravity"
  },
  {
    "manifestPath": "bundled:happier.app-context",
    "packageName": "@happier-dev/plugins-app-context",
    "packageVersion": "0.0.0",
    "pluginId": "happier.app-context",
    "pluginPackageId": "app-context"
  },
  {
    "agentId": "auggie",
    "manifestPath": "bundled:happier.agent.auggie",
    "packageName": "@happier-dev/plugins-auggie",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.auggie",
    "pluginPackageId": "auggie"
  },
  {
    "manifestPath": "bundled:happier.channel.discord",
    "packageName": "@happier-dev/plugins-channel-discord",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channel.discord",
    "pluginPackageId": "channel-discord"
  },
  {
    "manifestPath": "bundled:happier.channel.email",
    "packageName": "@happier-dev/plugins-channel-email",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channel.email",
    "pluginPackageId": "channel-email"
  },
  {
    "manifestPath": "bundled:happier.channel.slack",
    "packageName": "@happier-dev/plugins-channel-slack",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channel.slack",
    "pluginPackageId": "channel-slack"
  },
  {
    "manifestPath": "bundled:happier.channel.telegram",
    "packageName": "@happier-dev/plugins-channel-telegram",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channel.telegram",
    "pluginPackageId": "channel-telegram"
  },
  {
    "manifestPath": "bundled:happier.channels",
    "packageName": "@happier-dev/plugins-channels",
    "packageVersion": "0.0.0",
    "pluginId": "happier.channels",
    "pluginPackageId": "channels"
  },
  {
    "agentId": "claude",
    "manifestPath": "bundled:happier.agent.claude",
    "packageName": "@happier-dev/plugins-claude",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.claude",
    "pluginPackageId": "claude"
  },
  {
    "manifestPath": "bundled:happier.provider.cliproxyapi",
    "packageName": "@happier-dev/plugins-cliproxyapi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.cliproxyapi",
    "pluginPackageId": "cliproxyapi"
  },
  {
    "agentId": "codebuddy",
    "manifestPath": "bundled:happier.agent.codebuddy",
    "packageName": "@happier-dev/plugins-codebuddy",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.codebuddy",
    "pluginPackageId": "codebuddy"
  },
  {
    "agentId": "codex",
    "manifestPath": "bundled:happier.agent.codex",
    "packageName": "@happier-dev/plugins-codex",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.codex",
    "pluginPackageId": "codex"
  },
  {
    "agentId": "copilot",
    "manifestPath": "bundled:happier.agent.copilot",
    "packageName": "@happier-dev/plugins-copilot",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.copilot",
    "pluginPackageId": "copilot"
  },
  {
    "agentId": "cursor",
    "manifestPath": "bundled:happier.agent.cursor",
    "packageName": "@happier-dev/plugins-cursor",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.cursor",
    "pluginPackageId": "cursor"
  },
  {
    "agentId": "custom-acp",
    "manifestPath": "bundled:happier.agent.custom-acp",
    "packageName": "@happier-dev/plugins-custom-acp",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.custom-acp",
    "pluginPackageId": "custom-acp"
  },
  {
    "manifestPath": "bundled:happier.provider.deepseek",
    "packageName": "@happier-dev/plugins-deepseek",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.deepseek",
    "pluginPackageId": "deepseek"
  },
  {
    "agentId": "devin",
    "manifestPath": "bundled:happier.agent.devin",
    "packageName": "@happier-dev/plugins-devin",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.devin",
    "pluginPackageId": "devin"
  },
  {
    "agentId": "droid",
    "manifestPath": "bundled:happier.agent.droid",
    "packageName": "@happier-dev/plugins-droid",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.droid",
    "pluginPackageId": "droid"
  },
  {
    "manifestPath": "bundled:happier.voice.elevenlabs",
    "packageName": "@happier-dev/plugins-elevenlabs",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.elevenlabs",
    "pluginPackageId": "elevenlabs"
  },
  {
    "agentId": "fx",
    "manifestPath": "bundled:happier.agent.fx",
    "packageName": "@happier-dev/plugins-fx",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.fx",
    "pluginPackageId": "fx"
  },
  {
    "agentId": "gemini",
    "manifestPath": "bundled:happier.agent.gemini",
    "packageName": "@happier-dev/plugins-gemini",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.gemini",
    "pluginPackageId": "gemini"
  },
  {
    "manifestPath": "bundled:happier.voice.google",
    "packageName": "@happier-dev/plugins-google",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.google",
    "pluginPackageId": "google"
  },
  {
    "agentId": "grok",
    "manifestPath": "bundled:happier.agent.grok",
    "packageName": "@happier-dev/plugins-grok",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.grok",
    "pluginPackageId": "grok"
  },
  {
    "manifestPath": "bundled:happier.inspector",
    "packageName": "@happier-dev/plugins-inspector",
    "packageVersion": "0.0.0",
    "pluginId": "happier.inspector",
    "pluginPackageId": "inspector"
  },
  {
    "manifestPath": "bundled:happier.jira",
    "packageName": "@happier-dev/plugins-jira",
    "packageVersion": "0.0.0",
    "pluginId": "happier.jira",
    "pluginPackageId": "jira"
  },
  {
    "agentId": "kilo",
    "manifestPath": "bundled:happier.agent.kilo",
    "packageName": "@happier-dev/plugins-kilo",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kilo",
    "pluginPackageId": "kilo"
  },
  {
    "agentId": "kimi",
    "manifestPath": "bundled:happier.agent.kimi",
    "packageName": "@happier-dev/plugins-kimi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kimi",
    "pluginPackageId": "kimi"
  },
  {
    "agentId": "kiro",
    "manifestPath": "bundled:happier.agent.kiro",
    "packageName": "@happier-dev/plugins-kiro",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.kiro",
    "pluginPackageId": "kiro"
  },
  {
    "manifestPath": "bundled:happier.language.typescript",
    "packageName": "@happier-dev/plugins-lang-typescript",
    "packageVersion": "0.0.0",
    "pluginId": "happier.language.typescript",
    "pluginPackageId": "lang-typescript"
  },
  {
    "manifestPath": "bundled:happier.linear",
    "packageName": "@happier-dev/plugins-linear",
    "packageVersion": "0.0.0",
    "pluginId": "happier.linear",
    "pluginPackageId": "linear"
  },
  {
    "manifestPath": "bundled:happier.provider.lmstudio",
    "packageName": "@happier-dev/plugins-lmstudio",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.lmstudio",
    "pluginPackageId": "lmstudio"
  },
  {
    "manifestPath": "bundled:happier.machine.boat",
    "packageName": "@happier-dev/plugins-machine-boat",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.boat",
    "pluginPackageId": "machine-boat"
  },
  {
    "manifestPath": "bundled:happier.machine.crabbox",
    "packageName": "@happier-dev/plugins-machine-crabbox",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.crabbox",
    "pluginPackageId": "machine-crabbox"
  },
  {
    "manifestPath": "bundled:happier.machine.cua",
    "packageName": "@happier-dev/plugins-machine-cua",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.cua",
    "pluginPackageId": "machine-cua"
  },
  {
    "manifestPath": "bundled:happier.machine.digitalocean",
    "packageName": "@happier-dev/plugins-machine-digitalocean",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.digitalocean",
    "pluginPackageId": "machine-digitalocean"
  },
  {
    "manifestPath": "bundled:happier.machine.docker-sandboxes",
    "packageName": "@happier-dev/plugins-machine-docker-sandboxes",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.docker-sandboxes",
    "pluginPackageId": "machine-docker-sandboxes"
  },
  {
    "manifestPath": "bundled:happier.machine.fly",
    "packageName": "@happier-dev/plugins-machine-fly",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.fly",
    "pluginPackageId": "machine-fly"
  },
  {
    "manifestPath": "bundled:happier.machine.hetzner",
    "packageName": "@happier-dev/plugins-machine-hetzner",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.hetzner",
    "pluginPackageId": "machine-hetzner"
  },
  {
    "manifestPath": "bundled:happier.machine.lima",
    "packageName": "@happier-dev/plugins-machine-lima",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.lima",
    "pluginPackageId": "machine-lima"
  },
  {
    "manifestPath": "bundled:happier.machine.lume",
    "packageName": "@happier-dev/plugins-machine-lume",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.lume",
    "pluginPackageId": "machine-lume"
  },
  {
    "manifestPath": "bundled:happier.machine.modal",
    "packageName": "@happier-dev/plugins-machine-modal",
    "packageVersion": "0.0.0",
    "pluginId": "happier.machine.modal",
    "pluginPackageId": "machine-modal"
  },
  {
    "manifestPath": "bundled:happier.provider.minimax",
    "packageName": "@happier-dev/plugins-minimax",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.minimax",
    "pluginPackageId": "minimax"
  },
  {
    "agentId": "ohmypi",
    "manifestPath": "bundled:happier.agent.ohmypi",
    "packageName": "@happier-dev/plugins-ohmypi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.ohmypi",
    "pluginPackageId": "ohmypi"
  },
  {
    "manifestPath": "bundled:happier.provider.ollama",
    "packageName": "@happier-dev/plugins-ollama",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.ollama",
    "pluginPackageId": "ollama"
  },
  {
    "manifestPath": "bundled:happier.voice.openai",
    "packageName": "@happier-dev/plugins-openai",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.openai",
    "pluginPackageId": "openai"
  },
  {
    "manifestPath": "bundled:happier.voice.openai-compat",
    "packageName": "@happier-dev/plugins-openai-compat",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.openai-compat",
    "pluginPackageId": "openai-compat"
  },
  {
    "manifestPath": "bundled:happier.provider.openai",
    "packageName": "@happier-dev/plugins-openai-models",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.openai",
    "pluginPackageId": "openai-models"
  },
  {
    "agentId": "opencode",
    "manifestPath": "bundled:happier.agent.opencode",
    "packageName": "@happier-dev/plugins-opencode",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.opencode",
    "pluginPackageId": "opencode"
  },
  {
    "manifestPath": "bundled:happier.provider.openrouter",
    "packageName": "@happier-dev/plugins-openrouter",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.openrouter",
    "pluginPackageId": "openrouter"
  },
  {
    "agentId": "pi",
    "manifestPath": "bundled:happier.agent.pi",
    "packageName": "@happier-dev/plugins-pi",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.pi",
    "pluginPackageId": "pi"
  },
  {
    "manifestPath": "bundled:happier.posthog",
    "packageName": "@happier-dev/plugins-posthog",
    "packageVersion": "0.0.0",
    "pluginId": "happier.posthog",
    "pluginPackageId": "posthog"
  },
  {
    "agentId": "qwen",
    "manifestPath": "bundled:happier.agent.qwen",
    "packageName": "@happier-dev/plugins-qwen",
    "packageVersion": "0.0.0",
    "pluginId": "happier.agent.qwen",
    "pluginPackageId": "qwen"
  },
  {
    "agentId": "coderabbit",
    "manifestPath": "bundled:happier.review.coderabbit",
    "packageName": "@happier-dev/plugins-review-coderabbit",
    "packageVersion": "0.0.0",
    "pluginId": "happier.review.coderabbit",
    "pluginPackageId": "review-coderabbit"
  },
  {
    "agentId": "deepsec",
    "manifestPath": "bundled:happier.review.deepsec",
    "packageName": "@happier-dev/plugins-review-deepsec",
    "packageVersion": "0.0.0",
    "pluginId": "happier.review.deepsec",
    "pluginPackageId": "review-deepsec"
  },
  {
    "manifestPath": "bundled:happier.scm.forge.azure-devops",
    "packageName": "@happier-dev/plugins-scm-azure-devops",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.forge.azure-devops",
    "pluginPackageId": "scm-azure-devops"
  },
  {
    "manifestPath": "bundled:happier.scm.forge.bitbucket",
    "packageName": "@happier-dev/plugins-scm-bitbucket",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.forge.bitbucket",
    "pluginPackageId": "scm-bitbucket"
  },
  {
    "manifestPath": "bundled:happier.scm.backend.git",
    "packageName": "@happier-dev/plugins-scm-git",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.backend.git",
    "pluginPackageId": "scm-git"
  },
  {
    "manifestPath": "bundled:happier.scm.forge.github",
    "packageName": "@happier-dev/plugins-scm-github",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.forge.github",
    "pluginPackageId": "scm-github"
  },
  {
    "manifestPath": "bundled:happier.scm.forge.gitlab",
    "packageName": "@happier-dev/plugins-scm-gitlab",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.forge.gitlab",
    "pluginPackageId": "scm-gitlab"
  },
  {
    "manifestPath": "bundled:happier.scm.backend.sapling",
    "packageName": "@happier-dev/plugins-scm-sapling",
    "packageVersion": "0.0.0",
    "pluginId": "happier.scm.backend.sapling",
    "pluginPackageId": "scm-sapling"
  },
  {
    "manifestPath": "bundled:happier.sentry",
    "packageName": "@happier-dev/plugins-sentry",
    "packageVersion": "0.0.0",
    "pluginId": "happier.sentry",
    "pluginPackageId": "sentry"
  },
  {
    "manifestPath": "bundled:happier.triage",
    "packageName": "@happier-dev/plugins-triage",
    "packageVersion": "0.0.0",
    "pluginId": "happier.triage",
    "pluginPackageId": "triage"
  },
  {
    "manifestPath": "bundled:happier.voice.xai",
    "packageName": "@happier-dev/plugins-xai",
    "packageVersion": "0.0.0",
    "pluginId": "happier.voice.xai",
    "pluginPackageId": "xai"
  },
  {
    "manifestPath": "bundled:happier.provider.zai",
    "packageName": "@happier-dev/plugins-zai",
    "packageVersion": "0.0.0",
    "pluginId": "happier.provider.zai",
    "pluginPackageId": "zai"
  }
]);

export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: readonly BundledFirstPartyPluginLocator[] = Object.freeze([
  Object.freeze({
    pluginId: "happier.agent.antigravity",
    manifestRelativePath: "assets/bundled-plugin-manifests/antigravity.json",
    manifestPath: "bundled:happier.agent.antigravity",
    daemonEntryPath: "@happier-dev/plugins-antigravity",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-antigravity",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.app-context",
    manifestRelativePath: "assets/bundled-plugin-manifests/app-context.json",
    manifestPath: "bundled:happier.app-context",
    daemonEntryPath: "@happier-dev/plugins-app-context",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-app-context",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.auggie",
    manifestRelativePath: "assets/bundled-plugin-manifests/auggie.json",
    manifestPath: "bundled:happier.agent.auggie",
    daemonEntryPath: "@happier-dev/plugins-auggie",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-auggie",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channel.discord",
    manifestRelativePath: "assets/bundled-plugin-manifests/channel-discord.json",
    manifestPath: "bundled:happier.channel.discord",
    daemonEntryPath: "@happier-dev/plugins-channel-discord",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channel-discord",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channel.email",
    manifestRelativePath: "assets/bundled-plugin-manifests/channel-email.json",
    manifestPath: "bundled:happier.channel.email",
    daemonEntryPath: "@happier-dev/plugins-channel-email",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channel-email",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channel.slack",
    manifestRelativePath: "assets/bundled-plugin-manifests/channel-slack.json",
    manifestPath: "bundled:happier.channel.slack",
    daemonEntryPath: "@happier-dev/plugins-channel-slack",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channel-slack",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channel.telegram",
    manifestRelativePath: "assets/bundled-plugin-manifests/channel-telegram.json",
    manifestPath: "bundled:happier.channel.telegram",
    daemonEntryPath: "@happier-dev/plugins-channel-telegram",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channel-telegram",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.channels",
    manifestRelativePath: "assets/bundled-plugin-manifests/channels.json",
    manifestPath: "bundled:happier.channels",
    daemonEntryPath: "@happier-dev/plugins-channels",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-channels",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.claude",
    manifestRelativePath: "assets/bundled-plugin-manifests/claude.json",
    manifestPath: "bundled:happier.agent.claude",
    daemonEntryPath: "@happier-dev/plugins-claude",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-claude",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.cliproxyapi",
    manifestRelativePath: "assets/bundled-plugin-manifests/cliproxyapi.json",
    manifestPath: "bundled:happier.provider.cliproxyapi",
    daemonEntryPath: "@happier-dev/plugins-cliproxyapi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-cliproxyapi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.codebuddy",
    manifestRelativePath: "assets/bundled-plugin-manifests/codebuddy.json",
    manifestPath: "bundled:happier.agent.codebuddy",
    daemonEntryPath: "@happier-dev/plugins-codebuddy",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-codebuddy",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.codex",
    manifestRelativePath: "assets/bundled-plugin-manifests/codex.json",
    manifestPath: "bundled:happier.agent.codex",
    daemonEntryPath: "@happier-dev/plugins-codex",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-codex",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.copilot",
    manifestRelativePath: "assets/bundled-plugin-manifests/copilot.json",
    manifestPath: "bundled:happier.agent.copilot",
    daemonEntryPath: "@happier-dev/plugins-copilot",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-copilot",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.cursor",
    manifestRelativePath: "assets/bundled-plugin-manifests/cursor.json",
    manifestPath: "bundled:happier.agent.cursor",
    daemonEntryPath: "@happier-dev/plugins-cursor",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-cursor",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.custom-acp",
    manifestRelativePath: "assets/bundled-plugin-manifests/custom-acp.json",
    manifestPath: "bundled:happier.agent.custom-acp",
    daemonEntryPath: "@happier-dev/plugins-custom-acp",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-custom-acp",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.deepseek",
    manifestRelativePath: "assets/bundled-plugin-manifests/deepseek.json",
    manifestPath: "bundled:happier.provider.deepseek",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-deepseek",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.devin",
    manifestRelativePath: "assets/bundled-plugin-manifests/devin.json",
    manifestPath: "bundled:happier.agent.devin",
    daemonEntryPath: "@happier-dev/plugins-devin",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-devin",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.droid",
    manifestRelativePath: "assets/bundled-plugin-manifests/droid.json",
    manifestPath: "bundled:happier.agent.droid",
    daemonEntryPath: "@happier-dev/plugins-droid",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-droid",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.elevenlabs",
    manifestRelativePath: "assets/bundled-plugin-manifests/elevenlabs.json",
    manifestPath: "bundled:happier.voice.elevenlabs",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-elevenlabs",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.fx",
    manifestRelativePath: "assets/bundled-plugin-manifests/fx.json",
    manifestPath: "bundled:happier.agent.fx",
    daemonEntryPath: "@happier-dev/plugins-fx",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-fx",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.gemini",
    manifestRelativePath: "assets/bundled-plugin-manifests/gemini.json",
    manifestPath: "bundled:happier.agent.gemini",
    daemonEntryPath: "@happier-dev/plugins-gemini",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-gemini",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.google",
    manifestRelativePath: "assets/bundled-plugin-manifests/google.json",
    manifestPath: "bundled:happier.voice.google",
    daemonEntryPath: "@happier-dev/plugins-google",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-google",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.grok",
    manifestRelativePath: "assets/bundled-plugin-manifests/grok.json",
    manifestPath: "bundled:happier.agent.grok",
    daemonEntryPath: "@happier-dev/plugins-grok",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-grok",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.inspector",
    manifestRelativePath: "assets/bundled-plugin-manifests/inspector.json",
    manifestPath: "bundled:happier.inspector",
    daemonEntryPath: "@happier-dev/plugins-inspector",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-inspector",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.jira",
    manifestRelativePath: "assets/bundled-plugin-manifests/jira.json",
    manifestPath: "bundled:happier.jira",
    daemonEntryPath: "@happier-dev/plugins-jira",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-jira",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kilo",
    manifestRelativePath: "assets/bundled-plugin-manifests/kilo.json",
    manifestPath: "bundled:happier.agent.kilo",
    daemonEntryPath: "@happier-dev/plugins-kilo",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kilo",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kimi",
    manifestRelativePath: "assets/bundled-plugin-manifests/kimi.json",
    manifestPath: "bundled:happier.agent.kimi",
    daemonEntryPath: "@happier-dev/plugins-kimi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kimi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.kiro",
    manifestRelativePath: "assets/bundled-plugin-manifests/kiro.json",
    manifestPath: "bundled:happier.agent.kiro",
    daemonEntryPath: "@happier-dev/plugins-kiro",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-kiro",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.language.typescript",
    manifestRelativePath: "assets/bundled-plugin-manifests/lang-typescript.json",
    manifestPath: "bundled:happier.language.typescript",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-lang-typescript",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.linear",
    manifestRelativePath: "assets/bundled-plugin-manifests/linear.json",
    manifestPath: "bundled:happier.linear",
    daemonEntryPath: "@happier-dev/plugins-linear",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-linear",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.lmstudio",
    manifestRelativePath: "assets/bundled-plugin-manifests/lmstudio.json",
    manifestPath: "bundled:happier.provider.lmstudio",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-lmstudio",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.boat",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-boat.json",
    manifestPath: "bundled:happier.machine.boat",
    daemonEntryPath: "@happier-dev/plugins-machine-boat",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-boat",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.crabbox",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-crabbox.json",
    manifestPath: "bundled:happier.machine.crabbox",
    daemonEntryPath: "@happier-dev/plugins-machine-crabbox",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-crabbox",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.cua",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-cua.json",
    manifestPath: "bundled:happier.machine.cua",
    daemonEntryPath: "@happier-dev/plugins-machine-cua",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-cua",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.digitalocean",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-digitalocean.json",
    manifestPath: "bundled:happier.machine.digitalocean",
    daemonEntryPath: "@happier-dev/plugins-machine-digitalocean",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-digitalocean",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.docker-sandboxes",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-docker-sandboxes.json",
    manifestPath: "bundled:happier.machine.docker-sandboxes",
    daemonEntryPath: "@happier-dev/plugins-machine-docker-sandboxes",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-docker-sandboxes",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.fly",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-fly.json",
    manifestPath: "bundled:happier.machine.fly",
    daemonEntryPath: "@happier-dev/plugins-machine-fly",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-fly",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.hetzner",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-hetzner.json",
    manifestPath: "bundled:happier.machine.hetzner",
    daemonEntryPath: "@happier-dev/plugins-machine-hetzner",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-hetzner",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.lima",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-lima.json",
    manifestPath: "bundled:happier.machine.lima",
    daemonEntryPath: "@happier-dev/plugins-machine-lima",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-lima",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.lume",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-lume.json",
    manifestPath: "bundled:happier.machine.lume",
    daemonEntryPath: "@happier-dev/plugins-machine-lume",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-lume",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.machine.modal",
    manifestRelativePath: "assets/bundled-plugin-manifests/machine-modal.json",
    manifestPath: "bundled:happier.machine.modal",
    daemonEntryPath: "@happier-dev/plugins-machine-modal",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-machine-modal",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.minimax",
    manifestRelativePath: "assets/bundled-plugin-manifests/minimax.json",
    manifestPath: "bundled:happier.provider.minimax",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-minimax",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.ohmypi",
    manifestRelativePath: "assets/bundled-plugin-manifests/ohmypi.json",
    manifestPath: "bundled:happier.agent.ohmypi",
    daemonEntryPath: "@happier-dev/plugins-ohmypi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-ohmypi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.ollama",
    manifestRelativePath: "assets/bundled-plugin-manifests/ollama.json",
    manifestPath: "bundled:happier.provider.ollama",
    daemonEntryPath: "@happier-dev/plugins-ollama",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-ollama",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.openai",
    manifestRelativePath: "assets/bundled-plugin-manifests/openai.json",
    manifestPath: "bundled:happier.voice.openai",
    daemonEntryPath: "@happier-dev/plugins-openai",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.openai-compat",
    manifestRelativePath: "assets/bundled-plugin-manifests/openai-compat.json",
    manifestPath: "bundled:happier.voice.openai-compat",
    daemonEntryPath: "@happier-dev/plugins-openai-compat",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openai-compat",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.openai",
    manifestRelativePath: "assets/bundled-plugin-manifests/openai-models.json",
    manifestPath: "bundled:happier.provider.openai",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openai-models",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.opencode",
    manifestRelativePath: "assets/bundled-plugin-manifests/opencode.json",
    manifestPath: "bundled:happier.agent.opencode",
    daemonEntryPath: "@happier-dev/plugins-opencode",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-opencode",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.openrouter",
    manifestRelativePath: "assets/bundled-plugin-manifests/openrouter.json",
    manifestPath: "bundled:happier.provider.openrouter",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-openrouter",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.pi",
    manifestRelativePath: "assets/bundled-plugin-manifests/pi.json",
    manifestPath: "bundled:happier.agent.pi",
    daemonEntryPath: "@happier-dev/plugins-pi",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-pi",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.posthog",
    manifestRelativePath: "assets/bundled-plugin-manifests/posthog.json",
    manifestPath: "bundled:happier.posthog",
    daemonEntryPath: "@happier-dev/plugins-posthog",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-posthog",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.agent.qwen",
    manifestRelativePath: "assets/bundled-plugin-manifests/qwen.json",
    manifestPath: "bundled:happier.agent.qwen",
    daemonEntryPath: "@happier-dev/plugins-qwen",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-qwen",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.review.coderabbit",
    manifestRelativePath: "assets/bundled-plugin-manifests/review-coderabbit.json",
    manifestPath: "bundled:happier.review.coderabbit",
    daemonEntryPath: "@happier-dev/plugins-review-coderabbit",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-review-coderabbit",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.review.deepsec",
    manifestRelativePath: "assets/bundled-plugin-manifests/review-deepsec.json",
    manifestPath: "bundled:happier.review.deepsec",
    daemonEntryPath: "@happier-dev/plugins-review-deepsec",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-review-deepsec",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.forge.azure-devops",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-azure-devops.json",
    manifestPath: "bundled:happier.scm.forge.azure-devops",
    daemonEntryPath: "@happier-dev/plugins-scm-azure-devops",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-azure-devops",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.forge.bitbucket",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-bitbucket.json",
    manifestPath: "bundled:happier.scm.forge.bitbucket",
    daemonEntryPath: "@happier-dev/plugins-scm-bitbucket",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-bitbucket",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.backend.git",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-git.json",
    manifestPath: "bundled:happier.scm.backend.git",
    daemonEntryPath: "@happier-dev/plugins-scm-git",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-git",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.forge.github",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-github.json",
    manifestPath: "bundled:happier.scm.forge.github",
    daemonEntryPath: "@happier-dev/plugins-scm-github",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-github",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.forge.gitlab",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-gitlab.json",
    manifestPath: "bundled:happier.scm.forge.gitlab",
    daemonEntryPath: "@happier-dev/plugins-scm-gitlab",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-gitlab",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.scm.backend.sapling",
    manifestRelativePath: "assets/bundled-plugin-manifests/scm-sapling.json",
    manifestPath: "bundled:happier.scm.backend.sapling",
    daemonEntryPath: "@happier-dev/plugins-scm-sapling",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-scm-sapling",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.sentry",
    manifestRelativePath: "assets/bundled-plugin-manifests/sentry.json",
    manifestPath: "bundled:happier.sentry",
    daemonEntryPath: "@happier-dev/plugins-sentry",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-sentry",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.triage",
    manifestRelativePath: "assets/bundled-plugin-manifests/triage.json",
    manifestPath: "bundled:happier.triage",
    daemonEntryPath: "@happier-dev/plugins-triage",
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-triage",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.voice.xai",
    manifestRelativePath: "assets/bundled-plugin-manifests/xai.json",
    manifestPath: "bundled:happier.voice.xai",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-xai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
  Object.freeze({
    pluginId: "happier.provider.zai",
    manifestRelativePath: "assets/bundled-plugin-manifests/zai.json",
    manifestPath: "bundled:happier.provider.zai",
    daemonEntryPath: null,
    sourceSpec: Object.freeze({
      kind: 'bundled',
      locator: "@happier-dev/plugins-zai",
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: "0.0.0",
    }),
  }),
]);

