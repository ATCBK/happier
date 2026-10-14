import { z } from 'zod/mini';

export type PluginContributionFamilyDescriptorV2<
  TFamily extends string = string,
  TSchema extends z.ZodMiniType = z.ZodMiniType,
> = Readonly<{
  family: TFamily;
  schema: TSchema;
  maxItems?: number;
}>;

export function definePluginContributionFamilyV2<
  const TFamily extends string,
  TSchema extends z.ZodMiniType,
>(
  descriptor: PluginContributionFamilyDescriptorV2<TFamily, TSchema>,
): PluginContributionFamilyDescriptorV2<TFamily, TSchema> {
  return Object.freeze(descriptor);
}

type PluginContributionFamilyShapeV2<
  TDescriptors extends readonly PluginContributionFamilyDescriptorV2[],
> = {
  [TDescriptor in TDescriptors[number] as TDescriptor['family']]: z.ZodMiniDefault<
    z.ZodMiniArray<TDescriptor['schema']>
  >;
};

export function buildPluginContributionFamilySchemaV2<
  const TDescriptors extends readonly PluginContributionFamilyDescriptorV2[],
>(
  descriptors: TDescriptors,
): z.ZodMiniObject<PluginContributionFamilyShapeV2<TDescriptors>> {
  const shape: Record<string, z.ZodMiniDefault<z.ZodMiniArray<z.ZodMiniType>>> = {};
  for (const descriptor of descriptors) {
    const items = z.array(descriptor.schema);
    shape[descriptor.family] = z._default(
      descriptor.maxItems === undefined ? items : items.check(z.maxLength(descriptor.maxItems)),
      [],
    );
  }
  return z.strictObject(shape) as unknown as z.ZodMiniObject<
    PluginContributionFamilyShapeV2<TDescriptors>
  >;
}
