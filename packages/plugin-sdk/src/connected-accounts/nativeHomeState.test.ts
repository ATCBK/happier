import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES, parseConnectedAccountNativeHomeState, readConnectedAccountNativeHomeState } from './nativeHomeState.js';

describe('Connected Account native-home state affinity', () => {
  it('preserves the host-selected affinity while dropping unrelated lifecycle fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-home-state-'));
    try {
      expect(await readConnectedAccountNativeHomeState(root)).toBeNull();
      await writeFile(join(root, CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES.legacy), JSON.stringify({
        v: 1, requestedStateMode: 'shared', effectiveStateMode: 'shared', stateEntries: ['sessions'],
      }));
      expect(await readConnectedAccountNativeHomeState(root)).toEqual({ effectiveStateMode: 'shared' });
      const affinity = { CODEX_SQLITE_HOME: join(root, 'state') };
      await writeFile(join(root, CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES.primary), JSON.stringify({
        v: 1, effectiveStateMode: 'shared', stateRootEnvironment: affinity, unknownFutureField: true,
      }));
      expect(await readConnectedAccountNativeHomeState(root)).toEqual({ effectiveStateMode: 'shared', stateRootEnvironment: affinity });
      expect(parseConnectedAccountNativeHomeState({ v: 1, effectiveStateMode: 'isolated',
        stateRootEnvironment: { CODEX_SQLITE_HOME: '.' },
      })).toEqual({ effectiveStateMode: 'isolated', stateRootEnvironment: { CODEX_SQLITE_HOME: '.' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([null, { CODEX_SQLITE_HOME: 7 }, { CODEX_SQLITE_HOME: '../foreign' }, { 'not an env key': '.' }])(
    'rejects malformed known affinity: %j', stateRootEnvironment => {
      expect(() => parseConnectedAccountNativeHomeState({ v: 1, effectiveStateMode: 'shared', stateRootEnvironment }))
        .toThrow('connected_service_state_sharing_manifest_invalid');
    },
  );
  it('refuses a shared absolute root in an isolated projection', () => {
    expect(() => parseConnectedAccountNativeHomeState({ v: 1, effectiveStateMode: 'isolated',
      stateRootEnvironment: { CODEX_SQLITE_HOME: join(tmpdir(), 'shared') },
    })).toThrow(expect.objectContaining({ code: 'connected_service_state_sharing_manifest_invalid' }));
  });
});
