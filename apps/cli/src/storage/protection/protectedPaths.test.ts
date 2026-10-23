import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyPath, classifyPaths, classifyPhysicalPath, type StorageProtectionFacts } from './protectedPaths';
import { physicalPathWithoutFollowingLeaf } from '@/utils/path/physicalAncestorPath';
import { createDaemonEventLoopStallMonitor } from '@/daemon/diagnostics/daemonEventLoopStallMonitor';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const fixtures: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-protection-'))); fixtures.push(root);
  const home = join(root, 'home'); await mkdir(home);
  return { root, home };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('storage physical path protection', () => {
  it('projects repeated Session process bindings without starving the daemon or losing a holder', async () => {
    const paths = Array.from({ length: 1500 }, (_, index) => `/projects/work-${index % 15}`);
    const warnings: Readonly<Record<string, unknown>>[] = [];
    const monitor = createDaemonEventLoopStallMonitor({ getActiveRpcOperations: () => [],
      warn: (_message, data) => warnings.push(data) });
    const traceEnv = createEnvKeyScope(['HAPPIER_WEB_LATENCY_TRACE']);
    try {
      traceEnv.patch({ HAPPIER_WEB_LATENCY_TRACE: '1' });
      monitor.start();
      const result = classifyPhysicalPath('/projects', { homeDir: '/people/alice', platform: 'linux',
        inUsePaths: paths, inUseSessions: paths.map((path, index) => ({ path, sessionId: `session-${index % 15}` })) });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(result.loses).toHaveLength(15);
      expect(new Set(result.loses?.map(reason => reason.detail?.sessionId)).size).toBe(15);
      expect(warnings).toEqual([]);
    } finally { monitor.stop(); traceEnv.restore(); }
  });
  it('shares only one read’s physical rules, preserving managed children, aliases and fresh protection', async () => {
    const { root, home } = await fixture();
    const data = join(home, '.happier'); const child = join(data, 'cache');
    const system = join(root, 'system'); const alias = join(home, 'alias');
    await mkdir(child, { recursive: true }); await mkdir(join(system, 'child'), { recursive: true });
    await symlink(system, alias, 'junction');
    const candidates = [{ path: data, managedItemPath: data }, { path: child, managedItemPath: child },
      { path: child }, { path: alias }, { path: join(alias, 'child') }];
    const facts = { homeDir: home, dataHomes: [data], systemPaths: [system] };
    const first = await classifyPaths(candidates, facts);
    expect(first.map(value => value.tier)).toEqual(['forbidden', null, 'forbidden', null, 'forbidden']);
    expect(await classifyPaths(candidates, facts)).toEqual(await Promise.all(candidates.map(candidate =>
      classifyPath(candidate.path, { ...facts, managedItemPath: candidate.managedItemPath }))));
    expect((await classifyPaths([{ path: child, managedItemPath: child }], { ...facts, userProtectedFolders: [child] }))[0].tier).toBe('keep');
    const aliasFacts = { homeDir: home, dataHomes: [data], systemPaths: [alias] };
    const managedChild = [{ path: child, managedItemPath: child }];
    expect((await classifyPaths(managedChild, aliasFacts))[0].tier).toBeNull();
    // A different read resolves a changed OS symlink afresh, not a retained rule cache.
    await rm(alias); await symlink(data, alias, 'junction');
    expect((await classifyPaths(managedChild, aliasFacts))[0].tier).toBe('forbidden');
  });
  it.skipIf(process.platform !== 'win32')('keeps private and locked Windows system leaves protected without blocking ordinary NTFS candidates', async () => {
    const { home } = await fixture(); const cache = join(home, 'cache'); await mkdir(cache);
    const drive = process.env.SystemDrive ?? win32.parse(home).root;
    const facts = { homeDir: home, env: process.env };
    expect((await classifyPath(cache, facts)).tier).toBeNull();
    expect((await classifyPath(win32.join(drive, 'System Volume Information'), facts)).tier).toBe('forbidden');
    expect((await classifyPath(win32.join(drive, 'pagefile.sys'), facts)).tier).toBe('forbidden');
  });

  it('resolves parents but keeps a symlink leaf as the target being removed', async () => {
    const { root, home } = await fixture();
    const system = join(root, 'system'); await mkdir(system); await mkdir(join(system, 'child'));
    const alias = join(home, 'alias'); await symlink(system, alias, 'junction');
    expect(await physicalPathWithoutFollowingLeaf(join(alias, 'child'))).toBe(join(system, 'child'));
    expect(await physicalPathWithoutFollowingLeaf(alias)).toBe(alias);
    expect((await classifyPath(join(alias, 'child'), { homeDir: home, systemPaths: [system] })).tier).toBe('forbidden');
    expect((await classifyPath(alias, { homeDir: home, systemPaths: [system] })).tier).toBeNull();
  });
  it('protects containers of roots and checkouts without forbidding all verified managed children', async () => {
    const { home } = await fixture(); const data = join(home, '.happier'); const cache = join(data, 'cache');
    const project = join(home, 'projects', 'main'); await mkdir(cache, { recursive: true }); await mkdir(project, { recursive: true });
    expect((await classifyPath(data, { homeDir: home, dataHomes: [data], managedItemPath: data })).tier).toBe('forbidden');
    expect((await classifyPath(cache, { homeDir: home, dataHomes: [data], managedItemPath: cache })).tier).toBeNull();
    expect((await classifyPath(cache, { homeDir: home, dataHomes: [data] })).tier).toBe('forbidden');
    expect(await classifyPath(join(home, 'projects'), { homeDir: home, mainCheckouts: [project] })).toMatchObject({ tier: 'keep', reason: { code: 'contains' } });
    expect((await classifyPath(home, { homeDir: home })).tier).toBe('forbidden');
  });
  it('rechecks current protected folders and cloud ancestors, with sibling boundaries', async () => {
    const { home } = await fixture(); const shared = join(home, 'projects', 'cloud'); await mkdir(shared, { recursive: true });
    expect((await classifyPath(join(home, 'projects'), { homeDir: home, cloudSyncedFolders: [shared] })).tier).toBe('caution');
    expect((await classifyPath(shared, { homeDir: home, userProtectedFolders: [shared] })).tier).toBe('keep');
    expect((await classifyPath(`${shared}2`, { homeDir: home, userProtectedFolders: [shared] })).tier).toBeNull();
  });
  it('classifies every planned OS system location from platform facts, including relocated Windows roots', () => {
    const unix: StorageProtectionFacts = { homeDir: '/people/alice', platform: 'linux', volumeRoots: ['/disk'] };
    for (const path of ['/', '/disk', '/System', '/usr', '/bin', '/sbin', '/etc', '/boot', '/efi', '/var/lib', '/var/db', '/private/var/db', '/private/var/vm', '/Users', '/home']) {
      expect(classifyPhysicalPath(path, unix).tier, path).toBe('forbidden');
    }
    expect(classifyPhysicalPath('/usr/local/rebuildable', unix).tier).toBeNull();
    const windows: StorageProtectionFacts = { platform: 'win32', homeDir: 'D:\\Users\\Alice', volumeRoots: ['D:\\', 'E:\\'], env: {
      ...process.env, SystemDrive: 'D:', windir: 'D:\\OS', ProgramFiles: 'D:\\Apps', ProgramData: 'D:\\Data', LOCALAPPDATA: 'D:\\Users\\Alice\\Local', APPDATA: 'D:\\Users\\Alice\\Roaming' } };
    for (const path of ['D:\\', 'E:\\', 'D:\\OS\\System32', 'D:\\System Volume Information', 'D:\\Recovery', 'D:\\Boot',
      'D:\\Apps\\WindowsApps', 'D:\\Data\\Microsoft', 'D:\\pagefile.sys', 'D:\\hiberfil.sys', 'D:\\swapfile.sys', 'D:\\Users', 'D:\\Users\\Alice\\ntuser.dat']) {
      expect(classifyPhysicalPath(path, windows).tier, path).toBe('forbidden');
    }
    expect(classifyPhysicalPath('D:\\Users\\Alice2\\cache', windows).tier).toBeNull();
    expect(classifyPhysicalPath('D:\\Users', { ...windows, homeDir: 'E:\\People\\Alice' }).tier).toBe('forbidden');
  });
  it('preserves Keep confirmations for all built-in personal and credential paths and normalized protected identities', () => {
    const facts: StorageProtectionFacts = { homeDir: '/people/alice', platform: 'darwin', userProtectedFolders: ['/people/alice/Café'],
      mainCheckouts: ['/projects/main'], inUsePaths: ['/work/live'], agentHomes: ['/agents/home'], browserProfileRoots: ['/browser/Default'] };
    for (const path of ['Documents', 'Desktop', 'Pictures', 'Music', 'Movies', 'Videos', 'Downloads', 'Library', '.ssh', '.gnupg', '.password-store', '.gitconfig', '.bashrc', '.zshrc',
      'Library/Preferences', 'Library/Keychains', 'Library/Mobile Documents']) {
      expect(classifyPhysicalPath(`/people/alice/${path}`, facts).tier, path).toBe('keep');
    }
    for (const path of ['/srv', '/root', '/nix', '/snap', '/opt', '/mnt', '/media', '/Applications', '/projects/main', '/work/live/child', '/agents/home/child',
      '/browser/Default', '/browser/Default/Cookies', '/browser/Default/Local Storage', '/people/alice/Cafe\u0301/child']) {
      expect(classifyPhysicalPath(path, facts).tier, path).toBe('keep');
    }
    expect(classifyPhysicalPath('/browser/Default/Cache', facts).tier).toBeNull();
    expect(classifyPhysicalPath('/projects', facts)).toMatchObject({ tier: 'keep', reason: { code: 'contains' }, loses: [{ code: 'main_checkout' }] });
    const windows = { ...facts, platform: 'win32' as const, homeDir: 'D:\\Users\\Alice', userProtectedFolders: ['D:\\Users\\Alice\\Protected'] };
    expect(classifyPhysicalPath('\\\\?\\D:\\USERS\\ALICE\\PROTECTED\\child', windows).tier).toBe('keep');
  });
  it('refuses a managed candidate containing protected data, even if its own owner says Safe', async () => {
    const { home } = await fixture(); const cache = join(home, '.happier', 'cache'); const credentials = join(cache, 'keys'); await mkdir(credentials, { recursive: true });
    expect((await classifyPath(cache, { homeDir: home, dataHomes: [join(home, '.happier')], managedItemPath: cache, userProtectedFolders: [credentials] })).tier).toBe('keep');
    expect((await classifyPath(cache, { homeDir: home, dataHomes: [join(home, '.happier')], managedItemPath: cache, trashRoots: [credentials] })).tier).toBe('forbidden');
  });
  it('expands user-protected home aliases through the canonical owner using this machine home', async () => {
    const { home } = await fixture(); const path = join(home, 'protected', 'child'); await mkdir(path, { recursive: true });
    expect((await classifyPath(path, { homeDir: home, userProtectedFolders: ['~\\protected'] })).tier).toBe('keep');
    expect((await classifyPath('~/protected/child', { homeDir: home, userProtectedFolders: ['~/protected/'] })).tier).toBe('keep');
  });
  it('names every kept descendant in the confirmation and identifies cloud effects in typed detail', () => {
    const facts = { homeDir: '/people/alice', platform: 'linux' as const, mainCheckouts: ['/projects/one', '/projects/two'] };
    expect(classifyPhysicalPath('/projects', facts).loses).toEqual([
      { code: 'main_checkout', detail: { path: '/projects/one' } }, { code: 'main_checkout', detail: { path: '/projects/two' } },
    ]);
    expect(classifyPhysicalPath('/cloud/files', { ...facts, cloudSyncedFolders: ['/cloud'] }).reason?.detail).toMatchObject({ cloudSynced: true });
    expect(classifyPhysicalPath('/projects', { ...facts, mainCheckouts: [], cloudSyncedFolders: ['/projects/cloud'] }).reason?.detail).toMatchObject({ cloudSynced: true, containsSyncedFolder: true });
    expect(classifyPhysicalPath('/projects', { ...facts, cloudSyncedFolders: ['/projects'] }).loses).toContainEqual({
      code: 'not_rebuildable', detail: { path: '/projects', cloudSynced: true },
    });
  });
  it('names each holding Session without attributing non-Session holders or choosing only the first holder', () => {
    const facts: StorageProtectionFacts = { homeDir: '/people/alice', platform: 'linux',
      inUsePaths: ['/projects/one', '/projects/other', '/projects/one'],
      inUseSessions: [{ path: '/projects/one', sessionId: 's1' }, { path: '/projects/one', sessionId: 's2' },
        { path: '/projects/one', sessionId: 's1' }] };
    const result = classifyPhysicalPath('/projects', facts);
    expect(result.loses).toEqual([
      { code: 'in_use', detail: { path: '/projects/one', sessionId: 's1' } },
      { code: 'in_use', detail: { path: '/projects/one', sessionId: 's2' } },
      { code: 'in_use', detail: { path: '/projects/other' } },
    ]);
    expect(classifyPhysicalPath('/projects/one/child', facts).reason).toMatchObject({ code: 'in_use', detail: { sessionId: 's1' } });
  });
});
