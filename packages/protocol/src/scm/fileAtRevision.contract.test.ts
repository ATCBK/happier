import { describe, expect, it } from 'vitest';
import { SCM_GIT_ACTION_SPECS } from '../actions/scmGitActionSpecs.js';

describe('SCM file-at-revision Action contract', () => {
  it('admits only a pinned blob or before-side selector and preserves binary results', () => {
    const spec = SCM_GIT_ACTION_SPECS.find(spec => String(spec.id) === 'scm.file.read');
    expect(spec, 'the canonical SCM Action family must provide the base-revision read').toBeDefined();
    if (!spec) return;
    const request = { cwd: '/repo', path: 'logo.png', selector: { blobId: 'a'.repeat(40) }, maxBytes: 16 * 1024 * 1024 };
    expect(spec.inputSchema.parse(request)).toEqual(request);
    expect(spec.inputSchema.safeParse({ ...request, selector: { ...request.selector, side: 'before', area: 'both' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...request, selector: { side: 'after', area: 'both' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...request, offset: 1 }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...request, selector: { side: 'before', area: 'pending' } }).success).toBe(true);
    const reply = { success: true, contentBase64: 'AP8=', sizeBytes: 2, sha256: 'a'.repeat(64) };
    expect(spec.outputSchema.parse(reply)).toEqual(reply);
    expect(spec.outputSchema.safeParse({ success: false, errorCode: 'blob_unavailable' }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ success: false, errorCode: 'not_found', contentBase64: 'AP8=' }).success).toBe(false);
  });
});
