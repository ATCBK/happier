import type { WidgetLayoutGroupV1 } from '@happier-dev/protocol/widgets';
import { getTranslationValue } from '@/text';

/** The group's own title, without the untitled/child-name presentation fallback. */
export function readWidgetGroupTitle(group: Pick<WidgetLayoutGroupV1, 'title' | 'titleKey'>): string | undefined {
    const translated = group.titleKey ? getTranslationValue(group.titleKey) : undefined;
    if (typeof translated === 'string') return translated;
    return group.title;
}
