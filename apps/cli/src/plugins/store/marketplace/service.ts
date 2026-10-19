import { MarketplaceIndexQueryResultV1Schema } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import type { MarketplaceIndexQueryResultV1, MarketplaceIndexSourceKindV1 } from '@happier-dev/protocol';
import { PUBLIC_NPM_REGISTRY_ORIGIN_V1 } from '@happier-dev/protocol/marketplace/communityNpmDiscoveryV1';
import { registryMarketplaceSourceV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { readStoredCredentials } from '@/persistence';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { normalizeNpmArtifactRequest } from '@/plugins/distribution/npm/normalize';
import { createExactMarketplaceIndex } from './index';
import { loadMarketplaceIndexSource, type LoadedMarketplaceIndexSource } from './indexSourceLoader';

type MarketplaceArtifactAccessProfile = Readonly<{
  profileId: string;
  displayName?: string;
  origin: string;
  scopes?: readonly string[];
  useAsDefault?: boolean;
  availability: 'unknown' | 'available' | 'sign_in_required' | 'offline';
  updatedAtMs?: number;
}>;

type MarketplaceArtifactAccess = MarketplaceIndexQueryResultV1['items'][number]['artifactAccess'];

export function projectMarketplaceArtifactAccess(
  item: MarketplaceIndexQueryResultV1['items'][number],
  profiles: readonly MarketplaceArtifactAccessProfile[],
  source?: Readonly<{ registryProfileId?: string | null }>,
): MarketplaceIndexQueryResultV1['items'][number] {
  const artifactAccess = resolveMarketplaceArtifactAccess(item.distribution, profiles, source);
  return artifactAccess ? { ...item, artifactAccess } : item;
}

/**
 * Whether this Home can reach one listed npm artifact through the persisted
 * source binding, decided from the distribution facts alone. `null` means the
 * listing's own public access stands. The exact-install preparer consumes the
 * same decision before any registry access, so a listing that needs a registry
 * profile is asked for one at preparation rather than refused after review.
 */
export function resolveMarketplaceArtifactAccess(
  distribution: Pick<
    MarketplaceIndexQueryResultV1['items'][number]['distribution'],
    'packageName' | 'registryOrigin' | 'registryProfileId'
  >,
  profiles: readonly MarketplaceArtifactAccessProfile[],
  source?: Readonly<{ registryProfileId?: string | null }>,
): MarketplaceArtifactAccess | null {
  const catalogProfileId = distribution.registryProfileId;
  const profileId = source?.registryProfileId ?? null;
  if (!profileId) {
    if (!catalogProfileId && distribution.registryOrigin === PUBLIC_NPM_REGISTRY_ORIGIN_V1) return null;
    if (!catalogProfileId) {
      return { state: 'unverified-profile', registryProfileId: null };
    }
    return { state: 'unverified-profile', registryProfileId: catalogProfileId };
  }
  // Catalog documents are remote input. Only the persisted host binding can
  // select a profile; the catalog-supplied id remains non-authoritative.
  const profile = profiles.find((entry) => entry.profileId === profileId) ?? null;
  if (!profile) return { state: 'source-removed', registryProfileId: profileId };
  try {
    normalizeNpmArtifactRequest({
      packageName: distribution.packageName,
      curatedExactOrigin: distribution.registryOrigin,
      explicitProfileId: profileId,
      profiles: profiles.map((entry) => ({
        version: 1,
        id: entry.profileId,
        displayName: entry.displayName ?? entry.profileId,
        origin: entry.origin,
        scopes: [...(entry.scopes ?? [])],
        useAsDefault: entry.useAsDefault ?? false,
        createdAtMs: entry.updatedAtMs ?? 0,
        updatedAtMs: entry.updatedAtMs ?? 0,
      })),
    });
  } catch {
    return { state: 'unverified-profile', registryProfileId: profileId };
  }
  if (profile.availability === 'offline') {
    return { state: 'offline', registryProfileId: profileId };
  }
  // Availability is the profile owner's own answer, and it already folds
  // credential state in: a profile referencing a credential it can no longer
  // read is projected as `sign_in_required`. A profile that intentionally
  // references no credential — an anonymous internal registry — stays
  // installable, exactly as the artifact-request path treats it.
  if (profile.availability !== 'available') {
    return { state: 'auth-unavailable', registryProfileId: profileId };
  }
  return { state: 'available', registryProfileId: profileId };
}

export type MarketplaceIndexSourceConfig = Readonly<{
  id: string;
  title: string;
  sourceUrl: string;
  enabled: boolean;
  origin: MarketplaceIndexSourceKindV1;
  registryProfileId?: string | null;
  /** The current canonical descriptor proves any installed-declaration binding. */
  registrySource: RegistrySourceDescriptorV1;
}>;

/** Marketplace install sources are a projection of the one Account source owner. */
export type MarketplaceRegistrySourcesReaderV1 = () => Promise<readonly RegistrySourceDescriptorV1[]>;

async function createAccountSourceReader(): Promise<MarketplaceRegistrySourcesReaderV1> {
  const credentials = await readStoredCredentials();
  return createCliRegistryHostV1({ ...(credentials ? { credentials } : {}) }).readSources;
}

export async function readMarketplaceInstallSources(input: Readonly<{ readRegistrySources?: MarketplaceRegistrySourcesReaderV1 }> = {}): Promise<readonly MarketplaceIndexSourceConfig[]> {
  const readSources = input.readRegistrySources ?? await createAccountSourceReader();
  return (await readSources()).filter(source => (source.kinds.includes('plugin') || source.kinds.includes('agent'))
    && (source.format === 'happier-catalog' || source.format === 'happier-npm')).map(source => {
    const projected = registryMarketplaceSourceV1(source);
    return { id: source.id, title: source.title, sourceUrl: source.url, enabled: source.enabled, registrySource: source,
      origin: projected.kind, ...(source.npmRegistryProfileId ? { registryProfileId: source.npmRegistryProfileId } : {}) };
  });
}

export async function resolveExactMarketplaceSourceBinding(params: Readonly<{
  happyHomeDir?: string;
  sourceId: string;
  readRegistrySources?: MarketplaceRegistrySourcesReaderV1;
}>): Promise<
  | Readonly<{ ok: true; source: MarketplaceIndexSourceConfig }>
  | Readonly<{ ok: false; code: 'install_unavailable'; message: string }>
> {
  let source: MarketplaceIndexSourceConfig | undefined;
  try { source = (await readMarketplaceInstallSources(params)).find(entry => entry.id === params.sourceId.trim()); }
  catch { return { ok: false, code: 'install_unavailable', message: 'Account marketplace sources are currently unavailable.' }; }
  if (!source?.enabled) return { ok: false, code: 'install_unavailable',
    message: 'No enabled Account marketplace source is configured for this Install and trust action.' };
  return { ok: true, source };
}

export function createMarketplaceIndexService(params?: Readonly<{
  happyHomeDir?: string;
  /** A Runner's admitted sealed commitment supplies one read-only source;
   *  ordinary CLI/daemon consumers use the captured Account catalog owner. */
  readRegistrySources?: MarketplaceRegistrySourcesReaderV1;
}>): Readonly<{
  queryExactListing: (params: Readonly<{ sourceId: string; pluginId: string; packageName?: string; version?: string }>) => Promise<
    | Readonly<{ ok: true; source: MarketplaceIndexSourceConfig; result: MarketplaceIndexQueryResultV1 }>
    | Readonly<{ ok: false; code: 'install_unavailable' | 'source_changed'; message: string }>
  >;
}> {
  const registryProfiles = createNpmRegistryProfileService({ happyHomeDir: params?.happyHomeDir });
  let accountReader: Promise<MarketplaceRegistrySourcesReaderV1> | undefined;
  const readRegistrySources: MarketplaceRegistrySourcesReaderV1 = params?.readRegistrySources ?? (async () => {
    accountReader ??= createAccountSourceReader();
    return (await accountReader)();
  });
  return {
    async queryExactListing(exact) {
      const sourceId = exact.sourceId.trim(), pluginId = exact.pluginId.trim();
      if (!sourceId || !pluginId) return { ok: false, code: 'install_unavailable',
        message: 'An Account marketplace source identity and plugin ID are required.' };
      const binding = await resolveExactMarketplaceSourceBinding({ sourceId, readRegistrySources });
      if (!binding.ok) return binding;
      const source = binding.source;
      const profileStateBeforeFetch = await registryProfiles.snapshot().catch(() => ({ revision: -1, profiles: [] }));
      // A source binding can reuse its registry's explicit network permission
      // only for that same origin. Remote catalog fields never select it.
      const allowPrivateNetwork = profileStateBeforeFetch.profiles.some(profile =>
        profile.profileId === source.registryProfileId && profile.allowPrivateNetwork === true
        && profile.origin === new URL(source.sourceUrl).origin);
      let snapshot: LoadedMarketplaceIndexSource;
      try {
        snapshot = await loadMarketplaceIndexSource({ happyHomeDir: params?.happyHomeDir,
          registrySource: source.registrySource,
          allowPrivateNetwork,
          source: { id: source.id, title: source.title, sourceUrl: source.sourceUrl, kind: source.origin },
          query: { text: source.origin === 'community-npm' && !exact.packageName ? pluginId : '',
            ...(exact.packageName ? { exactPackageName: exact.packageName } : {}),
            ...(source.origin === 'community-npm' && exact.version !== undefined ? { exactVersion: exact.version } : {}) } });
      } catch { return { ok: false, code: 'install_unavailable', message: 'The exact marketplace source facts are currently unavailable.' }; }
      const current = await resolveExactMarketplaceSourceBinding({ sourceId, readRegistrySources });
      if (!current.ok || current.source.origin !== source.origin || current.source.sourceUrl !== source.sourceUrl
        || (current.source.registryProfileId ?? null) !== (source.registryProfileId ?? null)
        || current.source.registrySource.origin.kind !== source.registrySource.origin.kind
        || source.registrySource.origin.kind === 'plugin' && (current.source.registrySource.origin.kind !== 'plugin'
          || current.source.registrySource.origin.pluginId !== source.registrySource.origin.pluginId
          || current.source.registrySource.origin.localId !== source.registrySource.origin.localId)) {
        return { ok: false, code: 'source_changed', message: 'The Account marketplace source binding changed while exact facts were loading.' };
      }
      const profileState = await registryProfiles.snapshot().catch(() => ({ revision: -1, profiles: [] }));
      const { communityNpmPage: _page, ...cleanSnapshot } = snapshot;
      const result = createExactMarketplaceIndex({ source: cleanSnapshot, pluginId, version: exact.version });
      return { ok: true, source, result: MarketplaceIndexQueryResultV1Schema.parse({
        ...result, items: result.items.map(item => projectMarketplaceArtifactAccess(item, profileState.profiles, source)),
      }) };
    },
  };
}
