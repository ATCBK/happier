import { t } from '@/text';

import { summarizePluginMachines, type PluginMachineMatrixV1 } from './pluginMachineMatrix';

/**
 * Where each plugin runs, as the Plugins collection's card line: "On 3 machines", or the machine's
 * name when it runs on one; a plugin whose one machine is offline says so. A plugin current nowhere
 * else, or an unloaded matrix, has no line.
 */
export function resolvePluginMachineCoverageLabels(matrix: PluginMachineMatrixV1): Readonly<Record<string, string>> {
    if (matrix.kind !== 'available') return {};
    const labels: Record<string, string> = {};
    for (const row of matrix.rows) {
        const summary = summarizePluginMachines(row, matrix.machineCount);
        if (summary.currentCount > 1) {
            labels[row.pluginId] = t('settingsPlugins.surfaces.onMachines', { count: summary.currentCount });
        } else if (summary.currentCount === 1 && summary.currentNames[0]) {
            labels[row.pluginId] = t('settingsPlugins.surfaces.onMachine', { machine: summary.currentNames[0] });
        } else if (summary.currentCount === 0) {
            // Presence alone establishes offline; revoked, replaced or missing machines stay unavailable.
            const offline = summary.exceptions.filter((cell) => cell.state === 'staleOffline');
            if (offline.length === 1 && summary.exceptions.length === 1 && offline[0]!.name) {
                labels[row.pluginId] = t('settingsPlugins.surfaces.onMachineOffline', { machine: offline[0]!.name });
            }
        }
    }
    return Object.freeze(labels);
}
