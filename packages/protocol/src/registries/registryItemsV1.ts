import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryFormatV1Schema, RegistryKindV1Schema } from './registrySourcesV1.js';
import { MarketplaceIndexEntryV1Schema, MarketplaceIndexSourceSnapshotV1Schema } from '../marketplace/marketplaceIndexV1.js';
import { PinnedArchivePlatformSchema } from '../installables/sourceKind.js';

export const RegistryContentRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gitTree'), repo: z.string().min(1), path: z.string(),
    commit: z.string().min(1), treeSha: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('version'), version: z.string().min(1) }).strict(),
]));
export type RegistryContentRefV1 = z.infer<typeof RegistryContentRefV1Schema>;

export const RegistryProvenanceV1Schema = lazyZodSchema(() => z.object({
  sourceId: z.string().min(1), format: RegistryFormatV1Schema, sourceUrl: z.string().min(1),
  itemId: z.string(), ref: RegistryContentRefV1Schema, importedAt: z.number().int().nonnegative(),
}).strict());
export type RegistryProvenanceV1 = z.infer<typeof RegistryProvenanceV1Schema>;

export const RegistryItemPointerV1Schema = lazyZodSchema(() => z.object({ sourceId: z.string().min(1),
  itemId: z.string(), version: z.string().min(1) }).strict());
export type RegistryItemPointerV1 = z.infer<typeof RegistryItemPointerV1Schema>;
export const RegistryItemProblemV1Schema = lazyZodSchema(() => z.discriminatedUnion('code', [
  z.object({ code: z.literal('too_large'), limit: z.enum(['files', 'bytes']) }).strict(),
  z.object({ code: z.literal('unsupported_entry'), reason: z.enum(['symlink', 'submodule', 'distribution', 'package_type']) }).strict(),
  z.object({ code: z.literal('removed_from_source') }).strict(),
]));
export type RegistryItemProblemV1 = z.infer<typeof RegistryItemProblemV1Schema>;
/** Selected distribution only; list fit needs targets/extraction support, never executable operands. */
export const RegistryAgentDistributionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npm') }).strict(),
  z.object({ kind: z.literal('uv') }).strict(),
  z.object({ kind: z.literal('archive'), platforms: z.partialRecord(PinnedArchivePlatformSchema,
    z.enum(['supported', 'archive_type_unsupported'])) }).strict(),
]));
export type RegistryAgentDistributionV1 = z.infer<typeof RegistryAgentDistributionV1Schema>;
export const RegistryItemSummaryV1Schema = lazyZodSchema(() => z.object({
  sourceId: z.string().min(1), kind: RegistryKindV1Schema, itemId: z.string(), title: z.string().min(1),
  description: z.string().optional(), version: z.string().min(1).optional(), iconUrl: z.string().optional(),
  publisher: z.object({ name: z.string().min(1), verification: z.enum(['github-account', 'domain', 'registry-checked', 'happier-reviewed']).optional() }).strict().optional(),
  updatedAt: z.number().optional(), installs: z.number().nonnegative().optional(), license: z.string().optional(),
  links: z.object({ repository: z.string().optional(), website: z.string().optional() }).strict().optional(),
  flags: z.object({ deprecated: z.literal(true).optional(), pick: z.literal(true).optional() }).strict().optional(),
  problem: RegistryItemProblemV1Schema.optional(),
  agentDistribution: RegistryAgentDistributionV1Schema.optional(),
}).strict());
export type RegistryItemSummaryV1 = z.infer<typeof RegistryItemSummaryV1Schema>;
export const RegistrySkillSourceV1Schema = lazyZodSchema(() => z.object({
  ref: RegistryContentRefV1Schema.options[0], skillMarkdown: z.string(), files: z.array(z.object({
    path: z.string().min(1), size: z.number().int().nonnegative(), unixMode: z.union([z.literal(0o644), z.literal(0o755)]), blobSha: z.string().min(1),
  }).strict()), notImported: z.object({ hooks: z.number().int().nonnegative(), commands: z.number().int().nonnegative(),
    mcpServers: z.number().int().nonnegative(), agents: z.number().int().nonnegative() }).strict().optional(),
}).strict());
export type RegistrySkillSourceV1 = z.infer<typeof RegistrySkillSourceV1Schema>;
const McpRegistryVariableV1Schema = lazyZodSchema(() => z.object({
  description: z.string().optional(), required: z.boolean(), secret: z.boolean(),
  default: z.string().optional(), value: z.string().optional(), choices: z.array(z.string()).optional(),
}).strict());
export const McpRegistryInputV1Schema = lazyZodSchema(() => McpRegistryVariableV1Schema.extend({
  name: z.string().min(1), target: z.enum(['env', 'header', 'url-variable']),
  variables: z.record(z.string(), McpRegistryVariableV1Schema).optional(),
}).strict());
export type McpRegistryInputV1 = z.infer<typeof McpRegistryInputV1Schema>;
export const McpRegistryArgumentV1Schema = lazyZodSchema(() => McpRegistryVariableV1Schema.extend({
  type: z.enum(['named', 'positional']), name: z.string().optional(), valueHint: z.string().optional(),
  variables: z.record(z.string(), McpRegistryVariableV1Schema).optional(),
}).strict());
export type McpRegistryArgumentV1 = z.infer<typeof McpRegistryArgumentV1Schema>;
export const McpRegistryServerV1Schema = lazyZodSchema(() => z.object({
  name: z.string().min(1), title: z.string().optional(), description: z.string(), version: z.string().min(1),
  status: z.enum(['active', 'deprecated']), publishedAt: z.number().optional(), repository: z.string().optional(),
  websiteUrl: z.string().optional(), iconUrl: z.string().optional(),
  remotes: z.array(z.object({ transport: z.enum(['streamable-http', 'sse']), url: z.string(), inputs: z.array(McpRegistryInputV1Schema) }).strict()),
  packages: z.array(z.object({ ecosystem: z.enum(['npm', 'pypi', 'oci', 'mcpb', 'nuget', 'cargo']),
    identifier: z.string().min(1), version: z.string(), transport: z.enum(['stdio', 'streamable-http', 'sse']),
    fileSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), runtimeArguments: z.array(McpRegistryArgumentV1Schema),
    packageArguments: z.array(McpRegistryArgumentV1Schema), environment: z.array(McpRegistryInputV1Schema),
  }).strict()),
}).strict());
export type McpRegistryServerV1 = z.infer<typeof McpRegistryServerV1Schema>;
const AcpRegistryPackageV1Schema = lazyZodSchema(() => z.object({
  package: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  args: z.array(z.string()), env: z.record(z.string(), z.string()),
}).strict());
export const AcpRegistryAgentV1Schema = lazyZodSchema(() => z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), name: z.string().min(1), version: z.string().min(1), description: z.string().min(1),
  authors: z.array(z.string()).optional(), license: z.string().optional(), licenseUrl: z.string().optional(),
  repository: z.string().optional(), website: z.string().optional(), iconUrl: z.string().optional(),
  distributions: z.object({
    binary: z.partialRecord(PinnedArchivePlatformSchema, z.object({
      archiveUrl: z.string().url().refine(url => url.startsWith('https://')), command: z.string().min(1),
      args: z.array(z.string()), env: z.record(z.string(), z.string()), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }).strict()).optional(), npm: AcpRegistryPackageV1Schema.optional(), uv: AcpRegistryPackageV1Schema.optional(),
  }).strict(),
}).strict());
export type AcpRegistryAgentV1 = z.infer<typeof AcpRegistryAgentV1Schema>;
export const RegistryItemPayloadV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skill'), skill: RegistrySkillSourceV1Schema }).strict(),
  z.object({ kind: z.literal('mcpServer'), server: McpRegistryServerV1Schema }).strict(),
  z.object({ kind: z.literal('agent'), agent: AcpRegistryAgentV1Schema }).strict(),
  z.object({ kind: z.literal('plugin'), listing: MarketplaceIndexEntryV1Schema,
    source: MarketplaceIndexSourceSnapshotV1Schema.shape.source }).strict(),
]));
export type RegistryItemPayloadV1 = z.infer<typeof RegistryItemPayloadV1Schema>;
export const RegistryItemV1Schema = lazyZodSchema(() => z.object({
  summary: RegistryItemSummaryV1Schema, payload: RegistryItemPayloadV1Schema,
  fetchedAt: z.number().int().nonnegative(),
}).strict().superRefine((item, ctx) => {
  const version = item.payload.kind === 'skill' ? item.payload.skill.ref.commit
    : item.payload.kind === 'agent' ? item.payload.agent.version
      : item.payload.kind === 'mcpServer' ? item.payload.server.version : item.payload.listing.distribution.version;
  if (item.summary.kind !== item.payload.kind || item.summary.version !== version
    || item.payload.kind === 'agent' && item.summary.itemId !== item.payload.agent.id
    || item.payload.kind === 'mcpServer' && item.summary.itemId !== item.payload.server.name
    || item.payload.kind === 'plugin' && (item.summary.sourceId !== item.payload.source.id
      || item.summary.itemId !== (item.payload.source.kind === 'community-npm' ? item.payload.listing.distribution.packageName : item.payload.listing.pluginId))) {
    ctx.addIssue({ code: 'custom', path: ['summary'], message: 'Read summary must identify the pinned payload' });
  }
}));
export type RegistryItemV1 = z.infer<typeof RegistryItemV1Schema>;
export type RegistrySkillItemV1 = RegistryItemV1 & Readonly<{ payload: Extract<RegistryItemPayloadV1, { kind: 'skill' }> }>;
