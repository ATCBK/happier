import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveCodexHome } from '../../../mcp/configServers.js';

export class CodexNativeProxyUnavailableError extends Error {
  readonly code = 'CODEX_NATIVE_PROXY_UNAVAILABLE';

  constructor() {
    super('The existing Codex app-server control socket is unavailable.');
  }
}

/** Codex 0.162.1 app-server-transport/src/transport/mod.rs owns this path.
 * The proxy connects to it directly; it does not discover or start a server.
 * Check once before this invocation launches any proxy, without retaining an
 * availability cache that could outlive the caller or hide a later server.
 */
export async function assertCodexNativeProxyAvailable(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    await stat(join(resolveCodexHome(env), 'app-server-control', 'app-server-control.sock'));
  } catch {
    signal?.throwIfAborted();
    throw new CodexNativeProxyUnavailableError();
  }
  signal?.throwIfAborted();
}
