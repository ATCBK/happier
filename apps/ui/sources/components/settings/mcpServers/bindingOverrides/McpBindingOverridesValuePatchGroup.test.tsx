import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ValueRefV1 } from '@happier-dev/protocol';
import { ValueRefV1Schema } from '@happier-dev/protocol/valueRefs/valueRefV1';
import { renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { McpBindingOverridesValuePatchGroupProps } from './McpBindingOverridesValuePatchGroup';

installSettingsViewCommonModuleMocks({ storage: 'real' });

describe('McpBindingOverridesValuePatchGroup', () => {
    it('renders malformed value refs with a safe fallback instead of throwing', async () => {
        const { McpBindingOverridesValuePatchGroup } = await import('./McpBindingOverridesValuePatchGroup');
        const invalidValueRef = { t: 'savedSecret' } as unknown as ValueRefV1;

        const screen = await renderSettingsView(React.createElement(McpBindingOverridesValuePatchGroup, {
                    kind: 'env',
                    patch: { BROKEN: invalidValueRef },
                    setPatch: vi.fn(),
                    openValueRefModal: vi.fn(),
                    onPressDeleteKey: vi.fn(),
                }));

        const brokenRow = screen.findRowByTitle('BROKEN');
        expect(brokenRow?.props.subtitle).toBe('settings.mcpServersValidationFailed');
        await screen.unmount();
    });

    it('renames an edited key without losing neighbors and removes a deletion override when pressed', async () => {
        const { McpBindingOverridesValuePatchGroup } = await import('./McpBindingOverridesValuePatchGroup');
        const initial = ValueRefV1Schema.parse({ t: 'literal', v: 'before' });
        const replacement = ValueRefV1Schema.parse({ t: 'savedSecret', secretId: 'saved-key' });
        let editor: Parameters<McpBindingOverridesValuePatchGroupProps['openValueRefModal']>[0] | undefined;
        function StatefulGroup() {
            const [patch, setPatch] = React.useState<Record<string, ValueRefV1 | null>>({
                ORIGINAL: initial, NEIGHBOR: initial, REMOVED: null,
            });
            return <McpBindingOverridesValuePatchGroup kind="env" patch={patch} setPatch={setPatch}
                openValueRefModal={params => { editor = params; }} onPressDeleteKey={() => {}} />;
        }
        const screen = await renderSettingsView(<StatefulGroup />);
        await act(async () => screen.pressRowByTitle('ORIGINAL'));
        expect(editor).toMatchObject({ initialKey: 'ORIGINAL', initialValueRef: initial,
            existingKeys: new Set(['ORIGINAL', 'NEIGHBOR', 'REMOVED']) });
        if (!editor) throw new Error('Expected the real row to open its value editor');
        await act(async () => editor!.onSubmit({ key: 'RENAMED', valueRef: replacement }));
        expect(screen.findRowByTitle('ORIGINAL')).toBeNull();
        expect(screen.findRowByTitle('RENAMED')?.props.subtitle).toBe('settings.mcpServersValueSourceSavedSecret');
        expect(screen.findRowByTitle('NEIGHBOR')?.props.subtitle).toBe('settings.mcpServersValueSourceLiteral');
        await act(async () => screen.pressRowByTitle('REMOVED'));
        expect(screen.findRowByTitle('REMOVED')).toBeNull();
        expect(screen.findRowByTitle('RENAMED')).not.toBeNull();
        await screen.unmount();
    });
});
