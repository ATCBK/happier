import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { TriageSourceAdministrationActionResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { Button, ErrorState, Item, ItemGroup, PageHeader, Screen, defineUiSurface, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';

type SetupState = 'pending' | 'ready' | 'failed';

function InternalTaskSettings(): React.ReactElement {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const [setup, setSetup] = React.useState<Readonly<{ host: typeof host; state: SetupState }> | null>(null);
  const state = setup?.host === host ? setup.state : 'idle';
  const configure = React.useCallback(async () => {
    setSetup({ host, state: 'pending' });
    const settle = (state: SetupState) => setSetup(current => current?.host === host ? { host, state } : current);
    try {
      const result = TriageSourceAdministrationActionResultV1Schema.parse(await host.executeAction('internal/tasks/configure-v1', { v: 1 }));
      settle(result.kind === 'active' || result.kind === 'reused' || result.kind === 'reactivated' ? 'ready' : 'failed');
    } catch { settle('failed'); }
  }, [host]);
  return <Screen>
    <PageHeader title={text('plugins.triage.internal.title', 'Happier tasks')}
      description={text('plugins.triage.internal.description', 'Keep personal work in your Happier Account.')} />
    <ItemGroup title={text('plugins.triage.internal.personal', 'Personal tasks')}>
      <Item title={text('plugins.triage.internal.use', 'Use Happier tasks')}
        subtitle={text('plugins.triage.internal.existing', 'Your existing tasks and linked Sessions appear in Tasks.')}
        accessory={<Button title={state === 'ready' ? text('plugins.triage.internal.ready', 'Ready') : text('plugins.triage.internal.use', 'Use Happier tasks')}
          disabled={state === 'pending' || state === 'ready'} onPress={() => { void configure(); }} />} />
    </ItemGroup>
    {state === 'failed' ? <ErrorState title={text('plugins.triage.internal.setupFailed', 'Happier tasks could not be enabled')} /> : null}
  </Screen>;
}
export const renderSurface: RenderSurface = defineUiSurface(InternalTaskSettings);
