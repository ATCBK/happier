import { describe, expect, it } from 'vitest';

import * as hostRuntimeExternals from './hostRuntimeExternals.js';
import {
    PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
} from './hostRuntimeExternals.js';

describe('plugin UI host runtime externals', () => {
    it('declares the canonical exhaustive specifier list once', () => {
        expect(PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS).toEqual([
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-native',
            'react-native-web',
            '@react-navigation/native',
            '@react-navigation/native-stack',
            'react-native-reanimated',
            '@happier-dev/plugin-ui',
            '@happier-dev/plugin-ui/components',
            '@happier-dev/plugin-ui/hostApi',
            '@happier-dev/plugin-ui/data',
            '@happier-dev/plugin-ui/declarative',
            '@happier-dev/plugin-ui/environment',
            '@happier-dev/plugin-ui/advanced',
            '@happier-dev/plugin-sdk/ui/client',
        ]);
    });

    it('does not publish predecessor global-install or native-subset contracts', () => {
        expect(hostRuntimeExternals).not.toHaveProperty('PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY');
        expect(hostRuntimeExternals).not.toHaveProperty('PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS');
        expect(hostRuntimeExternals).not.toHaveProperty('PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS');
        expect(hostRuntimeExternals).not.toHaveProperty('isPluginUiHostRuntimeExternalGlobalInstalled');
    });
});
