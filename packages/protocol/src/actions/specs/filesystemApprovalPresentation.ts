/**
 * How an approval for a workspace file change reads to the person deciding it: the effect on a named
 * file in a named checkout ("Write docs/getting-started.md in d-dc-hello-world"), and what will be
 * written as its size. The Action specs keep their technical descriptions for agents and forms.
 */

function readRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Quoting exposes literal whitespace/control bytes without changing the reviewed operand. */
function displayPath(path: string): string {
  return /\s|["\u0000-\u001f\u007f]/u.test(path) ? JSON.stringify(path) : path;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/u, '');
}

/** The checkout's own name: the last segment of its root. */
function checkoutName(rootPath: string | null): string | null {
  if (!rootPath) return null;
  const segments = trimTrailingSeparators(rootPath).split(/[\\/]/u).filter(Boolean);
  const name = segments.at(-1);
  return name ? displayPath(name) : null;
}

/** A path as the checkout names it: relative to the root when it is under it. */
export function describeWorkspaceRelativePath(rootPath: string | null, path: string | null): string | null {
  if (!path) return null;
  if (!rootPath) return displayPath(path);
  const root = trimTrailingSeparators(rootPath);
  const normalized = path.replace(/\\/gu, '/');
  const rootNormalized = root.replace(/\\/gu, '/');
  if (normalized === rootNormalized) return '.';
  return displayPath(normalized.startsWith(`${rootNormalized}/`) ? normalized.slice(rootNormalized.length + 1) : path);
}

function inCheckout(rootPath: string | null): string {
  const name = checkoutName(rootPath);
  return name ? ` in ${name}` : '';
}

/**
 * What a summary calls the path it acts on, and where. The checkout folder itself reads by its own
 * name ("Write mqa2-checkout"), never as a lone "." inside the sentence, and is not "in" itself.
 */
function summaryTarget(rootPath: string | null, path: string | null): Readonly<{ path: string; where: string }> | null {
  const relative = describeWorkspaceRelativePath(rootPath, path);
  if (!relative) return null;
  return relative === '.' && checkoutName(rootPath)
    ? { path: checkoutName(rootPath) as string, where: '' }
    : { path: relative, where: inCheckout(rootPath) };
}

/** A byte count in words: "12 bytes", "3.4 KB". */
export function describeByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** The decoded size of base64 content, in words: "Empty file", "12 bytes", "3.4 KB". */
export function describeBase64ContentSize(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const compact = content.replace(/\s+/gu, '');
  if (!compact) return 'Empty file';
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return describeByteSize(Math.max(0, Math.floor((compact.length * 3) / 4) - padding));
}

export function describeWriteFileApprovalSummary(input: unknown): string | null {
  const value = readRecord(input);
  const root = readText(value.rootPath);
  const target = summaryTarget(root, readText(value.path));
  if (!target) return null;
  return `${readText(value.expectedHash) ? 'Save changes to' : 'Write'} ${target.path}${target.where}`;
}

/** The reviewed operands of a write: the checkout, the file as the checkout names it, and the content's size. */
export function projectWriteFileApprovalInput(input: unknown): unknown {
  const value = readRecord(input);
  const root = readText(value.rootPath);
  return {
    ...value,
    path: describeWorkspaceRelativePath(root, readText(value.path)) ?? value.path,
    content: describeBase64ContentSize(value.content) ?? value.content,
  };
}

export function describeCreateDirectoryApprovalSummary(input: unknown): string | null {
  const value = readRecord(input);
  const root = readText(value.rootPath);
  const target = summaryTarget(root, readText(value.path));
  return target ? `Create the folder ${target.path}${target.where}` : null;
}

export function describeRenameApprovalSummary(input: unknown): string | null {
  const value = readRecord(input);
  const root = readText(value.rootPath);
  const from = describeWorkspaceRelativePath(root, readText(value.from));
  const to = describeWorkspaceRelativePath(root, readText(value.to));
  return from && to ? `Rename ${from} to ${to}${inCheckout(root)}` : null;
}

export function describeDeleteApprovalSummary(input: unknown): string | null {
  const value = readRecord(input);
  const root = readText(value.rootPath);
  const target = summaryTarget(root, readText(value.path));
  if (!target) return null;
  const from = target.where.replace(/^ in /u, ' from ');
  return value.recursive === true ? `Delete ${target.path} and everything in it${from}` : `Delete ${target.path}${from}`;
}

/** The file an upload adds, its size, and the checkout it lands in ("Upload docs/a.txt (4 bytes) to repo"). */
export function describeUploadApprovalSummary(input: unknown): string | null {
  const value = readRecord(input);
  const root = readText(value.rootPath);
  const target = summaryTarget(root, readText(value.path));
  if (!target) return null;
  const size = readRecord(value.source).sizeBytes;
  const sized = typeof size === 'number' && Number.isFinite(size) && size >= 0 ? ` (${describeByteSize(size)})` : '';
  const to = target.where.replace(/^ in /u, ' to ');
  return `${value.overwrite === true ? 'Upload and replace' : 'Upload'} ${target.path}${sized}${to}`;
}
