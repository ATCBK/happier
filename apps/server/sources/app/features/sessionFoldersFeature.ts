import type { FeaturesPayloadDelta } from './types';

export function resolveSessionFoldersFeature(_env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    return {
        features: {
            sessions: {
                enabled: true,
                folders: { enabled: true },
            },
        },
    };
}
