import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { transform } from 'esbuild';

type InstalledRoutingState = Readonly<{
    key?: string;
    stale?: boolean;
    type?: string;
    index?: number;
    routes: readonly InstalledRoutingRoute[];
}>;
type InstalledRoutingRoute = Readonly<{
    name: string;
    params?: object;
    state?: InstalledRoutingState;
}>;

/** Evaluate a published SDK module while replacing only the supplied external ports. */
export async function evaluateInstalledExpoModule(path: string, overrides: Readonly<Record<string, unknown>>) {
    const module: { exports: Record<string, unknown> } = { exports: {} };
    const sdkRequire = createRequire(path);
    const { code } = await transform(await readFile(path, 'utf8'), { loader: 'js', format: 'cjs' });
    new Function('exports', 'require', 'module', '__filename', '__dirname', code)(module.exports,
        (id: string) => Object.hasOwn(overrides, id) ? overrides[id] : sdkRequire(id), module, path, dirname(path));
    return module.exports;
}

/** Execute the installed pure routing algorithms with their real dynamic-name matcher.
 * The surrounding CJS module imports native/browser adapters that these algorithms never use. */
export async function loadInstalledExpoRoutingState() {
    const require = createRequire(import.meta.url);
    const source = await readFile(require.resolve('expo-router/build/global-state/routing'), 'utf8');
    const start = source.indexOf('function getPayloadFromStateRoute(');
    const end = source.indexOf('//# sourceMappingURL=', start);
    if (start < 0 || end < 0) throw new Error('Installed Expo routing algorithms unavailable');
    const exports: unknown = new Function('matchers_1', `${source.slice(start, end)}\nreturn { findDivergentState, getPayloadFromStateRoute };`)(
        require('expo-router/build/matchers'),
    );
    // The installed CJS boundary is untyped; this is its published algorithm shape.
    return exports as Readonly<{
        findDivergentState(action: InstalledRoutingState, navigation: InstalledRoutingState): Readonly<{
            navigationState: InstalledRoutingState;
            actionStateRoute: InstalledRoutingRoute;
        }>;
        getPayloadFromStateRoute(route: InstalledRoutingRoute): Readonly<{ screen: string; params: object }>;
    }>;
}

/** Loads the installed SDK's real serializer without its unrelated native entrypoint. */
export async function loadInstalledExpoPathSerializer() {
    const require = createRequire(import.meta.url);
    // Published CommonJS requires bypass Vitest's RN aliases. Preserve the exact SDK
    // serializers and pure navigation validator rather than mocking path/query logic.
    const navigation = await evaluateInstalledExpoModule(require.resolve('@react-navigation/core').replace(/index\.js$/, 'validatePathConfig.js'), {});
    const forks = await evaluateInstalledExpoModule(require.resolve('expo-router/build/fork/getPathFromState-forks'), { '@react-navigation/native': navigation });
    return evaluateInstalledExpoModule(require.resolve('expo-router/build/fork/getPathFromState'), { './getPathFromState-forks': forks });
}
