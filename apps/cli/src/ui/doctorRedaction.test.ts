import { describe, expect, it } from 'vitest';

import { redactDoctorDiagnosticValue, redactDoctorProcessCommandForDisplay } from './doctorRedaction';

describe('doctor diagnostic redaction', () => {
    it('applies canonical process privacy before additional Doctor diagnostic redaction', () => {
        const command = 'env TOKEN=ordinary" credential suffix" agent postgresql://alice:database-credential@example.test:5432/db --port=5173';
        const redacted = redactDoctorProcessCommandForDisplay(command);
        expect(redacted).not.toContain('credential');
        expect(redacted).not.toContain('alice');
        expect(redacted).toContain('example.test:5432/db');
        expect(redacted).toContain('--port=5173');
    });
    it('keeps argv boundaries while removing inline and URL credentials from structured process diagnostics', () => {
        const redacted = redactDoctorDiagnosticValue({ processArgv: ['env', 'TOKEN=ordinary credential suffix',
            'agent', 'postgresql://alice:database-credential@example.test:5432/db', 'public argument with spaces', '--port=5173'] });
        const serialized = JSON.stringify(redacted);
        expect(serialized).not.toMatch(/ordinary|credential|suffix|alice/);
        expect(redacted).toMatchObject({ processArgv: expect.arrayContaining(['public argument with spaces', '--port=5173']) });
        expect(serialized).toContain('example.test:5432/db');
    });
    it('uses the credential classifier without suppressing count and prose fields', () => {
        expect(redactDoctorDiagnosticValue({
            accessToken: 'doctor-access-secret',
            sessionId: 'doctor-session-secret',
            sessionCount: 3,
            tokenCount: 4,
            secretary: 'meeting-notes',
        })).toEqual({
            accessToken: '<redacted>',
            sessionId: '<redacted>',
            sessionCount: 3,
            tokenCount: 4,
            secretary: 'meeting-notes',
        });
    });

    it('removes native-auth secrets from captured process argv', () => {
        const value = redactDoctorDiagnosticValue({
            processArgv: [
                'happier', 'auth', 'password', 'enroll',
                '--password', 'doctor-password-value',
                '--verification-token=doctor-verification-value',
                '--reauth-proof-json', 'doctor-proof-value',
                '--invitation-token', 'doctor-invitation-value',
            ],
        });
        const serialized = JSON.stringify(value);
        expect(serialized).not.toContain('doctor-password-value');
        expect(serialized).not.toContain('doctor-verification-value');
        expect(serialized).not.toContain('doctor-proof-value');
        expect(serialized).not.toContain('doctor-invitation-value');
    });
});
