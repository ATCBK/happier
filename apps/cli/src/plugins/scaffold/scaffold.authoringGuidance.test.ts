import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scaffoldLocalPlugin } from './scaffold';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('scaffoldLocalPlugin authoring guidance', () => {
  it('teaches the normal create-to-dev loop, diagnostics, examples, and the supported registry option', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-guidance-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.authoring-guidance',
        displayName: 'Authoring guidance',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');
      expect(skill).toContain('happier plugins dev');
      expect(skill).toContain('happier plugins doctor .');
      expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/examples');
      expect(skill).toContain('--sdk-registry <origin>');
      expect(skill).toContain('prepares declared dependencies automatically');
      expect(skill).toContain('do not run `happier plugins dev install .` first');
      // The dependency-refresh exception: cold-start preparation materializes
      // an author root once; refreshing a stale tree is `plugins dev install`.
      expect(skill).toContain('Exception — dependency refresh');
      expect(skill).toContain('change declared dependencies in `package.json`');
      expect(skill).toContain('run `happier plugins dev install .` once to refresh the tree');
      expect(skill).toContain('running Happier CLI');
      expect(skill).toContain('prepublication SDK version resolves automatically');
      expect(skill).toContain('managed author commands');
      expect(skill).toContain('author-owned `pnpm-workspace.yaml`');
      expect(skill).not.toContain('release-authorized `--sdk-registry` origin');
      expect(skill).toContain('examples/advanced-package-root');
      expect(skill).toContain('happier plugins dev typecheck .');
      expect(skill).toContain('happier plugins dev build .');
      expect(skill).toContain('happier plugins pack .');
      expect(skill).toContain(
        'A failed in-process replacement keeps the incumbent plugin occurrence active only while that daemon lives.',
      );
      expect(skill).toContain(
        'After a daemon restart, Happier rebuilds the current source; if it cannot build and activate, the development plugin is unavailable until corrected.',
      );
      expect(skill).not.toContain('retained last-known-good generation');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('threads the selected CLI invoker through scripts and generated guidance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-hdev-guidance-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.authoring-hdev',
        displayName: 'Authoring hdev',
        invokerName: 'hdev',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const packageJson = JSON.parse(await readFile(join(root, 'plugin', 'package.json'), 'utf8')) as Readonly<{
        scripts: Readonly<Record<string, string>>;
      }>;
      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');

      expect(packageJson.scripts.build).toBe('hdev plugins dev build .');
      expect(packageJson.scripts.typecheck).toBe('hdev plugins dev typecheck .');
      expect(packageJson.scripts.test).toBe('hdev plugins test .');
      expect(packageJson.scripts['pack:plugin']).toBe('hdev plugins pack .');
      expect(skill).toContain('hdev plugins dev');
      expect(skill).toContain('hdev plugins doctor .');
      expect(skill).not.toContain('happier plugins dev');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['declarative', 'reactNative', 'hostedWeb'] as const)('resolves standalone %s author references from public package inventories', async (ui) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-references-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.authoring-references',
        displayName: 'Authoring references',
        ui,
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');

      // A root-relative Markdown target resolves against a documentation site,
      // not against the author project this file is written into.
      expect(skill).not.toMatch(/\]\(\/[^)]*\)/u);

      // Repository instructions are not installed in an external author's
      // project. Check local skill/design references at the generated root,
      // independently of the published SDK references below.
      const projectReferences = [...new Set(
        [...skill.matchAll(/`(\.agents\/[^`]+|[A-Z][A-Z_-]*\.md)`/gu)]
          .map((match) => match[1]!),
      )];
      for (const reference of projectReferences) {
        await expect(
          stat(join(root, 'plugin', reference)).then(() => reference),
          `${reference} is missing from the standalone author project`,
        ).resolves.toBe(reference);
      }

      const packageReferences = new Map<string, Set<string>>();
      for (const match of skill.matchAll(/node_modules\/(@happier-dev\/[^/]+)\/([^\s`'")]+)/gu)) {
        const references = packageReferences.get(match[1]!) ?? new Set<string>();
        references.add(match[2]!.replace(/\/+$/u, ''));
        packageReferences.set(match[1]!, references);
      }
      expect(packageReferences.size).toBeGreaterThan(0);
      const authorPackage = JSON.parse(await readFile(scaffold.packageJsonPath, 'utf8')) as {
        dependencies: Record<string, string>;
      };

      // Materialize the referenced public documentation and example sources,
      // without symlinks or any repository instructions. Exclude generated
      // example artifacts and private dependency trees from this source proof.
      for (const [packageName, referenceSet] of packageReferences) {
        expect(authorPackage.dependencies).toHaveProperty(packageName);
        const packageRoot = join(repositoryRoot, 'packages', packageName.split('/')[1]!);
        const published: readonly string[] = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).files;
        const references = [...referenceSet];
        for (const reference of references) {
          const inPackedInventory = published.some((entry) => {
            const normalized = entry.replace(/\/+$/u, '');
            return normalized === reference
              || normalized.startsWith(`${reference}/`)
              || reference.startsWith(`${normalized}/`);
          });
          expect(inPackedInventory, `${reference} is not in the ${packageName} files inventory`).toBe(true);
        }
        const installedRoot = join(root, 'plugin', 'node_modules', packageName);
        await mkdir(installedRoot, { recursive: true });
        for (const reference of references.filter((entry) => !references.some(
          (parent) => entry !== parent && entry.startsWith(`${parent}/`),
        ))) {
          await cp(join(packageRoot, reference), join(installedRoot, reference), {
            recursive: true,
            filter: (entry) => !entry.split(/[\\/]/u).some((part) => part === 'node_modules' || part === 'dist'),
          });
        }
        for (const reference of references) {
          await expect(stat(join(installedRoot, reference))).resolves.toBeDefined();
        }
      }
      await expect(stat(join(root, 'plugin', 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('directs React Native authors to the shipped Plugin UI API inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-plugin-ui-inventory-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.plugin-ui-inventory',
        displayName: 'Plugin UI inventory',
        ui: 'reactNative',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');
      expect(skill).toContain('node_modules/@happier-dev/plugin-ui/API.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('links broader composition guidance only to examples shipped in the SDK package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-contributions-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.authoring-contributions',
        displayName: 'Authoring contributions',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');

      expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/examples/public-authoring/');
      expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/examples/advanced-package-root/');
      expect(skill).toContain('families marked available in the capability matrix');
      expect(skill).toContain('does not create product availability');
      expect(skill).toContain('This beginner scaffold does not declare a feature integration.');
      expect(skill).not.toContain('operation-only-channel-provider');
      expect(skill).not.toContain('action-contract-producer');
      expect(skill).not.toContain('action-contract-consumer');
      expect(skill).not.toContain('defineTargetedContributionProtocol');
      expect(skill).not.toContain('defineTargetedContributionPoint');
      expect(skill).not.toContain('defineContributionProtocol');
      expect(skill).not.toContain('defineContributionPoint');
      expect(skill).not.toContain('`.point()`');
      expect(skill).not.toContain('`.contribute()`');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
