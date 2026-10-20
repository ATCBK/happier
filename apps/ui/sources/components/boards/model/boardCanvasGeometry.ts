/**
 * Canvas geometry for Boards: where a card lands when dropped or moved by keyboard, and how many
 * card columns the unplaced cards flow into. Positions are logical pixels from the canvas origin and
 * are the user's data (`positionsByItemRef`); they are kept on phones, which show By status only.
 */
export const BOARD_CANVAS_METRICS = Object.freeze({
    /** The snap grid, and the keyboard's move step. */
    gridStepPx: 24,
    /** A whole number of grid steps, so the horizontal gutter is exactly one step. */
    cardWidthPx: 408,
    gapPx: 24,
    /** The canvas's inner margin, so a card at the origin does not touch the page edge. */
    paddingPx: 24,
});

export type BoardCanvasPoint = Readonly<{ x: number; y: number }>;
export type BoardCanvasRect = BoardCanvasPoint & Readonly<{ width: number; height: number }>;
export type BoardCanvasDirection = 'up' | 'down' | 'left' | 'right';

function snapValue(value: number): number {
    const step = BOARD_CANVAS_METRICS.gridStepPx;
    return Math.round(value / step) * step;
}

function clampToCanvas(point: BoardCanvasPoint): BoardCanvasPoint {
    return { x: Math.max(0, Math.round(point.x)), y: Math.max(0, Math.round(point.y)) };
}

/**
 * Snapping on: the nearest grid point. Off: exactly where it was released, unless ⇧ was held for this
 * drop (`snapOnce`). Overlapping releases settle to the nearest free rectangle with the Canvas gutter.
 * Never off the canvas; the moving member does not obstruct itself.
 */
export function resolveBoardCardDrop(input: Readonly<{
    origin: BoardCanvasPoint;
    translation: BoardCanvasPoint;
    snap: boolean;
    snapOnce?: boolean;
    footprint?: BoardCanvasFootprint;
    occupied?: readonly (BoardCanvasFootprint & BoardCanvasPoint)[];
}>): BoardCanvasPoint {
    const x = input.origin.x + input.translation.x;
    const y = input.origin.y + input.translation.y;
    const snapping = input.snap || input.snapOnce === true;
    const point = clampToCanvas(snapping ? { x: snapValue(x), y: snapValue(y) } : { x, y });
    const member = input.footprint;
    if (!member) return point;
    const occupied = (input.occupied ?? []).filter(other => other.key !== member.key);
    const free = (candidate: BoardCanvasPoint) => !occupied.some(other => intersects(member, candidate, other));
    if (free(point)) return point;
    // A nearest point outside a union of forbidden rectangles lies on their edges (or the
    // requested axis). Testing their intersections also finds diagonal openings between cards.
    const xs = new Set([point.x, 0]), ys = new Set([point.y, 0]);
    const step = BOARD_CANVAS_METRICS.gridStepPx;
    for (const other of occupied) {
        const left = other.x - member.width - BOARD_CANVAS_METRICS.gapPx;
        const right = other.x + other.width + BOARD_CANVAS_METRICS.gapPx;
        const top = other.y - member.height - BOARD_CANVAS_METRICS.gapPx;
        const bottom = other.y + other.height + BOARD_CANVAS_METRICS.gapPx;
        xs.add(Math.max(0, snapping ? Math.floor(left / step) * step : Math.floor(left)));
        xs.add(snapping ? ceilToBoardCanvasGrid(right) : Math.ceil(right));
        ys.add(Math.max(0, snapping ? Math.floor(top / step) * step : Math.floor(top)));
        ys.add(snapping ? ceilToBoardCanvasGrid(bottom) : Math.ceil(bottom));
    }
    let best = point, distance = Infinity;
    for (const x of xs) for (const y of ys) {
        const candidateDistance = (x - point.x) ** 2 + (y - point.y) ** 2;
        if (candidateDistance >= distance || !free({ x, y })) continue;
        best = { x, y }; distance = candidateDistance;
    }
    return best;
}

/** An arrow key moves a focused card one grid step, first settling a free position onto the grid. */
export function moveBoardCardByKeyboard(position: BoardCanvasPoint, direction: BoardCanvasDirection): BoardCanvasPoint {
    const step = BOARD_CANVAS_METRICS.gridStepPx;
    const x = snapValue(position.x);
    const y = snapValue(position.y);
    switch (direction) {
        case 'up': return clampToCanvas({ x, y: y - step });
        case 'down': return clampToCanvas({ x, y: y + step });
        case 'left': return clampToCanvas({ x: x - step, y });
        case 'right': return clampToCanvas({ x: x + step, y });
    }
}

/** How many card columns fit in the canvas width; unplaced cards flow into them. */
export function resolveBoardCanvasColumnCount(widthPx: number): number {
    const { cardWidthPx, gapPx } = BOARD_CANVAS_METRICS;
    const stride = cardWidthPx + gapPx;
    return Math.max(1, Math.floor((widthPx - cardWidthPx) / stride) + 1);
}

export function ceilToBoardCanvasGrid(value: number): number {
    return Math.ceil(value / BOARD_CANVAS_METRICS.gridStepPx) * BOARD_CANVAS_METRICS.gridStepPx;
}

export type BoardCanvasFootprint = Readonly<{ key: string; width: number; height: number }>;

function intersects(member: BoardCanvasFootprint, point: BoardCanvasPoint, other: BoardCanvasFootprint & BoardCanvasPoint): boolean {
    const { gapPx } = BOARD_CANVAS_METRICS;
    return point.x < other.x + other.width + gapPx && other.x < point.x + member.width + gapPx
        && point.y < other.y + other.height + gapPx && other.y < point.y + member.height + gapPx;
}

/** Whether two rectangles actually share area: a hand-placed card closer than the gutter is the user's choice, not a collision. */
function overlaps(member: BoardCanvasFootprint, point: BoardCanvasPoint, other: BoardCanvasFootprint & BoardCanvasPoint): boolean {
    return point.x < other.x + other.width && other.x < point.x + member.width
        && point.y < other.y + other.height && other.y < point.y + member.height;
}

/** One placement owner for saved XY and measured auto cards. Auto positions are visit-local only. */
export function resolveBoardCanvasPositions(input: Readonly<{
    members: readonly BoardCanvasFootprint[];
    positionsByItemRef: Readonly<Record<string, BoardCanvasPoint>>;
    columnCount: number;
    snap: boolean;
    previous: ReadonlyMap<string, BoardCanvasPoint>;
}>): ReadonlyMap<string, BoardCanvasPoint> {
    const { cardWidthPx, gapPx } = BOARD_CANVAS_METRICS;
    const stride = cardWidthPx + gapPx;
    const right = (input.columnCount - 1) * stride + cardWidthPx;
    const occupied: (BoardCanvasFootprint & BoardCanvasPoint)[] = [];
    const next = new Map<string, BoardCanvasPoint>();
    const place = (member: BoardCanvasFootprint, point: BoardCanvasPoint) => {
        const previous = input.previous.get(member.key);
        next.set(member.key, previous?.x === point.x && previous.y === point.y ? previous : point);
        occupied.push({ ...member, ...point });
    };
    // Reserve every hand-placed rectangle before considering any auto card, regardless of Board order.
    // Stored positions can collide (a card that was not visible when its neighbour was set down); the
    // first in Board order keeps its place and the others settle at the nearest free slot, for display
    // only: the stored position is the user's data and is not rewritten here.
    const displaced: BoardCanvasFootprint[] = [];
    for (const member of input.members) {
        const saved = input.positionsByItemRef[member.key];
        if (!saved) continue;
        if (occupied.some(other => overlaps(member, saved, other))) displaced.push(member);
        else place(member, saved);
    }
    for (const member of displaced) {
        place(member, resolveBoardCardDrop({ origin: input.positionsByItemRef[member.key]!, translation: { x: 0, y: 0 },
            snap: input.snap, footprint: member, occupied }));
    }
    // Auto flow is a projection of the current members, not saved layout. Recompute in Board
    // order so filtering closes vacated slots; identical inputs still reuse each point and map.
    for (const member of input.members) {
        if (input.positionsByItemRef[member.key]) continue;
        let best: BoardCanvasPoint | null = null;
        for (let column = 0; column < input.columnCount; column += 1) {
            const x = column * stride;
            if (column > 0 && x + member.width > right) break;
            let y = 0;
            for (;;) {
                const hits = occupied.filter(other => intersects(member, { x, y }, other));
                if (!hits.length) break;
                y = Math.max(...hits.map(other => other.y + other.height + gapPx));
                y = ceilToBoardCanvasGrid(y);
            }
            if (!best || y < best.y) best = { x, y };
        }
        place(member, best!);
    }
    return next.size === input.previous.size && [...next].every(([key, point]) => input.previous.get(key) === point)
        ? input.previous : next;
}
