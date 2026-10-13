import { definePlugin } from '@happier-dev/plugin-sdk';
import { VoiceCredentialSlotIdSchema } from '@happier-dev/plugin-sdk/voice';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';

import { openAiConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import { OPENAI_VOICE_PROVIDER_CONTRIBUTION_ID } from './constants.js';
import { OPENAI_REALTIME_SETTINGS_SECTION } from './voiceSettingsPresentation.js';

const OPENAI_API_KEY_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.voice.openai',
  version: '0.0.0',
  displayName: 'OpenAI Realtime Voice',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
  },
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  connectedAccountDescriptors: {
    openai: {
      declaration: {
        title: 'OpenAI API key',
        authentication: {
          defaultModeId: 'api-key',
          modes: [{
            id: 'api-key',
            kind: 'manual',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'OpenAI API key',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
          }],
        },
      },
      runtime: openAiConnectedAccountRuntime,
    },
  },
  ui: {
    translations: [
      { locale: 'en', messages: { 'settingsVoice.realtimeProviders.openai.description': "Uses your OpenAI account or API key" } },
      { locale: 'ru', messages: { 'settingsVoice.realtimeProviders.openai.description': "Использует ваш аккаунт OpenAI или API-ключ" } },
      { locale: 'pl', messages: { 'settingsVoice.realtimeProviders.openai.description': "Korzysta z Twojego konta OpenAI lub klucza API" } },
      { locale: 'es', messages: { 'settingsVoice.realtimeProviders.openai.description': "Usa tu cuenta de OpenAI o tu clave API" } },
      { locale: 'fr', messages: { 'settingsVoice.realtimeProviders.openai.description': "Utilise ton compte OpenAI ou ta clé API" } },
      { locale: 'it', messages: { 'settingsVoice.realtimeProviders.openai.description': "Usa il tuo account OpenAI o la tua chiave API" } },
      { locale: 'pt', messages: { 'settingsVoice.realtimeProviders.openai.description': "Usa a tua conta OpenAI ou chave API" } },
      { locale: 'ca', messages: { 'settingsVoice.realtimeProviders.openai.description': "Fa servir el teu compte d’OpenAI o la teva clau API" } },
      { locale: 'de', messages: { 'settingsVoice.realtimeProviders.openai.description': "Nutzt dein OpenAI-Konto oder deinen API-Schlüssel" } },
      { locale: 'zh-Hans', messages: { 'settingsVoice.realtimeProviders.openai.description': "使用你的 OpenAI 账户或 API 密钥" } },
      { locale: 'zh-Hant', messages: { 'settingsVoice.realtimeProviders.openai.description': "使用你的 OpenAI 帳戶或 API 金鑰" } },
      { locale: 'ja', messages: { 'settingsVoice.realtimeProviders.openai.description': "OpenAIアカウントまたはAPIキーを使用" } },
    ],
  },
  voiceProviders: {
    [OPENAI_VOICE_PROVIDER_CONTRIBUTION_ID]: {
      declaration: {
      title: 'OpenAI Realtime Voice',
      description: { key: 'settingsVoice.realtimeProviders.openai.description', fallback: 'Uses your OpenAI account or API key' },
      mark: { kind: 'connected_service', serviceId: 'openai' },
      kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web', 'ios', 'android'],
      capabilities: {
        turn: { cancelResponse: true, bargeIn: true, clearInput: true },
        tools: { effectCalls: 'stable_ids' },
      },
      credentials: {
        slot: {
          id: OPENAI_API_KEY_CREDENTIAL_SLOT_ID,
          purpose: 'voice.client-auth',
          title: 'OpenAI credential',
          description: 'Credential used to mint short-lived OpenAI Realtime client authentication.',
        },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          operationProjections: [{
            kind: 'recipientCredential',
            operation: 'client-auth',
            phase: 'prepare',
            format: 'bearer',
          }],
        }, {
          kind: 'connectedAccount',
          service: { pluginId: 'happier.voice.openai', localId: 'openai' },
          operationProjections: [{
            kind: 'materializedHttpHeaders',
            operation: 'client-auth',
            phase: 'prepare',
            request: {
              kind: 'httpHeaders',
              origin: 'https://api.openai.com',
              headerNames: ['authorization'],
            },
            requiredHeaderNames: ['authorization'],
            allowedHeaderNames: ['authorization'],
          }],
        }, {
          kind: 'connectedAccount',
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          operationProjections: [{
            kind: 'materializedHttpHeaders',
            operation: 'client-auth',
            phase: 'prepare',
            request: {
              kind: 'httpHeaders',
              origin: 'https://api.openai.com',
              headerNames: ['authorization', 'chatgpt-account-id'],
            },
            requiredHeaderNames: ['authorization'],
            allowedHeaderNames: ['authorization', 'chatgpt-account-id'],
          }],
        }],
        hostMediated: {
          operations: [{
            id: 'client-auth',
            purpose: 'voice.client-auth',
            credentialSlotId: OPENAI_API_KEY_CREDENTIAL_SLOT_ID,
            effect: 'read',
            request: {
              origin: 'https://api.openai.com',
              pathTemplate: '/v1/realtime/client_secrets',
              queryTemplate: [],
              headerTemplate: [
                { name: 'accept', value: 'application/json' },
                { name: 'content-type', value: 'application/json' },
              ],
              bodyTemplate: { kind: 'json', value: {} },
              method: 'POST',
              credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
              redirect: 'error',
              maxBodyBytes: 65536,
              contentTypes: ['application/json'],
            },
            parameters: {
              schema: {
                type: 'object',
                properties: {
                  body: { type: 'object', additionalProperties: true },
                },
                required: ['body'],
                additionalProperties: false,
              },
              mapping: [{ parameter: 'body', target: { kind: 'body', pointer: '' } }],
            },
            response: { maxBytes: 65536, contentTypes: ['application/json'] },
          }],
        },
      },
      settings: {
        schemaVersion: 1,
        presentation: JSON.parse(JSON.stringify(OPENAI_REALTIME_SETTINGS_SECTION)),
        fields: [{
          id: 'model',
          title: 'Model',
          schema: {
            type: 'object',
            oneOf: [{
              type: 'object',
              properties: {
                kind: { const: 'pinned' },
                id: { type: 'string', minLength: 1, maxLength: 128 },
              },
              required: ['kind', 'id'],
              additionalProperties: false,
            }, {
              type: 'object',
              properties: {
                kind: { const: 'moving_alias' },
                id: { const: 'gpt-realtime' },
              },
              required: ['kind', 'id'],
              additionalProperties: false,
            }],
          },
          default: { kind: 'pinned', id: 'gpt-realtime-2.1' },
          presentation: { control: 'json' },
        }, {
          id: 'voice',
          title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 128 },
          default: 'marin',
          presentation: { control: 'text' },
        }, {
          id: 'instructions',
          title: 'Instructions',
          schema: { type: 'string', maxLength: 10_000 },
          default: '',
          presentation: { control: 'textarea' },
        }, {
          id: 'turnDetection',
          title: 'Turn detection',
          schema: { type: 'string', enum: ['server_vad', 'semantic_vad', 'manual'] },
          default: 'server_vad',
          presentation: {
            control: 'select',
            options: [
              { value: 'server_vad', title: 'Server voice activity detection' },
              { value: 'semantic_vad', title: 'Semantic voice activity detection' },
              { value: 'manual', title: 'Manual' },
            ],
          },
        }, {
          id: 'inputTranscriptionModel',
          title: 'Input transcription model',
          schema: { type: 'string', maxLength: 128 },
          default: '',
          presentation: { control: 'text' },
        }],
        privacyDisclosure: {
          key: 'settingsVoice.realtimeProviders.openai.privacyDisclosure',
          fallback: 'Audio and conversation content are sent from this device to OpenAI using WebRTC. When enabled or used, OpenAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the selected Saved Voice API key, OpenAI Connected Service, or experimental Codex OAuth account to mint short-lived client authentication; connected accounts are accessed through the selected machine. OpenAI processes the live conversation under the selected account and may retain received data according to that account’s settings and OpenAI’s terms. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
        },
        privacyFacts: {
          audioDestination: 'OpenAI',
          processor: 'OpenAI Realtime',
          retention: { key: 'settingsVoice.pages.privacy.servicePolicy', fallback: 'Follows your service account settings and terms.' },
        },
      },
        client: {
          artifactId: 'voice-runtime-web',
          exportName: 'activate',
        },
      },
    },
  },
});
