import { describe, expect, it } from 'vitest';

import { createVoiceCaptureAdmissionController } from './VoiceCaptureAdmissionController';

describe('createVoiceCaptureAdmissionController', () => {
    it(
        'keeps one utterance owner when conversation starts before Dictation',
        () => {
            const controller = createVoiceCaptureAdmissionController();

            const conversation = controller.acquire('conversation');
            expect(conversation).toMatchObject({ status: 'acquired' });
            if (conversation.status !== 'acquired') throw new Error('expected conversation admission');

            const dictation = controller.acquire('dictation');
            expect(dictation).toEqual({
                status: 'busy',
                activeOwner: 'conversation',
            });

            conversation.lease.release();
            expect(controller.acquire('dictation').status).toBe('acquired');
        },
    );

    it(
        'keeps one utterance owner when Dictation starts before conversation',
        () => {
            const controller = createVoiceCaptureAdmissionController();

            const dictation = controller.acquire('dictation');
            expect(dictation).toMatchObject({ status: 'acquired' });
            if (dictation.status !== 'acquired') throw new Error('expected Dictation admission');

            const conversation = controller.acquire('conversation');
            expect(conversation).toEqual({
                status: 'busy',
                activeOwner: 'dictation',
            });

            dictation.lease.release();
            expect(controller.acquire('conversation').status).toBe('acquired');
        },
    );

    it('releases only the active lease and makes repeated release inert', () => {
        const controller = createVoiceCaptureAdmissionController();
        const acquired = controller.acquire('dictation');
        if (acquired.status !== 'acquired') throw new Error('expected Dictation admission');

        acquired.lease.release();
        acquired.lease.release();

        const next = controller.acquire('conversation');
        expect(next).toMatchObject({ status: 'acquired' });
        if (next.status !== 'acquired') throw new Error('expected conversation admission');

        acquired.lease.release();
        expect(controller.acquire('dictation')).toEqual({
            status: 'busy',
            activeOwner: 'conversation',
        });
    });
});
