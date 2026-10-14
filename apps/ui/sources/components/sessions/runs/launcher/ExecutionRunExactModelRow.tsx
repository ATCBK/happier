import * as React from 'react';

import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { t } from '@/text';

/**
 * The Run's own model, in the route chip once "Choose for this run" is open: the row reads the
 * exact choice (source and model) and opens the same model picker the composer uses. Mounting it
 * is the demand signal the picker's model list loads on.
 */
export function ExecutionRunExactModelRow(props: Readonly<{
    subtitle: string;
    accessibilityLabel?: string;
    onDemand: () => void;
    onPress: () => void;
}>) {
    const { onDemand } = props;
    React.useEffect(() => { onDemand(); }, [onDemand]);
    return (
        <ActionListSection actions={[{
            id: 'model',
            testID: 'execution-run-route-choice.model',
            label: t('agentInput.model.title'),
            subtitle: props.subtitle,
            ...(props.accessibilityLabel ? { accessibilityLabel: props.accessibilityLabel } : {}),
            onPress: props.onPress,
        }]} />
    );
}
