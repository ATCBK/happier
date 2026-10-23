/** @moduleRealm daemon */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES = Object.freeze<Record<'primary' | 'legacy', string>>({
  primary: '.happier-state-sharing.json',
  legacy: '.happier-codex-home-sharing.json',
});

/** Read-only affinity; lifecycle and history-entry management remain host-owned. */
export type ConnectedAccountNativeHomeState = Readonly<{
  effectiveStateMode: 'shared' | 'isolated';
  stateRootEnvironment?: Readonly<Record<string, string>>;
}>;

function invalidNativeHomeState() {
  return Object.assign(new Error('connected_service_state_sharing_manifest_invalid'), {
    code: 'connected_service_state_sharing_manifest_invalid' as const,
  });
}

export function parseConnectedAccountNativeHomeState(value: unknown): ConnectedAccountNativeHomeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidNativeHomeState();
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.v !== 1) throw invalidNativeHomeState();
  const effectiveStateMode = record.effectiveStateMode === 'shared' ? 'shared' : 'isolated';
  let stateRootEnvironment: Record<string, string> | undefined;
  if (record.stateRootEnvironment !== undefined) {
    const entries = record.stateRootEnvironment;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw invalidNativeHomeState();
    }
    stateRootEnvironment = {};
    for (const [key, path] of Object.entries(entries as Readonly<Record<string, unknown>>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof path !== 'string'
        || (path !== '.' && !isAbsolute(path)) || (effectiveStateMode === 'isolated' && path !== '.')) {
        throw invalidNativeHomeState();
      }
      Object.defineProperty(stateRootEnvironment, key, { value: path, enumerable: true });
    }
  }
  return {
    effectiveStateMode,
    ...(stateRootEnvironment ? { stateRootEnvironment } : {}),
  };
}

export async function readConnectedAccountNativeHomeState(homeRoot: string): Promise<ConnectedAccountNativeHomeState | null> {
  for (const filename of [CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES.primary, CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES.legacy]) {
    try {
      return parseConnectedAccountNativeHomeState(JSON.parse(await readFile(join(homeRoot, filename), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}
