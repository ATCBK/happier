import { describe, expect, it } from 'vitest';

import {
    areDeviceRemoteAlertPoliciesEqual,
    deriveDeviceRemoteAlertPolicyV1,
} from './deriveDeviceRemoteAlertPolicy';

const IOS = { platform: 'ios' } as const;

describe('deriveDeviceRemoteAlertPolicyV1', () => {
    it('enrolls opted-in machines independently of remote session consent while retaining the device opt-out', () => {
        const inputs = {
            accountSettings: { sessionRemoteAlertsEnabled: false, machineOfflineAlertsV1: { machineIds: ['machine-one'] } },
            nativeSupport: IOS,
        };
        expect(deriveDeviceRemoteAlertPolicyV1({ ...inputs, localSettings: { deviceRemoteAlertsEnabled: true } }))
            .toMatchObject({ enabled: true, nativeConsumer: 'ios_service_extension_v1' });
        expect(deriveDeviceRemoteAlertPolicyV1({ ...inputs, localSettings: { deviceRemoteAlertsEnabled: false } }))
            .toMatchObject({ enabled: false });
        expect(deriveDeviceRemoteAlertPolicyV1({ ...inputs, localSettings: { deviceRemoteAlertsEnabled: true }, nativeSupport: null }))
            .toBeNull();
    });
    it('publishes nothing until the Account explicitly opts into policy disclosure', () => {
        expect(deriveDeviceRemoteAlertPolicyV1({
            accountSettings: {},
            localSettings: { deviceRemoteAlertsEnabled: true },
            nativeSupport: IOS,
        })).toBeNull();
    });

    it('publishes nothing when this build ships no native alert consumer', () => {
        expect(deriveDeviceRemoteAlertPolicyV1({
            accountSettings: { sessionRemoteAlertsEnabled: true },
            localSettings: { deviceRemoteAlertsEnabled: true },
            nativeSupport: null,
        })).toBeNull();
    });

    it('treats disabled device overrides as Account inheritance and keeps local-only controls local', () => {
        expect(deriveDeviceRemoteAlertPolicyV1({
            accountSettings: {
                sessionRemoteAlertsEnabled: true,
                attentionDeliveryPolicyV1: { v: 1, sounds: { volume: 0.4 } },
            },
            localSettings: {
                deviceRemoteAlertsEnabled: true,
                attentionDeviceOverridesV1: {
                    enabled: false,
                    foregroundBehavior: 'off',
                    localNotifications: { enabled: false },
                    sounds: { enabled: false, volume: 0 },
                    privacy: { previewBehavior: 'status_only' },
                    quietHoursOverride: { mode: 'disabled' },
                },
            },
            nativeSupport: IOS,
        })).toEqual({
            v: 1,
            enabled: true,
            nativeConsumer: 'ios_service_extension_v1',
            quietHoursOverride: { mode: 'account' },
            foregroundBehavior: 'account',
            previewCeiling: 'account',
            soundVolume: 0.4,
        });
    });

    it('projects the active device overrides, including a custom quiet-hours schedule', () => {
        expect(deriveDeviceRemoteAlertPolicyV1({
            accountSettings: { sessionRemoteAlertsEnabled: true },
            localSettings: {
                deviceRemoteAlertsEnabled: true,
                attentionDeviceOverridesV1: {
                    enabled: true,
                    foregroundBehavior: 'silent',
                    // Local-only switches must not leak into the remote overlay.
                    localNotifications: { enabled: false, events: { ready: false } },
                    sounds: { enabled: false, volume: 0.5 },
                    privacy: { previewBehavior: 'title_only' },
                    quietHoursOverride: {
                        mode: 'custom',
                        timezone: 'Europe/Zurich',
                        windows: [{ startLocalTime: '22:00', endLocalTime: '07:00', days: ['mon'] }],
                    },
                },
            },
            nativeSupport: { platform: 'android' },
        })).toEqual({
            v: 1,
            enabled: true,
            nativeConsumer: 'android_native_v1',
            quietHoursOverride: {
                mode: 'custom',
                timezone: 'Europe/Zurich',
                windows: [{ startLocalTime: '22:00', endLocalTime: '07:00', days: ['mon'] }],
            },
            foregroundBehavior: 'silent',
            previewCeiling: 'title_only',
            soundVolume: 0.5,
        });
    });

    it('records an explicit per-device opt-out instead of dropping the registration', () => {
        expect(deriveDeviceRemoteAlertPolicyV1({
            accountSettings: { sessionRemoteAlertsEnabled: true },
            localSettings: { deviceRemoteAlertsEnabled: false },
            nativeSupport: IOS,
        })).toMatchObject({ enabled: false, nativeConsumer: 'ios_service_extension_v1' });
    });
});

describe('areDeviceRemoteAlertPoliciesEqual', () => {
    const base = deriveDeviceRemoteAlertPolicyV1({
        accountSettings: { sessionRemoteAlertsEnabled: true },
        localSettings: { deviceRemoteAlertsEnabled: true },
        nativeSupport: IOS,
    });

    it('treats an unchanged overlay as equal so no redundant registration is written', () => {
        expect(areDeviceRemoteAlertPoliciesEqual(base, structuredClone(base))).toBe(true);
        expect(areDeviceRemoteAlertPoliciesEqual(null, null)).toBe(true);
    });

    it('detects a changed opt-in, a changed schedule and a one-sided absence', () => {
        expect(areDeviceRemoteAlertPoliciesEqual(base, base && { ...base, enabled: false })).toBe(false);
        expect(areDeviceRemoteAlertPoliciesEqual(base, base && {
            ...base,
            quietHoursOverride: { mode: 'custom', timezone: 'UTC', windows: [{ startLocalTime: '22:00', endLocalTime: '07:00' }] },
        })).toBe(false);
        expect(areDeviceRemoteAlertPoliciesEqual(base, null)).toBe(false);
    });
});
