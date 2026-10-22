import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateScript } from './migratePnpmScripts.mjs';

test('maps local scripts, workspace scripts and binaries without changing their runtime', () => {
  const options = {
    scripts: { build: 'node build.mjs' },
    manifestsByName: new Map([['@happier-dev/cli', { scripts: { build: 'node scripts/build.mjs' } }]]),
    manifestPath: '/repo/package.json',
    manifestsByPath: new Map([['/repo/apps/ui', { scripts: { typecheck: 'hstack-exec' } }]]),
  };
  assert.equal(migrateScript('yarn -s build && yarn workspace @happier-dev/cli build', options), 'pnpm --silent run build && pnpm --filter @happier-dev/cli run build');
  assert.equal(migrateScript('corepack yarn --cwd apps/ui -s typecheck && yarn expo export --platform web', options), 'pnpm --dir apps/ui --silent run typecheck && pnpm exec expo export --platform web');
  assert.equal(migrateScript('$npm_execpath run build && $npm_execpath test', options), 'pnpm run build && pnpm run test');
  assert.equal(migrateScript('(yarn || npm) && node run.mjs', options), '(pnpm install) && node run.mjs');
});

test('the cutover transformation is idempotent and does not change user-project flags', () => {
  const script = 'node buildExampleProjects.mjs --yarn=demo && pnpm --silent run build';
  assert.equal(migrateScript(script), script);
});
