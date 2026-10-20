import { describe, expect, it } from 'vitest';
import { ExecutableParticipantPicker } from '@happier-dev/plugin-ui/components';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('participant picker on an unsupported presentation host', () => {
  it('shows an explicit readable unavailable state instead of an empty successful picker', () => {
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider context={context} hostApi={createHostApiStub(context)}>
      <ExecutableParticipantPicker testID="picker" sections={[]}
        selection={{ kind: 'single', selectedId: null }} searchPlaceholder="Search"
        doneLabel="Done" canConfirm={false} onSelect={() => {}} onDone={() => {}} onRequestClose={() => {}}
        unavailableLabel="Choose a participant in the Happier app" />
    </PluginUiProvider>);
    expect(mounted.container.querySelector('[data-testid="picker-unavailable"]')?.textContent)
      .toBe('Choose a participant in the Happier app');
    expect(mounted.container.querySelector('[role="button"]')).toBeNull();
    mounted.unmount();
  });
});
