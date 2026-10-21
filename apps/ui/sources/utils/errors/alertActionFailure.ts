import { Modal } from '@/modal';
import { t } from '@/text';

/** Deliberate disclosure of a typed Action failure, never its private transport details. */
export function alertActionFailure(failure: Readonly<{
    reason: string;
    code: string | null;
    context?: Readonly<{ phase: string; targetHome: string | null }>;
}>): void {
    if (!failure.code) {
        Modal.alert(t('common.error'), failure.reason);
        return;
    }
    const details = failure.context
        ? JSON.stringify({ code: failure.code, ...failure.context }, null, 2)
        : failure.code;
    Modal.alert(t('common.error'), failure.reason, [
        { text: t('approvals.technicalDetails'), onPress: () => Modal.alert(t('approvals.technicalDetails'), details) },
        { text: t('common.ok'), style: 'cancel' },
    ]);
}
