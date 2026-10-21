import { describe, expect, it } from 'vitest';
import { buildHomeConfigEnv } from '@/app/home/settings/homeConfigOverlay';
import { resolvePublicProfilePrerequisite } from './publicProfileContext';

describe('public-profile publication prerequisites', () => {
    it('uses admitted ingress and the same validated report contact for env and Home configuration', () => {
        const env = { HAPPIER_PUBLIC_SERVER_URL: 'http://localhost:3000/prefix' };
        expect(resolvePublicProfilePrerequisite(env)).toBe('report_contact_unconfigured');
        expect(resolvePublicProfilePrerequisite({ HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' })).toBe('public_ingress_unconfigured');
        expect(resolvePublicProfilePrerequisite({ ...env, HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'javascript:alert(1)' })).toBe('report_contact_unconfigured');
        expect(resolvePublicProfilePrerequisite(buildHomeConfigEnv({}, {
            HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test/prefix', HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test',
        }))).toBeNull();
    });
});
