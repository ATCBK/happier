import { describe, expect, it } from 'vitest';
import { buildReviewUnits, buildScmChangeKeys, buildScmReviewScopeId, locateComparisonOccurrences } from './comparisonOccurrences.js';
import { parseUnifiedDiffHunks, revertHunks } from '../diff/hunks.js';
import { ScmComparisonSchema } from './comparison.js';

const patch = '@@ -1,5 +1,6 @@ fn\n head\n-old\n+new\n middle\n-tail\n+last\n+extra\n end\n';
describe('content-keyed review units', () => {
  it('splits change runs into independently reversible units and reverts both without context overlap', () => {
    const units = buildReviewUnits('src/a.ts', 'unstaged', patch);
    expect(units).toHaveLength(2);
    expect(units.map((unit) => [unit.hunkIndex, unit.runIndex])).toEqual([[0, 0], [0, 1]]);
    expect(revertHunks('head\nnew\nmiddle\nlast\nextra\nend\n', [units[0]!.hunk])).toEqual({ ok: true, text: 'head\nold\nmiddle\nlast\nextra\nend\n' });
    expect(revertHunks('head\nnew\nmiddle\nlast\nextra\nend\n', units.map((unit) => unit.hunk))).toEqual({ ok: true, text: 'head\nold\nmiddle\ntail\nend\n' });
    const single = '@@ -1,3 +1,3 @@\n a\n-old\n+new\n z\n';
    expect(buildReviewUnits('a', null, single)[0]!.hunk).toEqual(parseUnifiedDiffHunks(single)[0]);
  });
  it('keeps keys through shifts and unrelated context changes, but distinguishes text, paths, layers and identical ordinals', () => {
    const key = buildReviewUnits('src/a.ts', 'unstaged', patch)[0]!.key;
    const shifted = patch.replace('-1,5 +1,6', '-21,5 +21,6').replace(' head', ' other');
    expect(buildReviewUnits('src/a.ts', 'unstaged', shifted)[0]!.key).toBe(key);
    expect(buildReviewUnits('src/a.ts', 'unstaged', patch.replace('+new', '+NEW'))[0]!.key).not.toBe(key);
    expect(buildReviewUnits('src/b.ts', 'unstaged', patch)[0]!.key).not.toBe(key);
    expect(buildReviewUnits('src/a.ts', 'staged', patch)[0]!.key).not.toBe(key);
    const duplicated = '@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-old\n+new\n';
    expect(new Set(buildReviewUnits('a', null, duplicated).map((unit) => unit.key)).size).toBe(2);
    expect(buildReviewUnits('a', null, '@@ -1 +1 @@\n-old\n+new\n')[0]!.key).not.toBe(
      buildReviewUnits('a', null, '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n')[0]!.key);
  });
  it('keys the review scope by source selector rather than endpoint bytes', () => {
    const a = buildScmReviewScopeId({ repositoryRootPath: '/repo', source: { kind: 'session', sessionId: 'a' } });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(buildScmReviewScopeId({ repositoryRootPath: '/repo', source: { kind: 'session', sessionId: 'a' } })).toBe(a);
    expect(buildScmReviewScopeId({ repositoryRootPath: '/repo', source: { kind: 'session', sessionId: 'b' } })).not.toBe(a);
  });
  it('maps captured layered occurrences to the same run keys as displayed evidence without rewriting ids', () => {
    const section = '@@ -1 +1 @@\n-old\n+new\n';
    const comparison = ScmComparisonSchema.parse({ id: 'capture', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
      endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{ path: 'a', changeKind: 'modified', binary: false,
        generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: section + section },
        occurrences: ['staged', 'unstaged'].map((layer, position) => ({ id: `capture:${position}`, alias: `c${position}`, path: 'a', layer, position,
          before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } })),
      }] } });
    const keys = buildScmChangeKeys(comparison);
    expect(keys.get('capture:0')).toEqual(buildReviewUnits('a', 'staged', section).map((unit) => unit.key));
    expect(keys.get('capture:1')).toEqual(buildReviewUnits('a', 'unstaged', section).map((unit) => unit.key));
    const located = locateComparisonOccurrences(comparison);
    expect([...located.located].map(([id, entry]) => [id, entry.hunkIndex])).toEqual([['capture:0', 0], ['capture:1', 1]]);
    expect(located.hunksByPath.get('a')).toHaveLength(2);
  });
});
