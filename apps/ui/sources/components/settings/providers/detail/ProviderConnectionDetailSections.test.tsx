import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Item } from '@/components/ui/lists/Item';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

describe('ProviderCompatibilitySection', () => {
    afterEach(standardCleanup);

    it('lists the agents that can use a connection and folds the rest into one row that names them', async () => {
        const { ProviderCompatibilitySection } = await import('./ProviderConnectionDetailSections');
        const screen = await renderScreen(<ProviderCompatibilitySection summaries={[
            { agentTargetKey: 'backend:codex', agentName: 'Codex', status: 'experimental', reasons: ['compatibility_evidence_missing'] },
            { agentTargetKey: 'backend:claude', agentName: 'Claude', status: 'verified', reasons: [] },
            { agentTargetKey: 'backend:auggie', agentName: 'Auggie', status: 'incompatible', reasons: ['no_compatible_protocol'] },
            { agentTargetKey: 'backend:kilo', agentName: 'Kilo', status: 'incompatible', reasons: [] },
        ] as never} />);
        const items = screen.findAllByType(Item);
        // Usable agents first, each pill finished by its reason, never by the pill's own sentence again.
        expect(items.map((item) => item.props.title).slice(0, 2)).toEqual(['Claude', 'Codex']);
        expect(items.find((item) => item.props.title === 'Codex')?.props.subtitle)
            .toBe('settingsProviders.compatibility.reasons.evidenceMissing');
        expect(items.find((item) => item.props.title === 'Claude')?.props.subtitle).toBeUndefined();
        // The agents that cannot use it: one quiet row with their names and count, opened on demand.
        expect(items.map((item) => item.props.title)).not.toContain('Auggie');
        const incompatible = items.find((item) => item.props.title === 'settingsProviders.compatibility.incompatible');
        expect(incompatible?.props.detail).toBe('2');
        expect(incompatible?.props.subtitle).toBe('Auggie, Kilo');
    });
});
