import { basename, dirname, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import { canonicalizePath, isCanonicalAbsolutePathInsideRoot, resolveConfiguredNativeHomePath, resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { discoverAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';

export async function resolveCopilotSource(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv) {
  if (source.kind !== 'copilotHome') throw new Error('source_invalid');
  const home = await canonicalizePath(typeof source.homeDir === 'string'
    ? resolveConfiguredPath(source.homeDir, { homeDir: resolveHomeDirFromEnvironment(env) })
    : resolveConfiguredNativeHomePath({ environmentKey: 'COPILOT_HOME', defaultRelativePath: '.copilot' }, env));
  return { home, root: join(home, 'session-state'), source: { kind: 'copilotHome', homeDir: home } };
}

export async function discoverCopilotSessions(root: string, signal: AbortSignal) {
  const inventory = await discoverAgentAccountingJsonlSource([root], signal);
  return { ...inventory, files: inventory.files.filter(path => basename(path) === 'events.jsonl' && dirname(dirname(path)) === root) };
}

export async function resolveCopilotSessionFile(root: string, remoteSessionId: string) {
  if (!remoteSessionId || remoteSessionId === '.' || remoteSessionId === '..' || /[\\/\0]/u.test(remoteSessionId)) {
    throw new Error('source_invalid');
  }
  const file = await realpath(join(root, remoteSessionId, 'events.jsonl'));
  const physicalRoot = await realpath(root);
  if (!isCanonicalAbsolutePathInsideRoot(physicalRoot, file) || !(await stat(file)).isFile()) throw new Error('source_invalid');
  return file;
}
