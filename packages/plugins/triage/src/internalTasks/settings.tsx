import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { Button, ErrorState, Item, ItemGroup, PageHeader, Screen, defineUiSurface, usePluginTranslation } from '@happier-dev/plugin-ui';
import { useInternalTaskSetup } from './useInternalTaskSetup.js';

function InternalTaskSettings(): React.ReactElement {
  const text = usePluginTranslation();
  const { state, configure } = useInternalTaskSetup();
  return <Screen>
    <PageHeader title={text('plugins.triage.internal.title', 'Happier tasks')}
      description={text('plugins.triage.internal.description', 'Keep personal work in your Happier Account.')} />
    <ItemGroup title={text('plugins.triage.internal.personal', 'Personal tasks')}>
      <Item title={text('plugins.triage.internal.use', 'Use Happier tasks')}
        subtitle={text('plugins.triage.internal.existing', 'Your existing tasks and linked Sessions appear in Tasks.')}
        accessory={<Button title={state === 'ready' ? text('plugins.triage.internal.ready', 'Ready') : text('plugins.triage.internal.use', 'Use Happier tasks')}
          disabled={state !== 'idle' && state !== 'failed'} onPress={() => { void configure(); }} />} />
    </ItemGroup>
    {state === 'failed' ? <ErrorState title={text('plugins.triage.internal.setupFailed', 'Happier tasks could not be enabled')} /> : null}
  </Screen>;
}
export const renderSurface: RenderSurface = defineUiSurface(InternalTaskSettings);
