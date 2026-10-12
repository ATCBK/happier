import { describe, expect, it } from 'vitest';

import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';

import { buildNewSessionAuthoringContext } from './buildNewSessionAuthoringContext';

const DISABLED: NewSessionAutomationDraft = { enabled: false, name: 'Paused recipe', description: '', triggers: [] };
const BASE_DRAFT = { targetType: 'new_session', automation: null } as SessionAuthoringDraft;

function build(params: Readonly<{
    draft: NewSessionAutomationDraft;
    supported?: boolean;
    machineActive?: boolean;
}>) {
    return buildNewSessionAuthoringContext({
        automationDraft: params.draft,
        automationFeatureEnabled: params.supported ?? true,
        selectedMachineId: 'machine-1',
        scope: { serverId: 'authoring-home', accountId: 'authoring-account' },
        selectedMachine: {
            id: 'machine-1',
            active: params.machineActive ?? true,
            activeAt: params.machineActive === false ? 0 : Date.now(),
        } as any,
        selectedPath: '/repo/project',
        buildDraft: (automation) => ({ ...BASE_DRAFT, automation }),
    });
}

describe('buildNewSessionAuthoringContext', () => {
    it('launches an ordinary disabled inline draft', () => {
        const context = build({ draft: DISABLED });
        expect(context.canSubmit).toBe(true);
    });

    it('never turns submit into an Automation write, even for a hydrated enabled draft', () => {
        // Creating an Automation is the shared wrapper's journey; a persisted
        // pre-change draft is handed there by the screen, so submit here keeps
        // ordinary launch gating and never borrows the offline allowance an
        // Automation write had.
        const hydrated = build({ draft: { ...DISABLED, enabled: true }, machineActive: false });
        expect(hydrated.canSubmit).toBe(false);
        expect(hydrated).not.toHaveProperty('submitAccessibilityLabelKey');
    });

    it('hides Automation chips when Automation support is unavailable', () => {
        const context = build({ draft: { ...DISABLED, enabled: true }, supported: false, machineActive: false });
        expect(context.showAutomationActionChips).toBe(false);
        expect(context.canSubmit).toBe(false);
    });
});
