import { describe, expect, it } from 'vitest';

import { formatProcessOwnerTag, parseProcessOwnerTag, resolveProcessOwnerScopeKey, withProcessOwnerEnvironment, withHostProcessOwnerEnvironment } from './ownerTag';

describe('process owner tag', () => {
  it('isolates Happier homes while preserving canonical Windows home identity and opaque ids', () => {
    const tag = formatProcessOwnerTag({ happierHomeDir: 'C:\\Users\\Alice\\.happier\\',
      platform: 'win32', owner: { kind: 'run', runId: 'run.with.dots' } });
    expect(parseProcessOwnerTag(tag)).toEqual({
      daemonScopeKey: resolveProcessOwnerScopeKey('c:/users/alice/.happier', 'win32'),
      kind: 'run', ownerId: 'run.with.dots', owner: { kind: 'run', runId: 'run.with.dots' },
    });
    expect(resolveProcessOwnerScopeKey('/home/alice/.happier', 'linux'))
      .not.toBe(resolveProcessOwnerScopeKey('/home/alice/.happier-dev', 'linux'));
  });

  it('rejects malformed scopes, kinds, ids and fabricated named helpers', () => {
    for (const tag of ['v1.0123456789ab.unknown.id', 'v1.0123456789ab.session.',
      'v1.0123456789ab.session. id', 'v1.0123456789ab.session.id\0',
      'v1.0123456789ab.happier.unregistered_worker', 'v1.0123456789ab.browser_sidecar.other',
      'v1.0123456789abc.session.id', 'v2.0123456789ab.session.id']) {
      expect(parseProcessOwnerTag(tag)).toBeNull();
    }
  });

  it('stamps the canonical owner over every casing of a forged environment key', () => {
    const env = withProcessOwnerEnvironment({ HAPPIER_PROCESS_OWNER: 'forged', happier_process_owner: 'forged', SAFE: 'value' },
      { kind: 'happier', component: 'voice_worker' }, '/home/alice/.happier');
    expect(parseProcessOwnerTag(env.HAPPIER_PROCESS_OWNER)?.owner).toEqual({ kind: 'happier', component: 'voice_worker' });
    expect(env).not.toHaveProperty('happier_process_owner');
    expect(env.SAFE).toBe('value');
    const runTag = formatProcessOwnerTag({ happierHomeDir: '/home/alice/.happier', owner: { kind: 'run', runId: 'run-1' } });
    expect(withHostProcessOwnerEnvironment({ HAPPIER_PROCESS_OWNER: 'forged' }, runTag).HAPPIER_PROCESS_OWNER).toBe(runTag);
  });
});
