import { describe, expect, it } from 'vitest';

import {
  buildCodexTerminalChildEnv,
  normalizeCodexTerminalSessionId,
  resolveCodexTerminalRolloutDiscoveryConfig,
  resolveCodexTerminalSessionsRootDir,
} from './invocation.js';

describe('Codex terminal invocation policy', () => {
  it('removes Codex-internal thread env while preserving CODEX_HOME', () => {
    expect(buildCodexTerminalChildEnv({
      env: {
        CODEX_HOME: '/codex-home',
        CODEX_THREAD_ID: 'thread',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'origin',
        CODEX_SHELL: 'shell',
        KEEP: 'yes',
      },
    })).toEqual({
      CODEX_HOME: '/codex-home',
      KEEP: 'yes',
    });
  });

  it('resolves sessions root from explicit override, Codex home, or user home', () => {
    expect(resolveCodexTerminalSessionsRootDir({
      env: { HAPPIER_CODEX_SESSIONS_DIR: '/override' },
      homeDir: '/home/me',
    })).toBe('/override');
    expect(resolveCodexTerminalSessionsRootDir({
      env: { CODEX_HOME: '/codex-home' },
      homeDir: '/home/me',
    })).toBe('/codex-home/sessions');
    expect(resolveCodexTerminalSessionsRootDir({
      env: {},
      homeDir: '/home/me',
    })).toBe('/home/me/.codex/sessions');
  });

  it('normalizes rollout discovery config and session ids', () => {
    expect(resolveCodexTerminalRolloutDiscoveryConfig({ initialTimeoutMs: 10 })).toEqual({
      initialTimeoutMs: 10,
      initialPollIntervalMs: 500,
      extendedPollIntervalMs: 2_000,
    });
    expect(normalizeCodexTerminalSessionId(' resume ')).toBe('resume');
    expect(normalizeCodexTerminalSessionId('   ')).toBeNull();
  });
});

