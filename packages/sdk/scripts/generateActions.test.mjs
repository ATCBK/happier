import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  PUBLIC_ACTION_IDS,
  getActionSpec,
  isHumanSecretApiExcludedActionId,
  isInternalActionId,
  isPluginProvenanceOnlyActionId,
  listActionSpecs,
  resolveActionSdkMethodName,
} from '../../protocol/src/actions/actionSpecs.js';
import { validateSdkMethodRows } from './generateActions.ts';

const generatedSourcePath = new URL('../src/actions/generated.ts', import.meta.url);

async function readGeneratedActionSource() {
  return await readFile(generatedSourcePath, 'utf8');
}

function emittedActionIds(source) {
  return [...source.matchAll(/=> execute\("([^"]+)"/gu)].map(([, actionId]) => actionId);
}

test('consumes the canonical Protocol Action source owner without a mutable dist build', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');
  assert.match(source, /protocol\/src\/actions\/actionSpecs\.js/u);
  assert.doesNotMatch(source, /protocol\/dist|ensureWorkspacePackagesBuiltByName/u);
});

test('uses the Action owner public projection rather than re-deriving eligibility', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');

  assert.match(source, /PUBLIC_ACTION_IDS/u);
  assert.doesNotMatch(source, /isInternalActionId|isPluginProvenanceOnlyActionId/u);
});

test('does not mutate shared workspace artifacts while resolving Action rows', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');

  assert.doesNotMatch(source, /ensureWorkspacePackagesBuiltByName|writeFile[^\n]*protocol/u);
  assert.match(source, /return PUBLIC_ACTION_IDS[\s\S]*getActionSpec[\s\S]*resolveActionSdkMethodName/u);
});

test('composed typecheck reuses the governance build and checks only the test project afterward', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['typecheck:local'],
    'pnpm --silent run check:api-governance && node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.tests.json && pnpm --silent run test:external-consumer',
  );
});

test('emits exactly the catalog public surface, once per Action', async () => {
  const emitted = emittedActionIds(await readGeneratedActionSource());

  assert.deepEqual(
    [...emitted].sort(),
    [...PUBLIC_ACTION_IDS].sort(),
    'The generated tree must mirror PUBLIC_ACTION_IDS: no SDK-local method, alias or omission.',
  );
  assert.equal(new Set(emitted).size, emitted.length, 'No Action may be published under two method paths.');
  for (const actionId of emitted) {
    assert.equal(
      getActionSpec(actionId).surfaces.api,
      true,
      `Generated PAT method ${actionId} must be executable by account_automation in principle.`,
    );
  }
});

test('excludes every catalog-owned non-public Action class without generator policy', async () => {
  const emitted = new Set(emittedActionIds(await readGeneratedActionSource()));

  const excluded = listActionSpecs()
    .map((spec) => spec.id)
    .filter((actionId) => isInternalActionId(actionId)
      || isPluginProvenanceOnlyActionId(actionId)
      || isHumanSecretApiExcludedActionId(actionId));
  assert.ok(excluded.length > 0, 'Expected the catalog to still declare excluded Action ids.');
  for (const actionId of excluded) {
    assert.equal(emitted.has(actionId), false, `Excluded Action ${actionId} reached the public SDK tree.`);
  }
  // A named provenance-only Action guards against the predicate lists silently
  // emptying and turning this assertion into a tautology.
  assert.equal(emitted.has('plugin.webhook.endpoint.checkCorrespondence'), false);
  for (const actionId of [
    'account.password.enroll',
    'account.password.change',
    'account.password.remove',
    'account.email.change.request',
    'account.apiTokens.create',
    'account.apiTokens.list',
    'account.apiTokens.revoke',
    'account.apiTokens.revokeAll',
  ]) {
    assert.equal(emitted.has(actionId), false, `${actionId} must stay private to trusted interactive hosts.`);
  }
  assert.equal(emitted.has('account.security.get'), true);
  assert.equal(emitted.has('discussion.read_state.set'), false);
  assert.equal(emitted.has('approval.request.decide'), true);
  assert.equal(emitted.has('plugins.install'), false);
  assert.equal(emitted.has('teams.directory.sources.remove.preview'), true);
});

test('publishes directory-source removal preview and approved nested mutation execution', async () => {
  const source = await readGeneratedActionSource();
  const emitted = emittedActionIds(source);
  const publicMethodPaths = PUBLIC_ACTION_IDS.map((actionId) => (
    resolveActionSdkMethodName(getActionSpec(actionId))
  ));

  // Both Actions are public, while the mutation's explicit SDK method path
  // keeps it beside `remove.preview` without colliding at the namespace node.
  assert.equal(emitted.includes('teams.directory.sources.remove'), true);
  assert.equal(emitted.includes('teams.directory.sources.remove.preview'), true);
  assert.equal(publicMethodPaths.includes('teams.directory.sources.remove.execute'), true);
  assert.equal(publicMethodPaths.includes('teams.directory.sources.remove.preview'), true);
  assert.match(
    source,
    /readonly remove: Readonly<\{\s+readonly execute: \(input: PublicActionInputById\["teams\.directory\.sources\.remove"\][^\n]+\s+readonly preview: \(input: PublicActionInputById\["teams\.directory\.sources\.remove\.preview"\][^\n]+\s+\}> ;/u,
  );
  assert.match(
    source,
    /remove: \{\s+execute: \(input: PublicActionInputById\["teams\.directory\.sources\.remove"\][^\n]+=> execute\("teams\.directory\.sources\.remove", input, options\),\s+preview: \(input: PublicActionInputById\["teams\.directory\.sources\.remove\.preview"\][^\n]+=> execute\("teams\.directory\.sources\.remove\.preview", input, options\),\s+\},/u,
  );
});

test('keeps directory removal free of generator special cases', async () => {
  const generatorSource = await readFile(new URL('./generateActions.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(generatorSource, /teams\.directory|callable|Object\.assign/u);
  assert.match(generatorSource, /resolveActionSdkMethodName/u);
});

test('rejects reserved generated roots', () => {
  for (const reservedRoot of ['execute', 'get', 'search', 'invoke']) {
    assert.throws(
      () => validateSdkMethodRows([{ actionId: 'safe.action', methodPath: `${reservedRoot}.now` }]),
      /reserved SDK root/,
    );
  }
});

test('rejects exact and namespace-prefix collisions', () => {
  assert.throws(
    () => validateSdkMethodRows([
      { actionId: 'first', methodPath: 'session.open' },
      { actionId: 'second', methodPath: 'session.open' },
    ]),
    /share SDK method path/,
  );
  assert.throws(
    () => validateSdkMethodRows([
      { actionId: 'first', methodPath: 'session.open' },
      { actionId: 'second', methodPath: 'session.open.now' },
    ]),
    /conflict at SDK namespace/,
  );
});
