import * as React from 'react';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import type { WorkSectionSetupDisclosure } from './WorkSection';

type SessionSetupSectionKey = keyof NonNullable<ReturnType<typeof useSessionSetupExpandedSections>>;

function useSessionSetupExpandedSections() {
    return useLocalSetting('sessionInfoExpandedSectionsV1');
}

/**
 * The Setup rows share this device preference; mounting never writes it. Each row publishes its own
 * expand/collapse command with the state it shows (`WorkSectionAsSetupRow`).
 */
export function useSessionSetupDisclosure(): WorkSectionSetupDisclosure {
    const remembered = useSessionSetupExpandedSections();
    return React.useMemo(() => ({
        isExpanded: (key: string, sectionDefault?: boolean) =>
            remembered[key as SessionSetupSectionKey] ?? sectionDefault ?? key === 'instructions',
        setExpanded: (key: string, expanded: boolean) => {
            const current = storage.getState().localSettings.sessionInfoExpandedSectionsV1;
            storage.getState().applyLocalSettings({
                sessionInfoExpandedSectionsV1: { ...current, [key]: expanded },
            });
        },
    }), [remembered]);
}
