import { splitSkillMarkdownV1 } from './skillLibraryItemV1.js';

const fencePattern = /^\s*(```|~~~)/;
// `[text](target "title")`, `![alt](<target>)` and `[label]: target` definitions.
const inlineLinkPattern =
  /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const definitionPattern = /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/;
const inlineCodePattern = /`([^`\n]+)`/g;
const schemePattern = /^[a-z][a-z0-9+.-]*:/i;
const plainPathPattern = /^[\w.@+\- /]+$/;

function proseLines(body: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const opening = fencePattern.exec(line)?.[1];
    if (opening !== undefined) {
      if (fence === null) fence = opening;
      else if (fence === opening) fence = null;
      continue;
    }
    if (fence === null) lines.push(line);
  }
  return lines;
}

function readableTarget(raw: string): string | null {
  let target = raw.trim();
  const cut = target.search(/[#?]/);
  if (cut >= 0) target = target.slice(0, cut);
  if (
    target === '' ||
    target.startsWith('/') ||
    target.startsWith('~') ||
    target.startsWith('$') ||
    schemePattern.test(target)
  )
    return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  return plainPathPattern.test(target) ? target : null;
}

/** Where a relative reference lands inside the skill folder, or `null` when it climbs out of it. */
function resolveInsideSkill(target: string): string | null {
  const resolved: string[] = [];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') resolved.push(segment);
    else if (resolved.pop() === undefined) return null;
  }
  return resolved.join('/');
}

/**
 * The relative files a skill's instructions point at that its bundle will not have: a link or an inline `../` path that climbs out of the skill folder, or a link that names a file the folder lacks. Only
 * written references count: URLs, anchors, absolute paths, fenced examples and prose are never read as
 * dependencies. Advisory; it never changes what is imported.
 */
export function readSkillOutsideReferencesV1(
  skillMarkdown: string,
  bundlePaths: readonly string[],
): string[] {
  const candidates: string[] = [];
  for (const line of proseLines(splitSkillMarkdownV1(skillMarkdown).body)) {
    const definition = definitionPattern.exec(line);
    if (definition) candidates.push(definition[1] ?? definition[2]!);
    // A link written inside a code span is an example, not a reference.
    for (const link of line.replace(inlineCodePattern, '').matchAll(inlineLinkPattern))
      candidates.push(link[1] ?? link[2]!);
    // Inline paths count only when they leave the folder: `./x` is as often a path in the user's project.
    for (const code of line.matchAll(inlineCodePattern)) {
      const path = code[1]!.trim();
      if (path.startsWith('../') && !/\s/.test(path)) candidates.push(path);
    }
  }
  const found = new Set<string>();
  for (const candidate of candidates) {
    const target = readableTarget(candidate);
    if (target === null) continue;
    const inside = resolveInsideSkill(target);
    if (inside === '') continue;
    if (
      inside === null ||
      !bundlePaths.some(
        (path) => path === inside || path.startsWith(`${inside}/`),
      )
    )
      found.add(target);
  }
  return [...found];
}

/**
 * The skill folders in the same source tree that a skill's outside references point at, as tree-relative
 * paths: `../b/SKILL.md` names `b`, and `../b/`, `../b` or `../b/references/x.md` name the folder one level
 * below where this skill's path and the reference part. Whether such a folder really holds a `SKILL.md` is
 * the caller's check against the tree it has.
 */
export function readSiblingSkillPathsV1(skillPath: string, references: readonly string[]): string[] {
  const own = skillPath.split('/').filter(Boolean);
  const siblings = new Set<string>();
  for (const reference of references) {
    const target = [...own];
    let climbed = true;
    for (const segment of reference.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment !== '..') target.push(segment);
      else if (target.pop() === undefined) {
        climbed = false;
        break;
      }
    }
    if (!climbed) continue;
    let shared = 0;
    while (shared < own.length && shared < target.length && own[shared] === target[shared]) shared++;
    // Inside this skill's own folder (a missing file), or an ancestor of it: not a sibling.
    if (shared === own.length || shared === target.length) continue;
    if (target.at(-1) === 'SKILL.md') target.pop();
    else if (target.length === shared + 1 && target[shared]!.includes('.')) continue;
    else target.length = shared + 1;
    siblings.add(target.join('/'));
  }
  return [...siblings];
}
