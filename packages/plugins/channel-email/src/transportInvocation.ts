import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { EmailConfig } from './config.js';

export type EmailTransportContribution = NonNullable<
  (typeof import('./plugin.js'))['EMAIL_TRANSPORT_POINT_REF']['__targetedContribution']
>;

/** Retain only contributor identity in config; resolve original host handles anew per invocation. */
export async function readEmailTransport(
  identity: EmailConfig['transport'], context: PluginInvocationContext,
): Promise<EmailTransportContribution> {
  context.signal.throwIfAborted();
  const { EMAIL_TRANSPORT_POINT_REF: point } = await import('./plugin.js');
  const observation = context.services.targetedContributions.observeForSelf(point, { onInvalidated: () => {} });
  try {
    const snapshot = await observation.readCurrent({ signal: context.signal });
    const matches = snapshot.contributions.filter(entry =>
      entry.protocol.id === point.protocol.id && entry.protocol.version === point.protocol.version
      && entry.contributor.pluginId === identity.pluginId
      && entry.contributor.contributionId === identity.contributionId);
    if (matches.length !== 1) {
      throw new PluginError({ code: 'email_transport_unavailable',
        message: 'The selected Email transport is unavailable.', retryable: true });
    }
    return matches[0]!;
  } finally {
    observation.dispose();
  }
}
