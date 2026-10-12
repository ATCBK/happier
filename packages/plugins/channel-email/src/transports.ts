import { defineContributionPoint } from '@happier-dev/plugin-sdk/contributions';
import { EmailTransportsContributionProtocolV1 } from '@happier-dev/email-transports-protocol/v1';

export * from '@happier-dev/email-transports-protocol/v1';

/** The email plugin owns the target point; its public business protocol is package-owned. */
export const EmailTransportsContributionPointV1 = defineContributionPoint([EmailTransportsContributionProtocolV1]);
