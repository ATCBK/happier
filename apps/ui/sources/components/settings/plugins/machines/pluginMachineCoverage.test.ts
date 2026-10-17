import { describe, expect, it } from 'vitest';
import { t } from '@/text';

import { resolvePluginMachineCoverageLabels } from './pluginMachineCoverage';
import type { PluginMachineMatrixCellV1, PluginMachineMatrixV1 } from './pluginMachineMatrix';

function cell(machineName: string, state: PluginMachineMatrixCellV1['state']): PluginMachineMatrixCellV1 {
    return {
        machineKey: `key-${machineName}`,
        machineName,
        serverLabel: 'Home',
        state,
        version: '1.0.0',
        observedAt: 1,
        observation: 'live',
        retained: false,
    };
}

function matrix(rows: Readonly<Record<string, readonly PluginMachineMatrixCellV1[]>>): PluginMachineMatrixV1 {
    return {
        kind: 'available',
        availabilityCursor: 1,
        machineCount: 3,
        unresolvedServerCount: 0,
        rows: Object.entries(rows).map(([pluginId, cells]) => ({
            pluginId,
            accountAvailability: null,
            cells,
            installedCurrentCount: cells.filter((entry) => entry.state === 'installedCurrent').length,
            includedWithHappier: false,
        })),
    };
}

describe('resolvePluginMachineCoverageLabels', () => {
    it('counts the machines a plugin is current on, names a single one, and says nothing where it runs nowhere', () => {
        const labels = resolvePluginMachineCoverageLabels(matrix({
            everywhere: [cell('mac-mini', 'installedCurrent'), cell('laptop', 'installedCurrent'), cell('vps', 'installedCurrent')],
            one: [cell('mac-mini', 'installedCurrent'), cell('laptop', 'absent'), cell('vps', 'unknown')],
            nowhere: [cell('mac-mini', 'absent'), cell('laptop', 'absent'), cell('vps', 'absent')],
        }));

        expect(labels.everywhere).toContain('3');
        expect(labels.one).toContain('mac-mini');
        expect(labels.one).not.toContain('laptop');
        expect(labels).not.toHaveProperty('nowhere');
    });

    it('says where a plugin is installed when its only machine is offline, rather than nothing', () => {
        const labels = resolvePluginMachineCoverageLabels(matrix({
            offline: [cell('mac-mini', 'absent'), cell('laptop', 'staleOffline'), cell('vps', 'unknown')],
            disabled: [cell('mac-mini', 'disabled'), cell('laptop', 'absent'), cell('vps', 'absent')],
        }));

        expect(labels.offline).toBe(t('settingsPlugins.surfaces.onMachineOffline', { machine: 'laptop' }));
        expect(labels).not.toHaveProperty('disabled');
    });

    it('has no line while the matrix is not loaded', () => {
        expect(resolvePluginMachineCoverageLabels({ kind: 'unavailable', code: 'account_availability_not_loaded' })).toEqual({});
    });
});
