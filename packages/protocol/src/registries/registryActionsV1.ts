import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryKindV1Schema, RegistrySourceDescriptorV1Schema, RegistryFormatV1Schema, RegistrySourceTokenV1Schema } from './registrySourcesV1.js';
import { RegistryItemV1Schema } from './registryItemsV1.js';
import { RegistryListPageV1Schema } from './registryListV1.js';
import { RegistryUpdateCheckResultV1Schema } from './registryUpstreamV1.js';
import { parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
// Stored rows keep legacy refs for promotion; every new binding uses the
// incumbent private-resource identity, not an unverified Settings id.
const RegistryTokenBindingV1Schema=lazyZodSchema(()=>RegistrySourceTokenV1Schema.superRefine((token,context)=>{
  try{if(parseSavedSecretRefV1(token.secretRef).kind==='shared_resource')return;}catch{}
  context.addIssue({code:'custom',path:['secretRef'],message:'A current private Saved Secret resource reference is required'});
}));
export const REGISTRY_ACTION_IDS_V1=['registries.sources.list','registries.sources.detect','registries.sources.create',
  'registries.sources.update','registries.sources.token.set','registries.sources.delete','registries.items.list','registries.items.read','registries.updates.check'] as const;
export type RegistryActionIdV1=typeof REGISTRY_ACTION_IDS_V1[number];
const id=()=>z.string().min(1);
export const REGISTRY_ACTION_INPUT_SCHEMAS_V1={
  'registries.sources.list':lazyZodSchema(()=>z.object({kind:RegistryKindV1Schema.optional()}).strict()),
  'registries.sources.detect':lazyZodSchema(()=>z.object({url:id()}).strict()),
  'registries.sources.create':lazyZodSchema(()=>z.object({url:id(),title:id().optional(),kinds:z.array(RegistryKindV1Schema).min(1).optional(),
    token:RegistryTokenBindingV1Schema.optional(),npmRegistryProfileId:id().optional()}).strict()),
  'registries.sources.update':lazyZodSchema(()=>z.object({sourceId:id(),title:id().optional(),enabled:z.boolean().optional()}).strict()),
  'registries.sources.token.set':lazyZodSchema(()=>z.object({sourceId:id(),token:RegistryTokenBindingV1Schema.nullable().optional(),
    npmRegistryProfileId:id().nullable().optional()}).strict()),
  'registries.sources.delete':lazyZodSchema(()=>z.object({sourceId:id()}).strict()),
  'registries.items.list':lazyZodSchema(()=>z.object({kind:RegistryKindV1Schema,sourceIds:z.array(id()).optional(),query:z.string().optional(),cursor:z.string().nullable().optional(),refresh:z.boolean().optional()}).strict()),
  'registries.items.read':lazyZodSchema(()=>z.object({kind:RegistryKindV1Schema,sourceId:id(),itemId:z.string(),version:id().optional()}).strict()),
  'registries.updates.check':lazyZodSchema(()=>z.object({kind:RegistryKindV1Schema.optional(),keys:z.array(id()).optional()}).strict()),
};
export const RegistryDetectedSourceV1Schema=lazyZodSchema(()=>z.union([
  z.object({format:RegistryFormatV1Schema,kinds:z.array(RegistryKindV1Schema).min(1),title:id(),itemCount:z.number().int().nonnegative().optional()}).strict(),
  z.object({unsupported:z.enum(['organisation','unknown_format','needs_token','unreachable'])}).strict(),
]));
export const REGISTRY_ACTION_OUTPUT_SCHEMAS_V1={
  'registries.sources.list':lazyZodSchema(()=>z.object({sources:z.array(RegistrySourceDescriptorV1Schema)}).strict()),
  'registries.sources.detect':lazyZodSchema(()=>z.object({detected:RegistryDetectedSourceV1Schema}).strict()),
  'registries.sources.create':lazyZodSchema(()=>z.object({source:RegistrySourceDescriptorV1Schema,existing:z.boolean()}).strict()),
  'registries.sources.update':lazyZodSchema(()=>z.object({source:RegistrySourceDescriptorV1Schema}).strict()),
  'registries.sources.token.set':lazyZodSchema(()=>z.object({source:RegistrySourceDescriptorV1Schema}).strict()),
  'registries.sources.delete':lazyZodSchema(()=>z.object({removed:z.literal(true)}).strict()),
  'registries.items.list':lazyZodSchema(()=>z.object({pages:z.array(RegistryListPageV1Schema)}).strict()),
  'registries.items.read':lazyZodSchema(()=>z.object({item:RegistryItemV1Schema}).strict()),
  'registries.updates.check':RegistryUpdateCheckResultV1Schema,
};
