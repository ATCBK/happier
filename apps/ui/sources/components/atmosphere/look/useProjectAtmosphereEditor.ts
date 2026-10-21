import * as React from 'react';
import { useProjectAtmosphere, useSetting } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storage';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { ProjectAtmosphere, AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AtmosphereEditor } from './atmosphereEditor';
import { projectAtmosphereEdit } from './projectAtmosphereEdit';
import { mutateProjectAtmosphereSetting } from '../projectAtmosphereSettings';

/** Look edits the existing private Project organization row through its captured-Account CAS owner. */
export function useProjectAtmosphereEditor(project: Readonly<{ serverId: string; projectKey: string }>): AtmosphereEditor {
    const home = useSetting('homeAtmosphere');
    const override = useProjectAtmosphere(project);
    const pending = React.useRef(Promise.resolve());
    const write = React.useCallback((edit: ((value: ProjectAtmosphere) => ProjectAtmosphere) | 'home') => {
        const scope = storage.getState().profileScope;
        // A drag can submit another edit while its prior HTTP write is in flight. Reapply each intent
        // to the fresh row, never to the panel's render-time snapshot; the row owner still owns CAS.
        const run = async () => {
            const account = await captureLazyActionAccountContext(project.serverId);
            try {
                if (!scope || scope.serverId !== project.serverId || scope.accountId !== account.accountId) throw new Error('project_account_scope_changed');
                const rows = createUiProjectAccountRowsClient(account);
                const result = await mutateProjectAtmosphereSetting({ rows, scope, target: project, edit,
                    isCurrent: () => { try { account.assertCurrent(); return true; } catch { return false; } },
                    readHome: async () => storage.getState().settings.homeAtmosphere });
                if (result.status !== 'updated') throw new Error('project_account_mutation_conflict');
            } finally { account.dispose(); }
        };
        pending.current = pending.current.then(run).catch(() => { Modal.alert(t('common.error'), t('errors.tryAgain')); });
    }, [project.projectKey, project.serverId]);
    return React.useMemo<AtmosphereEditor>(() => ({
        value: projectAtmosphereEdit(home, override, value => value),
        pictureActions: { target: { kind: 'project', serverId: project.serverId, projectKey: project.projectKey } },
        update: (edit: (value: AtmospherePresentation) => AtmospherePresentation) => write(current => ({ ...current, ...edit(current) })),
        sameAsHome: override === undefined || override === 'home',
        resetToHome: () => write('home'),
    }), [home, override, project.projectKey, project.serverId, write]);
}
