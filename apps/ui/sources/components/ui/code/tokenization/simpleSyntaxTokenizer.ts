export type SimpleSyntaxTokenType = 'keyword' | 'string' | 'number' | 'comment' | 'default';

export type SimpleSyntaxToken = Readonly<{
    text: string;
    type: SimpleSyntaxTokenType;
}>;

function isIdentifierStart(ch: string): boolean {
    return /[A-Za-z_$]/.test(ch);
}

function isIdentifierChar(ch: string): boolean {
    return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
    return /[0-9]/.test(ch);
}

function buildKeywordSet(language: string): ReadonlySet<string> {
    const base = [
        'if',
        'else',
        'for',
        'while',
        'do',
        'switch',
        'case',
        'break',
        'continue',
        'return',
        'try',
        'catch',
        'finally',
        'throw',
        'new',
        'import',
        'export',
        'from',
        'as',
        'in',
        'instanceof',
        'typeof',
        'void',
        'delete',
        'await',
        'async',
    ];

    const lang = language.toLowerCase();
    const tsLike = [
        'const',
        'let',
        'var',
        'function',
        'class',
        'interface',
        'type',
        'enum',
        'extends',
        'implements',
        'public',
        'private',
        'protected',
        'static',
        'readonly',
        'get',
        'set',
    ];

    const pyLike = [
        'def',
        'lambda',
        'pass',
        'yield',
        'with',
        'global',
        'nonlocal',
        'and',
        'or',
        'not',
        'is',
        'None',
        'True',
        'False',
    ];

    const keywords =
        lang === 'python' || lang === 'py'
            ? base.concat(pyLike)
            : lang === 'typescript' || lang === 'ts' || lang === 'javascript' || lang === 'js'
                ? base.concat(tsLike)
                : base;

    return new Set(keywords);
}

function shouldHighlightKeywords(language: string): boolean {
    const lang = language.toLowerCase();

    // Markdown and MDX are frequently plain prose; highlighting generic programming keywords is distracting.
    if (lang === 'markdown' || lang === 'md' || lang === 'mdx') return false;

    // Config-like formats: keep simple string/number/comment tokenization, but avoid keyword highlighting.
    if (lang === 'text' || lang === 'ini' || lang === 'toml' || lang === 'yaml' || lang === 'json' || lang === 'jsonc' || lang === 'dotenv') return false;

    return true;
}

// Languages whose comments start with `#`. They have no `//` or `/* */` comments, so a URL such as
// `https://…` in a shell command stays code instead of greying out the rest of the line.
const HASH_COMMENT_LANGUAGES: ReadonlySet<string> = new Set([
    'python', 'py', 'bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'ruby', 'rb', 'perl', 'r',
    'yaml', 'yml', 'toml', 'dockerfile', 'makefile', 'dotenv',
]);

function pushToken(out: SimpleSyntaxToken[], token: SimpleSyntaxToken) {
    const prev = out[out.length - 1];
    if (prev && prev.type === token.type) {
        out[out.length - 1] = { type: prev.type, text: prev.text + token.text };
        return;
    }
    out.push(token);
}

export function tokenizeSimpleSyntaxLine(params: {
    line: string;
    language: string | null;
}): SimpleSyntaxToken[] {
    const raw = params.line ?? '';
    const language = params.language;
    if (!language) return [{ text: raw, type: 'default' }];

    const keywords = shouldHighlightKeywords(language) ? buildKeywordSet(language) : null;
    const out: SimpleSyntaxToken[] = [];

    const lang = language.toLowerCase();
    const isPython = lang === 'python' || lang === 'py';
    const hashComments = HASH_COMMENT_LANGUAGES.has(lang);

    let i = 0;
    while (i < raw.length) {
        const ch = raw[i] ?? '';

        // Line comments. Outside Python, `#` opens a comment only at a word start (`$#`, `${#a}` stay code).
        if (!hashComments && ch === '/' && raw[i + 1] === '/') {
            pushToken(out, { type: 'comment', text: raw.slice(i) });
            break;
        }
        if (hashComments && ch === '#' && (isPython || i === 0 || /\s/.test(raw[i - 1] ?? ''))) {
            pushToken(out, { type: 'comment', text: raw.slice(i) });
            break;
        }

        // Block comment start.
        if (!hashComments && ch === '/' && raw[i + 1] === '*') {
            const end = raw.indexOf('*/', i + 2);
            const commentText = end === -1 ? raw.slice(i) : raw.slice(i, end + 2);
            pushToken(out, { type: 'comment', text: commentText });
            i += commentText.length;
            continue;
        }

        // Strings.
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            let j = i + 1;
            while (j < raw.length) {
                const cj = raw[j] ?? '';
                if (cj === '\\') {
                    j += 2;
                    continue;
                }
                if (cj === quote) {
                    j += 1;
                    break;
                }
                j += 1;
            }
            const str = raw.slice(i, j);
            pushToken(out, { type: 'string', text: str });
            i = j;
            continue;
        }

        // Numbers.
        if (isDigit(ch)) {
            let j = i + 1;
            while (j < raw.length) {
                const cj = raw[j] ?? '';
                if (isDigit(cj) || cj === '_' || cj === '.' || /[a-fA-Fxob]/.test(cj)) {
                    j += 1;
                    continue;
                }
                break;
            }
            pushToken(out, { type: 'number', text: raw.slice(i, j) });
            i = j;
            continue;
        }

        // Identifiers / keywords.
        if (isIdentifierStart(ch)) {
            let j = i + 1;
            while (j < raw.length && isIdentifierChar(raw[j] ?? '')) {
                j += 1;
            }
            const ident = raw.slice(i, j);
            pushToken(out, { type: keywords?.has(ident) ? 'keyword' : 'default', text: ident });
            i = j;
            continue;
        }

        // Everything else.
        pushToken(out, { type: 'default', text: ch });
        i += 1;
    }

    return out;
}

export function tokenizeSimpleSyntaxText(params: {
    text: string;
    language: string | null;
}): SimpleSyntaxToken[] {
    const raw = params.text ?? '';
    if (raw.length === 0) return [{ text: '', type: 'default' }];

    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const out: SimpleSyntaxToken[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (i > 0) out.push({ text: '\n', type: 'default' });
        out.push(...tokenizeSimpleSyntaxLine({ line: lines[i] ?? '', language: params.language }));
    }
    return out;
}
