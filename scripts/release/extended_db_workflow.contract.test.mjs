import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

const repoRoot = new URL('../..', import.meta.url).pathname;

function loadWorkflow(fileName = 'extended-db-tests.yml') {
  return YAML.parse(readFileSync(join(repoRoot, '.github', 'workflows', fileName), 'utf8'), {
    prettyErrors: true,
  });
}

test('extended DB E2E owns provider generation once and runs only database-relevant coverage', () => {
  const workflow = loadWorkflow();
  assert.equal(workflow.concurrency['cancel-in-progress'], false);

  for (const [jobName, provider] of [
    ['e2e-postgres', 'postgres'],
    ['e2e-mysql', 'mysql'],
  ]) {
    const job = workflow.jobs[jobName];
    const generate = job.steps.find((step) => step.name === `Generate server provider client (${provider})`);
    assert.ok(generate, `${jobName} should generate its provider client before Vitest starts`);
    assert.equal(generate.env.HAPPIER_BUILD_DB_PROVIDERS, provider);
    assert.equal(generate.run, 'pnpm --filter @happier-dev/server run generate:providers');

    const run = job.steps.find((step) => step.name === `Run core e2e database suite (${provider})`);
    assert.ok(run, `${jobName} should own a bounded external-database E2E command`);
    assert.equal(run.env.HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE, '1');
    assert.equal(
      run.run,
      'pnpm run test:e2e:core:fast -- --no-file-parallelism --maxWorkers=1 --minWorkers=1',
    );

    const upload = job.steps.find((step) => step.name === 'Upload e2e diagnostics (on failure)');
    assert.ok(upload, `${jobName} should retain bounded diagnostics`);
    assert.doesNotMatch(upload.with.path, /^\.project\/logs\/e2e$/m);
    assert.match(upload.with.path, /\.project\/logs\/e2e\/\*\*\/\*\.log/);
    assert.equal(upload.with['retention-days'], 7);
  }
});

test('provider DB contracts check generated schemas without repair before provider execution', () => {
  const workflow = loadWorkflow();
  for (const [jobName, provider] of [
    ['db-contract-postgres', 'Postgres'],
    ['db-contract-mysql', 'MySQL'],
  ]) {
    const steps = workflow.jobs[jobName].steps;
    const checkIndex = steps.findIndex((step) => step.name === 'Check provider schema synchronization');
    const runIndex = steps.findIndex((step) => step.name === `Run db contract suite (${provider})`);
    assert.ok(checkIndex >= 0, `${jobName} must run the non-mutating schema check`);
    assert.ok(checkIndex < runIndex, `${jobName} must check schema drift before provider tests`);
    assert.equal(steps[checkIndex].run, 'pnpm --dir apps/server run schema:sync:check');
    assert.doesNotMatch(steps[checkIndex].run, /db push|migrate|repair/iu);
    const providerUrlKey = provider === 'Postgres'
      ? 'HAPPIER_TEST_POSTGRES_DATABASE_URL'
      : 'HAPPIER_TEST_MYSQL_DATABASE_URL';
    assert.equal(
      steps[runIndex].env[providerUrlKey],
      steps[runIndex].env.DATABASE_URL,
      `${jobName} must explicitly identify its disposable provider-test database`,
    );
  }
});

test('provider DB contracts exercise the Session System Record preview upgrade before final-schema coverage', () => {
  const workflow = loadWorkflow();
  for (const [jobName, provider, db] of [
    ['db-contract-postgres', 'Postgres', 'postgres'],
    ['db-contract-mysql', 'MySQL', 'mysql'],
  ]) {
    const steps = workflow.jobs[jobName].steps;
    const schemaIndex = steps.findIndex((step) => step.name === 'Check provider schema synchronization');
    const upgradeIndex = steps.findIndex(
      (step) => step.name === `Run Session System Record preview upgrade contract (${provider})`,
    );
    const finalContractIndex = steps.findIndex((step) => step.name === `Run db contract suite (${provider})`);
    assert.ok(schemaIndex >= 0 && schemaIndex < upgradeIndex, `${jobName} must check source schema before the upgrade`);
    assert.ok(upgradeIndex < finalContractIndex, `${jobName} must finish the preview upgrade before final-schema contracts`);
    assert.equal(
      steps[upgradeIndex].run,
      `node packages/tests/scripts/run-extended-db-docker.mjs --db ${db} --mode session-system-record-upgrade`,
    );
  }

  const postgresSteps = workflow.jobs['db-contract-postgres'].steps;
  const postgresMigration = postgresSteps.find((step) => step.name === 'Migrate (Postgres)');
  assert.equal(postgresMigration.run, 'pnpm --dir apps/server run migrate:full:deploy');
  assert.doesNotMatch(
    postgresSteps.map((step) => step.run ?? '').join('\n'),
    /prisma\s+migrate\s+deploy/iu,
    'Postgres DB contracts must not bypass the canonical Session System Record migration lifecycle',
  );
});

test('the primary PostgreSQL DB-contract job also uses the canonical migration owner', () => {
  const workflow = loadWorkflow('tests.yml');
  const postgresMigration = workflow.jobs['server-db-contract'].steps.find(
    (step) => step.name === 'Migrate (Postgres)',
  );
  assert.equal(postgresMigration.env.HAPPIER_DB_PROVIDER, 'postgres');
  assert.equal(postgresMigration.run, 'pnpm --dir apps/server run migrate:full:deploy');
  assert.doesNotMatch(postgresMigration.run, /prisma\s+migrate\s+deploy/iu);
});
