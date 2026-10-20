import { realpath } from 'node:fs/promises';
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
export async function droidInventory(source: DroidSource, signal: AbortSignal) {
  return discoverAgentAccountingJsonlSource(droidRoots(source), signal);
}
export async function authorizeDroidFile(source: DroidSource, candidate: string): Promise<string> {
  const file = await realpath(candidate).catch(() => { throw new DroidReadError('source_unreachable', 'Droid transcript is unavailable.'); });
  const roots = await Promise.all(droidRoots(source).map(root => canonicalizePath(root)));
  if (!file.endsWith('.jsonl') || !roots.some(root => isCanonicalAbsolutePathInsideRoot(root, file))) {
    throw new DroidReadError('source_invalid', 'Droid transcript is outside its native session roots.');
  }
  return file;
}
