import * as React from 'react';

import { MachineChoiceLine } from '@/components/settings/machines/MachineScopedSection';
import { useDaemonMemorySearchTargetSelection } from '@/sync/domains/memory/resolveDaemonMemorySearchTarget';

/**
 * Memory reads (counts, search) come from the Memory Machine the person chose on this device. When
 * none is chosen, this is the one place that says so and offers the same chooser Memory settings uses;
 * choosing persists through that selection owner, so every reader moves on at once.
 */
export const MemoryMachineChoice = React.memo(function MemoryMachineChoice(props: Readonly<{
  testID: string;
  invitation: string;
}>) {
  const selection = useDaemonMemorySearchTargetSelection();
  return <MachineChoiceLine selection={selection} invitation={props.invitation} testIDPrefix={props.testID} />;
});
