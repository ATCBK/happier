import assert from 'node:assert/strict';
import test from 'node:test';
import { readCurrentUiActionParity } from './validateUiActionParity.ts';
import { listActionSpecsForCatalogSurface } from '../../packages/protocol/src/actions/actionCatalog.ts';
import { MachineGuardActivityWayBackV1Schema } from '../../packages/protocol/src/machines/guard/activityV1.ts';
import { buildGuardStopWarningPushDataV1, readGuardStopWarningPushActionV1 } from '../../packages/protocol/src/activity/webhookPayload.ts';

const report = readCurrentUiActionParity();

// Filesystem/source analysis belongs to the Node tooling harness, not a loaded UI worker.
test('maps current UI Action invocations, registrations and settings mutations to agent-visible canonical specs', () => {
  assert.ok(report.actions.length > 0);
  assert.ok(report.settings.length > 0);
  assert.deepEqual(report.findings.map(finding => `${finding.filePath}:${finding.line} ${finding.code}: ${finding.operation}`), []);
});

test('machine resources UI intents map to canonical agent and MCP specs (AGW-1)', () => {
  // Same source walker and settings admission as the global check, not a second
  // inventory. Include the header terminal's existing admission adapter.
  const owns = (path: string) => /^apps\/ui\/sources\/(components\/machines\/|components\/approvals\/resourceProposal\/|sync\/domains\/machines\/(resources|storage|processes|guard)\/)/.test(path)
    || [
      'apps/ui/sources/hooks/machine/useMachineTerminalActionAdmission.ts',
      'apps/ui/sources/components/navigation/shell/appRail/AppRailMachines.tsx',
      'apps/ui/sources/components/navigation/shell/appRail/useMachinesRailSignal.ts',
      'apps/ui/sources/components/navigation/shell/sidebarFooter/SidebarMachinesPopoverContent.tsx',
      'apps/ui/sources/components/navigation/shell/sidebarFooter/MachinesPopoverAttention.tsx',
      'apps/ui/sources/activity/notifications/guardStopWarningLifecycle.ts',
    ].includes(path);
  const actions = report.actions.filter(site => owns(site.filePath));
  const findings = report.findings.filter(site => owns(site.filePath));
  assert.deepEqual(findings, []);
  for (const surface of ['agent', 'mcp'] as const) {
    const catalog = new Set<string>(listActionSpecsForCatalogSurface({ surface }).map(spec => spec.id));
    assert.deepEqual(actions.filter(site => !catalog.has(site.actionId)), []);
    // R44: local clipboard use is exempt; the agent equivalent already exists.
    assert.ok(catalog.has('clipboard.write'));
  }
  // Later additions at their actual dispatch owners: header Open terminal,
  // offline Notify consent, scan shortcuts, recipient Storage entries and Undo.
  for (const [suffix, actionId] of [
    ['hooks/machine/useMachineTerminalActionAdmission.ts', 'machines.terminal.open'],
    ['resources/useMachineOfflineAlert.ts', 'settings.set'],
    ['storage/machineRpc.ts', 'machines.storage.scan.start'],
    ['storage/machineRpc.ts', 'machines.storage.pile.set'],
    ['storage/machineRpc.ts', 'machines.storage.items.check'],
    ['storage/machineRpc.ts', 'machines.storage.trash.move'],
    ['storage/machineRpc.ts', 'machines.storage.trash.empty'],
    ['guard/machineGuardRpc.ts', 'machines.guard.activity.undo'],
    ['sidebarFooter/MachinesPopoverAttention.tsx', 'machines.guard.activity.undo'],
  ]) assert.ok(actions.some(site => site.filePath.endsWith(suffix) && site.actionId === actionId), `${suffix}: ${actionId}`);
  // These dispatchers forward closed owner-produced references. Check the real
  // push producer/reader so their canonical walker exclusions do not hide ids
  // absent from the agent or MCP catalog.
  for (const warning of [
    { topic: 'guard_stop_warning', machineId: 'machine', sessionId: 'session', rule: 'idle_sessions', stopAt: 300_000 },
    { topic: 'guard_stop_warning', machineId: 'machine', terminalId: 'terminal', terminalKey: 'shell', rule: 'idle_terminals', stopAt: 300_000 },
  ] as const) {
    const push = buildGuardStopWarningPushDataV1(warning);
    for (const action of ['keepRunning', 'stopNow'] as const) {
      const admitted = readGuardStopWarningPushActionV1(push, action, { serverId: 'home' });
      assert.ok(admitted);
      for (const surface of ['agent', 'mcp'] as const) {
        assert.ok(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === admitted.actionId));
      }
    }
    assert.equal(readGuardStopWarningPushActionV1({ ...push, actions: { ...push.actions,
      stopNow: { actionId: 'machines.guard.unmappedIntent', input: {} } } }, 'stopNow', { serverId: 'home' }), null);
  }
  for (const actionId of ['machines.storage.trash.empty', 'machines.storage.unmappedIntent']) {
    assert.equal(MachineGuardActivityWayBackV1Schema.safeParse({ label: 'empty_now', actionId, input: {} }).success,
      actionId === 'machines.storage.trash.empty');
  }
});
