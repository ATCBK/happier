import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { resolveVitestFeatureTestExcludeGlobs } from "../../scripts/testing/featureTestGating";
import { serverWorkspacePackageSourcesPlugin } from './vitestWorkspacePackageResolution';
import { createTestHomeEnvironment } from '../../scripts/testing/testHomeEnvironment.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    test: {
        ...resolveVitestWorkers(),
        globals: true,
        environment: "node",
        setupFiles: [resolve(__dirname, '../../scripts/testing/vitestHomeSetup.mjs'), "./sources/configureZodLocale.ts"],
        sequence: { setupFiles: 'list' },
        include: ["**/*.dbcontract.spec.ts"],
        exclude: [...resolveVitestFeatureTestExcludeGlobs()],
        isolate: true,
        testTimeout: 60_000,
        hookTimeout: 60_000,
        env: {
            ...createTestHomeEnvironment().env,
            HAPPIER_FEATURE_POLICY_ENV: "",
        },
    },
    // Cross-owner DB contracts exercise the real CLI consumer against server
    // routes. Resolve each importer's own alias without scanning Expo projects.
    plugins: [serverWorkspacePackageSourcesPlugin, tsconfigPaths({ projects: [
        resolve(__dirname, "./tsconfig.vitest.json"), resolve(__dirname, "../cli/tsconfig.json"),
    ] })],
});
