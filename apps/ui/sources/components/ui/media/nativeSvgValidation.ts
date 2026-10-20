export type NativeSvgNode = Readonly<{
    tag: string;
    props: Readonly<Record<string, unknown>>;
    children: readonly (NativeSvgNode | string)[];
}>;

const LOCAL_FRAGMENT_PATTERN = /^#[A-Za-z0-9_.:-]+$/;
const SAFE_RASTER_DATA_URI_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i;

function isLocalFragment(value: string): boolean {
    return value === value.trim() && LOCAL_FRAGMENT_PATTERN.test(value);
}

function containsOnlyLocalCssUrls(value: string): boolean {
    const urlStartPattern = /url\s*\(/gi;
    while (urlStartPattern.exec(value) !== null) {
        const targetEnd = value.indexOf(')', urlStartPattern.lastIndex);
        if (targetEnd < 0) return false;
        let target = value.slice(urlStartPattern.lastIndex, targetEnd).trim();
        const quote = target[0];
        if (quote === '"' || quote === "'") {
            if (target.at(-1) !== quote) return false;
            target = target.slice(1, -1);
        }
        if (!isLocalFragment(target)) return false;
        urlStartPattern.lastIndex = targetEnd + 1;
    }
    return true;
}

function isSafeProperty(tag: string, property: string, value: unknown): boolean {
    if (/^on/i.test(property)) return false;
    const normalizedProperty = property.toLowerCase().replace(':', '');
    if (normalizedProperty === 'href' || normalizedProperty === 'xlinkhref') {
        if (typeof value !== 'string') return false;
        if (isLocalFragment(value)) return true;
        if (tag !== 'image' && tag !== 'feimage') return false;
        if (value !== value.trim()) return false;
        const raster = SAFE_RASTER_DATA_URI_PATTERN.exec(value);
        return typeof raster?.[1] === 'string' && raster[1].length > 0;
    }
    if (typeof value === 'string') return containsOnlyLocalCssUrls(value);
    if (value && typeof value === 'object') {
        return !Array.isArray(value) && Object.entries(value).every(([name, nested]) => isSafeProperty(tag, name, nested));
    }
    return true;
}

function isSafeNode(node: NativeSvgNode): boolean {
    const tag = node.tag.toLowerCase();
    if (tag === 'foreignobject' || tag === 'script') return false;
    return Object.entries(node.props).every(([property, value]) => isSafeProperty(tag, property, value))
        && node.children.every(child => typeof child === 'string' || isSafeNode(child));
}

/** Validate the parser's raw tree before react-native-svg creates any drawing elements. */
export function isSafeNativeSvgAst(root: NativeSvgNode): boolean {
    return root.tag === 'svg' && isSafeNode(root);
}
