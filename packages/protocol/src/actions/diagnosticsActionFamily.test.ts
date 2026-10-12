import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { DiagnosticsActionInputSchemas, DiagnosticsActionOutputSchemas } from './diagnosticsActionFamily.js';

describe('diagnostic Action input admission', () => {
  it('publishes result-bearing diagnostic reads through the canonical catalog', () => {
    for (const id of ['diagnostics.diagnosis.run', 'diagnostics.daemons.check', 'diagnostics.status.get'] as const) {
      const spec = getActionSpec(id);
      expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', approval: { result: 'required' } });
      for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
        const args = { actionId: id, spec, context: { surface, authority: 'account_automation' as const } };
        expect(resolveActionApprovalRouting(args)).toEqual({ required: false, flow: 'blocking', result: 'required' });
        expect(resolveActionApprovalRouting({
          ...args, settings: { v: 1, actions: { [id]: { approvalRequiredSurfaces: [surface] } } },
        }).required).toBe(true);
      }
    }
  });

  it('admits the diagnosis, daemon-check and diagnostic-export intents through the closed Action vocabulary', () => {
    for (const id of ['diagnostics.diagnosis.run', 'diagnostics.daemons.check', 'diagnostics.status.get']) {
      const admitted = ActionIdSchema.safeParse(id);
      expect(admitted.success, id).toBe(true);
    }
    expect(ActionIdSchema.safeParse('diagnostics.doctor.raw').success).toBe(false);
  });
  it('keeps diagnostic results closed and cannot return a native doctor payload beside findings', () => {
    const input = DiagnosticsActionInputSchemas['diagnostics.diagnosis.run'];
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ accountId: 'other-account' }).success).toBe(false);
    const report = { capturedAt: '2026-10-12T10:00:00Z', findings: [{ code: 'server.http_error', severity: 'error', details: { httpStatus: 503 } }] };
    const output = DiagnosticsActionOutputSchemas['diagnostics.diagnosis.run'];
    expect(output.safeParse({ status: 'completed', report }).success).toBe(true);
    expect(output.safeParse({ status: 'completed', report, doctorSnapshot: { accountId: 'private' } }).success).toBe(false);
    expect(output.safeParse({ status: 'completed', report: { ...report, findings: [{ ...report.findings[0], details: { token: 'private' } }] } }).success).toBe(false);
  });
});
