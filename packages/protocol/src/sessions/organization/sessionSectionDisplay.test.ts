import { describe, expect, it } from 'vitest';
import * as folders from './folders.js';

describe('Section display projection', () => {
  it('orders fractional keys lexically so a prepended section remains before the first section', () => {
    expect(folders.compareSessionSectionOrderV1({ sectionId: 'first', sortKey: 'Zz' }, { sectionId: 'second', sortKey: 'a0' })).toBeLessThan(0);
    expect(folders.compareSessionSectionOrderV1({ sectionId: 'unarranged', sortKey: null }, { sectionId: 'second', sortKey: 'a0' })).toBeGreaterThan(0);
  });
  it('opens retained display shapes and preserves locked evidence', () => {
    expect(folders.readSessionSectionDisplayV1({ status: 'available', value: 'Legacy' })).toEqual({ status: 'available', value: { name: 'Legacy', icon: null } });
    expect(folders.readSessionSectionDisplayV1({ status: 'available', value: { name: 'Launch', workspace: { machineId: 'm', path: '/x' } } })).toEqual({ status: 'available', value: { name: 'Launch', icon: null } });
    expect(folders.readSessionSectionDisplayV1({ status: 'locked', reason: 'storage_mode_mismatch' })).toEqual({ status: 'locked', reason: 'storage_mode_mismatch' });
    expect(folders.readSessionSectionDisplayV1({ status: 'available', value: null })).toEqual({ status: 'locked', reason: 'invalid_stored_display' });
  });
});
