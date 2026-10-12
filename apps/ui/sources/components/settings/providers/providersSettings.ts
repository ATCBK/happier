import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** Searchable collection actions; connection-specific controls belong to the selected detail. */
export const PROVIDERS_SETTINGS = defineSettingsPage({
    pageId: 'providers',
    sections: {
        connections: {
            titleKey: 'settingsProviders.configuredTitle',
            settings: {
                connections: {},
                add: {},
                custom: {},
            },
        },
        local: {
            titleKey: 'settingsProviders.local.title',
            featureId: 'providers.localDiscovery',
            settings: {
                local: {},
            },
        },
    },
});

const selectedConnectionRoute = (context: import('@/components/settings/catalog/settingDeclarations').SettingsRouteContext) =>
    /^\/(?:\(app\)\/)?settings\/providers\/pc_[^/]+$/.test(context.pathname) ? context.pathname : null;

/** Entity-specific settings use the selected connection's route, never the first saved connection. */
export const PROVIDER_DETAIL_SETTINGS = defineSettingsPage({ pageId: 'providers',
    subpage: { id: 'detail', route: selectedConnectionRoute, titleKey: 'settingsProviders.configuredTitle' },
    sections: { details: { settings: { name: {} } }, models: { settings: { visibility: {} } } },
});
export const PROVIDER_GATEWAY_SETTINGS = defineSettingsPage({ pageId: 'providers',
    subpage: { id: 'gateway', route: selectedConnectionRoute, titleKey: 'settingsProvidersCollection.gateway.detailsTitle' },
    sections: { sources: { settings: { slots: {} } }, execution: { settings: { placement: {} } }, helpers: { settings: { helpers: {} } } },
});
