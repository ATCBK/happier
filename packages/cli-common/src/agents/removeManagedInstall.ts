import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAgentCliManagedInstallRootForRuntime, type AgentCliRuntimeDescriptor } from './resolution.js';
import { readManagedAcpInstallNamespace } from './managedAcpInstallIdentity.js';
import { readManagedUvAgentMetadata, type ManagedUvAgentMetadata } from './install/managedUvInstall.js';

export type ManagedAgentCliAcpMetadata = Readonly<{ definitionId: string; title: string; kind: 'npm'; version: string }> | ManagedUvAgentMetadata;

/** Observe retained current bytes independently of version, launcher health or receipt parsing. */
export async function hasAgentCliManagedInstallForRuntime(params: Readonly<{
  runtimeSpec: Pick<AgentCliRuntimeDescriptor, 'id'>; env?: NodeJS.ProcessEnv;
}>): Promise<boolean> {
  const root = resolveAgentCliManagedInstallRootForRuntime(params.runtimeSpec, { processEnv: params.env });
  for (const name of ['current', 'active']) {
    try { await access(join(root, name)); return true; }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

/** The authored workspace manifest, never a vendor package manifest, identifies a definition install. */
export async function readManagedAgentCliInstallMetadata(params: Readonly<{
  runtimeSpec: Pick<AgentCliRuntimeDescriptor, 'id'>; env?: NodeJS.ProcessEnv;
}>): Promise<ManagedAgentCliAcpMetadata | null> {
  const root = resolveAgentCliManagedInstallRootForRuntime(params.runtimeSpec, { processEnv: params.env });
  const uv = await readManagedUvAgentMetadata(params.runtimeSpec, params.env ?? process.env);
  if (uv) return uv;
  try {
    const raw: unknown = JSON.parse(await readFile(join(root, 'current', 'workspace', 'package.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || !('happierManagedAcp' in raw)) return null;
    const value = raw.happierManagedAcp;
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'npm'
      || !('definitionId' in value) || typeof value.definitionId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(value.definitionId)
      || !('title' in value) || typeof value.title !== 'string' || !value.title
      || !('version' in value) || typeof value.version !== 'string' || !value.version
      || !readManagedAcpInstallNamespace(params.runtimeSpec.id, value.definitionId, value.version)) return null;
    return { definitionId: value.definitionId, title: value.title, kind: 'npm', version: value.version };
  } catch (error) {
    if (error instanceof SyntaxError || error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeAgentCliManagedInstallForRuntime(params: Readonly<{
  runtimeSpec: Pick<AgentCliRuntimeDescriptor, 'id'>; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true } | { ok: false; code: 'not_managed' }>> {
  params.signal?.throwIfAborted();
  const root = resolveAgentCliManagedInstallRootForRuntime(params.runtimeSpec, { processEnv: params.env });
  try { await access(root); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { ok: false, code: 'not_managed' };
    throw error;
  }
  params.signal?.throwIfAborted();
  await rm(root, { recursive: true, force: true });
  return { ok: true };
}
