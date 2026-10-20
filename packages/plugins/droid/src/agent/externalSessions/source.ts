import { opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalAbsolutePathsEqual, canonicalizePath, isCanonicalAbsolutePathInsideRoot,
  resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { discoverAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';

export class DroidReadError extends Error {
  constructor(readonly code: 'source_invalid' | 'source_unreachable' | 'unsupported' | 'invalid_request' | 'unavailable', message: string) {
    super(message);
  }
}
export type DroidSource = { kind: 'droidFactoryDir'; factoryDir: string; sessionFilePath?: string };
export async function resolveDroidSource(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv): Promise<DroidSource> {
  if (source.kind !== 'droidFactoryDir') throw new DroidReadError('source_invalid', 'Expected a Droid native session source.');
  const home = resolveHomeDirFromEnvironment(env);
  const configured = await canonicalizePath(join(home, '.factory'));
  const requested = typeof source.factoryDir === 'string'
    ? await canonicalizePath(resolveConfiguredPath(source.factoryDir, { homeDir: home })) : configured;
  // There is no Droid Account setting override. A caller-supplied carrier is
  // never permission to read another directory on the Machine.
  if (!canonicalAbsolutePathsEqual(requested, configured)) throw new DroidReadError('source_invalid', 'Droid source is outside the configured native home.');
  return { kind: 'droidFactoryDir', factoryDir: configured };
}
export function droidRoots(source: DroidSource): string[] {
  return ['sessions', 'projects'].map(name => join(source.factoryDir, name));
}
export function droidInventory(source: DroidSource, signal: AbortSignal): ReturnType<typeof discoverAgentAccountingJsonlSource> {
  return discoverAgentAccountingJsonlSource(droidRoots(source), signal);
}
export async function authorizeDroidFile(source: DroidSource, candidate: string): Promise<string> {
  const roots = await Promise.all(droidRoots(source).map(async native => ({ native, physical: await canonicalizePath(native) })));
  const containingRoot = roots.find(root => isCanonicalAbsolutePathInsideRoot(root.native, candidate)
    || isCanonicalAbsolutePathInsideRoot(root.physical, candidate));
  if (!containingRoot || !candidate.endsWith('.jsonl')) throw new DroidReadError('source_invalid', 'Droid transcript is outside its native session roots.');
  const file = await realpath(candidate).catch(async (error: unknown) => {
    if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    // A missing file is authoritative absence only while its native storage
    // root is readable. A removed/offline store or denied read must retain the
    // incumbent Memory projection rather than look like individual deletion.
    const root = await opendir(containingRoot.native);
    await root.close();
    throw new DroidReadError('source_unreachable', 'Droid transcript is no longer present in its native store.');
  });
  if (!file.endsWith('.jsonl') || !roots.some(root => isCanonicalAbsolutePathInsideRoot(root.physical, file))) {
    throw new DroidReadError('source_invalid', 'Droid transcript is outside its native session roots.');
  }
  return file;
}
