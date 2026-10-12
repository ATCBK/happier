import { userInfo } from 'node:os';
import { join } from 'node:path';
import { withExclusiveFileLock } from '@happier-dev/plugin-sdk/fs';

/** Native initialization mutates SQLite and system skills, not just the socket. */
export async function withCodexNativeStartupLock<TResult>(
  initialize: () => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  // Native layered config can override SQLite independently of env/home. Keep
  // one OS-user startup scope shared with 0.2, without a second config parser.
  return await withExclusiveFileLock({
    lockPath: join(userInfo().homedir, '.happier-codex-native-startup.lock'),
    timeoutMs: Number.POSITIVE_INFINITY,
    ...(signal ? { signal } : {}),
  }, initialize);
}
