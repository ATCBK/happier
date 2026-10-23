import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

vi.mock('@/text', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    t: (key: string) => key,
}));

import { MakeCoordinatorRoleHeld } from './MakeCoordinatorRoleHeld';

const refusal = { title: 'Restart the session to go hands-off', message: 'Let its turn finish, then choose the role again.' };

afterEach(() => { standardCleanup(); });

describe('Make coordinator, Role held by a running turn', () => {
    it('says why the Role did not apply and offers to end the turn only while one is running', async () => {
        const onStopTurn = vi.fn();
        const screen = await renderSettingsView(<MakeCoordinatorRoleHeld {...refusal} turnRunning={true} onStopTurn={onStopTurn} />);

        const heldRow = screen.findRow('make-coordinator-role-held');
        if (!heldRow) throw new Error('Expected the held-role explanation row');
        expect(heldRow.props.title).toBe(refusal.title);
        expect(heldRow.props.subtitle).toBe(refusal.message);
        screen.pressRow('make-coordinator-stop-turn');
        expect(onStopTurn).toHaveBeenCalledTimes(1);
    });

    it('drops the stop control once the turn has ended, leaving the explanation for Retry', async () => {
        const screen = await renderSettingsView(<MakeCoordinatorRoleHeld {...refusal} turnRunning={false} onStopTurn={vi.fn()} />);

        const heldRow = screen.findRow('make-coordinator-role-held');
        if (!heldRow) throw new Error('Expected the held-role explanation row');
        expect(heldRow.props.title).toBe(refusal.title);
        expect(screen.findAllByTestId('make-coordinator-stop-turn')).toHaveLength(0);
    });

    it('shows no stop control for a refusal a finished turn would not clear', async () => {
        const screen = await renderSettingsView(<MakeCoordinatorRoleHeld {...refusal} turnRunning={true} onStopTurn={null} />);

        expect(screen.findAllByTestId('make-coordinator-stop-turn')).toHaveLength(0);
    });
});
