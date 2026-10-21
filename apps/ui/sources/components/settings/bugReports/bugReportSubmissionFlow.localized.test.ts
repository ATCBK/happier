import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    });
});

import { getBugReportDraftFieldErrors, validateBugReportDraft } from './bugReportSubmissionFlow';

const input = {
    title: 'Crash on launch',
    summary: 'App freezes on startup after update',
    currentBehavior: '',
    expectedBehavior: '',
    reproductionStepsText: '',
    whatChangedRecently: '',
    frequency: 'often' as const,
    severity: 'high' as const,
    environment: { appVersion: '1.2.3', platform: 'ios', deploymentType: 'cloud' as const },
    includeDiagnostics: true,
    acceptedPrivacyNotice: true,
};

describe('bug report validation copy', () => {
    it('says every problem in the reader\'s language, through the translation owner', () => {
        expect(getBugReportDraftFieldErrors({ ...input, title: 'x', summary: 'y', acceptedPrivacyNotice: false })).toEqual({
            title: 'bugReports.composer.validation.titleTooShort:{"min":3}',
            summary: 'bugReports.composer.validation.summaryTooShort:{"min":3}',
        });
        expect(validateBugReportDraft({ ...input, title: 'x' })).toEqual({
            code: 'title',
            title: 'bugReports.composer.validation.missingTitle',
            message: 'bugReports.composer.validation.titleTooShort:{"min":3}',
        });
        expect(validateBugReportDraft({ ...input, summary: 'y' })).toMatchObject({
            code: 'details', title: 'bugReports.composer.validation.incompleteReport',
        });
        // The Action review is the only acknowledgement; an unticked notice is not a draft problem.
        expect(validateBugReportDraft({ ...input, acceptedPrivacyNotice: false })).toEqual({ code: 'ok' });
    });
});

describe('resolveBugReportOsVersion', () => {
    it('names the OS from the browser on web instead of the placeholder version React Native Web reports', async () => {
        const { resolveBugReportOsVersion } = await import('./bugReportComposerDraft');
        const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
        expect(resolveBugReportOsVersion({ os: 'web', version: '0.0.0', userAgent: mac })).toBe('macOS');
        expect(resolveBugReportOsVersion({ os: 'web', version: '0.0.0', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('Linux');
        expect(resolveBugReportOsVersion({ os: 'web', version: '0.0.0', userAgent: null })).toBe('');
        expect(resolveBugReportOsVersion({ os: 'ios', version: '18.2', userAgent: null })).toBe('18.2');
        expect(resolveBugReportOsVersion({ os: 'android', version: 35, userAgent: null })).toBe('35');
    });
});
