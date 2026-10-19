import * as React from 'react';

import { CapabilityScopeSection } from '@/components/capabilities/scope/CapabilityScopeSection';
import { t } from '@/text';

/**
 * "Skills and MCP servers" on Project → Context, after Memory (P8 U8.6, lab xs-P): what the viewer's sessions in this
 * Project get on every machine, with a switch per row that sets a rule for this Project only. A teammate sees their
 * own rules; the team's sessions follow theirs. The page keeps its composition; this is its slot.
 */
export const ProjectCapabilitiesSection = React.memo(function ProjectCapabilitiesSection(props: Readonly<{
    projectKey: string;
    projectName: string;
    teamName: string | null;
    testID: string;
}>) {
    const place = React.useMemo(() => ({ t: 'project' as const, projectKey: props.projectKey }), [props.projectKey]);
    return (
        <CapabilityScopeSection
            testID={props.testID}
            place={place}
            placeLabel={props.projectName}
            description={props.teamName
                ? t('capabilities.scopeSection.descProjectTeam', { project: props.projectName, team: props.teamName })
                : t('capabilities.scopeSection.descProject', { project: props.projectName })}
        />
    );
});
