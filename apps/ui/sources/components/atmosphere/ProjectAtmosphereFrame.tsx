import * as React from 'react';
import type { View } from 'react-native';
import { AtmosphereSurfaceFrame } from './AtmosphereSurfaceFrame';
import { LookChip, type LookTarget } from './look/LookChip';
import { useProjectAtmosphereEditor } from './look/useProjectAtmosphereEditor';

const ProjectLook = React.createContext<LookTarget | null>(null);
export function ProjectAtmosphereFrame(props: Readonly<{
    project: Readonly<{ serverId: string; projectKey: string }>;
    focused?: boolean;
    column?: React.RefObject<View | null>;
    children: React.ReactNode;
}>) {
    const editor = useProjectAtmosphereEditor(props.project);
    const target = React.useMemo(() => ({ surface: { project: props.project }, editor }), [editor, props.project]);
    return <ProjectLook.Provider value={target}>
        <AtmosphereSurfaceFrame surface={target.surface} editor={editor} focused={props.focused} column={props.column}>
            {props.children}
        </AtmosphereSurfaceFrame>
    </ProjectLook.Provider>;
}
export function ProjectAtmosphereLookChip() {
    const target = React.useContext(ProjectLook);
    return target ? <LookChip target={target} testID="project-look" /> : null;
}
