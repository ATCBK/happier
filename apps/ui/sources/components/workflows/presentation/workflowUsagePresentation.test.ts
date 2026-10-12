import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { formatMachineDuration } from '@/components/machines/durationWords';
import { formatWorkflowInvocationElapsedLabel, formatWorkflowUsageLabel } from './workflowUsagePresentation';

describe('formatWorkflowInvocationElapsedLabel', () => {
    it('reports short completed durations without fabricating historical or unfinished timing', () => {
        const startedAt = '2026-10-11T20:54:03.018Z';
        expect(formatWorkflowInvocationElapsedLabel({ startedAt, finishedAt: '2026-10-11T20:54:57.085Z' }))
            .toBe(t('tools.common.elapsedSeconds', { seconds: '54' }));
        expect(formatWorkflowInvocationElapsedLabel({ startedAt, finishedAt: startedAt }))
            .toBe(t('tools.common.elapsedSeconds', { seconds: '0' }));
        expect(formatWorkflowInvocationElapsedLabel({ startedAt, finishedAt: '2026-10-11T20:56:03.018Z' }))
            .toBe(formatMachineDuration(120_000));
        expect(formatWorkflowInvocationElapsedLabel(undefined)).toBeNull();
        expect(formatWorkflowInvocationElapsedLabel({ startedAt })).toBeNull();
        expect(formatWorkflowInvocationElapsedLabel({ startedAt, finishedAt: 'invalid' })).toBeNull();
        expect(formatWorkflowInvocationElapsedLabel({ startedAt, finishedAt: '2026-10-11T20:54:02.018Z' })).toBeNull();
    });
});

describe('formatWorkflowUsageLabel', () => {
    it('uses the incumbent locale-aware token and currency formatters', () => {
        expect(formatWorkflowUsageLabel({
            inputTokens: 120,
            outputTokens: 30,
            costUsd: 0.04,
        }, { tokens: 'Tokens', input: 'Input', output: 'Output' })).toBe(`150 Tokens · ${new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 4,
        }).format(0.04)}`);
    });

    it('does not invent zero-valued dimensions when usage is unavailable', () => {
        const labels = { tokens: 'Tokens', input: 'Input', output: 'Output' };
        expect(formatWorkflowUsageLabel({}, labels)).toBeNull();
        expect(formatWorkflowUsageLabel({ inputTokens: 120 }, labels)).toBe('120 Tokens · Input');
        expect(formatWorkflowUsageLabel({ outputTokens: 30 }, labels)).toBe('30 Tokens · Output');
    });
});
