import { describe, expect, it } from 'vitest';
import type { EntityDropAdmissionV1, EntityDropPreviewV1 } from '@happier-dev/protocol/plugins/ui';

import { describeEntityDropOutcome, describeEntityDropSettled } from '../../ui/entityDropOutcome';

const allowed = (actionId: string, glyph?: EntityDropPreviewV1['glyph'], verb = 'Verb'): EntityDropAdmissionV1 => ({
    status: 'allowed', effect: { actionId, input: {}, preview: { verb, target: 'Target', glyph } },
});

describe('Happier core outcome vocabulary (lab SYS verbs)', () => {
    it('honors declared core and plugin marks without reinterpreting their Action input', () => {
        for (const glyph of ['copy', 'move', 'board', 'below', 'split'] as const) {
            for (const actionId of ['session.reports_to.set', 'plugin.releases.link']) {
                expect(describeEntityDropOutcome({ phase: 'carrying', admission: allowed(actionId, glyph) })?.glyph).toBe(glyph);
            }
        }
        expect(describeEntityDropOutcome({ phase: 'carrying', admission: allowed('plugin.releases.link') })?.glyph).toBe('add');
    });

    it('treats every "nothing would change" code as a quiet Already here, never a refusal', () => {
        for (const code of ['no-change', 'same-position', 'board-no-change', 'workspace_tab_already_here']) {
            expect(describeEntityDropOutcome({ phase: 'carrying', admission: { status: 'refused', reason: { code, message: 'It’s already here' } } }))
                .toMatchObject({ tone: 'quiet', glyph: 'here' });
        }
    });

    it('describes refused action previews as refusals while keeping the target and owner reason', () => {
        for (const [glyph, verb, title] of [
            ['move', 'Move to Project', 'Can’t move to Project'],
            ['copy', 'Copy to Project', 'Can’t copy to Project'],
            ['above', 'Move above Project', 'Can’t move above Project'],
            ['below', 'Move below Project', 'Can’t move below Project'],
            ['nest', 'Put under Project', 'Can’t put under Project'],
            ['add', 'Add to Project', 'Can’t add to Project'],
            ['open', 'Open Project', 'Can’t open Project'],
            ['tab', 'Open Project as a tab', 'Can’t open Project'],
            ['attach', 'Attach to Project', 'Can’t attach to Project'],
            ['upload', 'Upload to Project', 'Can’t upload to Project'],
            ['goTo', 'Go to Project', 'Can’t go to Project'],
            ['split', 'Split left', 'Can’t split here'],
            ['splitVertical', 'Split down', 'Can’t split here'],
        ] as const) {
            const admission: EntityDropAdmissionV1 = { status: 'refused',
                reason: { code: 'read-only', message: 'Ask its owner for edit access' },
                preview: { glyph, verb, target: 'Project' } };
            for (const phase of ['carrying', 'settled'] as const) {
                expect(describeEntityDropOutcome({ phase, admission })).toEqual({
                    tone: 'refused', title, detail: 'Ask its owner for edit access',
                });
            }
            expect(describeEntityDropOutcome({ phase: 'carrying', admission: allowed('plugin.move', glyph, verb) })?.title).toBe(verb);
        }
        expect(describeEntityDropOutcome({ phase: 'carrying', admission: { status: 'refused',
            reason: { code: 'read-only', message: 'Because' }, preview: { verb: 'Link to Project', target: 'Project' } } })?.title)
            .toBe('Can’t add to Project');
    });

    it('keeps domain-authored refusals and quiet unchanged previews intact', () => {
        const preview: EntityDropPreviewV1 = { verb: 'Can’t put it in website', target: 'Changes', glyph: 'refused' };
        for (const code of ['widget_group_width_no_fit', 'widget_group_nesting_forbidden']) {
            expect(describeEntityDropOutcome({ phase: 'carrying', admission: { status: 'refused',
                reason: { code, message: 'Choose a wider group' }, preview } })?.title).toBe(preview.verb);
        }
        const unchanged: EntityDropAdmissionV1 = { status: 'refused', reason: { code: 'same-position', message: 'Already here' },
            preview: { glyph: 'move', verb: 'Move to Project', target: 'Project' } };
        expect(describeEntityDropOutcome({ phase: 'carrying', admission: unchanged })).toMatchObject({ tone: 'quiet', title: 'Move to Project' });
    });

    it('names a late relation refusal by item and lead, and any other one by its verb', () => {
        const refused = { status: 'refused' as const, reason: { code: 'changed', message: 'This session was just moved. Try again' } };
        expect(describeEntityDropSettled({ phase: 'settled', admission: allowed('session.reports_to.set', 'nest'), outcome: refused }, 'Review #2481'))
            .toMatchObject({ kind: 'refused', title: 'Couldn’t put Review #2481 under Target', detail: 'This session was just moved. Try again' });
        expect(describeEntityDropSettled({ phase: 'settled', admission: allowed('todos.reorder', 'above', 'Move above Buy milk'), outcome: refused }))
            .toMatchObject({ kind: 'refused', title: 'Move above Buy milk didn’t go through' });
    });
});
