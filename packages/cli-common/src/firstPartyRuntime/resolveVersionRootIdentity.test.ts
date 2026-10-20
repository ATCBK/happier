import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveFirstPartyInstallLayout } from './installLayout.js';
import {
  FirstPartyVersionRootIdentityError,
  resolveFirstPartyVersionRootIdentity,
} from './resolveVersionRootIdentity.js';

describe('resolveFirstPartyVersionRootIdentity', () => {
  it('resolves current through its canonical marker to the immutable version root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-version-root-current-'));
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'publicdev',
      processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir },
    });
    const versionRoot = join(layout.versionsDir, 'version-a');
    try {
      await mkdir(versionRoot, { recursive: true });
      await writeFile(join(layout.installRoot, 'current.version'), 'version-a\n', 'utf8');

      expect(resolveFirstPartyVersionRootIdentity({
        layout,
        runtimeRoot: layout.currentPath,
      })).toEqual({
        root: await realpath(versionRoot),
        versionRootId: 'version-a',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('keeps an exact versions child as the stable identity', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-version-root-direct-'));
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'preview',
      processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir },
    });
    const versionRoot = join(layout.versionsDir, 'version-a');
    try {
      await mkdir(versionRoot, { recursive: true });

      expect(resolveFirstPartyVersionRootIdentity({
        layout,
        runtimeRoot: versionRoot,
      })).toEqual({
        root: await realpath(versionRoot),
        versionRootId: 'version-a',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('recognizes physical version roots and marked pointers under an aliased home without admitting escapes', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'happier-version-root-alias-'));
    const homeDir = join(scratchDir, 'home-alias');
    try {
      await mkdir(join(scratchDir, 'home'));
      await symlink(await realpath(join(scratchDir, 'home')), homeDir, process.platform === 'win32' ? 'junction' : 'dir');
      const layout = resolveFirstPartyInstallLayout({
        componentId: 'happier-cli',
        channel: 'publicdev',
        processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir },
      });
      const versionRoot = join(layout.versionsDir, 'version-a');
      await mkdir(versionRoot, { recursive: true });
      const physicalRoot = await realpath(versionRoot);
      const expected = { root: physicalRoot, versionRootId: 'version-a' };
      expect(resolveFirstPartyVersionRootIdentity({ layout, runtimeRoot: versionRoot })).toEqual(expected);
      expect(resolveFirstPartyVersionRootIdentity({ layout, runtimeRoot: physicalRoot })).toEqual(expected);

      for (const marker of ['current', 'previous'] as const) {
        const pointer = join(layout.installRoot, marker);
        const physicalPointer = join(await realpath(layout.installRoot), marker);
        // A missing or inaccessible pointer still requires the canonical marker.
        expect(() => resolveFirstPartyVersionRootIdentity({ layout, runtimeRoot: physicalPointer }))
          .toThrow(expect.objectContaining({ code: 'FIRST_PARTY_VERSION_ROOT_MARKER_MISSING' }));
        await writeFile(join(layout.installRoot, `${marker}.version`), 'version-a\n', 'utf8');
        expect(resolveFirstPartyVersionRootIdentity({ layout, runtimeRoot: physicalPointer })).toEqual(expected);
        await symlink(physicalRoot, pointer, process.platform === 'win32' ? 'junction' : 'dir');
        for (const runtimeRoot of [pointer, physicalPointer]) {
          expect(resolveFirstPartyVersionRootIdentity({ layout, runtimeRoot })).toEqual(expected);
        }
        await writeFile(join(layout.installRoot, `${marker}.version`), 'version-b\n', 'utf8');
        await mkdir(join(layout.versionsDir, 'version-b'), { recursive: true });
        expect(() => resolveFirstPartyVersionRootIdentity({ layout, runtimeRoot: physicalPointer }))
          .toThrow(expect.objectContaining({ code: 'FIRST_PARTY_VERSION_ROOT_POINTER_MISMATCH' }));
      }

      const outsideRoot = join(scratchDir, 'escaped-version');
      await mkdir(outsideRoot);
      const escapedRoot = join(layout.versionsDir, 'escaped-version');
      await symlink(await realpath(outsideRoot), escapedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      for (const runtimeRoot of [escapedRoot, join(await realpath(layout.versionsDir), 'escaped-version')]) {
        expect(() => resolveFirstPartyVersionRootIdentity({ layout, runtimeRoot }))
          .toThrow(expect.objectContaining({ code: 'FIRST_PARTY_VERSION_ROOT_MALFORMED' }));
      }
      expect(() => resolveFirstPartyVersionRootIdentity({ layout, runtimeRoot: outsideRoot }))
        .toThrow(expect.objectContaining({ code: 'FIRST_PARTY_VERSION_ROOT_OUTSIDE_LAYOUT' }));
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['a mutable pointer without a marker', 'current'],
    ['a nested version path', join('versions', 'version-a', 'nested')],
    ['a path outside the install layout', '..'],
  ])('fails typed for %s', async (_label, relativeRuntimeRoot) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-version-root-invalid-'));
    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'stable',
      processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir },
    });
    try {
      expect(() => resolveFirstPartyVersionRootIdentity({
        layout,
        runtimeRoot: join(layout.installRoot, relativeRuntimeRoot),
      })).toThrow(FirstPartyVersionRootIdentityError);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
