import { describe, expect, it, vi } from 'vitest';
import { UsageQuerySchema } from '@happier-dev/protocol/inputs/usageQuery';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

describe('the Usage page as widgets follow it', () => {
    it('names the page as the source and the page’s current value after it, never the field’s own noun twice (F4 D-12)', async () => {
        const { usageWidgetSurfaceContext } = await import('./usageWidgetPageContext');
        const { readUsageWidgetPageContext } = await import('./usageWidgetPageContext');
        const context = usageWidgetSurfaceContext(readUsageWidgetPageContext(UsageQuerySchema.parse({
            period: { relative: '7days' }, agents: [], machines: ['m1', 'm2'], projects: [], sources: [], costBasis: 'reported',
        })), '7days');
        const slots = context.slots!;
        for (const [path, slot] of Object.entries(slots)) {
            expect(slot.label, path).toBe('widgetAdd.thisPage');
            expect(slot.value?.label, path).not.toBe(slot.label);
        }
        expect(slots.period!.value!.label).toBe('usage.last7Days');
        expect(slots.agents!.value!.label).toBe('usage.board.page.filterAllOf(what=usage.board.page.filteragents)');
        expect(slots.machines!.value!.label).toBe('usage.board.page.filterCount(count=2)');
        expect(slots.costBasis!.value!.label).toBe('usage.board.page.costBasisReported');
    });
    it('follows “This session” on a Session’s Usage page', async () => {
        const { usageWidgetSurfaceContext } = await import('./usageWidgetPageContext');
        const context = usageWidgetSurfaceContext({ session: ['session-1'] }, '30days', 'session-1');
        expect(context.slots!.session!.label).toBe('usage.board.page.slotSession');
        expect(context.slots!.session!.offered).toBeUndefined();
    });
});
