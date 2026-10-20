/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ArtifactDetailContent } from '@/app/(app)/artifacts/[id]';
import { EditArtifactContent } from '@/app/(app)/artifacts/edit/[id]';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';

// Native/navigation adapters only; the real route content receives its selected Artifact, not a store mock.
installApprovalCommonModuleMocks();
afterEach(standardCleanup);

function artifact(kind?: string): DecryptedArtifact {
    return { id: 'board-one', ownerAccountId: 'board-owner', access: 'owner',
        title: 'Board', header: { title: 'Board', ...(kind ? { kind } : {}) },
        body: '{"id":"board-one","name":"Board"}', headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true };
}

describe('Board Artifact front doors', () => {
    it('opens the Board owner instead of generic note detail/edit controls', async () => {
        const board = artifact('work-board.v1');
        for (const Screen of [ArtifactDetailContent, EditArtifactContent]) {
            const rendered = await renderScreen(<Screen id={board.id} artifact={board} />);
            expect(rendered.findAllByType('Redirect').map(node => node.props.href)).toEqual(['/boards/board-one']);
            expect(rendered.findAll(node => typeof node.props.onChangeText === 'function')).toHaveLength(0);
            await rendered.unmount();
        }
    });

    it('keeps ordinary note editing available', async () => {
        const note = artifact();
        const rendered = await renderScreen(<EditArtifactContent id={note.id} artifact={note} />);
        expect(rendered.findAllByType('Redirect')).toHaveLength(0);
        expect(rendered.findByType(MarkdownCodeEditorField).props.value).toBe(note.body);
        expect(rendered.findByTestId('artifact-editor:save')?.props.disabled).toBe(true);
        await act(async () => { rendered.findByType(MarkdownCodeEditorField).props.onChange('Edited note'); });
        expect(rendered.findByType(MarkdownCodeEditorField).props.value).toBe('Edited note');
        expect(rendered.findByTestId('artifact-editor:save')?.props.disabled).toBe(false);
    });
});
