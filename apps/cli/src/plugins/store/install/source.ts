import { copyFile, mkdir, mkdtemp, stat, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { PluginSourceSpecV1 } from '@happier-dev/protocol';
import { readPluginArchiveIntegrity } from '@/plugins/distribution/integrity';

import {
  cleanupStagedNpmCompatiblePluginArchive,
  stageNpmCompatiblePluginArchive,
  type StagedNpmCompatiblePluginArchive,
} from '@/plugins/distribution/archive';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { downloadRemoteArchiveToTempFile } from './archive/download';
import { resolveLocalPluginInstallTrust } from './trustPolicy';
import { canonicalizeRemotePluginArchiveUrl, isRemotePluginArchiveLocator } from './trustIdentity';

export type PluginSourceInspectionKind = 'path' | 'archive';

export type InspectPluginSourceResult =
  | Readonly<{
      ok: true;
      alreadyInstalled: boolean;
      pluginId: string;
      sourceKind: PluginSourceInspectionKind;
      source: PluginSourceSpecV1;
      manifestVersion: string;
      manifestPath: string;
      installedPath: string | null;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'plugin_source_invalid' | 'plugin_install_failed' | 'plugin_install_conflict' | 'plugin_already_installed' | 'plugin_install_trust_required';
      errorMessage: string;
    }>;

export function inferPluginSourceInspectionKind(locator: string): PluginSourceInspectionKind {
  const normalizedLocator = locator.trim();
  if (!normalizedLocator) {
    return 'path';
  }

  if (isRemotePluginArchiveLocator(normalizedLocator)) {
    return 'archive';
  }

  const normalized = normalizedLocator.toLowerCase();
  if (normalized.endsWith('.tar.gz') || normalized.endsWith('.tgz') || normalized.endsWith('.tar.xz') || normalized.endsWith('.zip')) {
    return 'archive';
  }
  return 'path';
}

function normalizeInspectedTrustPolicy(
  trustPolicy: PluginSourceSpecV1['trustPolicy'],
): PluginSourceSpecV1['trustPolicy'] {
  return trustPolicy === 'untrusted' ? 'untrusted' : 'prompt';
}

async function stageArchivePluginSource(params: Readonly<{
  happyHomeDir: string;
  archivePath: string;
}>): Promise<StagedNpmCompatiblePluginArchive> {
  const store = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
  const facts = await readPluginArchiveIntegrity(params.archivePath);
  const staged = await stageNpmCompatiblePluginArchive({
    archivePath: params.archivePath,
    byteLength: facts.byteLength,
    integrity: facts.integrity,
    archiveDigestSha256: facts.archiveDigestSha256,
    stagingParentPath: store.paths.cacheDir,
  });
  if (!staged.ok) {
    throw new Error(`Archive plugin candidate rejected (${staged.rejection.code}): ${staged.rejection.message}`);
  }
  return staged.candidate;
}

export async function inspectPluginSource(params: Readonly<{
  happyHomeDir: string;
  locator: string;
  sourceKind?: PluginSourceInspectionKind;
  sourceSpecOverride?: PluginSourceSpecV1;
  skipIfInstalled?: boolean;
  dev?: boolean;
  workspaceRoot?: string;
}>): Promise<InspectPluginSourceResult> {
  const sourceKind = params.sourceKind ?? inferPluginSourceInspectionKind(params.locator);
  const stateStore = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
  const initialState = await stateStore.read();

  try {
    if (sourceKind === 'path') {
      if (isRemotePluginArchiveLocator(params.locator)) throw new Error('Remote plugin sources require archive inspection');
      const resolvedSource = await resolveLocalPathPluginSource({ locator: params.locator });
      if (!resolvedSource.ok) {
        return {
          ok: false,
          errorCode: 'plugin_source_invalid',
          errorMessage: resolvedSource.diagnostics.map((diagnostic) => diagnostic.message).join('\n') || 'Invalid plugin source',
        };
      }

      const pluginId = resolvedSource.manifest.id;
      if (params.skipIfInstalled && initialState.plugins[pluginId]) {
        const existingRecord = initialState.plugins[pluginId]!;
        const installedPath = existingRecord.install.installedPath ?? null;
        return {
          ok: true,
          alreadyInstalled: true,
          pluginId,
          sourceKind,
          source: existingRecord.source,
          manifestVersion: existingRecord.install.manifestVersion,
          manifestPath: existingRecord.source.manifestPath,
          installedPath,
        };
      }

      const trust = await resolveLocalPluginInstallTrust({
        dev: params.dev,
        pluginRootPath: resolvedSource.pluginRootPath,
        workspaceRoot: params.workspaceRoot,
        sourceSpecOverride: params.sourceSpecOverride,
        defaultTrustPolicy: resolvedSource.sourceSpec.trustPolicy,
        defaultInstallPolicy: resolvedSource.sourceSpec.installPolicy,
      });
      const source: PluginSourceSpecV1 = {
        ...resolvedSource.sourceSpec,
        kind: 'path',
        locator: params.sourceSpecOverride?.kind === 'path' && params.sourceSpecOverride.locator.trim().length > 0
          ? params.sourceSpecOverride.locator.trim()
          : resolvedSource.sourceSpec.locator,
        trustPolicy: normalizeInspectedTrustPolicy(trust.trustPolicy),
        installPolicy: trust.installPolicy,
        resolvedPath: resolvedSource.pluginRootPath,
        manifestPath: resolvedSource.manifestPath,
        resolvedVersion: resolvedSource.manifest.version,
        installedAt: Date.now(),
        ...(trust.devWatch ? { devWatch: true } : {}),
      };

      return {
        ok: true,
        alreadyInstalled: false,
        pluginId,
        sourceKind,
        source,
        manifestVersion: resolvedSource.manifest.version,
        manifestPath: resolvedSource.manifestPath,
        installedPath: null,
      };
    }

    let downloadedArchiveTempDir: string | null = null;
    const archivePath = await (async () => {
      if (isRemotePluginArchiveLocator(params.locator)) {
        const archiveUrl = canonicalizeRemotePluginArchiveUrl(params.locator);
        const archiveName = basename(new URL(archiveUrl).pathname) || 'plugin-archive.tar.gz';
        const downloaded = await downloadRemoteArchiveToTempFile({
          happyHomeDir: params.happyHomeDir,
          archiveUrl,
          archiveName,
        });
        downloadedArchiveTempDir = downloaded.tempDir;
        return downloaded.archivePath;
      }

      const resolvedLocator = resolve(params.locator.trim());
      try {
        await stat(resolvedLocator);
        return resolvedLocator;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    })();
    if (!archivePath) {
      return {
        ok: false,
        errorCode: 'plugin_source_invalid',
        errorMessage: `Plugin archive does not exist: ${params.locator}`,
      };
    }

    let localArchiveTempDir: string | null = null;
    let stagedCandidate: StagedNpmCompatiblePluginArchive | undefined;
    try {
      let candidateArchivePath = archivePath;
      if (!isRemotePluginArchiveLocator(params.locator)) {
        await mkdir(stateStore.paths.cacheDir, { recursive: true });
        localArchiveTempDir = await mkdtemp(join(stateStore.paths.cacheDir, 'plugin-archive-preview-'));
        candidateArchivePath = join(localArchiveTempDir, 'candidate.tgz');
        await copyFile(archivePath, candidateArchivePath);
      }
      const staged = await stageArchivePluginSource({
        happyHomeDir: params.happyHomeDir,
        archivePath: candidateArchivePath,
      });
      stagedCandidate = staged;
      const resolvedSource = await resolveLocalPathPluginSource({
        locator: staged.rootPath,
        installedSourceKind: 'archive',
      });
      if (!resolvedSource.ok) {
        return {
          ok: false,
          errorCode: 'plugin_source_invalid',
          errorMessage: resolvedSource.diagnostics.map((diagnostic) => diagnostic.message).join('\n') || 'Invalid plugin archive source',
        };
      }

      const pluginId = resolvedSource.manifest.id;
      if (params.skipIfInstalled && initialState.plugins[pluginId]) {
        const existingRecord = initialState.plugins[pluginId]!;
        const installedPath = existingRecord.install.installedPath ?? null;
        return {
          ok: true,
          alreadyInstalled: true,
          pluginId,
          sourceKind,
          source: existingRecord.source,
          manifestVersion: existingRecord.install.manifestVersion,
          manifestPath: existingRecord.source.manifestPath,
          installedPath,
        };
      }

      const sourceLocator = isRemotePluginArchiveLocator(params.locator)
        ? params.locator.trim()
        : archivePath;
      const archiveSourceOverride = params.sourceSpecOverride?.kind === 'archive'
        ? params.sourceSpecOverride
        : null;
      const remoteArchive = isRemotePluginArchiveLocator(params.locator);
      const trustPolicy = normalizeInspectedTrustPolicy(
        remoteArchive ? 'prompt' : archiveSourceOverride?.trustPolicy ?? 'prompt',
      );

      const source: PluginSourceSpecV1 = {
        ...resolvedSource.sourceSpec,
        kind: 'archive',
        locator: remoteArchive
          ? sourceLocator
          : archiveSourceOverride?.locator?.trim() || sourceLocator,
        trustPolicy,
        installPolicy: archiveSourceOverride?.installPolicy ?? 'managed_install',
        resolvedPath: resolvedSource.pluginRootPath,
        manifestPath: resolvedSource.manifestPath,
        resolvedVersion: resolvedSource.manifest.version,
        installedAt: Date.now(),
      };

      return {
        ok: true,
        alreadyInstalled: false,
        pluginId,
        sourceKind,
        source,
        manifestVersion: resolvedSource.manifest.version,
        manifestPath: resolvedSource.manifestPath,
        installedPath: null,
      };
    } finally {
      if (stagedCandidate) {
        await cleanupStagedNpmCompatiblePluginArchive(stagedCandidate);
      }
      if (localArchiveTempDir) {
        await rm(localArchiveTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (downloadedArchiveTempDir) {
        await rm(downloadedArchiveTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch (error) {
    return {
      ok: false,
      errorCode: 'plugin_install_failed',
      errorMessage: error instanceof Error ? error.message : 'Plugin installation failed',
    };
  }
}
