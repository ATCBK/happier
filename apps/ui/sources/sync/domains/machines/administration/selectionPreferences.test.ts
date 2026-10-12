import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

import {
    applyMachineAdministrationSelectionMutationToAccountSettings,
    clearMachineAdministrationTargetPreference,
    clearPluginMachineExecutionOriginPreference,
    setMachineAdministrationTargetPreference,
    setPluginMachineExecutionOriginPreference,
} from './selectionPreferences';

describe('machine administration selection preferences', () => {
    it('edits a named source preference over retained stored fields without erasing sibling carriers', () => {
        const sibling = { serverIdentityId: 'srv_one', materializationRef: {
            machineId: 'other-machine', materializationId: 'other-installation', pluginId: 'other.plugin',
        }, futurePresentation: { keep: true } };
        const retained = { v: 1, targetsByKey: { agents: { serverIdentityId: 'srv_one', machineId: 'machine-a' } },
            futureField: { keep: true }, pluginExecutionOriginsByPluginId: { 'other.plugin': sibling } };
        const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'machine-a', pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development' as const, registeredRootId: '/registered/source' } } };
        const raw = { machineAdministrationSelectionsV1: retained, unrelatedRoot: { keep: true } };
        const selected = applyMachineAdministrationSelectionMutationToAccountSettings(raw, current => (
            setPluginMachineExecutionOriginPreference(current, 'acme.plugin', origin)
        ));
        expect(selected).toEqual({ ...raw, machineAdministrationSelectionsV1: { ...retained,
            pluginExecutionOriginsByPluginId: { 'other.plugin': sibling, 'acme.plugin': origin },
        } });
        expect(accountSettingsParse(selected).machineAdministrationSelectionsV1.pluginExecutionOriginsByPluginId['acme.plugin'])
            .toEqual(origin);
        expect(applyMachineAdministrationSelectionMutationToAccountSettings(selected, current => (
            clearPluginMachineExecutionOriginPreference(current, 'acme.plugin')
        ))).toEqual(raw);
        const invalidNewOrigin = { ...origin, unexpectedAuthority: true };
        expect(() => setPluginMachineExecutionOriginPreference({ v: 1, pluginExecutionOriginsByPluginId: {} },
            'acme.plugin', invalidNewOrigin)).toThrow();
    });

    it('refuses malformed known stored authority rather than resetting sibling selections', () => {
        expect(() => applyMachineAdministrationSelectionMutationToAccountSettings({
            machineAdministrationSelectionsV1: { v: 1, targetsByKey: {}, pluginExecutionOriginsByPluginId: {
                'other.plugin': { serverIdentityId: 'local-profile' },
            } },
        }, current => clearPluginMachineExecutionOriginPreference(current, 'acme.plugin'))).toThrow();
    });
    it('updates one device-local target entry without dropping another target', () => {
        const current = {
            agents: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
        };

        expect(setMachineAdministrationTargetPreference(
            current,
            'plugins.home',
            { serverIdentityId: 'srv_two', machineId: 'machine-b' },
        )).toEqual({
            ...current,
            'plugins.home': { serverIdentityId: 'srv_two', machineId: 'machine-b' },
        });
    });

    it('updates and clears only the named entry through the domain schema', () => {
        const withTarget = setMachineAdministrationTargetPreference(
            {},
            'plugins.home',
            { serverIdentityId: 'srv_one', machineId: 'machine-a' },
        );
        expect(clearMachineAdministrationTargetPreference(withTarget, 'plugins.home')).toEqual({});
    });

    it('rejects device-local profile ids before they can enter Account settings', () => {
        expect(() => setMachineAdministrationTargetPreference(
            {},
            'plugins.home',
            { serverIdentityId: 'profile-local-1', machineId: 'machine-a' },
        )).toThrow();
    });

    it('replays a named mutation without dropping a concurrent Account Settings winner', () => {
        const next = applyMachineAdministrationSelectionMutationToAccountSettings({
            unrelatedRoot: { preserved: true },
            machineAdministrationSelectionsV1: {
                v: 1,
                pluginExecutionOriginsByPluginId: {
                    'other.plugin': {
                        serverIdentityId: 'srv_one',
                        materializationRef: {
                            machineId: 'machine-a',
                            materializationId: 'mat-other',
                            pluginId: 'other.plugin',
                        },
                    },
                },
            },
        }, (current) => setPluginMachineExecutionOriginPreference(
            current,
            'acme.plugin',
            { serverIdentityId: 'srv_two', materializationRef: {
                machineId: 'machine-b', materializationId: 'mat-b', pluginId: 'acme.plugin',
            } },
        ));

        expect(next).toEqual({
            unrelatedRoot: { preserved: true },
            machineAdministrationSelectionsV1: {
                v: 1,
                pluginExecutionOriginsByPluginId: {
                    'acme.plugin': { serverIdentityId: 'srv_two', materializationRef: {
                        machineId: 'machine-b', materializationId: 'mat-b', pluginId: 'acme.plugin',
                    } },
                    'other.plugin': {
                        serverIdentityId: 'srv_one',
                        materializationRef: {
                            machineId: 'machine-a',
                            materializationId: 'mat-other',
                            pluginId: 'other.plugin',
                        },
                    },
                },
            },
        });
    });
});
