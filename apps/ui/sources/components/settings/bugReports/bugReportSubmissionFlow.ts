import { appendBugReportReporterToSummary } from '@happier-dev/protocol/bugs/reports/reporter';
import type { BugReportFormPayload } from '@happier-dev/protocol/bugs/reports/types';
import type { BugReportDraftInput } from '@happier-dev/protocol/actions/specs/bugReport';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { normalizeReproductionSteps } from './bugReportFallback';
import type { BugReportsFeature } from './bugReportFeatureDefaults';
import type { BugReportDiagnosticsArtifact } from './bugReportDiagnostics';

export type BugReportComposerSubmissionInput = BugReportDraftInput;

export type BugReportDraftValidation =
    | { code: 'ok' }
    | { code: 'title'; title: string; message: string }
    | { code: 'details'; title: string; message: string }
    | { code: 'privacy'; title: string; message: string };

export type BugReportSubmissionOutcome =
    | { mode: 'fallback' }
    | {
        mode: 'submitted';
        reportId: string;
        issueNumber: number;
        issueUrl: string;
        artifactCount: number;
    };

function toOptionalValue(raw: string | undefined): string | undefined {
    const value = String(raw ?? '').trim();
    return value.length > 0 ? value : undefined;
}

function buildBugReportForm(input: BugReportComposerSubmissionInput): BugReportFormPayload {
    const acceptedPrivacyNotice = input.includeDiagnostics ? input.acceptedPrivacyNotice : true;
    const normalizedRepro = normalizeReproductionSteps(input.reproductionStepsText);
    return {
        title: input.title.trim(),
        summary: appendBugReportReporterToSummary(input.summary, input.reporterGithubUsername),
        currentBehavior: toOptionalValue(input.currentBehavior),
        expectedBehavior: toOptionalValue(input.expectedBehavior),
        reproductionSteps: normalizedRepro.length > 0 ? normalizedRepro : undefined,
        frequency: input.frequency,
        severity: input.severity,
        whatChangedRecently: toOptionalValue(input.whatChangedRecently),
        environment: {
            ...input.environment,
            appVersion: input.environment.appVersion.trim() || 'unknown',
            platform: input.environment.platform.trim() || 'unknown',
            osVersion: toOptionalValue(input.environment.osVersion),
            deviceModel: toOptionalValue(input.environment.deviceModel),
            serverUrl: toOptionalValue(input.environment.serverUrl),
            serverVersion: toOptionalValue(input.environment.serverVersion),
        },
        consent: {
            includeDiagnostics: input.includeDiagnostics,
            acceptedPrivacyNotice,
        },
    };
}

const BUG_REPORT_TITLE_MIN_CHARS = 3;
const BUG_REPORT_SUMMARY_MIN_CHARS = 3;

export type BugReportDraftField = 'title' | 'summary' | 'privacy';
export type BugReportDraftFieldErrors = Partial<Record<BugReportDraftField, string>>;

export function getBugReportDraftFieldErrors(input: BugReportComposerSubmissionInput): BugReportDraftFieldErrors {
    const errors: BugReportDraftFieldErrors = {};

    if (input.title.trim().length < BUG_REPORT_TITLE_MIN_CHARS) {
        errors.title = t('bugReports.composer.validation.titleTooShort', { min: BUG_REPORT_TITLE_MIN_CHARS });
    }
    if (input.summary.trim().length < BUG_REPORT_SUMMARY_MIN_CHARS) {
        errors.summary = t('bugReports.composer.validation.summaryTooShort', { min: BUG_REPORT_SUMMARY_MIN_CHARS });
    }
    return errors;
}

export function validateBugReportDraft(input: BugReportComposerSubmissionInput): BugReportDraftValidation {
    const errors = getBugReportDraftFieldErrors(input);

    if (errors.title) {
        return {
            code: 'title',
            title: t('bugReports.composer.validation.missingTitle'),
            message: errors.title,
        };
    }
    if (errors.summary) {
        return {
            code: 'details',
            title: t('bugReports.composer.validation.incompleteReport'),
            message: errors.summary,
        };
    }
    return { code: 'ok' };
}

/**
 * What the line beside Submit says: nothing when the report can be sent; a neutral "complete the
 * required fields" while the person has not started (diagnostics are on by default, so only the text
 * counts); the first concrete problem once they have.
 */
export function resolveBugReportSubmitHint(input: BugReportComposerSubmissionInput): 'required' | 'problem' | null {
    if (validateBugReportDraft(input).code === 'ok') return null;
    const started = input.title.trim().length > 0 || input.summary.trim().length > 0;
    return started ? 'problem' : 'required';
}

export async function submitBugReportFromDraft(input: {
    feature: BugReportsFeature;
    machines: Machine[];
    input: BugReportComposerSubmissionInput;
    issueOwner: string;
    issueRepo: string;
    existingIssueNumber?: number;
    openFallbackIssue: (environment: BugReportComposerSubmissionInput['environment']) => Promise<void>;
    collectDiagnosticsArtifacts: (input: {
        machines: Machine[];
        includeDiagnostics: boolean;
        acceptedKinds: string[];
        maxArtifactBytes: number;
        contextWindowMs?: number;
    }) => Promise<{ artifacts: BugReportDiagnosticsArtifact[] }>;
    submitBugReport: (input: {
        providerUrl: string;
        timeoutMs: number;
        form: BugReportFormPayload;
        artifacts: BugReportDiagnosticsArtifact[];
        maxArtifactBytes?: number;
        issueOwner: string;
        issueRepo: string;
        existingIssueNumber?: number;
    }) => Promise<{ reportId: string; issueNumber: number; issueUrl: string }>;
}): Promise<BugReportSubmissionOutcome> {
    if (!input.feature.enabled || !input.feature.providerUrl) {
        await input.openFallbackIssue(input.input.environment);
        return { mode: 'fallback' };
    }

    const overrideKinds = Array.isArray(input.input.diagnosticsKinds) ? input.input.diagnosticsKinds : null;
    const acceptedKinds = overrideKinds
        ? overrideKinds.filter((kind) => input.feature.acceptedArtifactKinds.includes(kind))
        : input.feature.acceptedArtifactKinds;
    const includeDiagnostics = input.input.includeDiagnostics && acceptedKinds.length > 0;
    const diagnostics = includeDiagnostics
        ? await input.collectDiagnosticsArtifacts({
            machines: input.machines,
            includeDiagnostics,
            acceptedKinds,
            maxArtifactBytes: input.feature.maxArtifactBytes,
            contextWindowMs: input.feature.contextWindowMs,
        })
        : { artifacts: [] };

    const submitted = await input.submitBugReport({
        providerUrl: input.feature.providerUrl,
        timeoutMs: input.feature.uploadTimeoutMs,
        form: buildBugReportForm({ ...input.input, includeDiagnostics }),
        artifacts: diagnostics.artifacts,
        maxArtifactBytes: input.feature.maxArtifactBytes,
        issueOwner: input.issueOwner,
        issueRepo: input.issueRepo,
        existingIssueNumber: input.existingIssueNumber,
    });

    return {
        mode: 'submitted',
        reportId: submitted.reportId,
        issueNumber: submitted.issueNumber,
        issueUrl: submitted.issueUrl,
        artifactCount: diagnostics.artifacts.length,
    };
}
