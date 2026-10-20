import { describe, expect, it, vi } from 'vitest';
import { projectSessionTurnWaitingCompatibility } from './sessionTurnWaitingCompatibility';

import {
    buildAccountStoredContentUpgradeRequired,
    buildProfilePreservingSettingsWriterUpgradeRequired,
    CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS,
    evaluateAccountStoredContentCompatibility,
} from './accountStoredContentCompatibility';

describe('account-stored-content compatibility', () => {
    it('withholds only unknown waiting history while retaining an active external snapshot cursor barrier', () => {
        const completed = { turnId: 'known-turn', status: 'completed', startedAt: 10, updatedAt: 20 };
        const waiting = { turnId: 'question-turn', status: 'waiting', startedAt: 30, updatedAt: 40 };
        const snapshot = { externalShareableSnapshot: { turns: [completed, waiting], turnSettlementBlockedFromSeq: 4 } };
        for (const version of [2, 3]) {
            const compatibility = evaluateAccountStoredContentCompatibility({ status: 'valid', declaration: { v: 1, protocolVersion: version } });
            expect(projectSessionTurnWaitingCompatibility(snapshot, compatibility)).toEqual({
                externalShareableSnapshot: { turns: [completed], turnSettlementBlockedFromSeq: 4 },
            });
        }
        const current = evaluateAccountStoredContentCompatibility({ status: 'valid', declaration: { v: 1, protocolVersion: 4 } });
        expect(projectSessionTurnWaitingCompatibility(snapshot, current)).toBe(snapshot);
    });
    it('treats missing and malformed declarations as legacy callers without rejecting their connection', () => {
        expect(evaluateAccountStoredContentCompatibility({ status: 'missing' })).toMatchObject({
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'legacy-missing',
        });
        expect(evaluateAccountStoredContentCompatibility({ status: 'malformed' })).toMatchObject({
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'legacy-malformed',
        });
    });

    it('withholds the additive machinePool change kind from missing, malformed and pre-V4 declarations', () => {
        // A peer that never declared, or declared an older cumulative version, must not be assumed
        // able to parse a change kind it does not know: an old reader blocks unknown kinds.
        expect(evaluateAccountStoredContentCompatibility({ status: 'missing' })).toMatchObject({
            supportsMachinePoolChangeProtocol: false,
        });
        expect(evaluateAccountStoredContentCompatibility({ status: 'malformed' })).toMatchObject({
            supportsMachinePoolChangeProtocol: false,
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 3 },
        })).toMatchObject({
            supportsPluginDataProtocol: true,
            supportsMachinePoolChangeProtocol: false,
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 4 },
        })).toMatchObject({
            supportsMachinePoolChangeProtocol: true,
        });
    });

    it('withholds Saved Secret resource invalidations from missing, malformed and pre-V4 declarations', () => {
        expect(evaluateAccountStoredContentCompatibility({ status: 'missing' })).toMatchObject({
            supportsSavedSecretResourceChangeProtocol: false,
        });
        expect(evaluateAccountStoredContentCompatibility({ status: 'malformed' })).toMatchObject({
            supportsSavedSecretResourceChangeProtocol: false,
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 3 },
        })).toMatchObject({
            supportsSavedSecretResourceChangeProtocol: false,
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 4 },
        })).toMatchObject({
            supportsSavedSecretResourceChangeProtocol: true,
        });
    });

    it('keeps v1 legacy, preserves v2 current stored-content behavior, and reserves additive change-page fields by protocol version', () => {
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 1 },
        })).toMatchObject({
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'legacy-protocol-too-old',
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 2 },
        })).toMatchObject({
            supportsCurrentProtocol: true,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'accepted',
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 4 },
        })).toMatchObject({
            supportsCurrentProtocol: true,
            supportsPluginDataProtocol: true,
            supportsSessionAccessWitnessProtocol: true,
            outcome: 'accepted',
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 3 },
        })).toMatchObject({
            supportsCurrentProtocol: true,
            supportsPluginDataProtocol: true,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'accepted',
        });
    });

    it('advertises the cumulative V4 contract while retaining the V2 base requirement', () => {
        expect(CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS).toMatchObject({
            minimumProtocolVersion: 2,
            currentProtocolVersion: 4,
        });
        expect(buildAccountStoredContentUpgradeRequired()).toEqual({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 2,
            },
        });
        expect(buildProfilePreservingSettingsWriterUpgradeRequired()).toEqual({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 4,
            },
        });
    });

});
