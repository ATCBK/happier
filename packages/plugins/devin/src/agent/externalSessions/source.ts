import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalizePath, resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';

export class DevinSourceError extends Error {
  constructor(readonly code: 'source_invalid' | 'unavailable' | 'unsupported' | 'candidate_not_found', message: string) { super(message); }
}
export const digest = (text: string) => createHash('sha256').update(text).digest('base64url');
export async function resolveDevinSource(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv, platform = process.platform) {
  if (source.kind !== 'devinHome' || (source.devinHome != null && typeof source.devinHome !== 'string')) {
    throw new DevinSourceError('source_invalid', 'Invalid Devin native store.');
  }
  const home = resolveHomeDirFromEnvironment(env);
  const dataHome = platform === 'win32' ? env.APPDATA ?? join(home, 'AppData', 'Roaming')
    : env.XDG_DATA_HOME ?? (platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.local', 'share'));
  const root = await canonicalizePath(typeof source.devinHome === 'string' && source.devinHome.trim()
    ? resolveConfiguredPath(source.devinHome, { homeDir: home }) : join(resolveConfiguredPath(dataHome, { homeDir: home }), 'devin', 'cli'));
  return { root, path: join(root, 'sessions.db'), source: { kind: 'devinHome', devinHome: root } satisfies AgentExternalSessionSource };
}
