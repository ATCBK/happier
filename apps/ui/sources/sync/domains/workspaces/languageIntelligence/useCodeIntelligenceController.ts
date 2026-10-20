import * as React from 'react';

import { createCodeIntelligenceController, type CodeIntelligenceController, type CodeIntelligenceControllerInput } from './createCodeIntelligenceController';

/** Own controller custody for the mounted File page, not for a render attempt. */
export function useCodeIntelligenceController(input: CodeIntelligenceControllerInput | null) {
    const [mounted, setMounted] = React.useState<Readonly<{
        input: CodeIntelligenceControllerInput;
        controller: CodeIntelligenceController;
    }> | null>(null);
    React.useEffect(() => {
        if (!input) { setMounted(null); return; }
        const controller = createCodeIntelligenceController(input);
        setMounted({ input, controller });
        return () => controller.dispose();
    }, [input]);
    return mounted?.input === input ? mounted.controller : null;
}
