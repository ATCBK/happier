import { afterEach, describe, expect, it } from "vitest";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { CLI_RUNTIME_EXTERNAL_PACKAGES } from "@happier-dev/cli-common/componentArtifacts";
import { bundleInstalledPackageWithRuntimeDependencies } from "@happier-dev/cli-common/workspaces";

import { compileBunBinary, resolveBunCommand, resolveCurrentBinaryTarget, resolveSharpServerSidecarEntries, SERVER_BINARY_TARGETS } from "@happier-dev/cli-common/componentArtifacts";

const tempDirs: string[] = [];
const bunCommand = resolveBunCommand() ?? "";

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("sharpRuntime", () => {
    it.skipIf(!bunCommand)("defers an absent optional Sharp addon until its runtime branch is selected", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-sharp-optional-addon-"));
        tempDirs.push(root);
        const optionalPackageDir = join(root, "node_modules", "@img", "sharp-wasm32");
        await mkdir(optionalPackageDir, { recursive: true });
        // Matches the optional WASM package exposed by CI's --ignore-platform install.
        await writeFile(join(optionalPackageDir, "index.cjs"), "module.exports = require('./lib/sharp-wasm32-0.35.5.node');\n");
        const entrypoint = join(root, "entrypoint.ts");
        await writeFile(entrypoint, "if (process.env.SELECT_OPTIONAL_ADDON) require('./node_modules/@img/sharp-wasm32/index.cjs');\nelse process.stdout.write('optional-not-selected');\n");
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
        const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
        const executablePath = join(root, `optional-probe${target.exeExt}`);

        await compileBunBinary({
            entrypoint,
            bunTarget: target.bunTarget,
            outfile: executablePath,
            bunCommand,
            cwd: repoRoot,
            buildRunnerEntrypoint: join(repoRoot, "packages/cli-common/scripts/buildServerBunBinary.mjs"),
        });

        const ignored = spawnSync(executablePath, [], { cwd: root, encoding: "utf8", env: { PATH: "" } });
        expect(ignored.status, ignored.stderr).toBe(0);
        expect(ignored.stdout).toBe("optional-not-selected");
        const selected = spawnSync(executablePath, [], { cwd: root, encoding: "utf8", env: { PATH: "", SELECT_OPTIONAL_ADDON: "1" } });
        expect(selected.status).not.toBe(0);
        expect(selected.stderr).toContain("sharp-wasm32-0.35.5.node");
    });

    it.skipIf(!bunCommand)("does not embed libvips libraries named by Sharp's platform resolution hint", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-sharp-libvips-hint-"));
        tempDirs.push(root);
        const libvipsMarker = "happier-libvips-embedding-probe-7f3c9a";
        const libvipsPackageDir = join(root, "node_modules", "@img", "sharp-libvips-linux-x64");
        await mkdir(join(libvipsPackageDir, "lib"), { recursive: true });
        await writeFile(join(libvipsPackageDir, "package.json"), JSON.stringify({
            name: "@img/sharp-libvips-linux-x64",
            exports: { "./binary": "./lib/libvips-cpp.so.8.18.7" },
        }));
        await writeFile(join(libvipsPackageDir, "lib", "libvips-cpp.so.8.18.7"), libvipsMarker);
        const shimDir = join(root, "node_modules", "@img", "sharp-linux-x64");
        await mkdir(shimDir, { recursive: true });
        // Mirrors Sharp 0.35's platform shim; the libvips library ships as a sidecar instead.
        await writeFile(join(shimDir, "index.cjs"), "try { require.resolve('@img/sharp-libvips-linux-x64/binary'); } catch {}\nmodule.exports = 'shim-loaded';\n");
        const entrypoint = join(root, "entrypoint.ts");
        await writeFile(entrypoint, "process.stdout.write(require('./node_modules/@img/sharp-linux-x64/index.cjs'));\n");
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
        const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
        const executablePath = join(root, `libvips-hint-probe${target.exeExt}`);

        await compileBunBinary({
            entrypoint,
            bunTarget: target.bunTarget,
            outfile: executablePath,
            bunCommand,
            cwd: repoRoot,
            buildRunnerEntrypoint: join(repoRoot, "packages/cli-common/scripts/buildServerBunBinary.mjs"),
        });

        expect((await readFile(executablePath)).includes(libvipsMarker)).toBe(false);
        const launched = spawnSync(executablePath, [], { cwd: root, encoding: "utf8", env: { PATH: "" } });
        expect(launched.status, launched.stderr).toBe(0);
        expect(launched.stdout).toBe("shim-loaded");
    });

    it.skipIf(!bunCommand)("loads the packaged Sharp native sidecars in a standalone Bun executable", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-sharp-compiled-"));
        tempDirs.push(root);
        const entrypoint = join(root, "entrypoint.ts");
        const builder = join(
            dirname(fileURLToPath(import.meta.url)),
            "../../../../../packages/cli-common/scripts/buildServerBunBinary.mjs",
        );
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
        const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
        const executablePath = join(root, `happier-sharp-probe${target.exeExt}`);
        const unrelatedWorkingDirectory = join(root, "unrelated-cwd");
        const sharpRuntimePath = join(dirname(fileURLToPath(import.meta.url)), "sharpRuntime.ts");
        await writeFile(
            entrypoint,
            [
                `import { loadSharp } from ${JSON.stringify(sharpRuntimePath)};`,
                "const sharp = await loadSharp();",
                "const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();",
                "process.stdout.write(`sharp-ok:${png.byteLength}`);",
            ].join("\n"),
            "utf8",
        );
        await compileBunBinary({
            entrypoint, bunTarget: target.bunTarget, outfile: executablePath, bunCommand, cwd: repoRoot,
            buildRunnerEntrypoint: builder,
        });
        for (const entry of await resolveSharpServerSidecarEntries({ repoRoot, target })) {
            const targetDir = join(root, entry.targetPath);
            await mkdir(dirname(targetDir), { recursive: true });
            await cp(entry.sourcePath, targetDir, { recursive: true });
        }
        await mkdir(unrelatedWorkingDirectory);
        await writeFile(join(unrelatedWorkingDirectory, "bunfig.toml"), 'preload = ["./preload.cjs"]\n');
        await writeFile(join(unrelatedWorkingDirectory, "preload.cjs"), "throw new Error('Project bunfig preload was executed');\n");
        await writeFile(join(unrelatedWorkingDirectory, "package.json"), JSON.stringify({ type: "module" }));
        const platform = target.os === "windows" ? "win32" : target.os;
        for (const packageName of ["sharp", `@img/sharp-${platform}-${target.arch}`]) {
            const packageDir = join(unrelatedWorkingDirectory, "node_modules", ...packageName.split("/"));
            await mkdir(packageDir, { recursive: true });
            await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: packageName, exports: packageName === "sharp" ? { ".": "./index.cjs" } : { "./sharp.node": "./index.cjs" } }));
            await writeFile(join(packageDir, "index.cjs"), "throw new Error('Untrusted working-directory Sharp was loaded');");
        }

        const launched = spawnSync(executablePath, [], {
            cwd: unrelatedWorkingDirectory,
            encoding: "utf8",
            env: { PATH: "" },
        });
        expect(launched.status, launched.stderr).toBe(0);
        expect(launched.stdout).toMatch(/^sharp-ok:\d+$/);
    }, 20_000);

    it.skipIf(!bunCommand)("inspects pet images through the CLI physical ESM graph in a standalone Bun executable", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-cli-sharp-compiled-"));
        tempDirs.push(root);
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
        const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
        const executablePath = join(root, `happier-cli-sharp-probe${target.exeExt}`);
        const entrypoint = join(root, "entrypoint.ts");
        const { loadSharp } = await import("./sharpRuntime");
        const sharp = await loadSharp();
        const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();
        await writeFile(entrypoint, [
            `import { defaultPetImageInfoDecoder } from ${JSON.stringify(join(repoRoot, "apps/cli/src/pets/validation/validatePetAtlas.ts"))};`,
            "if (process.env.HAPPIER_SHARP_AMBIENT_TRAP) throw new Error('Project dotenv was loaded');",
            `const info = await defaultPetImageInfoDecoder({ bytes: Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64'), filename: 'probe.png', strict: true });`,
            "if (info?.contentInspected !== true || info.width !== 1) throw new Error('Sharp content inspection did not run');",
            "process.stdout.write(`sharp-ok:${info.width}`);",
        ].join("\n"));
        // The CLI owns a physical source graph behind its thin executable.
        const requireFromProject = createRequire(join(repoRoot, "apps/cli/package.json"));
        const esbuild = requireFromProject('esbuild') as { build(options: Record<string, unknown>): Promise<unknown> };
        const sourceRuntime = await import(pathToFileURL(join(repoRoot, "packages/cli-common/sourceRuntimeEntries.mjs")).href);
        await esbuild.build({
            absWorkingDir: repoRoot, entryPoints: [entrypoint], outfile: join(root, "package-dist/index.mjs"),
            bundle: true, format: 'esm', platform: 'node', target: 'node20', ...sourceRuntime.SOURCE_RUNTIME_OUTPUT_OPTIONS,
            conditions: [sourceRuntime.SOURCE_CONDITION], external: CLI_RUNTIME_EXTERNAL_PACKAGES,
            banner: { js: "import {createRequire as __artifactCreateRequire} from 'node:module'; import {fileURLToPath as __artifactFileURLToPath} from 'node:url'; import {dirname as __artifactDirname} from 'node:path'; const require=__artifactCreateRequire(import.meta.url); const __artifactFilename=__artifactFileURLToPath(import.meta.url); const __artifactDirectory=__artifactDirname(__artifactFilename);" },
            define: { __dirname: '__artifactDirectory', __filename: '__artifactFilename' },
            plugins: [sourceRuntime.createWorkspaceSourceResolver({ workspacePackages: await sourceRuntime.readWorkspacePackages(repoRoot), requireFromProject, externalPackages: CLI_RUNTIME_EXTERNAL_PACKAGES })],
        });
        await writeFile(join(root, "package.json"), JSON.stringify({ name: "@happier-dev/cli", type: "module", imports: { "#trusted-package": "./trusted.cjs" }, exports: { "./probe": "./trusted.cjs" } }));
        await writeFile(join(root, "trusted.cjs"), "module.exports = { trusted: true }; ");
        await appendFile(join(root, "package-dist/index.mjs"), ";for (const id of ['#trusted-package', '@happier-dev/cli/probe']) { const m = await import(id); if (m.default?.trusted !== true) throw new Error('Untrusted package metadata was loaded'); } if (process.env.HAPPIER_SHARP_DEFINE_TRAP) throw new Error('Ambient Bun define was loaded');");
        bundleInstalledPackageWithRuntimeDependencies({ packageName: "sharp", resolveFromPackageJsonPath: join(repoRoot, "apps/cli/package.json"), destNodeModulesDir: join(root, "node_modules"), dereferenceRootDir: repoRoot });
        const nativeEntry = join(root, "native-entry.mjs");
        await writeFile(nativeEntry, "import {dirname,join} from 'node:path'; import {pathToFileURL} from 'node:url'; await import(pathToFileURL(join(dirname(process.execPath),'package-dist/index.mjs')).href);");
        await compileBunBinary({ entrypoint: nativeEntry, bunTarget: target.bunTarget, outfile: executablePath, bunCommand, cwd: repoRoot, autoloadDotenv: false, autoloadPackageJson: true });
        const untrustedCwd = join(root, "untrusted-cwd");
        await mkdir(untrustedCwd);
        await writeFile(join(untrustedCwd, "package.json"), JSON.stringify({ name: "@happier-dev/cli", type: "commonjs", main: "./preload.cjs", imports: { "#trusted-package": "./preload.cjs" }, exports: { ".": "./preload.cjs", "./probe": "./preload.cjs" } }));
        const preloadMarker = join(root, "ambient-preload-ran");
        await writeFile(join(untrustedCwd, "preload.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran'); throw new Error('Ambient preload executed');`);
        await writeFile(join(untrustedCwd, "bunfig.toml"), "preload = ['./preload.cjs']\n[define]\n\"process.env.HAPPIER_SHARP_DEFINE_TRAP\" = \"'ambient'\"\n");
        await writeFile(join(untrustedCwd, ".env"), "HAPPIER_SHARP_AMBIENT_TRAP=1\n");
        const platform = target.os === "windows" ? "win32" : target.os;
        for (const packageName of ["sharp", `@img/sharp-${platform}-${target.arch}`]) {
            const packageDir = join(untrustedCwd, "node_modules", ...packageName.split("/"));
            await mkdir(packageDir, { recursive: true });
            await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: packageName, exports: packageName === "sharp" ? { ".": "./index.cjs" } : { "./sharp.node": "./index.cjs" } }));
            await writeFile(join(packageDir, "index.cjs"), "throw new Error('Untrusted working-directory Sharp was loaded');");
        }
        const launched = spawnSync(executablePath, [], { cwd: untrustedCwd, encoding: "utf8", env: { PATH: "" } });
        expect(launched.status, launched.stderr).toBe(0);
        expect(launched.stdout).toBe("sharp-ok:1");
        await expect(stat(preloadMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    }, 20_000);

});
