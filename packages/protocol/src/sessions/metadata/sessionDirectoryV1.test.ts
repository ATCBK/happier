import { describe, expect, it, vi } from 'vitest';
import { readSessionDirectoryKind, SessionDirectoryV1Schema, SessionDirectoryV1ReadSchema } from './sessionDirectoryV1.js';

describe('session directory classification', () => {
  it('does not construct parse failures for ordinary path sessions without a directory marker', () => {
    const parse = vi.spyOn(SessionDirectoryV1ReadSchema, 'safeParse');
    try {
      for (let index = 0; index < 20; index += 1) {
        expect(readSessionDirectoryKind({ path: '/project' })).toBe('path');
        expect(readSessionDirectoryKind({ sessionDirectoryV1: null })).toBe('path');
      }
      expect(parse).not.toHaveBeenCalled();
      expect(readSessionDirectoryKind({ sessionDirectoryV1: { v: 1, kind: 'managed', futureField: true } })).toBe('managed');
      expect(readSessionDirectoryKind({ sessionDirectoryV1: { v: 2, kind: 'managed' } })).toBe('path');
    } finally { parse.mockRestore(); }
  });
  it('classifies known persisted marker fields while keeping marker inputs strict', () => {
    const read = readSessionDirectoryKind;
    expect(read({ path: '/Users/alice/project', machineId: 'machine-1' })).toBe('path');
    expect(read({ path: '/private/allocation', sessionDirectoryV1: { v: 1, kind: 'managed' } })).toBe('managed');
    const additiveMarker = { v: 1, kind: 'managed', path: '/fake' };
    expect(read({ sessionDirectoryV1: additiveMarker })).toBe('managed');
    expect(SessionDirectoryV1Schema.safeParse(additiveMarker).success).toBe(false);
    for (const marker of [null, { v: 2, kind: 'managed' }, { v: 1, kind: 'path' }]) {
      expect(read({ sessionDirectoryV1: marker })).toBe('path');
    }
    expect(read(null)).toBe('path');
  });
});
