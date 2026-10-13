// PKG-1 (lane 13 §9.2(2), campaign ruling 3.9 option (a)): an external Agent
// from a creator-added marketplace source is acquired by a fresh endpoint whose
// activation-local Home has never seen that source. Only the index fetch and the
// npm registry transport — genuine network boundaries — are replaced.
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { runnerArtifactTargetForPlatform } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { createPluginCompatibilityProjectionV1, PluginManifestV2Schema } from '@happier-dev/protocol';
import { projectExpectedMarketplaceListing } from '@happier-dev/protocol/marketplace/internal';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace/marketplaceSourceRegistryV1';
import { createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  client: null as null | { getJson: (...args: unknown[]) => Promise<unknown>; getBody: (...args: unknown[]) => Promise<unknown> },
  snapshot: null as null | Awaited<ReturnType<typeof createSampleAgentNpmFixture>>['snapshot'],
  registryCalls: [] as string[],
  /** Authorization each registry client was created with; `null` is anonymous. */
  registryAuthorizations: [] as (string | null)[],
  /** When set, the registry answers only these bearer credentials and 401s everything else. */
  acceptedAuthorizations: null as null | readonly string[],
  indexLoads: [] as string[],
}));

vi.mock('@/auth/terminalAuthEnrollmentRuntime', () => ({
  acquireTerminalAuthEnrollmentRuntime: vi.fn(async () => ({ ok: true, runtime: {}, close: async () => undefined })),
}));

vi.mock('@/plugins/distribution/npm/httpsClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/plugins/distribution/npm/httpsClient')>(),
  createNpmRegistryHttpsClient: (options: Readonly<{ registryOrigin: string; authorizationHeader?: string }>) => {
    boundary.registryCalls.push(options.registryOrigin);
    boundary.registryAuthorizations.push(options.authorizationHeader ?? null);
    if (!boundary.client) throw new Error('registry access not expected');
    const accepted = boundary.acceptedAuthorizations;
    if (accepted && !accepted.includes(options.authorizationHeader ?? '')) {
      const refuse = async () => { throw new NpmRegistryHttpError(401); };
      return { getJson: refuse, getBody: refuse };
    }
    return boundary.client;
  },
}));

vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: async (url: string | URL) => {
    if (String(url) !== CUSTOM_SOURCE_URL) throw new Error(`index not served: ${url}`);
    if (!boundary.snapshot) throw new Error('index access not expected');
    boundary.indexLoads.push(boundary.snapshot.source.id);
    return new Response(JSON.stringify(boundary.snapshot), { status: 200, headers: { 'content-type': 'application/json' } });
  },
}));

import { NpmRegistryHttpError } from '@/plugins/distribution/npm/httpsClient';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { createNpmRegistryProfileProbe } from '@/plugins/distribution/npm/profiles/probe';
import { createTestNpmTarball, sriSha512 } from '@/plugins/distribution/testkit/npmTarball';
import { SAMPLE_PLUGIN_FIXTURE_ROOT, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import { createProductionEphemeralRunnerApplication } from './runtimeIntegrations';
import packageJson from '../../package.json';

const roots: string[] = [];
const PACKAGE_NAME = '@acme/sample';
// The public npm registry needs no registry profile.
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
// A private registry needs an explicit registry profile on the Home that installs.
const PRIVATE_REGISTRY_ORIGIN = 'https://npm.acme.example.test';

function currentRunnerArtifactTarget() {
  const target = runnerArtifactTargetForPlatform({
    os: process.platform === 'win32' ? 'windows' : process.platform,
    arch: process.arch,
  });
  if (!target) throw new Error('Test host is not a supported Runner target');
  return target;
}

afterEach(async () => {
  boundary.client = null;
  boundary.snapshot = null;
  boundary.acceptedAuthorizations = null;
  boundary.registryCalls.length = 0;
  boundary.registryAuthorizations.length = 0;
  boundary.indexLoads.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeActivationFile(activationFilePath: string, seedByte: number): Promise<void> {
  const activationKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
  await writeFile(activationFilePath, JSON.stringify({
    v: 1,
    home: {
      v: 1,
      homeServerIdentityId: 'srv_runner_home',
      canonicalServerUrl: 'https://home.example.test',
      revision: 1,
      endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
    },
    activation: {
      id: `00000000-0000-4000-8000-0000000000${seedByte}`,
      signingPrivateKeyBase64Url: encodeBase64(activationKey.secretKey, 'base64url'),
      creatorAccountId: 'creator-account',
      creatorTokenEpoch: 4,
      activationExpiresAt: null,
      workspace: { kind: 'choose_on_endpoint' as const },
      sessionId: 'runner-session',
      machineId: 'runner-machine',
      authoringCommitment: encodeBase64(new Uint8Array(32).fill(seedByte), 'base64url'),
      artifact: {
        product: 'happier-runner',
        version: packageJson.version,
        target: currentRunnerArtifactTarget(),
        sha256: 'f'.repeat(64),
      },
      endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'creator-account' },
    },
  }), { mode: 0o600 });
}

async function createSampleAgentNpmFixture(registryOrigin: string = REGISTRY_ORIGIN) {
  const manifestRaw = await readFile(join(SAMPLE_PLUGIN_FIXTURE_ROOT, '.happier-plugin', 'plugin.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as { version: string };
  const version = manifest.version;
  const compatibilityProjection = createPluginCompatibilityProjectionV1({
    manifest: PluginManifestV2Schema.parse(JSON.parse(manifestRaw)),
    uiArtifacts: { version: 2, entries: [] },
  });
  const archive = await createTestNpmTarball([
    {
      name: 'package/package.json',
      body: JSON.stringify({
        name: PACKAGE_NAME,
        version,
        keywords: ['happier-plugin'],
        files: ['.happier-plugin', 'daemon.mjs', 'agentRuntime.mjs'],
        happier: { manifest: '.happier-plugin/plugin.json', compatibilityProjection },
      }),
    },
    { name: 'package/.happier-plugin/plugin.json', body: manifestRaw },
    { name: 'package/daemon.mjs', body: await readFile(join(SAMPLE_PLUGIN_FIXTURE_ROOT, 'daemon.mjs'), 'utf8') },
    { name: 'package/agentRuntime.mjs', body: await readFile(join(SAMPLE_PLUGIN_FIXTURE_ROOT, 'agentRuntime.mjs'), 'utf8') },
  ]);
  const integrity = sriSha512(archive);
  const metadata = {
    name: PACKAGE_NAME,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name: PACKAGE_NAME,
        version,
        happier: { manifest: '.happier-plugin/plugin.json', compatibilityProjection },
        dist: { integrity, tarball: `${registryOrigin}/${encodeURIComponent(PACKAGE_NAME)}/-/sample-${version}.tgz` },
      },
    },
  };
  const manifestDigest = `sha256:${createHash('sha256').update(manifestRaw).digest('hex')}`;
  const client = {
    getJson: async () => metadata,
    getBody: async () => ({ body: Readable.from([archive]), contentLength: archive.byteLength }),
  };
  const snapshot = {
    source: { id: deriveMarketplaceSourceId(CUSTOM_SOURCE_URL), title: 'Acme catalog', kind: 'user', sourceUrl: CUSTOM_SOURCE_URL },
    freshness: { state: 'fresh', fetchedAtMs: 1 },
    diagnostics: [],
    entries: [{
      pluginId: SAMPLE_PLUGIN_ID,
      publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Acme Sample', description: 'Community npm plugin' },
      distribution: { kind: 'npm', packageName: PACKAGE_NAME, registryOrigin, version, integrity },
      manifestDigest,
      compatibility: { happier: '>=0.0.0', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      review: { status: 'unreviewed', reviewedAt: null },
      categories: [],
      media: [],
      updatePolicy: 'allowed',
      links: {},
    }],
  };
  return { version, integrity, manifestDigest, client, snapshot };
}

const CUSTOM_SOURCE_URL = 'https://catalog.acme.example.test/index.json';

async function creatorCommitment(fixture: Awaited<ReturnType<typeof createSampleAgentNpmFixture>>) {
  const host = createRegistryHostV1({ host: 'node',
    http: { getJson: async () => ({ ok: true, value: fixture.snapshot, fetchedAt: 1 }), getText: async () => { throw new Error('unused'); }, getBytes: async () => { throw new Error('unused'); } },
    readSources: async () => [{ id: fixture.snapshot.source.id, title: 'Acme catalog', format: 'happier-catalog', kinds: ['plugin'],
      url: CUSTOM_SOURCE_URL, enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true }],
  });
  const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
    kind: 'plugin', sourceId: fixture.snapshot.source.id, itemId: SAMPLE_PLUGIN_ID, version: fixture.version,
  }));
  if (item.payload.kind !== 'plugin') throw new Error('Expected a plugin listing');
  return projectExpectedMarketplaceListing({ ...item.payload.listing, source: item.payload.source }, null);
}

describe('Runner acquisition of an Agent from a creator-added marketplace source', () => {
  it('installs the exact reviewed generation without persisting an activation source registry', async () => {
    const fixture = await createSampleAgentNpmFixture();
    boundary.client = fixture.client;
    boundary.snapshot = fixture.snapshot;

    // Creator machine: the user added this catalog, and the creator projects
    // the commitment exactly as the Temporary-computer creator does.
    const commitment = await creatorCommitment(fixture);

    // Endpoint: a fresh activation-local Home.
    const root = await mkdtemp(join(tmpdir(), 'runner-pkg1-endpoint-'));
    roots.push(root);
    const activationFilePath = join(root, 'happier-runner.activation.json');
    await writeActivationFile(activationFilePath, 41);
    const app = await createProductionEphemeralRunnerApplication({ activationFilePath });
    const activationHome = await mkdtemp(join(root, 'activation-home-'));

    const acquisition = await app.dependencies.prepareReviewedPluginAcquisition({
      manifest: { preparedAuthoring: { agentPluginDistribution: commitment } } as never,
      homeDirectory: activationHome,
      signal: new AbortController().signal,
    });
    if ('kind' in acquisition) throw new Error('A public registry needs no registry selection');
    expect(acquisition.review).toMatchObject({ pluginId: SAMPLE_PLUGIN_ID });
    await acquisition.apply({ signal: new AbortController().signal, optionalSelections: [] });

    const installed = await createPluginRegistryStateStore({ happyHomeDir: activationHome }).read();
    expect(installed.plugins[SAMPLE_PLUGIN_ID]).toBeDefined();
    await expect(access(join(resolvePluginStorePaths({ happyHomeDir: activationHome }).stateDir, 'marketplace-source-registry.v1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('asks the endpoint to select a private registry profile, never uses the creator credential, and installs through the canonical owners', async () => {
    const fixture = await createSampleAgentNpmFixture(PRIVATE_REGISTRY_ORIGIN);
    boundary.client = fixture.client;
    boundary.snapshot = fixture.snapshot;
    boundary.acceptedAuthorizations = ['Bearer creator-secret', 'Bearer endpoint-secret'];

    // Creator machine: the catalog is bound to the creator's own signed-in
    // registry profile, so the creator's listing is installable there.
    const creatorHome = await mkdtemp(join(tmpdir(), 'runner-pkg1-private-creator-'));
    roots.push(creatorHome);
    const creatorProfiles = createNpmRegistryProfileService({ happyHomeDir: creatorHome, probe: createNpmRegistryProfileProbe() });
    await creatorProfiles.mutate({
      action: 'add', machineId: 'creator-machine', expectedRevision: 0, mutationId: 'creator-add',
      profileId: 'creator_registry',
      profile: { displayName: 'Acme', origin: PRIVATE_REGISTRY_ORIGIN, scopes: ['@acme'], useAsDefault: false, allowPrivateNetwork: false },
    });
    await creatorProfiles.mutate({
      action: 'login', machineId: 'creator-machine', expectedRevision: 1, mutationId: 'creator-login',
      profileId: 'creator_registry', credential: { kind: 'bearer_token', secret: 'creator-secret' },
    });
    await creatorProfiles.mutate({
      action: 'test', machineId: 'creator-machine', expectedRevision: 2, mutationId: 'creator-test', profileId: 'creator_registry',
    });
    const commitment = await creatorCommitment(fixture);
    boundary.registryCalls.length = 0;
    boundary.registryAuthorizations.length = 0;

    // Endpoint: a fresh activation-local Home that has no registry profile.
    const root = await mkdtemp(join(tmpdir(), 'runner-pkg1-private-endpoint-'));
    roots.push(root);
    const activationFilePath = join(root, 'happier-runner.activation.json');
    await writeActivationFile(activationFilePath, 42);
    const app = await createProductionEphemeralRunnerApplication({ activationFilePath });
    const activationHome = await mkdtemp(join(root, 'activation-home-'));
    const signal = new AbortController().signal;

    const first = await app.dependencies.prepareReviewedPluginAcquisition({
      manifest: { preparedAuthoring: { agentPluginDistribution: commitment } } as never,
      homeDirectory: activationHome,
      signal,
    });
    if (!('kind' in first)) throw new Error('Expected the endpoint to be asked for a registry profile');
    expect(first.requirement).toEqual({
      registryOrigin: PRIVATE_REGISTRY_ORIGIN,
      packageName: PACKAGE_NAME,
      registryProfileId: null,
    });
    // Nothing reached the private registry before the endpoint answered.
    expect(boundary.registryCalls).toEqual([]);

    const selected = await first.selectRegistryProfile({ credential: 'endpoint-secret', signal });
    if ('kind' in selected) throw new Error('Expected the installation review after the endpoint selection');
    expect(selected.review).toMatchObject({ pluginId: SAMPLE_PLUGIN_ID });
    await selected.apply({ signal, optionalSelections: [] });

    // The endpoint's own profile, created through the canonical profile
    // service, is the one binding the install used.
    const endpointProfiles = await createNpmRegistryProfileService({ happyHomeDir: activationHome }).snapshot();
    expect(endpointProfiles.profiles).toHaveLength(1);
    const endpointProfile = endpointProfiles.profiles[0]!;
    expect(endpointProfile).toMatchObject({ origin: PRIVATE_REGISTRY_ORIGIN, scopes: ['@acme'], hasCredentials: true });
    expect(endpointProfile.profileId).not.toBe('creator_registry');
    await expect(access(join(resolvePluginStorePaths({ happyHomeDir: activationHome }).stateDir, 'marketplace-source-registry.v1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const installed = await createPluginRegistryStateStore({ happyHomeDir: activationHome }).read();
    expect(installed.plugins[SAMPLE_PLUGIN_ID]?.install.trust?.distribution).toEqual({
      kind: 'npm',
      registryOrigin: PRIVATE_REGISTRY_ORIGIN,
      registryProfileId: endpointProfile.profileId,
      packageName: PACKAGE_NAME,
    });
    // Every endpoint registry request carried only the endpoint's credential.
    expect(boundary.registryAuthorizations.length).toBeGreaterThan(0);
    expect(new Set(boundary.registryAuthorizations)).toEqual(new Set(['Bearer endpoint-secret']));
  });

  it('refuses a remote catalog rebinding after review and before the install commits', async () => {
    const fixture = await createSampleAgentNpmFixture();
    boundary.client = fixture.client;
    boundary.snapshot = fixture.snapshot;
    const commitment = await creatorCommitment(fixture);
    const root = await mkdtemp(join(tmpdir(), 'runner-pkg1-rebound-'));
    roots.push(root);
    const activationFilePath = join(root, 'happier-runner.activation.json');
    await writeActivationFile(activationFilePath, 43);
    const app = await createProductionEphemeralRunnerApplication({ activationFilePath });
    const activationHome = await mkdtemp(join(root, 'activation-home-'));
    const signal = new AbortController().signal;
    const acquisition = await app.dependencies.prepareReviewedPluginAcquisition({
      manifest: { preparedAuthoring: { agentPluginDistribution: commitment } } as never,
      homeDirectory: activationHome, signal,
    });
    if ('kind' in acquisition) throw new Error('A public registry needs no registry selection');
    boundary.snapshot = { ...fixture.snapshot, entries: fixture.snapshot.entries.map(entry => ({ ...entry, manifestDigest: `sha256:${'d'.repeat(64)}` })) };
    await expect(acquisition.apply({ signal, optionalSelections: [] })).rejects.toThrow();
    expect((await createPluginRegistryStateStore({ happyHomeDir: activationHome }).read()).plugins[SAMPLE_PLUGIN_ID]).toBeUndefined();
  });

  it('refuses a creator profile binding before any endpoint acquisition', async () => {
    const fixture = await createSampleAgentNpmFixture(PRIVATE_REGISTRY_ORIGIN);
    const commitment = await creatorCommitment(fixture);
    const root = await mkdtemp(join(tmpdir(), 'runner-pkg1-creator-profile-'));
    roots.push(root);
    const activationFilePath = join(root, 'happier-runner.activation.json');
    await writeActivationFile(activationFilePath, 44);
    const app = await createProductionEphemeralRunnerApplication({ activationFilePath });
    await expect(app.dependencies.prepareReviewedPluginAcquisition({
      manifest: { preparedAuthoring: { agentPluginDistribution: { ...commitment, registryProfileId: 'creator_registry' } } } as never,
      homeDirectory: root, signal: new AbortController().signal,
    })).rejects.toThrow('runner_reviewed_plugin_creator_profile_forbidden');
    expect(boundary.registryCalls).toEqual([]);
    expect(boundary.indexLoads).toEqual([]);
  });

  it('refuses a sealed source identity that does not belong to its reviewed URL', async () => {
    const fixture = await createSampleAgentNpmFixture();
    const commitment = await creatorCommitment(fixture);
    const root = await mkdtemp(join(tmpdir(), 'runner-pkg1-source-identity-'));
    roots.push(root);
    const activationFilePath = join(root, 'happier-runner.activation.json');
    await writeActivationFile(activationFilePath, 45);
    const app = await createProductionEphemeralRunnerApplication({ activationFilePath });
    await expect(app.dependencies.prepareReviewedPluginAcquisition({
      manifest: { preparedAuthoring: { agentPluginDistribution: { ...commitment, source: { ...commitment.source, id: 'unbound-source' } } } } as never,
      homeDirectory: root, signal: new AbortController().signal,
    })).rejects.toThrow('runner_reviewed_plugin_source_unbound');
    expect(boundary.registryCalls).toEqual([]);
    expect(boundary.indexLoads).toEqual([]);
  });
});
