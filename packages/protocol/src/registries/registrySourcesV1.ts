import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { listSavedSecretReferenceCarrierPathsV1 } from '../account/settings/savedSecretReferenceV1.js';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, PUBLIC_NPM_REGISTRY_ORIGIN_V1, DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE, DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, deriveMarketplaceSourceId } from '../marketplace/marketplaceSourceRegistryV1.js';

export const RegistryFormatV1Schema = lazyZodSchema(() => z.enum([
  'skills-sh', 'git', 'claude-marketplace', 'mcp-registry', 'acp-registry', 'happier-catalog', 'happier-npm',
]));
export type RegistryFormatV1 = z.infer<typeof RegistryFormatV1Schema>;

export const RegistryKindV1Schema = lazyZodSchema(() => z.enum(['skill', 'mcpServer', 'agent', 'plugin']));
export type RegistryKindV1 = z.infer<typeof RegistryKindV1Schema>;
export const REGISTRY_FORMAT_KINDS_V1: Readonly<Record<RegistryFormatV1, readonly RegistryKindV1[]>> = {
  'skills-sh': ['skill'], git: ['skill'], 'claude-marketplace': ['skill'], 'mcp-registry': ['mcpServer'],
  'acp-registry': ['agent'], 'happier-catalog': ['skill', 'mcpServer', 'agent', 'plugin'], 'happier-npm': ['plugin', 'agent'],
};
export const RegistrySourceTokenV1Schema = lazyZodSchema(() => z.strictObject({ secretRef: z.string().check(z.minLength(1)),
  header: z.optional(z.strictObject({ name: z.string().check(z.minLength(1)), scheme: z.optional(z.enum(['Bearer', 'token'])) })),
}));
export const RegistrySourceV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), title: z.string().check(z.minLength(1)), format: RegistryFormatV1Schema,
  kinds: z.array(RegistryKindV1Schema).check(z.minLength(1)), url: z.string().check(z.minLength(1)), path: z.optional(z.string()), ref: z.optional(z.string().check(z.minLength(1))),
  enabled: z.boolean(), token: z.optional(RegistrySourceTokenV1Schema),
  npmRegistryProfileId: z.optional(z.string().check(z.minLength(1))), addedAt: z.number().check(z.int(), z.nonnegative()),
}).check(z.superRefine((source, ctx) => {
  if (source.kinds.some(kind => !REGISTRY_FORMAT_KINDS_V1[source.format].includes(kind))) {
    ctx.addIssue({ code: 'custom', path: ['kinds'], message: 'Kind not supported by source format' });
  }
  try { const url = new URL(source.url); if (url.username || url.password || source.format !== 'git' && url.protocol !== 'https:') throw new Error('credentials-or-scheme'); }
  catch { if (source.format !== 'git' || source.url.includes('://') && !/^(ssh|git):\/\//.test(source.url)) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Invalid credential-free source URL' });
  } }
})));
export type RegistrySourceV1 = z.infer<typeof RegistrySourceV1Schema>;
export const RegistrySourceDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  ...RegistrySourceV1Schema.shape,
  origin: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('built_in') }), z.strictObject({ kind: z.literal('user') }),
    z.strictObject({ kind: z.literal('plugin'), pluginId: z.string().check(z.minLength(1)), localId: z.string().check(z.minLength(1)), suppliers: z.array(z.string().check(z.minLength(1))) })]),
  removable: z.boolean(),
}).check(z.superRefine((descriptor, ctx) => {
  const { origin: _origin, removable: _removable, ...source } = descriptor;
  const parsed = RegistrySourceV1Schema.safeParse(source);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({code:'custom',path:issue.path,message:issue.message});
})));
export type RegistrySourceDescriptorV1 = RegistrySourceV1 & Readonly<{
  origin: Readonly<{ kind: 'built_in' }> | Readonly<{ kind: 'user' }> | Readonly<{ kind: 'plugin'; pluginId: string; localId: string; suppliers: readonly string[] }>;
  removable: boolean;
}>;
export const RegistrySourcesRecordV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(2),
  sources: z.array(RegistrySourceV1Schema), disabledSourceIds: z.array(z.string().check(z.minLength(1))),
}));
export type RegistrySourcesRecordV1 = z.infer<typeof RegistrySourcesRecordV1Schema>;
export const RegistrySourcesReadEnvelopeV1Schema=lazyZodSchema(()=>z.object({v:z.union([z.literal(1),z.literal(2)]),sources:z.array(z.unknown()),
  disabledSourceIds:z.optional(z.array(z.string().check(z.minLength(1))))}));

export function normalizeRegistrySourceUrlV1(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_source');
  url.hash = ''; url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.hostname === 'github.com') url.pathname = url.pathname.replace(/\.git$/, '');
  return url.toString().replace(/\/$/, '');
}
export function deriveRegistrySourceIdV1(url: string): string {
  return `registry:${bytesToHex(sha256(new TextEncoder().encode(normalizeRegistrySourceUrlV1(url)))).slice(0, 12)}`;
}
export const HAPPIER_PICKS_SOURCE_ID = deriveMarketplaceSourceId(DEFAULT_CURATED_MARKETPLACE_SOURCE_URL);

/** The stored-data seam drops unknown fields and malformed entries, never a whole usable list. */
export function readRegistrySourcesRecordV1(raw: unknown): RegistrySourcesRecordV1 {
  const input = RegistrySourcesReadEnvelopeV1Schema.parse(raw);
  const sources: RegistrySourceV1[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(input.sources) ? input.sources : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const config = value.config && typeof value.config === 'object' ? value.config as Record<string, unknown> : {};
    const legacy = input.v === 1;
    const legacySkillsSh = value.adapterId === 'skillsSh' || value.adapterId === 'skills-sh' || value.adapterId === 'skills_sh';
    const shape = legacy ? { id: value.id, title: value.title, format: legacySkillsSh ? 'skills-sh' : value.adapterId,
      kinds: ['skill'], url: config.repositoryUrl ?? config.baseUrl ?? (legacySkillsSh ? 'https://skills.sh' : undefined),
      ...(typeof config.subdirectory === 'string' ? { path: config.subdirectory } : {}),
      ...(typeof config.ref === 'string' ? { ref: config.ref } : {}), enabled: value.enabled !== false, addedAt: 0 }
      : Object.fromEntries(['id', 'title', 'format', 'kinds', 'url', 'path', 'ref', 'enabled', 'token', 'npmRegistryProfileId', 'addedAt']
        .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    const parsed = createStoredReadSchema(RegistrySourceV1Schema).safeParse(shape);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id); sources.push(parsed.data);
  }
  // Stored projection may discard an unusable source, but never its token
  // binding: deletion and promotion consume this same complete inventory.
  const represented = new Set<string>();
  const sourcesById = new Map(sources.map(source => [source.id, source] as const));
  for (const [index, entry] of input.sources.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const token = value.token;
    if (!token || typeof token !== 'object' || Array.isArray(token) || !('secretRef' in token)) continue;
    const source = typeof value.id === 'string' ? sourcesById.get(value.id) : undefined;
    if (source?.token?.secretRef === token.secretRef) represented.add(`sources[${index}].token.secretRef`);
  }
  if (listSavedSecretReferenceCarrierPathsV1(raw).some(path => !represented.has(path))) {
    throw new Error('Registry token reference inventory is incomplete');
  }
  return { v: 2, sources, disabledSourceIds: Array.isArray(input.disabledSourceIds)
    ? [...new Set(input.disabledSourceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [] };
}
// Other built-ins co-land with their format's first consuming unit.
export const BUILT_IN_REGISTRY_SOURCES_V1: readonly RegistrySourceDescriptorV1[] = [{
  id: HAPPIER_PICKS_SOURCE_ID, title: DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE, format: 'happier-catalog', kinds: ['skill', 'mcpServer', 'agent', 'plugin'],
  url: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, enabled: true, addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: 'builtin:skills-sh', title: 'skills.sh', format: 'skills-sh', kinds: ['skill'], url: 'https://skills.sh', enabled: true,
  addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: 'builtin:mcp-registry', title: 'MCP Registry', format: 'mcp-registry', kinds: ['mcpServer'],
  url: 'https://registry.modelcontextprotocol.io', enabled: true, addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: 'builtin:acp-registry', title: 'ACP Registry', format: 'acp-registry', kinds: ['agent'],
  url: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json', enabled: true,
  addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}, {
  id: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, title: 'Community npm', format: 'happier-npm', kinds: ['plugin', 'agent'],
  url: `${PUBLIC_NPM_REGISTRY_ORIGIN_V1}/-/v1/search`, enabled: true, addedAt: 0, origin: { kind: 'built_in' }, removable: false,
}];
export function listRegistrySourcesV1(input: Readonly<{ record: RegistrySourcesRecordV1; pluginSources: readonly RegistrySourceDescriptorV1[] }>): readonly RegistrySourceDescriptorV1[] {
  const disabled = new Set(input.record.disabledSourceIds);
  const seen = new Set<string>();
  return [...BUILT_IN_REGISTRY_SOURCES_V1, ...input.pluginSources,
    ...input.record.sources.map(source => ({ ...source, origin: { kind: 'user' as const }, removable: true }))]
    .filter(source => { if (seen.has(source.id)) return false; seen.add(source.id); return true; })
    // Existing plugin-only declarations also provide Agent plugin discovery.
    // This is a source projection, not a rewrite of the person's stored kinds.
    .map(source => source.kinds.includes('plugin') && !source.kinds.includes('agent')
      && REGISTRY_FORMAT_KINDS_V1[source.format].includes('agent')
      ? { ...source, kinds: [...source.kinds, 'agent' as const] } : source)
    .map(source => source.origin.kind === 'user' ? source : { ...source, enabled: !disabled.has(source.id) });
}
export function resolveLegacyRegistrySourceRefV1(sourceId: string): string {
  return sourceId.startsWith('git:') ? sourceId.slice(4) : sourceId;
}
