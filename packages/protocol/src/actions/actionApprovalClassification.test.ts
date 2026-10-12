import { describe, expect, it } from 'vitest';

import { ACTION_IDS, type ActionId } from './actionIds.js';
import { DIAGNOSTICS_ACTION_IDS } from './diagnosticsActionFamily.js';
import { ActionApprovalSchema, resolveActionApprovalFlow } from './actionApprovalMetadata.js';
import { resolveApprovalMetadataForActionId } from './actionApprovalClassification.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

type RequireAuthoredAction<T extends PreNormalizedActionSpec> = T;
// @ts-expect-error An authored Action without approval metadata must fail compilation.
type MissingApprovalMustFail = RequireAuthoredAction<Omit<PreNormalizedActionSpec, 'approval'>>;

describe('Action approval metadata completeness', () => {
  it('reads valid declaration-owned approval metadata for every ActionId', () => {
    const missing = ACTION_IDS.filter((id) => {
      try {
        const approval = resolveApprovalMetadataForActionId(id);
        return !ActionApprovalSchema.safeParse(approval).success;
      } catch {
        return true;
      }
    });
    expect(missing, `Missing or invalid approval metadata: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps diagnostics result-required and blocking like other sanitized reads', () => {
    for (const id of DIAGNOSTICS_ACTION_IDS) {
      const approval = resolveApprovalMetadataForActionId(id);
      expect(approval.result, id).toBe('required');
      expect(resolveActionApprovalFlow(approval), id).toBe('blocking');
    }
  });

  it('fails closed for an unclassified id rather than granting a fallback approval class', () => {
    // Invalid external vocabulary must not acquire metadata through a default.
    expect(() => resolveApprovalMetadataForActionId('diagnostics.doctor.raw' as ActionId))
      .toThrow('Unknown action spec: diagnostics.doctor.raw');
  });
});
