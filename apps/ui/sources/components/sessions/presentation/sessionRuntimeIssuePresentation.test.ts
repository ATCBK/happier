import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    AGENT_STARTUP_FAILURE_PREVIEWS,
    SESSION_PREPARATION_FAILURE_PREVIEWS,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { resolveSessionStartFailureNotice } from '@/components/sessions/startFailure/sessionStartFailureNotice';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnNewAction';
import { SUPPORTED_LANGUAGE_CODES, preloadTranslations, setPreferredLanguageFromSettings } from '@/text';

import { presentSessionRuntimeIssue } from './sessionRuntimeIssuePresentation';

const KNOWN_CODE = 'native_agent_privileged_effect_authority_unavailable';
const ENGLISH_PREVIEW = SESSION_PREPARATION_FAILURE_PREVIEWS[KNOWN_CODE];
const CLOSED_CODES = [
    ...Object.keys(SESSION_PREPARATION_FAILURE_PREVIEWS),
    ...Object.keys(AGENT_STARTUP_FAILURE_PREVIEWS),
];

function issue(overrides: Partial<SessionRuntimeIssueV1>): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: KNOWN_CODE,
        source: 'dependency_failure',
        occurredAt: 1_700_000_000_000,
        sanitizedPreview: ENGLISH_PREVIEW,
        ...overrides,
    };
}

async function useLanguage(language: string): Promise<void> {
    await preloadTranslations(language as never);
    setPreferredLanguageFromSettings(language);
}

describe('closed startup-failure recovery copy', () => {
    beforeAll(async () => {
        await Promise.all(SUPPORTED_LANGUAGE_CODES.map(language => preloadTranslations(language)));
    });
    afterEach(() => setPreferredLanguageFromSettings('en'));

    it('presents a stored English cause in the active locale through the Session banner and the composer failure', async () => {
        await useLanguage('fr');
        const stored = issue({});

        const body = presentSessionRuntimeIssue(stored).message;
        expect(body).toBeTruthy();
        expect(body).not.toBe(ENGLISH_PREVIEW);
        expect(resolveSessionStartFailureNotice({ issue: stored, sessionActive: false })?.message).toBe(body);

        const composer = resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: KNOWN_CODE, message: 'Runner exited before startup completed' },
        });
        expect(composer).toContain(body!);
        expect(composer).toContain(KNOWN_CODE);
        expect(composer).not.toContain(ENGLISH_PREVIEW);
    });

    it('localizes a known cause even when the stored issue kept no preview', async () => {
        await useLanguage('de');
        const { sanitizedPreview: _stored, ...withoutPreview } = issue({});
        const body = presentSessionRuntimeIssue(withoutPreview as SessionRuntimeIssueV1).message;
        expect(body).toBeTruthy();
        expect(body).not.toBe(ENGLISH_PREVIEW);
    });

    it('reads every closed code in every authored locale without falling back to the English diagnostic', async () => {
        for (const language of SUPPORTED_LANGUAGE_CODES.filter(code => code !== 'en')) {
            await useLanguage(language);
            for (const code of CLOSED_CODES) {
                const body = presentSessionRuntimeIssue(issue({ code })).message;
                expect(body, `${language}:${code}`).toBeTruthy();
                expect(body, `${language}:${code}`).not.toBe(
                    (SESSION_PREPARATION_FAILURE_PREVIEWS as Record<string, string>)[code]
                    ?? (AGENT_STARTUP_FAILURE_PREVIEWS as Record<string, string>)[code],
                );
            }
        }
    });

    it('keeps the stored cause for an unknown code and never names private text in the composer', async () => {
        await useLanguage('fr');
        expect(presentSessionRuntimeIssue(issue({ code: 'agent_session_error', sanitizedPreview: 'Agent session failed' })).message)
            .toBe('Agent session failed');
        expect(presentSessionRuntimeIssue(issue({ code: 'agent_session_error', sanitizedPreview: undefined })).message).toBeNull();
        const unknown = resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: 'daemon_private_cause', message: 'private detail' },
        });
        expect(unknown).toContain('spawn_failed');
        expect(unknown).not.toContain('daemon_private_cause');
        expect(unknown).not.toContain('private detail');
    });
});
