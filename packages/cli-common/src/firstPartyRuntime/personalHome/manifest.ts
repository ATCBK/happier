import { createHash } from 'node:crypto';
import { readPortablePathSegmentViolation } from '@happier-dev/protocol/filesystem/portablePathSegment';

export type PersonalHomeBackupEntry = Readonly<{ path: string; size: number; sha256: string }>;
export type PersonalHomeBackupManifestV1 = Readonly<{
  format: 'happier-personal-home-backup'; version: 1; createdAt: string; happierVersion: string;
  schemaVersion: string; homeServerIdentityId: string; masterSecretFingerprint: string;
  databaseProvider: 'sqlite'; filesProvider: 'local'; sourcePlatform: string;
  sourceRuntimeMode: 'user' | 'system'; entries: readonly PersonalHomeBackupEntry[];
}>;

export const PERSONAL_HOME_BACKUP_FORMAT = 'happier-personal-home-backup' as const;
export const PERSONAL_HOME_BACKUP_VERSION = 1 as const;
const HEX_64 = /^[a-f0-9]{64}$/u;
// Backup v1 is portable across the supported local filesystems. 4096 bytes is the
// common POSIX path ceiling and 255 bytes is the common directory-entry ceiling;
// these are filesystem interoperability bounds, not limits on Home content bytes.
export const PERSONAL_HOME_BACKUP_MAX_PATH_BYTES = 4096;
export const PERSONAL_HOME_BACKUP_MAX_SEGMENT_BYTES = 255;

/** Stable artifact ordering is byte/code-unit based and must never depend on the host locale. */
export function comparePersonalHomeBackupArtifactNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function fingerprintMasterSecret(secret: Buffer | string): string { return createHash('sha256').update(secret).digest('hex'); }

function isSafePersonalHomeBackupPathShape(path: string): boolean {
  if (!path || path.includes('\\')) return false;
  if (Buffer.byteLength(path, 'utf8') > PERSONAL_HOME_BACKUP_MAX_PATH_BYTES) return false;
  return path.split('/').every((segment) => readPortablePathSegmentViolation(segment) === null);
}
export function isAllowedPersonalHomeBackupPath(path: string): boolean {
  return isSafePersonalHomeBackupPathShape(path) && (path === 'manifest.json' || path === 'database/home.sqlite' || path === 'secrets/handy-master-secret.txt'
    || path === 'configuration/home.env.json' || path.startsWith('files/public/') || path.startsWith('files/private/'));
}
export function assertAllowedPersonalHomeBackupPath(path: string): void {
  if (Buffer.byteLength(path, 'utf8') > PERSONAL_HOME_BACKUP_MAX_PATH_BYTES || path.split('/').some((segment) => Buffer.byteLength(segment, 'utf8') > PERSONAL_HOME_BACKUP_MAX_SEGMENT_BYTES)) throw new Error('Personal Home backup path is too long for the portable filesystem contract');
  if (!isAllowedPersonalHomeBackupPath(path)) throw new Error(`Invalid Personal Home backup path: ${path}`);
}
/** tar represents directory entries with a trailing slash; normalize before validation and comparisons. */
export function normalizePersonalHomeBackupDirectoryPath(path: string): string { return path.replace(/\/+$/u, ''); }
/** Directory entries are safe only inside the two fixed file roots (including the roots themselves). */
export function isAllowedPersonalHomeBackupDirectoryPath(path: string): boolean {
  const normalized = normalizePersonalHomeBackupDirectoryPath(path);
  return isSafePersonalHomeBackupPathShape(normalized) && (normalized === 'files/public' || normalized === 'files/private'
    || normalized.startsWith('files/public/') || normalized.startsWith('files/private/'));
}
export function assertAllowedPersonalHomeBackupDirectoryPath(path: string): void { if (!isAllowedPersonalHomeBackupDirectoryPath(path)) throw new Error(`Invalid Personal Home backup directory path: ${path}`); }

type BackupPathKind = 'file' | 'directory';
type BackupPathNode = { name: string; kind?: BackupPathKind; children: Map<string, BackupPathNode> };

/**
 * Validates archive/manifest paths as one case-insensitive tree. This rejects exact duplicates,
 * case aliases at any path segment, and file/descendant conflicts before extraction reaches the
 * host filesystem. Directory ancestors with ordinary file descendants remain valid.
 */
export function assertNonCollidingPersonalHomeBackupPaths(entries: readonly Readonly<{ path: string; kind: BackupPathKind }>[]): void {
  const root: BackupPathNode = { name: '', children: new Map() };
  for (const entry of entries) {
    let node = root;
    const segments = entry.path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      if (node.kind === 'file') throw new Error(`Personal Home backup file conflicts with descendant path: ${entry.path}`);
      const segment = segments[index]!;
      const folded = segment.toLocaleLowerCase('en-US');
      const existing = node.children.get(folded);
      if (existing && existing.name !== segment) throw new Error(`Case-fold collision in Personal Home backup path: ${entry.path}`);
      const child = existing ?? { name: segment, children: new Map<string, BackupPathNode>() };
      if (!existing) node.children.set(folded, child);
      node = child;
    }
    if (node.kind) throw new Error(`Duplicate Personal Home backup path: ${entry.path}`);
    if (entry.kind === 'file' && node.children.size > 0) throw new Error(`Personal Home backup file conflicts with descendant path: ${entry.path}`);
    node.kind = entry.kind;
  }
}

function assertBoundedString(value: unknown, field: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`Invalid Personal Home manifest ${field}`);
}
function assertManifestEntry(value: unknown): PersonalHomeBackupEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Personal Home manifest entry');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'path,sha256,size') throw new Error('Invalid Personal Home manifest entry fields');
  if (typeof record.path !== 'string' || !record.path) throw new Error('Invalid Personal Home manifest entry path');
  assertAllowedPersonalHomeBackupPath(record.path);
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) throw new Error(`Invalid Personal Home manifest entry size: ${record.path}`);
  if (typeof record.sha256 !== 'string' || !HEX_64.test(record.sha256)) throw new Error(`Invalid Personal Home manifest entry hash: ${record.path}`);
  return Object.freeze({ path: record.path, size: record.size as number, sha256: record.sha256 });
}

export function parsePersonalHomeBackupManifest(value: unknown): PersonalHomeBackupManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Personal Home backup manifest');
  const record = value as Record<string, unknown>;
  const expected = ['createdAt', 'databaseProvider', 'entries', 'filesProvider', 'format', 'happierVersion', 'homeServerIdentityId', 'masterSecretFingerprint', 'schemaVersion', 'sourcePlatform', 'sourceRuntimeMode', 'version'];
  if (Object.keys(record).sort().join(',') !== expected.join(',')) throw new Error('Invalid Personal Home manifest fields');
  if (record.format !== PERSONAL_HOME_BACKUP_FORMAT || record.version !== PERSONAL_HOME_BACKUP_VERSION) throw new Error('Unsupported Personal Home backup manifest');
  assertBoundedString(record.createdAt, 'createdAt', 128); if (Number.isNaN(Date.parse(record.createdAt))) throw new Error('Invalid Personal Home manifest createdAt');
  assertBoundedString(record.happierVersion, 'happierVersion'); assertBoundedString(record.schemaVersion, 'schemaVersion'); assertBoundedString(record.homeServerIdentityId, 'homeServerIdentityId');
  if (typeof record.masterSecretFingerprint !== 'string' || !HEX_64.test(record.masterSecretFingerprint)) throw new Error('Invalid Personal Home manifest masterSecretFingerprint');
  if (record.databaseProvider !== 'sqlite' || record.filesProvider !== 'local') throw new Error('Unsupported Personal Home backup provider');
  assertBoundedString(record.sourcePlatform, 'sourcePlatform', 64); if (record.sourceRuntimeMode !== 'user' && record.sourceRuntimeMode !== 'system') throw new Error('Invalid Personal Home manifest sourceRuntimeMode');
  if (!Array.isArray(record.entries)) throw new Error('Invalid Personal Home manifest entries');
  const entries = record.entries.map(assertManifestEntry);
  assertNonCollidingPersonalHomeBackupPaths(entries.map((entry) => ({ path: entry.path, kind: 'file' })));
  const paths = new Set(entries.map((entry) => entry.path));
  for (const required of ['database/home.sqlite', 'secrets/handy-master-secret.txt', 'configuration/home.env.json']) if (!paths.has(required)) throw new Error('Personal Home backup is missing a required entry');
  return Object.freeze({ format: PERSONAL_HOME_BACKUP_FORMAT, version: PERSONAL_HOME_BACKUP_VERSION, createdAt: record.createdAt, happierVersion: record.happierVersion, schemaVersion: record.schemaVersion, homeServerIdentityId: record.homeServerIdentityId, masterSecretFingerprint: record.masterSecretFingerprint, databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: record.sourcePlatform, sourceRuntimeMode: record.sourceRuntimeMode, entries: Object.freeze(entries.slice().sort((a, b) => comparePersonalHomeBackupArtifactNames(a.path, b.path))) });
}
export function serializePersonalHomeManifest(manifest: PersonalHomeBackupManifestV1): string { return `${JSON.stringify(parsePersonalHomeBackupManifest(manifest), null, 2)}\n`; }
