import { describe, expect, it } from 'vitest';

import { resolveNativeAgentLaunchEnvironment } from './launchEnvironment';

describe('resolveNativeAgentLaunchEnvironment', () => {
    it('inherits command lookup while keeping ambient credentials and host controls private', () => {
        expect(resolveNativeAgentLaunchEnvironment({
            processEnv: { PATH: '/usr/local/bin:/usr/bin:/bin', PATHEXT: '.EXE',
                ANTHROPIC_API_KEY: 'ambient-secret', HAPPIER_TOKEN: 'ambient-account-token',
                HAPPIER_SESSION_ATTACH_FILE: '/private/runner-attach' },
            environmentVariables: { PROFILE_SECRET: 'admitted-secret' },
            platform: 'linux',
        })).toEqual({ values: { PATH: '/usr/local/bin:/usr/bin:/bin', PROFILE_SECRET: 'admitted-secret' }, unset: [] });
    });

    it.each(['linux', 'darwin', 'win32'] as const)('preserves explicit empty PATH and explicit unsets on %s', platform => {
        const processEnv = { PATH: '/inherited', PATHEXT: '.EXE' };
        expect(resolveNativeAgentLaunchEnvironment({ processEnv, environmentVariables: { PATH: '' }, platform }).values.PATH).toBe('');
        const unset = resolveNativeAgentLaunchEnvironment({ processEnv, unsetEnvironmentVariables: ['PATH'], platform });
        expect(unset.values).not.toHaveProperty('PATH');
        expect(unset.unset).toEqual(['PATH']);
        expect(processEnv.PATH).toBe('/inherited');
    });

    it('uses Windows environment identity for inherited Path and PATHEXT plus explicit overrides', () => {
        expect(resolveNativeAgentLaunchEnvironment({
            processEnv: { Path: 'C:\\Windows\\System32;C:\\Tools', PathExt: '.CMD;.EXE',
                OPENAI_API_KEY: 'ambient-secret' },
            environmentVariables: { PATH: 'D:\\SelectedTools' },
            platform: 'win32',
        })).toEqual({ values: { PATH: 'D:\\SelectedTools', PathExt: '.CMD;.EXE' }, unset: [] });
    });
});
