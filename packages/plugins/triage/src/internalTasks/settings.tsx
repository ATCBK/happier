import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { Button, Item, ItemGroup, PageHeader, Screen, defineUiSurface, usePluginTranslation } from '@happier-dev/plugin-ui';
import { useInternalTaskSetup } from './useInternalTaskSetup.js';

/**
 * Personal tasks: one row, one decision. The row names the thing ("Personal tasks") and its line says what turning
 * it on does; the trailing slot is the operation ("Turn on") until the Account has an active personal source, then a
 * quiet "On". Nothing is offered while the configured-source read is pending or unavailable (a second setup write
 * would be a guess), and a failed write says so on the row itself, beside its retry.
 */
function InternalTaskSettings(): React.ReactElement {
  const text = usePluginTranslation();
  const { state, configure, unavailableReason } = useInternalTaskSetup();
  const subtitle = state === 'failed'
    ? text('plugins.triage.internal.setupFailed', 'Happier tasks could not be enabled')
    : state === 'unavailable' && unavailableReason !== null
      ? unavailableReason
      : text('plugins.triage.internal.existing', 'Your existing tasks and linked Sessions appear in Tasks.');
  const offersSetup = state === 'idle' || state === 'pending' || state === 'failed';
  return <Screen>
    <PageHeader title={text('plugins.triage.internal.title', 'Happier tasks')}
      description={text('plugins.triage.internal.description', 'Keep personal work in your Happier Account.')} />
    {/* One untitled section on the page's sheet, on the page title's edge (an untitled group alone draws no sheet). */}
    <ItemGroup surface="sheet">
      <Item title={text('plugins.triage.internal.personal', 'Personal tasks')}
        subtitle={subtitle}
        {...(state === 'ready' ? { detail: text('plugins.triage.internal.on', 'On') } : {})}
        {...(offersSetup ? {
          accessory: <Button
            title={state === 'failed' ? text('plugins.triage.internal.retry', 'Try again') : text('plugins.triage.internal.turnOn', 'Turn on')}
            variant="secondary"
            size="small"
            busy={state === 'pending'}
            disabled={state === 'pending'}
            onPress={() => { void configure(); }} />,
        } : {})} />
    </ItemGroup>
  </Screen>;
}
export const renderSurface: RenderSurface = defineUiSurface(InternalTaskSettings);
