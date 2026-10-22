import { describe, expect, it } from 'vitest';

import { buildDesktopTrayState } from './buildDesktopTrayState';

describe('buildDesktopTrayState', () => {
    const translate = (key: string) => key;

    it('uses the existing neutral connecting tray state without inventing counts for unknown machine presence', () => {
        expect(buildDesktopTrayState({
            health: { kind: 'machine_unknown', machineCount: 2, onlineCount: 0,
                statusLabelKey: 'status.unknown', machineLabelKey: 'status.unknown' },
            t: translate,
        })).toEqual({ status: 'connecting', label: 'status.unknown', detail: 'status.unknown' });
    });

    it('maps healthy connection health to a healthy tray state', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'healthy',
                machineCount: 3,
                onlineCount: 3,
                statusLabelKey: 'status.connected',
                machineLabelKey: 'status.online',
            },
            t: translate,
        })).toEqual({
            status: 'healthy',
            label: 'status.connected',
            detail: 'status.online · 3/3',
        });
    });

    it('promotes healthy tray state to attention required when relay drift is present', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'healthy',
                machineCount: 3,
                onlineCount: 3,
                statusLabelKey: 'status.connected',
                machineLabelKey: 'status.online',
            },
            relayDriftBannerTitle: 'Relay drift detected',
            t: translate,
        })).toEqual({
            status: 'attention_required',
            label: 'status.actionRequired',
            detail: 'Relay drift detected',
        });
    });

    it('maps action-required health kinds without drifting from the canonical status keys', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'machine_offline',
                machineCount: 4,
                onlineCount: 0,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'status.offline',
            },
            t: translate,
        })).toEqual({
            status: 'machine_offline',
            label: 'status.actionRequired',
            detail: 'status.offline · 0/4',
        });
    });

    it('maps unreachable server health to a disconnected tray state', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'server_unreachable',
                machineCount: 0,
                onlineCount: 0,
                statusLabelKey: 'status.disconnected',
                machineLabelKey: 'status.unknown',
            },
            t: translate,
        })).toEqual({
            status: 'server_unreachable',
            label: 'status.disconnected',
            detail: 'status.unknown',
        });
    });

    it('maps machine_not_ready health to an attention-required tray state (Rust tray enum does not accept machine_not_ready)', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'machine_not_ready',
                machineCount: 2,
                onlineCount: 2,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'status.online',
            },
            t: translate,
        })).toEqual({
            status: 'attention_required',
            label: 'status.actionRequired',
            detail: 'status.online · 2/2',
        });
    });

    it('maps planned server restarts to the existing connecting tray state', () => {
        expect(buildDesktopTrayState({
            health: {
                kind: 'server_restarting',
                machineCount: 2,
                onlineCount: 2,
                statusLabelKey: 'status.connecting',
                machineLabelKey: 'status.online',
            },
            t: translate,
        })).toEqual({
            status: 'connecting',
            label: 'status.connecting',
            detail: 'status.online · 2/2',
        });
    });
    it('carries the Updates item label and its enabled bit, and omits both when there is nothing to update', () => {
        const health = {
            kind: 'healthy',
            machineCount: 1,
            onlineCount: 1,
            statusLabelKey: 'status.connected',
            machineLabelKey: 'status.online',
        } as const;

        expect(buildDesktopTrayState({
            health,
            updates: { label: 'Updates available (2)…', enabled: true },
            t: translate,
        })).toEqual({
            status: 'healthy',
            label: 'status.connected',
            detail: 'status.online · 1/1',
            updatesLabel: 'Updates available (2)…',
            updatesEnabled: true,
        });

        expect(buildDesktopTrayState({
            health,
            relayDriftBannerTitle: 'Relay drift detected',
            updates: { label: 'Updating…', enabled: false },
            t: translate,
        })).toMatchObject({ status: 'attention_required', updatesLabel: 'Updating…', updatesEnabled: false });

        const idle = buildDesktopTrayState({ health, updates: null, t: translate });
        expect(idle).not.toHaveProperty('updatesLabel');
        expect(idle).not.toHaveProperty('updatesEnabled');
    });
});
