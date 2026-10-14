import { describe, expect, it } from 'vitest';
import type { InputFieldHint } from '@happier-dev/protocol/inputs';
import type { WidgetBindingResolutionV1 } from '@happier-dev/protocol/widgets';

import {
    describeWidgetSetupBlocker,
    describeWidgetSetupRow,
    proposeWidgetSetupDraft,
    setWidgetSetupBinding,
    type WidgetSetupField,
} from './widgetSetupModel';

/**
 * The Set up / Edit inputs step's presentation model (lab `dashboards` IN): follows vs pinned never
 * mix, missing asks, two or three surface values are choices in place, a lost pin keeps its name and
 * is never swapped, and a per-viewer connection never blocks.
 */
const field = (path: string, title: string, extra: Partial<InputFieldHint> = {}): InputFieldHint =>
    ({ path, title, widget: 'json', required: true, ...extra }) as InputFieldHint;
const A = { serverId: 'home', sessionId: 'A' };
const B = { serverId: 'home', sessionId: 'B' };
const C = { serverId: 'home', sessionId: 'C' };

const sessionFollows: WidgetSetupField = {
    field: field('session', 'Session'),
    follow: { slot: 'session', label: 'This session', values: [{ value: A, label: 'Retry relay' }] },
};
const account: WidgetSetupField = { field: field('account', 'Your GitHub account', { connectedAccountOptions: true }), viewer: { purpose: 'account' } };
const checkout: WidgetSetupField = {
    field: field('checkout', 'Checkout'),
    follow: { slot: 'checkout', label: 'The checkout you’re on', values: [
        { value: A, label: 'MacBook Pro · main' }, { value: B, label: 'devbox · relay-retry' }, { value: C, label: 'devbox · main' },
    ] },
};
const ready: WidgetBindingResolutionV1 = { status: 'ready', input: {} };
const missing = (path: string): WidgetBindingResolutionV1 => ({ status: 'selection_required', fields: [{ path, status: 'selection_required', reasonCode: 'widget_input_missing' }] });

describe('widget setup model', () => {
    it('shows the effective array-valued Group by before its choices finish loading', () => {
        const entry = { field: field('breakdown', 'Group by', { widget: 'select',
            optionsSourceId: 'usage.query.breakdown' }) };
        expect(describeWidgetSetupRow({ entry, resolution: ready, options: [],
            draft: { bindings: { breakdown: { kind: 'value', value: ['agent'] } } } }))
            .toMatchObject({ kind: 'pinned', label: expect.stringMatching(/Agent/i) });
    });
    it('names every selected scope choice and the unrestricted empty pin', () => {
        const entry = { field: field('agents', 'Agents', { widget: 'multiselect', required: false,
            placeholder: 'All agents', optionsSourceId: 'usage.filters.agents' }) };
        const options = [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }];
        const row = (value: string[]) => describeWidgetSetupRow({ entry, options, resolution: ready,
            draft: { bindings: { agents: { kind: 'value', value } } } });
        expect(row(['claude', 'codex'])).toMatchObject({ kind: 'pinned', label: 'Claude · Codex' });
        expect(row([])).toMatchObject({ kind: 'pinned', label: 'All agents' });
    });
    it('names a pinned Usage Session by its title, also when an older save kept it as a list', () => {
        const entry = { field: field('session', 'Session', { widget: 'select',
            inputType: { hostType: 'usageQuery', field: 'session' } }) };
        const options = [{ value: 'orchard', label: 'Orchard and meadow' }];
        const row = (value: string | string[]) => describeWidgetSetupRow({ entry, options, resolution: ready,
            draft: { bindings: { session: { kind: 'value', value } } } });
        expect(row('orchard')).toMatchObject({ kind: 'pinned', label: 'Orchard and meadow' });
        expect(row(['orchard'])).toMatchObject({ kind: 'pinned', label: 'Orchard and meadow' });
        expect(describeWidgetSetupRow({ entry, options: [], pickedOptions: options, resolution: ready,
            draft: { bindings: { session: { kind: 'value', value: ['orchard'] } } } }))
            .toMatchObject({ kind: 'pinned', value: null, label: 'Orchard and meadow' });
    });
    it('starts a copy following one surface value, per viewer for connections, and the likeliest of a few', () => {
        expect(proposeWidgetSetupDraft([sessionFollows, account, checkout, { field: field('label', 'Label') }])).toEqual({
            bindings: {
                session: { kind: 'context', slot: 'session' },
                account: { kind: 'viewer', purpose: 'account' },
                checkout: { kind: 'value', value: A },
            },
        });
    });

    it('describes follows, pins, a few choices in place, needed and viewer rows', () => {
        const draft = proposeWidgetSetupDraft([sessionFollows, account, checkout]);
        expect(describeWidgetSetupRow({ entry: sessionFollows, draft, resolution: ready, options: [] }))
            .toEqual({ kind: 'follows', label: 'This session', valueLabel: 'Retry relay' });
        expect(describeWidgetSetupRow({ entry: checkout, draft, resolution: ready, options: [] }))
            .toMatchObject({ kind: 'choices', selectedIndex: 0 });
        const pinnedB = setWidgetSetupBinding(draft, 'session', { kind: 'pin', value: B });
        expect(describeWidgetSetupRow({ entry: sessionFollows, draft: pinnedB, resolution: ready, options: [{ value: B, label: 'Fix settings modal' }] }))
            .toMatchObject({ kind: 'pinned', label: 'Fix settings modal' });
    });

    it('treats a per-viewer connection as each viewer’s own: shown, never asked, never blocking', () => {
        const draft = proposeWidgetSetupDraft([sessionFollows, account]);
        const viewerMissing = missing('account');
        // The binder has no value for it here (each viewer's own connection fills it when it reads)…
        expect(describeWidgetSetupRow({ entry: account, draft, resolution: viewerMissing, options: [{ value: 'leeroy-brun', label: 'leeroy-brun' }] }))
            .toEqual({ kind: 'viewer' });
        // …so it never stops the step.
        expect(describeWidgetSetupBlocker([sessionFollows, account], viewerMissing)).toBeNull();
        // A real input still blocks beside it.
        const both: WidgetBindingResolutionV1 = { status: 'selection_required', fields: [
            { path: 'session', status: 'selection_required', reasonCode: 'widget_input_missing' },
            { path: 'account', status: 'selection_required', reasonCode: 'widget_viewer_selection_missing' },
        ] };
        expect(describeWidgetSetupBlocker([sessionFollows, account], both)).toMatchObject({ title: 'Session' });
    });

    it('keeps a lost pin as an invalid row with its own name, never the surface value', () => {
        const draft = setWidgetSetupBinding(proposeWidgetSetupDraft([sessionFollows]), 'session', { kind: 'pin', value: 'happier-dev/relay' });
        const lost: WidgetBindingResolutionV1 = { status: 'denied', fields: [{ path: 'session', status: 'denied', reasonCode: 'session_access_denied' }] };
        expect(describeWidgetSetupRow({ entry: sessionFollows, draft, resolution: lost, options: [] }))
            .toMatchObject({ kind: 'invalid', label: 'happier-dev/relay', issue: { status: 'denied' } });
        expect(describeWidgetSetupBlocker([sessionFollows], lost)).toEqual({ path: 'session', title: 'Session', status: 'denied' });
    });

    it('names what is still needed by its field title', () => {
        expect(describeWidgetSetupBlocker([sessionFollows, checkout], missing('checkout'))).toMatchObject({ title: 'Checkout' });
        expect(describeWidgetSetupBlocker([sessionFollows], ready)).toBeNull();
    });
});
