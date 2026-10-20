import { t } from '@/text';

export function describeComposerEntityDropReason(code: string): string {
    if (code === 'scopeMismatch') return t('entityDragDrop.surface.scopeMismatch');
    if (code === 'notEditable') return t('entityDragDrop.composer.readOnly');
    if (code === 'workspaceMismatch') return t('entityDragDrop.composer.otherWorkspace');
    return t('entityDragDrop.composer.unavailable');
}
