import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_ATMOSPHERE, HomeAtmosphereSchema, ProjectAtmosphereSchema } from './homeAtmosphere.js';
import { accountSettingsParse } from './accountSettings.js';

describe('Home atmosphere Fade contract', () => {
    it('admits the dissolve style and rejects numeric fade on Home and Project writes', () => {
        const value = { ...DEFAULT_HOME_ATMOSPHERE, looks: { sky: { dissolve: 'rows' } } };
        expect(HomeAtmosphereSchema.safeParse(value).success).toBe(true);
        const { moments: _moments, ...project } = value;
        expect(ProjectAtmosphereSchema.safeParse(project).success).toBe(true);
        const numeric = { sky: { fade: 0.55 } };
        expect(HomeAtmosphereSchema.safeParse({ ...value, looks: numeric }).success).toBe(false);
        expect(ProjectAtmosphereSchema.safeParse({ ...project, looks: numeric }).success).toBe(false);
    });
    it('drops the undeployed numeric field on stored reads while keeping authored dissolve and other choices', () => {
        const value = { ...DEFAULT_HOME_ATMOSPHERE, looks: { sky: { dissolve: 'rows', strength: 0.7 } } };
        expect(accountSettingsParse({ homeAtmosphere: { ...value, looks: { sky: { ...value.looks.sky, fade: 0.55 } } } }).homeAtmosphere).toEqual(value);
    });
});
