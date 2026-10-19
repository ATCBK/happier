import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';

import { logger } from '@/utils/logger';
import { observeConnectedServiceMaterializationPhase, observeCurrentConnectedServiceMaterializationPhase } from './materializationPhase';

afterEach(() => vi.restoreAllMocks());

it('attributes nested credential work to its declared service without recording account material', async () => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const service = { pluginId: 'example.agent', localId: 'subscription', accountId: 'private-account' };
  await observeConnectedServiceMaterializationPhase({
    agentId: 'claude', materializationKey: 'service-attribution', service,
  }, 'native_home_credentials', async () => {
    await observeCurrentConnectedServiceMaterializationPhase('established_credential_read', async () => 'private-token');
  });
  const rows = log.mock.calls.map(([, fields]) => fields);
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row).toMatchObject({ service: { pluginId: service.pluginId, localId: service.localId } });
  }
  expect(JSON.stringify(rows)).not.toMatch(/private-account|accountId|private-token/);
});

it('correlates overlapping materializations and settles failed children without logging their payload', async () => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const first = { agentId: 'claude', materializationKey: 'first' };
  const second = { agentId: 'claude', materializationKey: 'second' };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error('secret-credential-in-error');
  const blocked = observeConnectedServiceMaterializationPhase(first, 'native_home_credentials', async () => {
    await pending;
    return await observeConnectedServiceMaterializationPhase(first, 'credential_read', async () => { throw failure; });
  });
  await observeConnectedServiceMaterializationPhase(second, 'native_home_credentials', async () => {
    await observeConnectedServiceMaterializationPhase(second, 'credential_read', async () => 'secret-result');
  });
  time = 75;
  release();
  await expect(blocked).rejects.toBe(failure);
  // File logging is an untyped system boundary; inspect only its record payloads.
  const rows = log.mock.calls.flatMap(([, fields]) => fields && typeof fields === 'object'
    ? [fields as Record<string, unknown>] : []);
  for (const context of [first, second]) {
    const outer = rows.find(row => row.materializationKey === context.materializationKey
      && row.phase === 'native_home_credentials' && row.status === 'started')!;
    const child = rows.find(row => row.materializationKey === context.materializationKey
      && row.phase === 'credential_read' && row.status === 'started')!;
    expect(child.parentPhaseId).toBe(outer.phaseId);
    expect(outer.parentPhaseId).toBeUndefined();
    const status = context === first ? 'failed' : 'completed';
    expect(rows).toContainEqual(expect.objectContaining({ phaseId: child.phaseId, status }));
    expect(rows).toContainEqual(expect.objectContaining({ phaseId: outer.phaseId, status,
      durationMs: context === first ? 75 : 0 }));
  }
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(['agentId', 'materializationKey', 'phase', 'phaseId', 'status', 'durationMs',
      ...(row.parentPhaseId ? ['parentPhaseId'] : [])].sort());
  }
  expect(JSON.stringify(rows)).not.toMatch(/secret-|Error|stack|token/);
  log.mockClear();
  await expect(observeCurrentConnectedServiceMaterializationPhase('credential_read', async () => 'unobserved-result'))
    .resolves.toBe('unobserved-result');
  await expect(observeCurrentConnectedServiceMaterializationPhase('credential_read', () => { throw failure; }))
    .rejects.toBe(failure);
  expect(log).not.toHaveBeenCalled();
});
