import type { BuiltinUsagePublicPresentationV1, PublicProfileViewV1 } from '@happier-dev/plugin-sdk';

/** Erased adapter output contracts; the shared renderer needs no Account or transport. */
export type PublicProfileDisplayView = Pick<PublicProfileViewV1, 'handle' | 'identity' | 'metadata' | 'layout'> & Readonly<{
  urls: Pick<PublicProfileViewV1['urls'], 'report'> | null;
}>;
export type PublicProfileUsagePresentation = BuiltinUsagePublicPresentationV1;
export type PublicProfileInputView = Omit<PublicProfileViewV1, 'appearance' | 'service' | 'urls' | 'snapshot'> & Readonly<{
  urls: PublicProfileViewV1['urls'] | null;
  snapshot: PublicProfileViewV1['snapshot'] | null;
}>;
