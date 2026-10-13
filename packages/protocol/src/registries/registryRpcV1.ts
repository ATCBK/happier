import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryKindV1Schema,RegistryFormatV1Schema } from './registrySourcesV1.js';
import { RegistryItemV1Schema,RegistryContentRefV1Schema } from './registryItemsV1.js';
import { RegistryListPageV1Schema, RegistrySourceStatusV1Schema } from './registryListV1.js';
const identity=()=>z.string().min(1);
const sourceUrl=()=>z.string().url().refine(raw=>{const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password;});
export const RegistryFetchRequestV1Schema=lazyZodSchema(()=>z.discriminatedUnion('op',[
  z.object({op:z.literal('detect'),url:sourceUrl()}).strict(),
  z.object({op:z.literal('link'),url:sourceUrl(),ref:RegistryContentRefV1Schema.options[0].optional()}).strict(),
  z.object({op:z.literal('linkFiles'),url:sourceUrl(),itemId:z.string(),version:identity(),ref:RegistryContentRefV1Schema.options[0]}).strict(),
  z.object({op:z.literal('list'),sourceId:identity(),kind:RegistryKindV1Schema,query:z.string().optional(),cursor:z.string().nullable().optional()}).strict(),
  z.object({op:z.literal('read'),sourceId:identity(),kind:RegistryKindV1Schema,itemId:z.string(),version:identity().optional()}).strict(),
  z.object({op:z.literal('files'),sourceId:identity(),kind:z.literal('skill'),itemId:z.string(),version:identity()}).strict(),
]));
export type RegistryFetchRequestV1=z.infer<typeof RegistryFetchRequestV1Schema>;
export const RegistrySkillFilesPayloadV1Schema=lazyZodSchema(()=>z.array(z.object({path:identity(),unixMode:z.union([z.literal(0o644),z.literal(0o755)]),contentBase64:z.string()}).strict()));
export const RegistryFetchResponseV1Schema=lazyZodSchema(()=>z.discriminatedUnion('op',[
  z.object({op:z.literal('detect'),detected:z.union([z.object({format:RegistryFormatV1Schema,kinds:z.array(RegistryKindV1Schema),title:identity(),itemCount:z.number().optional()}).strict(),
    z.object({unsupported:z.enum(['organisation','unknown_format','needs_token','unreachable'])}).strict()])}).strict(),
  z.object({op:z.literal('link'),items:z.array(RegistryItemV1Schema)}).strict(),
  z.object({op:z.literal('list'),page:RegistryListPageV1Schema}).strict(),
  z.object({op:z.literal('read'),item:RegistryItemV1Schema}).strict(),
  z.object({op:z.literal('files'),files:RegistrySkillFilesPayloadV1Schema}).strict(),
  z.object({op:z.literal('error'),status:RegistrySourceStatusV1Schema}).strict(),
]));
export type RegistryFetchResponseV1=z.infer<typeof RegistryFetchResponseV1Schema>;
export const RegistryDownloadRequestV1Schema=lazyZodSchema(()=>z.object({sourceId:identity(),kind:z.literal('skill'),itemId:z.string(),version:identity()}).strict());
export type RegistryDownloadRequestV1=z.infer<typeof RegistryDownloadRequestV1Schema>;
