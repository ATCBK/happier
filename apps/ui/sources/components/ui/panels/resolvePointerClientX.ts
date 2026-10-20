import { resolvePointerClientPoint } from '@happier-dev/plugin-ui/presentation';

export function resolvePointerClientX(event: unknown): number | null {
    return resolvePointerClientPoint(event).x;
}
