import { describe, expect, it, vi } from 'vitest';
import type { InputTypePickerHostV1 } from '@happier-dev/protocol/inputs/runtime';
import { USAGE_QUERY_INPUT_FIELDS } from '@happier-dev/protocol/inputs/usageQuery';
import { createHostInputTypePickerForm, describeHostInputTypePickerValue } from './hostInputTypePickerForm';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const nowMs = Date.parse('2026-10-09T00:30:00Z');
function request(field: 'period' | 'session', value: Parameters<NonNullable<InputTypePickerHostV1['openHostPicker']>>[0]['value']) {
    return { reference: { hostType: 'usageQuery' as const, field }, fields: USAGE_QUERY_INPUT_FIELDS,
        value, signal: new AbortController().signal };
}

describe('host input type picker forms', () => {
    it('offers relative period choices and retains a saved absolute range unchanged until selection', async () => {
        const saved = { startMs: 100, endMs: 200 };
        const picker = createHostInputTypePickerForm({ request: request('period', saved), serverId: 'home',
            draftInput: { timeZoneOffsetMinutes: 120, metric: 'cost' }, nowMs });
        expect(picker.form.getInput()).toEqual({ value: saved });
        const field = picker.form.getFields()[0]!;
        expect(field.widget).toBe('select');
        const today = field.options!.find(option => option.label === 'usage.today')!;
        expect(today.value).toEqual({ relative: 'today' });
        picker.form.replaceInput({ value: today.value });
        expect(await picker.form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true } });
        expect(await picker.result).toEqual({ kind: 'completed', input: today.value });
    });

    it('labels a relative pin by its canonical period name without guessing an absolute range identity', () => {
        expect(describeHostInputTypePickerValue(request('period', undefined).reference, { relative: '7days' })).toBe('usage.last7Days');
        expect(describeHostInputTypePickerValue(request('period', undefined).reference, { startMs: 100, endMs: 200 })).not.toBe('usage.last7Days');
    });

    it('uses the incumbent qualified Session inventory and projects only ids from the captured Home', async () => {
        const picker = createHostInputTypePickerForm({ request: request('session', ['saved']), serverId: 'home', nowMs });
        expect(picker.form.getInput()).toEqual({ value: [{ serverId: 'home', sessionId: 'saved' }] });
        expect(picker.form.getFields()[0]).toMatchObject({ widget: 'multiselect', optionsSourceId: 'sessions' });
        picker.form.replaceInput({ value: [{ serverId: 'other', sessionId: 'spoof' }] });
        expect(await picker.form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: false } });
        picker.form.replaceInput({ value: [{ serverId: 'home', sessionId: 'two' }, { serverId: 'home', sessionId: 'one' }] });
        expect(await picker.form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true } });
        expect(await picker.result).toEqual({ kind: 'completed', input: ['one', 'two'] });
        const all = createHostInputTypePickerForm({ request: request('session', null), serverId: 'home', nowMs });
        expect(await all.form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true } });
        expect(await all.result).toEqual({ kind: 'completed', input: null });
    });

    it('cancels without changing a retained field after caller cancellation or dismissal', async () => {
        const abort = new AbortController();
        const picker = createHostInputTypePickerForm({ request: { ...request('period', { startMs: 100 }), signal: abort.signal },
            serverId: 'home', nowMs });
        abort.abort();
        expect(await picker.result).toEqual({ kind: 'cancelled' });
        expect(await picker.form.submit()).toMatchObject({ kind: 'stale' });
        const dismissed = createHostInputTypePickerForm({ request: request('session', ['saved']), serverId: 'home', nowMs });
        dismissed.form.cancel();
        expect(await dismissed.result).toEqual({ kind: 'cancelled' });
    });
});
