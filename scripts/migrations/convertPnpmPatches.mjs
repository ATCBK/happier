// Cutover: capture the latest legacy patches/ and apps/ui/patches/ in a temporary
// directory before applying their deletions, then pass --legacy-root=<directory>.
// Run after migratePnpmConfig.mjs, pnpm import and an ignore-scripts install.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execPnpm } from '../workspaces/execPnpmCommand.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { parsePatch, applyPatch } = require('diff');
const { parse: parseYaml, stringify: stringifyYaml } = require('yaml');
const legacyRootArgument = process.argv.slice(2).find(argument => argument.startsWith('--legacy-root='));
const legacyRoot = legacyRootArgument ? path.resolve(legacyRootArgument.slice('--legacy-root='.length)) : root;
const legacyDirs = ['patches', 'apps/ui/patches'];
const sources = legacyDirs.flatMap(dir => (fs.existsSync(path.join(legacyRoot, dir)) ? fs.readdirSync(path.join(legacyRoot, dir)) : [])
    .filter(name => /\+\d.*\.patch$/.test(name))
    .map(name => ({ file: path.join(legacyRoot, dir, name), name })));
if (sources.length === 0) {
    console.log('No legacy patches remain to convert.');
    process.exit(0);
}

// Patch commits resolve the lockfile again. Keep each patch's upstream basis
// installed rather than silently upgrading a semver range beyond its patch.
const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
const workspace = parseYaml(fs.readFileSync(workspaceFile, 'utf8'));
for (const { name } of sources) {
    const parts = name.slice(0, -6).split('+');
    const version = parts.pop();
    workspace.overrides[parts.join('/')] = version;
}
fs.writeFileSync(workspaceFile, stringifyYaml(workspace));
run(['install', '--ignore-scripts']);

function run(args, cwd = root) {
    execPnpm(args, {
        cwd, encoding: 'utf8', stdio: 'inherit',
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_ignore_scripts: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true' },
    });
}

for (const { file, name } of sources) {
    const parts = name.slice(0, -6).split('+');
    const version = parts.pop();
    const packageName = parts.join('/');
    const specifier = `${packageName}@${version}`;
    const editDir = path.join(root, 'node_modules/.pnpm-patch-convert', name.slice(0, -6));
    if (fs.existsSync(editDir)) fs.rmSync(editDir, { recursive: true });
    run(['patch', specifier, '--edit-dir', editDir, '--ignore-existing']);
    const effects = parsePatch(fs.readFileSync(file, 'utf8'));
    for (const effect of effects) {
        const prefix = `node_modules/${packageName}/`;
        const relativePath = effect.newFileName.replace(/^b\//, '').replace(prefix, '');
        const oldRelativePath = effect.oldFileName.replace(/^a\//, '').replace(prefix, '');
        const target = path.join(editDir, effect.newFileName === '/dev/null' ? oldRelativePath : relativePath);
        if (effect.newFileName === '/dev/null') {
            fs.unlinkSync(target);
            continue;
        }
        const original = effect.oldFileName === '/dev/null' ? '' : fs.readFileSync(target, 'utf8');
        let result = applyPatch(original, effect);
        // Legend's settled-scroll hunk consumes checkThresholds introduced by a later
        // hunk in the same patch. Apply the independent hunks, then that hunk; no fuzz.
        if (result === false && packageName === '@legendapp/list' && /^react-native\.(js|mjs)$/.test(relativePath)) {
            const [settledScroll, ...remaining] = effect.hunks;
            result = applyPatch(original, { ...effect, hunks: remaining });
            if (result !== false) result = applyPatch(result, { ...effect, hunks: [settledScroll] });
        }
        if (result === false) throw new Error(`Cannot apply ${name}: ${relativePath}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, result);
    }
    run(['patch-commit', editDir, '--patches-dir', 'patches']);
    // pnpm 12.14.0 can emit unrelated header-only deletions (observed for
    // expo-router's native module and plugin entry). Preserve the legacy
    // target set: a conversion must never delete an untouched upstream file.
    const patched = parseYaml(fs.readFileSync(workspaceFile, 'utf8')).patchedDependencies;
    const outputFile = path.join(root, patched[specifier]);
    const expectedTargets = new Set(effects.map(effect =>
        (effect.newFileName === '/dev/null' ? effect.oldFileName : effect.newFileName)
            .replace(/^[ab]\//, '').replace(`node_modules/${packageName}/`, '')));
    const generated = fs.readFileSync(outputFile, 'utf8');
    const blocks = generated.split(/(?=^diff --git )/m).filter(Boolean);
    fs.writeFileSync(outputFile, blocks.filter(block => {
        const target = /^diff --git a\/(.+) b\/(.+)$/m.exec(block)?.[2];
        if (!target) throw new Error(`Unrecognized native patch header: ${specifier}`);
        if (expectedTargets.has(target)) return true;
        if (packageName === 'expo-router'
            && ['android/src/main/java/expo/modules/router/ExpoRouterModule.kt', 'plugin/src/index.ts'].includes(target)
            && /^diff --git [^\n]+\ndeleted file mode 100644\nindex [a-f0-9]+\.\.0+\n?$/.test(block)) return false;
        throw new Error(`Unexpected generated patch target: ${specifier}: ${target}`);
    }).join(''));
    console.log(`Converted ${specifier} (${effects.length} files)`);
}
run(['install', '--ignore-scripts']);
console.log(`Converted ${sources.length} patches. Verify markers before deleting legacy patch files.`);
