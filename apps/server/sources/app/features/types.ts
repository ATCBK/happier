import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

export { OAuthProviderStatusSchema as oauthProviderStatusSchema } from '@happier-dev/protocol/features/payload/oauthProviderStatus';
export { FeaturesResponseSchema as featuresSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
export type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

type DeepPartial<T> =
    T extends (...args: never[]) => unknown
        ? T
        : T extends ReadonlyArray<infer Item>
            ? ReadonlyArray<DeepPartial<Item>>
            : T extends object
                ? { [K in keyof T]?: DeepPartial<T[K]> }
                : T;

export type FeaturesPayloadDelta = Readonly<{
    features?: DeepPartial<FeaturesResponse["features"]>;
    capabilities?: DeepPartial<FeaturesResponse["capabilities"]>;
}>;
