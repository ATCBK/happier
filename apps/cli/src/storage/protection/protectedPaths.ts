import type { StorageReasonV1 } from '@happier-dev/protocol/storage/storageV1';
import { lstat, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { physicalStoragePathWithoutFollowingLeaf as physicalPathWithoutFollowingLeaf,
  realStoragePathWithAbsentSuffix as realpathWithAbsentSuffix, storageAbsolutePath, storagePathToFs,
  storagePathDirname, storagePathLeaf } from '../storagePath';
import { createStoragePathComparator, type StoragePathComparator } from '../storagePath';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

export type StorageProtectionFacts = Readonly<{
  homeDir: string;
  platform?: NodeJS.Platform;
  dataHomes?: readonly string[];
  installPaths?: readonly string[];
  volumeRoots?: readonly string[];
  systemPaths?: readonly string[];
  personalFolders?: readonly string[];
  mainCheckouts?: readonly string[];
  inUsePaths?: readonly string[];
  /** Session bindings projected from the canonical process ownership roots. */
  inUseSessions?: readonly Readonly<{ path: string; sessionId: string }>[];
  agentHomes?: readonly string[];
  browserProfileRoots?: readonly string[];
  userProtectedFolders?: readonly string[];
  cloudSyncedFolders?: readonly string[];
  trashRoots?: readonly string[];
  /** OS-derived paths (Known Folders/XDG), overriding standard home locations. */
  knownFolders?: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
  /** Exact current catalog item; this never exempts the data root or an ancestor. */
  managedItemPath?: string;
}>;
export type StoragePathClassification = Readonly<{ tier: null; reason?: never; loses?: never }> | Readonly<{
  tier: 'forbidden' | 'keep' | 'caution';
  reason: StorageReasonV1;
  loses?: StorageReasonV1[];
}>;
type Rule = Readonly<{ path: string; tier: 'forbidden' | 'keep' | 'caution'; code: StorageReasonV1['code']; tree: boolean; except?: string; cloudSynced?: boolean; sessionId?: string }>;

/** OS facts are inputs; no drive letter, user name or relocated personal-folder path is guessed. */
export function storageProtectionRules(facts: StorageProtectionFacts): readonly Rule[] {
  const platform = facts.platform ?? process.platform;
  const api = platform === 'win32' ? win32 : posix;
  const env = facts.env ?? process.env;
  const home = facts.homeDir;
  const rules: Rule[] = [];
  const add = (paths: readonly string[], tier: Rule['tier'], code: Rule['code'], tree = true) => {
    for (const path of paths.filter(Boolean)) rules.push({ path, tier, code, tree });
  };
  add([api.parse(home).root, ...(facts.volumeRoots ?? [])], 'forbidden', 'root', false);
  add([home], 'forbidden', 'home_folder', false);
  add(facts.dataHomes ?? [], 'forbidden', 'happier_data');
  add(facts.installPaths ?? [], 'forbidden', 'happier_install');
  add(facts.trashRoots ?? [], 'forbidden', 'happier_data');
  add(facts.systemPaths ?? [], 'forbidden', 'system');
  if (platform === 'win32') {
    const drive = env.SystemDrive || api.parse(home).root;
    add([api.dirname(home), api.join(drive, 'Users')], 'forbidden', 'system', false);
    add([env.windir ?? env.WINDIR ?? '',
      ...['System Volume Information', 'Recovery', 'Boot', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys'].map(name => api.join(drive, name)),
      env.ProgramFiles ? api.join(env.ProgramFiles, 'WindowsApps') : '',
      env.ProgramData ? api.join(env.ProgramData, 'Microsoft') : '', api.join(home, 'ntuser.dat')], 'forbidden', 'system');
    add([env.ProgramFiles ?? '', env['ProgramFiles(x86)'] ?? ''], 'caution', 'not_rebuildable', false);
  } else {
    add(['/System', '/bin', '/sbin', '/etc', '/boot', '/efi', '/var/lib', '/var/db', '/private/var/db', '/private/var/vm'], 'forbidden', 'system');
    add(['/Users', '/home'], 'forbidden', 'system', false);
    rules.push({ path: '/usr', tier: 'forbidden', code: 'system', tree: true, except: '/usr/local' });
    add(['/srv', '/root', '/nix', '/snap', '/opt', '/mnt', '/media', '/Applications'], 'keep', 'personal_folder', false);
  }
  const personal = ['Documents', 'Desktop', 'Pictures', 'Music', 'Movies', 'Videos', 'Downloads'];
  add(personal.map(name => facts.knownFolders?.[name] ?? api.join(home, name)), 'keep', 'personal_folder', false);
  add(facts.personalFolders ?? [], 'keep', 'personal_folder', false);
  if (platform === 'darwin') {
    add([api.join(home, 'Library')], 'keep', 'personal_folder', false);
    add([api.join(home, 'Library')], 'caution', 'not_rebuildable', false);
    add([api.join(home, 'Library', 'Preferences'), api.join(home, 'Library', 'Keychains'),
      api.join(home, 'Library', 'Mobile Documents')], 'keep', 'credentials');
  } else if (platform === 'win32') {
    add([api.join(home, 'AppData'), env.APPDATA ?? '', env.LOCALAPPDATA ?? ''], 'keep', 'personal_folder', false);
    add([api.join(home, 'AppData')], 'caution', 'not_rebuildable', false);
  }
  add(['.ssh', '.gnupg', '.password-store', '.gitconfig', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile']
    .map(name => api.join(home, name)), 'keep', 'credentials');
  add(facts.mainCheckouts ?? [], 'keep', 'main_checkout', false);
  // Deduplicate process facts before joining holders: doing this only on the
  // finished rules still repeats every physical-path comparison for descendants.
  const seenHolders = new Set<string>();
  const holders = (facts.inUseSessions ?? []).filter(holder => {
    const key = JSON.stringify([holder.path, holder.sessionId]);
    if (seenHolders.has(key)) return false;
    seenHolders.add(key); return true;
  });
  const comparator = createStoragePathComparator(platform);
  for (const path of new Set(facts.inUsePaths ?? [])) {
    const sessions = holders.filter(holder => comparator.equal(holder.path, path));
    if (sessions.length) for (const holder of sessions) rules.push({ path, tier: 'keep', code: 'in_use', tree: true, sessionId: holder.sessionId });
    else add([path], 'keep', 'in_use');
  }
  add(facts.agentHomes ?? [], 'keep', 'agent_home');
  add(facts.browserProfileRoots ?? [], 'keep', 'credentials', false);
  for (const root of facts.browserProfileRoots ?? []) add(['Cookies', 'Network/Cookies', 'Local Storage'].map(name => api.join(root, name)), 'keep', 'credentials');
  add(facts.userProtectedFolders ?? [], 'keep', 'user_protected');
  for (const path of facts.cloudSyncedFolders ?? []) rules.push({ path, tier: 'caution', code: 'not_rebuildable', tree: true, cloudSynced: true });
  add([api.join(home, '.config'), api.join(home, '.local', 'share')], 'caution', 'not_rebuildable', false);
  // A process tree repeats its cwd/executable facts for each descendant. The
  // same rule adds no protection or confirmation, but multiplies every item read.
  const seen = new Set<string>();
  return rules.filter(rule => {
    const key = JSON.stringify([rule.path, rule.tier, rule.code, rule.tree, rule.except, rule.cloudSynced, rule.sessionId]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function storagePhysicalPathComparisonKey(path: string, platform: NodeJS.Platform): string {
  if (path.startsWith('bytes:')) return storageAbsolutePath(path);
  let value = path;
  if (platform === 'win32') value = value.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '');
  if (platform === 'win32' || platform === 'darwin') value = value.normalize('NFC').toLowerCase();
  return resolveCanonicalAbsolutePath(value, { platform })?.path ?? value;
}

/** Pure decision over physical facts, also used by platform fixture tables. */
export function classifyPhysicalPath(path: string, facts: StorageProtectionFacts): StoragePathClassification {
  return classifyAgainstRules(path, facts, storageProtectionRules(facts));
}

function physicalComparisonKeys(platform: NodeJS.Platform) {
  const keys = new Map<string, string>();
  return (path: string) => {
    let key = keys.get(path);
    if (key === undefined) { key = storagePhysicalPathComparisonKey(path, platform); keys.set(path, key); }
    return key;
  };
}

function classifyAgainstRules(path: string, facts: StorageProtectionFacts, rules: readonly Rule[],
  readKey?: (path: string) => string, comparison?: StoragePathComparator): StoragePathClassification {
  const platform = facts.platform ?? process.platform;
  const key = readKey ?? physicalComparisonKeys(platform);
  const comparator = comparison ?? createStoragePathComparator(platform);
  const normalized = key(path);
  const inside = (root: string, child: string) => comparator.contains(key(root), key(child));
  const equal = (left: string, right: string) => comparator.equal(key(left), key(right));
  const managed = facts.managedItemPath && equal(normalized, facts.managedItemPath);
  const matches: StoragePathClassification[] = [];
  for (const rule of rules) {
    const ancestor = inside(normalized, rule.path) && !equal(normalized, rule.path);
    const descendant = rule.tree && inside(rule.path, normalized);
    if (!ancestor && !equal(normalized, rule.path) && !descendant) continue;
    if (rule.except && inside(rule.except, normalized)) continue;
    if (rule.code === 'happier_data' && !facts.trashRoots?.some(root => inside(root, normalized))
      && facts.dataHomes?.some(root => equal(root, rule.path)) && managed && !equal(normalized, rule.path) && !ancestor) continue;
    const detail = { path: rule.path, ...(rule.sessionId ? { sessionId: rule.sessionId } : {}) };
    const reason: StorageReasonV1 = ancestor
      ? { code: rule.tier === 'forbidden' ? 'contains_forbidden' : rule.tier === 'keep' ? 'contains' : rule.code,
        detail: { ...detail, contains: rule.code, ...(rule.cloudSynced ? { cloudSynced: true, containsSyncedFolder: true } : {}) } }
      : { code: rule.code, detail: { ...detail, ...(rule.cloudSynced ? { cloudSynced: true } : {}) } };
    matches.push({ tier: rule.tier, reason, ...(rule.tier === 'keep' ? { loses: [{ code: rule.code, detail }] }
      : rule.tier === 'caution' ? { loses: [reason] } : {}) });
  }
  const match = matches.find(value => value.tier === 'forbidden') ?? matches.find(value => value.tier === 'keep')
    ?? matches.find(value => value.tier === 'caution');
  if (match?.tier === 'keep' || match?.tier === 'caution') {
    const loses = matches.flatMap(value => value.loses ?? []);
    return { ...match, loses: loses.filter((value, index) => loses.findIndex(previous => previous.code === value.code
      && equal(String(previous.detail?.path), String(value.detail?.path)) && previous.detail?.sessionId === value.detail?.sessionId
      && previous.detail?.cloudSynced === value.detail?.cloudSynced) === index) };
  }
  if (match) return match;
  if (managed) return { tier: null };
  if (normalized.startsWith('bytes:')) {
    const leaf = storagePathLeaf(normalized);
    return Buffer.isBuffer(leaf) && leaf[0] === 46 && equal(storagePathDirname(normalized), facts.homeDir)
      ? { tier: 'caution', reason: { code: 'not_rebuildable', detail: { hiddenFolder: true } } } : { tier: null };
  }
  const api = platform === 'win32' ? win32 : posix;
  const relative = api.relative(storagePhysicalPathComparisonKey(facts.homeDir, platform), normalized);
  return relative.startsWith('.') && !relative.startsWith('..') && api.dirname(normalized) === storagePhysicalPathComparisonKey(facts.homeDir, platform)
    ? { tier: 'caution', reason: { code: 'not_rebuildable', detail: { hiddenFolder: true } } } : { tier: null };
}

/** Fresh physical resolution is mandatory at both review and apply. Leaf symlinks stay leaves. */
export async function classifyPath(path: string, facts: StorageProtectionFacts): Promise<StoragePathClassification> {
  return (await classifyPaths([{ path, managedItemPath: facts.managedItemPath }], facts))[0];
}

/** One read's candidates share physical protection facts, never a cross-read cache. */
export async function classifyPaths(candidates: readonly Readonly<{ path: string; managedItemPath?: string }>[],
  facts: StorageProtectionFacts): Promise<StoragePathClassification[]> {
  if (!candidates.length) return [];
  const platform = facts.platform ?? process.platform;
  const env = { ...(facts.env ?? process.env), HOME: facts.homeDir, USERPROFILE: facts.homeDir };
  const expand = (value: string) => {
    if (value.startsWith('bytes:')) return storageAbsolutePath(value);
    const absolute = resolveCanonicalAbsolutePath(value, { platform, env });
    if (!absolute) throw Object.assign(new Error('Storage path must be absolute'), { code: 'invalid_storage_path' });
    return absolute.path;
  };
  const physicalRules = (await timeWebLatencyPhase('storage.classification.rules', () => Promise.all(storageProtectionRules(facts).map(async rule => {
    const path = expand(rule.path);
    const leaf = await physicalPathWithoutFollowingLeaf(path);
    let target: string;
    try { target = await realpathWithAbsentSuffix(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') throw error;
      // Windows denies access to or locks leaves such as System Volume
      // Information and pagefile.sys, so their full realpath cannot be read.
      // Their resolved parent + known leaf remains protected. Candidate parents
      // are still resolved above without this exception and therefore fail closed.
      target = leaf;
    }
    const except = rule.except ? await realpathWithAbsentSuffix(expand(rule.except)) : undefined;
    return [...new Set([leaf, target])].map(path => ({ ...rule, path, except }));
  })))).flat();
  const resolved: StorageProtectionFacts = { ...facts, homeDir: await timeWebLatencyPhase('storage.classification.home', () => realpathWithAbsentSuffix(expand(facts.homeDir))),
    dataHomes: await timeWebLatencyPhase('storage.classification.data-homes', () => Promise.all((facts.dataHomes ?? []).map(path => realpathWithAbsentSuffix(expand(path))))) };
  const readKey = physicalComparisonKeys(platform);
  const comparison = createStoragePathComparator(platform);
  return timeWebLatencyPhase('storage.classification.candidates', () => Promise.all(candidates.map(async (candidate): Promise<StoragePathClassification> => {
    const physical = await timeWebLatencyPhase('storage.classification.candidate-path', () => physicalPathWithoutFollowingLeaf(expand(candidate.path)));
    const managedItemPath = candidate.managedItemPath ?? facts.managedItemPath;
    const candidateFacts = { ...resolved, managedItemPath: managedItemPath
      ? await timeWebLatencyPhase('storage.classification.managed-path', () => physicalPathWithoutFollowingLeaf(expand(managedItemPath))) : undefined };
    const direct = classifyAgainstRules(physical, candidateFacts, physicalRules, readKey, comparison);
    if (direct.tier === 'forbidden' || direct.tier === 'keep') return direct;
    // Directory identity catches alternate Unicode/case spellings on APFS/NTFS.
    for (const protectedPath of facts.userProtectedFolders ?? []) {
      let protectedStat; try { protectedStat = await timeWebLatencyPhase('storage.classification.protected-identity', () => stat(storagePathToFs(expand(protectedPath)), { bigint: true })); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;
      }
      let ancestor = physical;
      while (true) {
        try {
          const entry = await timeWebLatencyPhase('storage.classification.ancestor-identity', () => lstat(storagePathToFs(ancestor), { bigint: true }));
          if (!entry.isSymbolicLink() && entry.dev === protectedStat.dev && entry.ino === protectedStat.ino)
            return { tier: 'keep', reason: { code: 'user_protected', detail: { path: protectedPath } }, loses: [{ code: 'user_protected', detail: { path: protectedPath } }] };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const parent = ancestor.startsWith('bytes:') ? storagePathDirname(ancestor) : (platform === 'win32' ? win32 : posix).dirname(ancestor);
        if (parent === ancestor) break; ancestor = parent;
      }
    }
    return direct;
  })));
}
