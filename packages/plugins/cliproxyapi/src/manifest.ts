import { definePlugin } from '@happier-dev/plugin-sdk';

import {
  CLIPROXYAPI_PROVIDER_CONTRIBUTION,
  CLIPROXYAPI_PROVIDER_LOCAL_ID,
} from './provider/contribution.js';
import { CLIPROXYAPI_MANAGED_ENV, CLIPROXYAPI_MANAGED_SERVICE } from './provider/managedContract.js';
import { CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME } from './provider/publicManagedRuntime.js';
import { CLIPROXYAPI_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.cliproxyapi',
  version: '0.0.0',
  displayName: 'CLIProxyAPI',
  description: 'Use models served by an external or locally detected CLIProxyAPI gateway.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
  },
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'managed-gateway-environment',
      capability: 'environment',
      reason: 'Configure the managed CLIProxyAPI gateway and its host-owned access bindings.',
      scope: {
        keys: [
          'HOST',
          CLIPROXYAPI_MANAGED_SERVICE.portEnvironmentKey,
          CLIPROXYAPI_MANAGED_ENV.consumerAccessPath,
          CLIPROXYAPI_MANAGED_ENV.downstreamBearer,
          CLIPROXYAPI_MANAGED_ENV.purposeConfiguration,
        ],
      },
    }],
    optional: [],
  },
  ui: { translations: CLIPROXYAPI_UI_TRANSLATION_BUNDLES },
  providers: {
    [CLIPROXYAPI_PROVIDER_LOCAL_ID]: {
      declaration: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
      runtime: CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME,
    },
  },
});
