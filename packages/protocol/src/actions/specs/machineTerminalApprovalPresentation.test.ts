import { describe, expect, it } from 'vitest';
import { describeApprovalActionFields } from '../actionApprovalPresentation.js';
import { buildApprovalPreviewSummary } from '../actionExecutor.js';
import { getActionSpec } from '../actionSpecs.js';

const open = {
  serverId: 'home-1', machineId: 'machine-1', terminalKey: 'workspace:pane:4f8c1e2a-77b0-4c1d-9d0e-1c2f3a4b5c6d',
  cwd: '/home/dev/projects/hello-world', sessionId: 'session-1',
};

describe('machine terminal approval presentation', () => {
  it('describes what will happen in plain words, without Action internals or raw keys', () => {
    const summary = buildApprovalPreviewSummary(getActionSpec('machines.terminal.open'), open);
    expect(summary).toContain('hello-world');
    expect(summary).not.toMatch(/PTY|custody|requester-owned|canonical|workspace:pane/i);
    expect(buildApprovalPreviewSummary(getActionSpec('machines.terminal.close'), { serverId: 'home-1', machineId: 'machine-1', terminalId: 't-1' }))
      .toMatch(/close/i);
  });

  it('keeps the raw Terminal key out of Details and names the Machine', () => {
    const { rows } = describeApprovalActionFields({ actionId: 'machines.terminal.open', actionArgs: open });
    const key = rows.find((row) => row.path === 'terminalKey');
    expect(key).toMatchObject({ kind: 'value', technical: true });
    expect(rows.find((row) => row.path === 'machineId')).toMatchObject({ kind: 'value', reference: { kind: 'machine', id: 'machine-1' } });
  });
});
