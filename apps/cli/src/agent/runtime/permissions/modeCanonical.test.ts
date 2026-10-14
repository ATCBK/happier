import { describe, expect, it } from 'vitest';

import { normalizePermissionModeToIntent } from './modeCanonical';

describe('normalizePermissionModeToIntent', () => {
  it('maps acceptEdits to safe-yolo', () => {
    expect(normalizePermissionModeToIntent('acceptEdits')).toBe('safe-yolo');
  });

  it('maps bypassPermissions to yolo', () => {
    expect(normalizePermissionModeToIntent('bypassPermissions')).toBe('yolo');
  });

  it('maps ask to default', () => {
    expect(normalizePermissionModeToIntent('ask')).toBe('default');
  });

  it('returns null for non-strings', () => {
    expect(normalizePermissionModeToIntent(null)).toBe(null);
    expect(normalizePermissionModeToIntent(123)).toBe(null);
  });
});
