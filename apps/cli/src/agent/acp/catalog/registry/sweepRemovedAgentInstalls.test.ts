import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { sweepRemovedAgentInstalls } from './sweepRemovedAgentInstalls';
import { getAcpManagedInstallId } from '../configured/resolveAcpLaunch';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'happier-acp-sweep-')); roots.push(home);
  const env = { HAPPIER_HOME_DIR: home };
  const managed = join(home, 'tools', `dep.${getAcpManagedInstallId({ id: 'removed', launch: { kind: 'npm', package: 'unused', version: '1.0', args: [] } }, 'alice')}`);
  await mkdir(join(managed, 'current'), { recursive: true });
  await writeFile(join(managed, 'current', '.happier-managed-version'), JSON.stringify({
    definitionId: 'removed', title: 'Removed fixture', version: '1.0', kind: 'archive',
  }));
  const outside = join(home, 'tools', 'user-installed');
  await mkdir(outside); await writeFile(join(outside, 'agent'), 'outside Happier');
  return { env, managed, outside };
}
const empty: AcpCatalogSnapshotV1 = { status: 'ready', revision: 1, record: { v: 1, definitions: [] } };
describe('removed ACP definition install sweep', () => {
  it('removes only unreferenced versions in its own Account namespace', async () => {
    const f = await fixture();
    const definition = { id: 'same', title: 'Same', launch: { kind: 'archive' as const, version: '1.0', args: [], assetsByPlatform: {
      'linux-x64': { archiveUrl: 'https://fixture.invalid/agent.zip', executableSubpath: 'agent' },
    } } };
    const old = join(f.env.HAPPIER_HOME_DIR, 'tools', `dep.${getAcpManagedInstallId(definition, 'alice')}`);
    const current = join(f.env.HAPPIER_HOME_DIR, 'tools', `dep.${getAcpManagedInstallId({ ...definition, launch: { ...definition.launch, version: '2.0' } }, 'alice')}`);
    const foreign = join(f.env.HAPPIER_HOME_DIR, 'tools', `dep.${getAcpManagedInstallId(definition, 'bob')}`);
    for (const [path, version] of [[old, '1.0'], [current, '2.0'], [foreign, '1.0']]) {
      await mkdir(join(path!, 'current'), { recursive: true });
      await writeFile(join(path!, 'current', '.happier-managed-version'), JSON.stringify({ definitionId: 'same', title: 'Same', kind: 'archive', version }));
    }
    const catalog: AcpCatalogSnapshotV1 = { status: 'ready', revision: 2, record: { v: 1, definitions: [AcpBackendDefinitionV1Schema.parse({
      ...definition, name: 'same', launch: { ...definition.launch, version: '2.0' }, createdAt: 1, updatedAt: 2,
    })] } };
    await sweepRemovedAgentInstalls({ catalog, accountId: 'alice', env: f.env, isCurrent: () => true, isDefinitionInUse: () => false });
    await expect(access(old)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(current)).resolves.toBeUndefined();
    await expect(access(foreign)).resolves.toBeUndefined();
  });
  it('removes an absent managed definition and keeps unrelated user installs', async () => {
    const f = await fixture();
    await sweepRemovedAgentInstalls({ accountId: 'alice', catalog: empty, env: f.env, isDefinitionInUse: () => false, isCurrent: () => true });
    await expect(access(f.managed)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(f.outside)).resolves.toBeUndefined();
  });
  it('keeps a live definition and retries on the next successful hydration', async () => {
    const f = await fixture(); let running = true;
    const input = { accountId: 'alice', catalog: empty, env: f.env, isDefinitionInUse: () => running, isCurrent: () => true };
    await sweepRemovedAgentInstalls(input);
    await expect(access(f.managed)).resolves.toBeUndefined();
    running = false; await sweepRemovedAgentInstalls(input);
    await expect(access(f.managed)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each<AcpCatalogSnapshotV1>([{ status: 'unavailable', reason: 'unreachable' },
    { status: 'partial', reason: 'incomplete-inventory', record: { v: 1, definitions: [] }, diagnostics: [] }])(
    'keeps every install for a $status hydration', async catalog => {
      const f = await fixture();
      await sweepRemovedAgentInstalls({ accountId: 'alice', catalog, env: f.env, isDefinitionInUse: () => false, isCurrent: () => true });
      await expect(access(f.managed)).resolves.toBeUndefined();
    });
  it('keeps installs after the captured Account retires', async () => {
    const f = await fixture();
    await sweepRemovedAgentInstalls({ accountId: 'alice', catalog: empty, env: f.env, isDefinitionInUse: () => false, isCurrent: () => false });
    await expect(access(f.managed)).resolves.toBeUndefined();
  });
});
