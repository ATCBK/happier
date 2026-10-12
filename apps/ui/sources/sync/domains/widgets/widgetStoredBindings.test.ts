import { describe, expect, it } from 'vitest';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { WidgetConnectedAccountSelectionReadSchema, WidgetSessionAddressReadSchema } from './widgetBinding';

describe('typed persisted Widget binding reads', () => {
    it('opens qualified selections recursively while fresh selection admission remains strict', () => {
        const stored = { service: { pluginId: 'example.accounts', localId: 'service', retired: true }, accountId: 'saved-account', retired: true };
        expect(WidgetConnectedAccountSelectionReadSchema.safeParse(stored)).toEqual({ success: true,
            data: { service: { pluginId: 'example.accounts', localId: 'service' }, accountId: 'saved-account' } });
        expect(QualifiedConnectedAccountRefSchema.safeParse(stored).success).toBe(false);
        expect(WidgetConnectedAccountSelectionReadSchema.safeParse({ ...stored, accountId: 4 }).success).toBe(false);
    });
    it('opens the saved Session address without retaining unknown fields or coercing identity', () => {
        expect(WidgetSessionAddressReadSchema.safeParse({ serverId: 'home', sessionId: 'session', retired: true }))
            .toMatchObject({ success: true, data: { serverId: 'home', sessionId: 'session' } });
        const parsed = WidgetSessionAddressReadSchema.safeParse({ serverId: 'home', sessionId: 'session', retired: true });
        if (parsed.success) expect(parsed.data).not.toHaveProperty('retired');
        expect(WidgetSessionAddressReadSchema.safeParse({ serverId: 'home', sessionId: 4 }).success).toBe(false);
    });
});
