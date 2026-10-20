import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, relative, win32 as win32Path } from 'node:path';

import {
  isWin32ShapedAbsolutePath,
  joinPathForPathShape,
  resolvePathForPathShape,
} from '../path/pathShape.js';
import {
  assertValidFirstPartyVersionId,
  type FirstPartyInstallLayout,
} from './installLayout.js';
import { readInstalledVersionMarkersSync } from './versionMarkers.js';

export type FirstPartyVersionRootIdentity = Readonly<{
  root: string;
  versionRootId: string;
}>;

export type FirstPartyVersionRootIdentityErrorCode =
  | 'FIRST_PARTY_VERSION_ROOT_OUTSIDE_LAYOUT'
  | 'FIRST_PARTY_VERSION_ROOT_MALFORMED'
  | 'FIRST_PARTY_VERSION_ROOT_MARKER_MISSING'
  | 'FIRST_PARTY_VERSION_ROOT_UNAVAILABLE'
  | 'FIRST_PARTY_VERSION_ROOT_POINTER_MISMATCH';

export class FirstPartyVersionRootIdentityError extends Error {
  readonly code: FirstPartyVersionRootIdentityErrorCode;
  readonly runtimeRoot: string;

  constructor(
    code: FirstPartyVersionRootIdentityErrorCode,
    runtimeRoot: string,
    message: string,
  ) {
    super(message);
    this.name = 'FirstPartyVersionRootIdentityError';
    this.code = code;
    this.runtimeRoot = runtimeRoot;
  }
}

function normalizeForEquality(pathLike: string): string {
  const resolved = resolvePathForPathShape(pathLike);
  return isWin32ShapedAbsolutePath(resolved) ? resolved.toLowerCase() : resolved;
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeForEquality(left) === normalizeForEquality(right);
}

function relativeForPathShape(from: string, to: string): string {
  return isWin32ShapedAbsolutePath(from) || isWin32ShapedAbsolutePath(to)
    ? win32Path.relative(from, to)
    : relative(from, to);
}

function resolvePhysicalPathOrSelf(pathLike: string): string {
  try {
    return realpathSync(pathLike);
  } catch {
    // Preserve marker-only pointers and typed unavailable-root diagnostics.
    return resolvePathForPathShape(pathLike);
  }
}

function resolveParentAliases(pathLike: string): string {
  const path = resolvePathForPathShape(pathLike);
  const pathShape = isWin32ShapedAbsolutePath(path) ? win32Path : { dirname, basename };
  // Resolve only the parent: dereferencing current/previous here would bypass
  // their markers, and dereferencing a version could hide an escaping symlink.
  return joinPathForPathShape(resolvePhysicalPathOrSelf(pathShape.dirname(path)), pathShape.basename(path));
}

function resolvePhysicalVersionRoot(
  layout: FirstPartyInstallLayout,
  runtimeRoot: string,
  exactVersionRoot: string,
  versionRootId: string,
): string {
  let physicalVersionRoot: string;
  let physicalVersionsDir: string;
  try {
    physicalVersionRoot = realpathSync(exactVersionRoot);
    physicalVersionsDir = realpathSync(layout.versionsDir);
    if (!statSync(physicalVersionRoot).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new FirstPartyVersionRootIdentityError(
      'FIRST_PARTY_VERSION_ROOT_UNAVAILABLE',
      runtimeRoot,
      'The selected first-party version root is unavailable',
    );
  }
  if (
    !pathsEqual(dirname(physicalVersionRoot), physicalVersionsDir)
    || basename(physicalVersionRoot) !== versionRootId
  ) {
    throw new FirstPartyVersionRootIdentityError(
      'FIRST_PARTY_VERSION_ROOT_MALFORMED',
      runtimeRoot,
      'The selected first-party version root is not an exact immutable versions child',
    );
  }
  return physicalVersionRoot;
}

function resolveMarkedPointer(
  layout: FirstPartyInstallLayout,
  runtimeRoot: string,
  marker: 'current' | 'previous',
): FirstPartyVersionRootIdentity {
  const markers = readInstalledVersionMarkersSync(layout);
  const versionRootId = marker === 'current'
    ? markers.currentVersionId
    : markers.previousVersionId;
  if (!versionRootId) {
    throw new FirstPartyVersionRootIdentityError(
      'FIRST_PARTY_VERSION_ROOT_MARKER_MISSING',
      runtimeRoot,
      `The ${marker} first-party runtime pointer has no canonical version marker`,
    );
  }
  const exactVersionRoot = joinPathForPathShape(layout.versionsDir, versionRootId);
  const physicalVersionRoot = resolvePhysicalVersionRoot(
    layout,
    runtimeRoot,
    exactVersionRoot,
    versionRootId,
  );

  // POSIX symlinks can be checked directly. Windows junction traversal may be
  // denied to non-elevated processes, so the canonical marker remains the
  // authority when realpath of the pointer itself is unavailable.
  try {
    const physicalPointerRoot = realpathSync(runtimeRoot);
    if (!pathsEqual(physicalPointerRoot, physicalVersionRoot)) {
      throw new FirstPartyVersionRootIdentityError(
        'FIRST_PARTY_VERSION_ROOT_POINTER_MISMATCH',
        runtimeRoot,
        `The ${marker} first-party runtime pointer disagrees with its canonical version marker`,
      );
    }
  } catch (error) {
    if (error instanceof FirstPartyVersionRootIdentityError) throw error;
  }

  return Object.freeze({ root: physicalVersionRoot, versionRootId });
}

/**
 * Resolve a managed first-party runtime path to one exact immutable
 * `<installRoot>/versions/<id>` root. Mutable `current`/`previous` pointers
 * are accepted only through their canonical marker files.
 */
export function resolveFirstPartyVersionRootIdentity(params: Readonly<{
  layout: FirstPartyInstallLayout;
  runtimeRoot: string;
}>): FirstPartyVersionRootIdentity {
  const runtimeRoot = resolvePathForPathShape(params.runtimeRoot);
  const membershipRoot = resolveParentAliases(runtimeRoot);
  if (pathsEqual(membershipRoot, resolveParentAliases(params.layout.currentPath))) {
    return resolveMarkedPointer(params.layout, runtimeRoot, 'current');
  }
  if (pathsEqual(membershipRoot, resolveParentAliases(params.layout.previousPath))) {
    return resolveMarkedPointer(params.layout, runtimeRoot, 'previous');
  }

  const relativeVersionPath = relativeForPathShape(resolvePhysicalPathOrSelf(params.layout.versionsDir), membershipRoot);
  const versionSegments = relativeVersionPath.split(/[\\/]/u);
  if (
    relativeVersionPath.length > 0
    && versionSegments.length === 1
    && versionSegments[0] !== '.'
    && versionSegments[0] !== '..'
  ) {
    const versionRootId = versionSegments[0]!;
    assertValidFirstPartyVersionId(versionRootId);
    const exactVersionRoot = joinPathForPathShape(params.layout.versionsDir, versionRootId);
    return Object.freeze({
      root: resolvePhysicalVersionRoot(
        params.layout,
        runtimeRoot,
        exactVersionRoot,
        versionRootId,
      ),
      versionRootId,
    });
  }

  const relativeInstallPath = relativeForPathShape(resolvePhysicalPathOrSelf(params.layout.installRoot), membershipRoot);
  const insideInstallRoot = relativeInstallPath === '' || (
    relativeInstallPath !== '..'
    && !relativeInstallPath.startsWith(`..${isWin32ShapedAbsolutePath(runtimeRoot) ? '\\' : '/'}`)
    && !isWin32ShapedAbsolutePath(relativeInstallPath)
  );
  throw new FirstPartyVersionRootIdentityError(
    insideInstallRoot
      ? 'FIRST_PARTY_VERSION_ROOT_MALFORMED'
      : 'FIRST_PARTY_VERSION_ROOT_OUTSIDE_LAYOUT',
    runtimeRoot,
    insideInstallRoot
      ? 'The first-party runtime root is not an exact version root or canonical pointer'
      : 'The first-party runtime root is outside the managed install layout',
  );
}
