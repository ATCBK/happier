import * as React from 'react';
import { AgentInput } from '@/components/sessions/agentInput';
import { useComposerTextValue, type ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import {
    useSessionComposerStructuredInputMentions,
    type SessionAgentInputComposerPersistence,
} from '@/hooks/session/useSessionAgentInputComposerPersistence';

/** Text and positional references subscribe here, outside the Session screen's render graph. */
export function SessionComposerAgentInput({
    textStore,
    pendingText,
    structuredInputPersistence,
    ...props
}: Omit<React.ComponentPropsWithoutRef<typeof AgentInput>, 'value'> & Readonly<{
    textStore: ComposerTextStore;
    pendingText: string | null;
    structuredInputPersistence: SessionAgentInputComposerPersistence['structuredInputPersistence'];
}>) {
    const liveText = useComposerTextValue(textStore);
    const mentions = useSessionComposerStructuredInputMentions(structuredInputPersistence);
    return <AgentInput {...props} value={pendingText ?? liveText} structuredInputMentions={props.structuredInputMentions ?? mentions} />;
}
