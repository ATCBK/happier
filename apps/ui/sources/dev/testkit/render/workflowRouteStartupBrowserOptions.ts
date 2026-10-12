import type { buildWorkspaceHistoryBrowser } from './buildWorkspaceHistoryBrowser.mjs';

// Existing real Metro startup build budget, also used by its interruption check.
export const workflowRouteStartupBrowserBuildTimeoutMs = 600_000;

export const workflowRouteStartupBrowserOptions = {
    entryFile: 'sources/dev/testkit/render/workflowRouteStartupBrowserEntry.ts',
    realExpoRouter: true, asyncRoutes: true, lazy: false, production: true,
    boundaryModules: {
        'expo-router/build/renderRootComponent': 'sources/dev/testkit/render/workflowRouteStartupRootBoundary.tsx',
        'node:child_process': 'sources/dev/testkit/render/workflowRouteStartupProcessBoundary.ts',
        'node:buffer': 'sources/dev/testkit/render/workflowRouteStartupBufferBoundary.ts',
        ...Object.fromEntries(['node:module', 'node:stream', 'node:stream/promises', 'node:http',
            'node:https', 'node:net', 'node:async_hooks', 'node:timers/promises', 'node:zlib', 'node:v8', 'tar', 'yauzl'].map(name => [
            name, 'sources/dev/testkit/render/workflowRouteStartupNodeBoundary.ts',
        ])),
    },
} satisfies NonNullable<Parameters<typeof buildWorkspaceHistoryBrowser>[0]>;
