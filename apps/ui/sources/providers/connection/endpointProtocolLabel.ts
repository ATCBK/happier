import { readBundledProviderWireProtocolFactV1, type BundledProviderWireProtocol, type ProviderWireProtocol } from '@happier-dev/protocol/providers/capabilities/v1';

import { t } from '@/text';

/**
 * Translated endpoint labels exist only for the protocols this build bundles a
 * copy string for. A protocol contributed by an installed plugin has none, so
 * the endpoint is labelled with the protocol id the plugin declared rather than
 * with another protocol's label or an unresolved translation key.
 */
const BUNDLED_PROTOCOL_LABEL_KEYS = {
    anthropic: 'settingsProviders.authoring.protocol.anthropic.title',
    'openai-chat': 'settingsProviders.authoring.protocol.openai-chat.title',
    'openai-responses': 'settingsProviders.authoring.protocol.openai-responses.title',
    'ollama-native': null,
} as const satisfies Record<BundledProviderWireProtocol, string | null>;

/** How a person reads an endpoint's protocol ("OpenAI Chat Completions"), not its wire id. */
export function endpointProtocolLabel(protocol: ProviderWireProtocol): string {
    const key = readBundledProviderWireProtocolFactV1(BUNDLED_PROTOCOL_LABEL_KEYS, protocol);
    return key === null ? protocol : t(key);
}
