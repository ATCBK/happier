export type PointerClientPoint = Readonly<{ x: number | null; y: number | null }>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : {};
}

export function resolvePointerClientPoint(event: unknown): PointerClientPoint {
    const record = readRecord(event);
    const nativeEvent = readRecord(record.nativeEvent);

    const readNumber = (value: unknown): number | null => {
        if (typeof value !== 'number') return null;
        if (!Number.isFinite(value)) return null;
        return value;
    };

    const directX =
        readNumber(nativeEvent.clientX)
        ?? readNumber(record.clientX)
        ?? readNumber(nativeEvent.pageX)
        ?? readNumber(record.pageX);

    const directY =
        readNumber(nativeEvent.clientY)
        ?? readNumber(record.clientY)
        ?? readNumber(nativeEvent.pageY)
        ?? readNumber(record.pageY);

    if (directX != null || directY != null) {
        return { x: directX ?? null, y: directY ?? null };
    }

    const touch0 = readRecord(readRecord(record.touches)[0] ?? readRecord(record.changedTouches)[0]);
    const touchX = readNumber(touch0?.clientX) ?? readNumber(touch0?.pageX);
    const touchY = readNumber(touch0?.clientY) ?? readNumber(touch0?.pageY);
    if (touchX != null || touchY != null) {
        return { x: touchX ?? null, y: touchY ?? null };
    }

    // Last-ditch: some event shims provide `x`/`y` coordinates.
    const xValue = readNumber(nativeEvent.x) ?? readNumber(record.x);
    const yValue = readNumber(nativeEvent.y) ?? readNumber(record.y);
    return { x: xValue ?? null, y: yValue ?? null };
}

