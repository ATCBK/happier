import { describe, expect, it } from 'vitest';
import { LocalSettingsSchema, localSettingsDefaults } from '../../localSettings';

describe('file local settings', () => {
    it('retains valid recent paths when reading partially malformed persisted settings', () => {
        const parsed = LocalSettingsSchema.parse({ ...localSettingsDefaults,
            recentWorkspaceFilesV1: { workspace: ['src/a.ts', 42, 'src/a.ts'], future: true } });
        expect(Reflect.get(parsed, 'recentWorkspaceFilesV1')).toEqual({ workspace: ['src/a.ts'] });
    });
});
