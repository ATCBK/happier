import { describe, expect, it } from 'vitest';

import { readTriageTaskProgressV1 } from './rows.js';

const text = (_key: string, fallback: string, params?: Readonly<Record<string, string | number>>) =>
  fallback.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''));
const ref = { source: { pluginId: 'acme.tracker', localId: 'issues' }, kindId: 'issue', collisionScope: 'acme', entryId: '7' };

describe('a task row\'s Progress hint', () => {
  it('leads with a blocker, then sub-tasks done, then the parent, and says nothing when relations were not read', () => {
    expect(readTriageTaskProgressV1({ blockedBy: [ref], children: { total: 5, completed: 3 } }, text)).toBe('Blocked');
    expect(readTriageTaskProgressV1({ children: { total: 5, completed: 3 } }, text)).toBe('3 of 5');
    expect(readTriageTaskProgressV1({ children: { total: 4 } }, text)).toBe('4 sub-tasks');
    expect(readTriageTaskProgressV1({ parent: ref }, text)).toBe('Sub-task');
    expect(readTriageTaskProgressV1({}, text)).toBeNull();
    expect(readTriageTaskProgressV1(null, text)).toBeNull();
  });
});
