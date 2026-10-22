import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const repository = new URL('../../..', import.meta.url);

test('the Home Iroh native gate runs by default and is selectable through manual dispatch', () => {
  const workflow = readFileSync(new URL('.github/workflows/tests.yml', repository), 'utf8');
  const dispatch = readFileSync(new URL('.github/workflows/tests-dispatch.yml', repository), 'utf8');
  assert.match(workflow, /run_home_iroh_real:/u);
  assert.match(
    workflow,
    /home-iroh-real:\n\s+if: \$\{\{ !inputs\.select_jobs_explicitly \|\| inputs\.run_home_iroh_real \}\}/u,
  );
  assert.match(workflow, /pnpm --filter @happier-dev\/iroh-native run test:home-iroh:real/u);
  assert.match(workflow, /ci_summary:[\s\S]*needs: \[[^\]]*home-iroh-real/u);
  assert.match(dispatch, /custom_checks:[\s\S]*home_iroh_real/u);
  assert.match(dispatch, /outputs:[\s\S]*run_home_iroh_real: \$\{\{ steps\.flags\.outputs\.run_home_iroh_real \}\}/u);
  assert.match(dispatch, /run: node scripts\/pipeline\/checks\/resolve-checks-plan\.mjs --target hosted/u);
  assert.doesNotMatch(dispatch, /if has home_iroh_real; then run_home_iroh_real=true; fi/u);
  assert.match(dispatch, /run_home_iroh_real: \$\{\{ needs\.resolve\.outputs\.run_home_iroh_real == 'true' \}\}/u);
});

test('the managed Iroh relay deployment contract runs in the release-contracts gate', () => {
  const rootPackage = JSON.parse(readFileSync(new URL('package.json', repository), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const workflow = readFileSync(new URL('.github/workflows/tests.yml', repository), 'utf8');
  assert.match(rootPackage.scripts['test:release:contracts'] ?? '', /deploy\/iroh-relay\/\*\.test\.mjs/u);
  assert.match(workflow, /release-contracts:\n\s+if: \$\{\{ !inputs\.select_jobs_explicitly \|\| inputs\.run_release_contracts \}\}/u);
  assert.match(workflow, /pnpm run test:release:contracts/u);
  assert.match(workflow, /ci_summary:[\s\S]*needs: \[[^\]]*release-contracts/u);
});

test('ordinary CLI integration excludes the native machine-carrier fixture', () => {
  const config = readFileSync(new URL('apps/cli/vitest.integration.config.ts', repository), 'utf8');
  assert.match(config, /workspaceMachineCarrierLane08\.real\.integration\.test\.ts/u);
  assert.match(config, /HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION === '1'/u);
});
