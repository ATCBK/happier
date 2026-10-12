import { describe, expect, it } from 'vitest';
import { buildSessionActionFieldOptionsHeightSignature, buildSessionActionFieldOptionsResolver } from './sessionActionFieldOptions';
import { usageAgentTitle, usageSourceTitle } from '@/sync/domains/usage/usageLabels';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { readUsageGroupByOptions } from '@happier-dev/protocol/inputs/usageQuery';

describe('resolved input options paint projection', () => {
    it('names automatic Group by independently of the cost-basis automatic choice', () => {
        const resolve = buildSessionActionFieldOptionsResolver({ 'usage.query.breakdown': readUsageGroupByOptions([]) });
        expect(resolve({ optionsSourceId: 'usage.query.breakdown' })[0]?.label).not.toBe(t('usage.board.page.costBasisAuto'));
        expect(resolve({ optionsSourceId: 'usage.query.breakdown' })[0]?.value).toEqual([]);
    });
    it('names Usage choices through the same label owners as the toolbar without changing their identities', () => {
        const sourceTitle = usageSourceTitle('claude-assistant-usage');
        const resolve = buildSessionActionFieldOptionsResolver({
            'usage.filters.agents': [{ value: 'claude', label: 'claude' }],
            'usage.filters.machines': [{ value: 'old-machine', label: 'old-machine' }],
            'usage.filters.sources': [{ value: 'claude-assistant-usage', label: 'claude-assistant-usage' }],
        });
        expect(resolve({ optionsSourceId: 'usage.filters.agents' })).toEqual([{ value: 'claude', label: usageAgentTitle('claude') }]);
        expect(resolve({ optionsSourceId: 'usage.filters.machines' })).toEqual([{ value: 'old-machine', label: getMachineDisplayName({ id: 'old-machine', absence: 'unlisted' }) }]);
        expect(resolve({ optionsSourceId: 'usage.filters.sources' })).toEqual([{ value: 'claude-assistant-usage', label: sourceTitle.charAt(0).toLocaleUpperCase() + sourceTitle.slice(1) }]);
    });
    it('paints any admitted source without a local source allowlist', () => {
        const channels = [{ value: 'phone', label: 'Phone', description: 'Push', disabled: true }];
        const resolve = buildSessionActionFieldOptionsResolver({ 'notifications.channels.available': channels });
        expect(resolve({ optionsSourceId: 'notifications.channels.available' })).toBe(channels);
        const staticOptions = [{ value: 'all', label: 'All changes' }];
        expect(resolve({ options: staticOptions })).toBe(staticOptions);
    });

    it('only changes height for painted content, not availability', () => {
        const signature = buildSessionActionFieldOptionsHeightSignature;
        const base = { source: [{ value: 'engine', label: 'Engine', description: 'Review' }] };
        expect(signature({ source: [{ ...base.source[0]!, disabled: true }] })).toBe(signature(base));
        expect(signature({ source: [{ ...base.source[0]!, label: 'New title' }] })).not.toBe(signature(base));
        expect(signature({ source: [{ ...base.source[0]!, description: 'New detail' }] })).not.toBe(signature(base));
        expect(signature({ source: [...base.source, { value: 'new', label: 'New engine' }] })).not.toBe(signature(base));
    });

    it('uses semantic Connected Account identity in height keys', () => {
        const account = { service: { pluginId: 'com.acme.accounts', localId: 'service' }, accountId: 'account-1' };
        const signature = buildSessionActionFieldOptionsHeightSignature;
        expect(signature({ source: [{ value: account, label: 'Account' }] })).toBe(
            signature({ source: [{ value: { ...account, service: { ...account.service } }, label: 'Account' }] }),
        );
        expect(signature({ source: [{ value: account, label: 'Account' }] })).not.toBe(
            signature({ source: [{ value: { ...account, accountId: 'account-2' }, label: 'Account' }] }),
        );
    });
});
