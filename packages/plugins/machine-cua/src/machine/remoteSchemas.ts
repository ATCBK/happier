import * as z from 'zod/mini';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString,
    defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const id = z.string().check(z.minLength(1));
const closed = { policy: 'closed' } as const;
const nativeId = defineProtocolString({ minLength: 1 });
const cloud = defineProtocolUnion([defineProtocolLiteral('aws'), defineProtocolLiteral('gcp'), defineProtocolLiteral('modal')]);
const finite = defineProtocolObject({ kind: defineProtocolLiteral('finite'),
    durationSeconds: defineProtocolNumber({ integer: true, minimum: 1 }) }, closed);
const durableLifetime = defineProtocolUnion([defineProtocolObject({ kind: defineProtocolLiteral('no-native-ttl') }, closed), finite]);

export const ByocLaunchV1Schema = defineProtocolUnion([
    defineProtocolObject({ cloud: defineProtocolLiteral('aws'), region: nativeId, nativeImageId: nativeId, nativeSizeId: nativeId,
        nativeLifetime: durableLifetime }, closed),
    defineProtocolObject({ cloud: defineProtocolLiteral('gcp'), region: nativeId, nativeImageId: nativeId, nativeSizeId: nativeId,
        nativeLifetime: durableLifetime }, closed),
    defineProtocolObject({ cloud: defineProtocolLiteral('modal'), region: nativeId, nativeImageId: nativeId, nativeSizeId: nativeId,
        // cua-byoc's Modal connection/provisioner caps native lifetime at 24 hours.
        nativeLifetime: defineProtocolObject({ kind: defineProtocolLiteral('finite'),
            durationSeconds: defineProtocolNumber({ integer: true, minimum: 1, maximum: 24 * 60 * 60 }) }, closed) }, closed),
]);
export type ByocLaunchV1 = ProtocolSchemaOutput<typeof ByocLaunchV1Schema>;
export const ByocOptionsQueryV1Schema = defineProtocolObject({ cloud }, closed);
export const ByocNativeOperationV1Schema = defineProtocolObject({ launch: ByocLaunchV1Schema, sandboxId: nativeId }, closed);

export const ByocResourceV1Schema = defineProtocolObject({
    cloud, nativeResourceId: nativeId, sandboxId: nativeId,
    spaceId: nativeId.optional(), ownedAttachmentIds: defineProtocolArray(nativeId),
}, closed);
export type ByocResourceV1 = ProtocolSchemaOutput<typeof ByocResourceV1Schema>;

// External native read projections drop vendor additions. Only these known facts
// leave the decoder; native JSON, credentials, addresses and service URLs do not.
export const NativeCloudResourceSchema = z.object({
    provider: z.enum(['aws', 'gcp', 'modal']), id, type: id,
    sandbox: z.string(), machine: z.string(), region: z.string(), state: z.string(),
    expires: z.string(), expired: z.boolean(),
});
export const NativeCloudProviderSchema = z.object({
    name: z.enum(['aws', 'gcp', 'modal']), connected: z.boolean(), region: z.string(),
    ttl_hours: z.number().check(z.int(), z.minimum(0), z.maximum(4_294_967_295)),
    kinds: z.array(z.object({ image: id, supported: z.boolean(), machine_type: id,
        usd_per_hour: z.number().check(z.minimum(0)) })),
});
