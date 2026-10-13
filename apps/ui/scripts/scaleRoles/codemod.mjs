import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ts = createRequire(import.meta.url)('typescript');
export const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
export const defaultRoots = ['apps/ui/sources', 'packages/plugin-ui/src'];
const steps = new Set([2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48]);
const margins = { xs: 's4', sm: 's8', md: 's12', lg: 's16', xl: 's20', xxl: 's24' };
// The public snapshot keeps its five keys; these are projections of the app's spacing owner.
const pluginSpacing = { 4: 'xsmall', 8: 'small', 12: 'medium', 16: 'large', 20: 'xlarge' };
const legacyRoles = { heading: 'title', title: 'heading', caption: 'micro', body: 'meta' };
const roleProps = new Set(['variant', 'triggerTextVariant', 'titleRole', 'sectionHeaderTitleRole', 'nameVariant']);
const roleCalls = /^(?:useHappierTypeRoleStyle|resolveHappierTypeRoleStyle|readHappierTypeRoleTabular|readCollectionLineHeight)$/;
const spacing = /^(?:padding|margin)(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?$|^(?:gap|rowGap|columnGap)$/;
const excluded = /(?:^|\/)(?:node_modules|dist|\.git)\/|(?:\.test(?:-d)?|\.spec)\.[cm]?[jt]sx?$|\/__tests__\//;
const domain = /(?:^|\/)(?:markdown|terminal|diff|code)(?:\/|$)/i;

export async function sourceFiles(roots = defaultRoots, includeTests = false) {
  const files = [];
  async function walk(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (['node_modules', 'dist', '.git'].includes(entry.name) || entry.name.startsWith('.') || entry.name.endsWith('.generated.ts') || entry.isSymbolicLink()) continue;
        await walk(resolve(path, entry.name));
      }
    } else if (/\.[cm]?[jt]sx?$/.test(path) && (includeTests || !excluded.test(path))) files.push(path);
  }
  for (const root of roots) await walk(resolve(repoRoot, root));
  return [...new Set(files)].sort();
}

function propertyName(node, source) { return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : node.name?.getText(source); }
function numeric(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  return null;
}
function platformMetric(node) {
  const literal = numeric(node);
  if (literal !== null) return literal;
  if (ts.isCallExpression(node) && node.expression.getText() === 'Platform.select' && ts.isObjectLiteralExpression(node.arguments[0])) {
    const fallback = node.arguments[0].properties.find(property => ts.isPropertyAssignment(property) && property.name.getText().replaceAll(/["']/g, '') === 'default');
    return fallback ? numeric(fallback.initializer) : null;
  }
  return null;
}
function animatedOrMeasured(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && /(?:useAnimatedStyle|interpolate|withTiming|withSpring|measure)/.test(parent.expression.getText())) return true;
    if (ts.isJsxAttribute(parent) && ts.isJsxOpeningLikeElement(parent.parent.parent) && parent.parent.parent.tagName.getText().startsWith('Animated.')) return true;
  }
  return false;
}
function codeTextMetrics(node, source) {
  // D8 is a text-domain boundary, not a folder convention: CommandView also
  // renders code outside the code/terminal trees. UI mono modifiers still snap.
  return ts.isObjectLiteralExpression(node.parent) && node.parent.properties.some(property =>
    ts.isPropertyAssignment(property) && propertyName(property, source) === 'fontFamily'
    && (ts.isCallExpression(property.initializer) && property.initializer.expression.getText(source) === 'resolveCodeMonoFontFamily'
      || ts.isStringLiteral(property.initializer) && property.initializer.text === 'Menlo'));
}
function nearestRole(size, weight, line) {
  size = Math.floor(size);
  if (size >= 26) return { role: 'display', flag: size > 34 };
  if (size >= 20) return { role: 'title', flag: size >= 24 };
  if (size >= 15 && weight === 'semiBold') return { role: 'heading', flag: size >= 18 };
  if (size >= 15) return { role: 'label', flag: true };
  if (size >= 14) return { role: size === 14 && weight === 'regular' && line >= 21 ? 'reading' : 'label', flag: size === 14 && weight === 'regular' && !(line >= 21) };
  if (size >= 13) return { role: 'body', flag: false };
  if (size >= 12) return { role: 'meta', flag: false };
  return { role: 'micro', flag: size <= 10.5 };
}
function removeProperty(node, source) {
  const start = node.getStart(source);
  let end = node.end;
  if (source.text[end] === ',') end++;
  const lineStart = source.text.lastIndexOf('\n', start - 1) + 1;
  const nextLine = source.text.indexOf('\n', end);
  if (nextLine !== -1 && /^[ \t]*$/.test(source.text.slice(lineStart, start)) && /^[ \t\r]*$/.test(source.text.slice(end, nextLine))) {
    return { start: lineStart, end: nextLine + 1, text: '' };
  }
  return { start, end, text: '' };
}
function scopeHas(node, name, source, nonOptional = false) {
  const contains = binding => ts.isIdentifier(binding) ? binding.text === name : binding.elements.some(element => ts.isBindingElement(element) && contains(element.name));
  // Require a lexical binding, rather than finding an unrelated theme hook elsewhere in the file.
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) continue;
    const declarations = ts.isFunctionLike(scope) ? scope.parameters : scope.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
    const binding = declarations.find(declaration => contains(declaration.name));
    if (binding) {
      if (!nonOptional) return true;
      return !binding.questionToken && !/(?:^|\W)(?:null|undefined)(?:$|\W)/.test(binding.type?.getText(source) ?? '')
        && !(binding.initializer && ts.isCallExpression(binding.initializer) && /^useOptional/.test(binding.initializer.expression.getText(source)));
    }
  }
  return false;
}

/** Dry-run analysis. Edits preserve all bytes outside selected AST ranges. */
export async function analyzeFile(path) {
  const text = await readFile(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const file = relative(repoRoot, path).replaceAll('\\', '/');
  const sites = [], edits = [];
  if (file === 'packages/plugin-ui/src/presentation/text/typeScale.ts') return { path, text, sites, edits };
  const special = domain.test(file);
  const dev = /(?:app\/\(app\)\/dev|components\/dev)\//.test(file);
  const scale = await loadTypeScale();
  let needsTypography = false, needsPluginRole = false;
  const addSite = (node, kind, value, status, reason, extra = {}) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    sites.push({ file, line: line + 1, column: character + 1, kind, value, status, reason, ...extra });
  };
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties;
      const weightProp = props.find(prop => ts.isPropertyAssignment(prop) && propertyName(prop, source) === 'fontWeight');
      const weightValue = weightProp && Number(weightProp.initializer.getText(source).replaceAll(/["']/g, ''));
      const fontSize = props.find(prop => ts.isPropertyAssignment(prop) && propertyName(prop, source) === 'fontSize');
      const face = props.find(prop => ts.isSpreadAssignment(prop) && ts.isCallExpression(prop.expression) && ['Typography.default', 'Typography.variant'].includes(prop.expression.expression.getText(source)));
      const family = props.find(prop => ts.isPropertyAssignment(prop) && propertyName(prop, source) === 'fontFamily' && ts.isStringLiteral(prop.initializer) && /^Inter-(?:Regular|Medium|SemiBold)$/.test(prop.initializer.text));
      // Font-size rewrites handle their adjacent weight atomically. Ambiguous sizes stay untouched.
      if (!fontSize && weightProp && Number.isFinite(weightValue) && weightValue > 0 && (face || family) && !special && !animatedOrMeasured(node)) {
        const emphasis = weightValue > 550 ? 'semiBold' : weightValue > 450 ? 'medium' : 'regular';
        if (face?.expression.expression.getText(source) === 'Typography.default' && face.expression.arguments[0]?.text === 'italic') {
          addSite(weightProp, 'font-weight', weightValue, 'flagged', 'italic face requires visual judgment');
        } else {
          if (face) {
            const role = face.expression.expression.getText(source) === 'Typography.variant' ? face.expression.arguments[0]?.getText(source) : null;
            edits.push({ start: face.expression.getStart(source), end: face.expression.end, text: role ? `Typography.variant(${role}, '${emphasis}')` : `Typography.default('${emphasis}')` });
          } else if (file.startsWith('packages/plugin-ui/')) {
            edits.push({ start: family.initializer.getStart(source), end: family.initializer.end, text: `'Inter-${emphasis === 'semiBold' ? 'SemiBold' : emphasis === 'medium' ? 'Medium' : 'Regular'}'` });
          } else {
            edits.push({ start: family.getStart(source), end: family.end, text: `...Typography.default('${emphasis}')` });
            needsTypography = true;
          }
          edits.push(removeProperty(weightProp, source));
          addSite(weightProp, 'font-weight', weightValue, 'exact', 'Inter face emphasis; numeric weight removed', { emphasis });
        }
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(node, source), value = key === 'fontSize' ? platformMetric(node.initializer) : numeric(node.initializer);
      if (['lineHeight', 'letterSpacing'].includes(key)) addSite(node, key === 'lineHeight' ? 'line-height' : 'tracking', platformMetric(node.initializer) ?? node.initializer.getText(source), 'observed', 'authored metric');
      if (key === 'fontSize') {
        if (value === null) {
          // A platform fork maps by its default branch; an area visual pass owns collapsing it.
          addSite(node, 'font', node.initializer.getText(source), 'flagged', 'computed or platform-forked size');
        } else if (special || codeTextMetrics(node, source) || animatedOrMeasured(node) || /(?:emoji|glyph|avatar|icon|initials)/i.test(node.parent.parent?.getText(source).split('{')[0] ?? '')) {
          addSite(node, 'font', value, 'flagged', special || codeTextMetrics(node, source) ? 'domain scale' : animatedOrMeasured(node) ? 'animation or measured layout' : 'glyph or avatar text');
        } else {
          const object = node.parent;
          const props = ts.isObjectLiteralExpression(object) ? object.properties : [];
          const weightProp = props.find(prop => ts.isPropertyAssignment(prop) && propertyName(prop, source) === 'fontWeight');
          const face = props.find(prop => ts.isSpreadAssignment(prop) && /^Typography\.default\(/.test(prop.expression.getText(source)));
          const interFamily = props.find(prop => ts.isPropertyAssignment(prop) && propertyName(prop, source) === 'fontFamily' && ts.isStringLiteral(prop.initializer) && /^Inter-(?:Regular|Medium|SemiBold)$/.test(prop.initializer.text));
          const weightText = weightProp?.initializer.getText(source).replaceAll(/["']/g, '') ?? face?.expression.arguments[0]?.text ?? (face ? 'regular' : null);
          const parsedWeight = Number(weightText);
          const weight = ['bold', 'semiBold'].includes(weightText) || parsedWeight > 550 ? 'semiBold' : weightText === 'medium' || parsedWeight > 450 ? 'medium' : weightText === 'regular' || parsedWeight === 400 ? 'regular' : null;
          const lineProp = props.find(prop => ts.isPropertyAssignment(prop) && propertyName(prop, source) === 'lineHeight');
          const trackingProp = props.find(prop => ts.isPropertyAssignment(prop) && propertyName(prop, source) === 'letterSpacing');
          const line = lineProp ? platformMetric(lineProp.initializer) : null;
          const mapping = nearestRole(value, weight, line);
          const plugin = file.startsWith('packages/plugin-ui/');
          const themeInScope = scopeHas(node, 'theme', source, plugin), typographyInScope = scopeHas(node, 'typography', source);
          const inputFloor = value === 16 && /TextInput/.test(text);
          const italicFace = face?.expression.arguments[0]?.text === 'italic';
          const devMove = dev && (value !== scale[mapping.role].fontSize || line !== null && line !== scale[mapping.role].lineHeight || trackingProp && platformMetric(trackingProp.initializer) !== scale[mapping.role].letterSpacing);
          const ambiguous = !weight || mapping.flag || inputFloor || italicFace || devMove || plugin && (!themeInScope || !typographyInScope);
          if (ambiguous) addSite(node, 'font', value, 'flagged', !weight ? 'no adjacent weight' : inputFloor ? 'TextInput zoom floor' : italicFace ? 'italic face requires visual judgment' : devMove ? 'dev routes accept exact matches only' : mapping.flag ? 'role requires visual judgment' : 'plugin theme/typography binding missing', { role: mapping.role });
          else {
            const role = scale[mapping.role];
            const emphasis = weight === role.weight ? '' : `, '${weight}'`;
            const expression = plugin ? `...resolveHappierTypeRoleStyle('${mapping.role}', theme, typography${emphasis})` : `...Typography.variant('${mapping.role}'${emphasis})`;
            edits.push({ start: node.getStart(source), end: node.end, text: expression });
            if (face) edits.push(removeProperty(face, source));
            if (interFamily) edits.push(removeProperty(interFamily, source));
            if (weightProp) edits.push(removeProperty(weightProp, source));
            for (const [prop, target, tolerance] of [[lineProp, role.lineHeight, 2], [trackingProp, role.letterSpacing, 0.2]]) {
              if (!prop) continue;
              const metric = platformMetric(prop.initializer);
              if (metric !== null && Math.abs(metric - target) <= tolerance) edits.push(removeProperty(prop, source));
              else addSite(prop, 'font-metric', prop.initializer.getText(source), 'flagged', 'retained line height or tracking override', { role: mapping.role });
            }
            needsTypography ||= !plugin; needsPluginRole ||= plugin;
            addSite(node, 'font', value, value === role.fontSize ? 'exact' : 'rounded', 'role reference', { role: mapping.role });
          }
        }
      } else if (spacing.test(key)) {
        const authored = node.initializer.getText(source);
        const owned = /^theme\.(?:space\.s(?:2|4|6|8|10|12|16|20|24|32|40|48)|spacing\.(?:xsmall|small|medium|large|xlarge))$/.test(authored)
          || /^(?:HAPPIER_PAGE_METRICS|PAGE_LIST_METRICS)\.[A-Za-z]+$/.test(authored);
        if (value === null) {
          if (!owned) addSite(node, 'spacing', authored, 'flagged', 'computed spacing');
        }
        else if (value <= 0 || [1, 3].includes(value)) addSite(node, 'spacing', value, 'retained', 'hairline or optical offset');
        else if (special || animatedOrMeasured(node) || dev && !steps.has(value) || !scopeHas(node, 'theme', source, file.startsWith('packages/plugin-ui/'))) addSite(node, 'spacing', value, 'flagged', special ? 'domain scale' : dev && !steps.has(value) ? 'dev routes accept exact matches only' : 'theme binding missing, optional or measured layout');
        else {
          const step = steps.has(value) ? value : [5, 7, 9, 11, 13].includes(value) ? value - 1 : null;
          if (step === null) addSite(node, 'spacing', value, 'flagged', 'layout role or visual judgment');
          else {
            const plugin = file.startsWith('packages/plugin-ui/');
            if (plugin && !pluginSpacing[step]) addSite(node, 'spacing', value, 'flagged', 'spacing step unavailable in public theme snapshot');
            else {
              edits.push({ start: node.initializer.getStart(source), end: node.initializer.end, text: plugin ? `theme.spacing.${pluginSpacing[step]}` : `theme.space.s${step}` });
              addSite(node, 'spacing', value, value === step ? 'exact' : 'rounded', 'spacing step', { step: `s${step}` });
            }
          }
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'margins' && node.expression.expression.getText(source) === 'theme' && margins[node.name.text]) {
      edits.push({ start: node.getStart(source), end: node.end, text: `theme.space.${margins[node.name.text]}` });
      addSite(node, 'legacy-spacing', node.getText(source), 'exact', 'legacy margin alias');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (needsTypography && !source.statements.some(statement => ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(element => element.name.text === 'Typography'))) edits.push({ start: 0, end: 0, text: "import { Typography } from '@/constants/Typography';\n" });
  if (needsPluginRole && !source.statements.some(statement => ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(element => element.name.text === 'resolveHappierTypeRoleStyle'))) {
    let importPath = relative(dirname(path), resolve(repoRoot, 'packages/plugin-ui/src/presentation/text/typeRole.js')).replaceAll('\\', '/');
    if (!importPath.startsWith('.')) importPath = `./${importPath}`;
    edits.push({ start: 0, end: 0, text: `import { resolveHappierTypeRoleStyle } from '${importPath}';\n` });
  }
  return { path, text, sites, edits };
}
let typeScale;
async function loadTypeScale() {
  if (typeScale) return typeScale;
  const { transform } = await import('esbuild');
  const { code } = await transform(await readFile(resolve(repoRoot, 'packages/plugin-ui/src/presentation/text/typeScale.ts'), 'utf8'), { loader: 'ts', format: 'esm' });
  typeScale = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).HAPPIER_TYPE_SCALE;
  return typeScale;
}

/** D1 is a separate semantic rename, applied once to the old vocabulary, never as a family snap. */
export function legacyRoleEdits(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), edits = [];
  function visit(node) {
    if (ts.isStringLiteral(node) && legacyRoles[node.text]) {
      let ancestor = node.parent, relevant = false;
      while (ancestor && !ts.isSourceFile(ancestor) && !ts.isBlock(ancestor)) {
        if (ts.isJsxAttribute(ancestor) && roleProps.has(ancestor.name.text) || ts.isPropertyAssignment(ancestor) && roleProps.has(propertyName(ancestor, source)) || ts.isBindingElement(ancestor) && roleProps.has(ancestor.name.getText(source))) relevant = true;
        if (ts.isCallExpression(ancestor) && roleCalls.test(ancestor.expression.getText(source)) && ancestor.arguments[0].pos <= node.pos && node.end <= ancestor.arguments[0].end) relevant = true;
        if (ts.isVariableDeclaration(ancestor) && ancestor.name.getText(source) === 'role' && /resolveHappierTypeRoleStyle|useHappierTypeRoleStyle/.test(text)) relevant = true;
        if (ts.isBinaryExpression(ancestor) && roleProps.has(ancestor.left.getText(source))) relevant = true;
        ancestor = ancestor.parent;
      }
      if (relevant) edits.push({ start: node.getStart(source) + 1, end: node.end - 1, text: legacyRoles[node.text], before: node.text });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return edits;
}
export function applyEdits(text, edits) {
  let previous = text.length + 1;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (edit.end > previous) throw new Error('Overlapping AST edits');
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); previous = edit.start;
  }
  return text;
}
export function patchFor(path, before, after) {
  return `*** Begin Patch\n*** Update File: ${relative(repoRoot, path)}\n@@\n${before.trimEnd().split('\n').map(line => `-${line}`).join('\n')}\n${after.trimEnd().split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), write = args.includes('--write');
  const roots = args.filter(arg => !arg.startsWith('--'));
  const files = await sourceFiles(roots.length ? roots : defaultRoots);
  for (const path of files) {
    const result = await analyzeFile(path);
    if (write && result.edits.length) {
      // Mutations go through the repository's patch protocol, never through AST printing.
      const { spawnSync } = await import('node:child_process');
      const patch = patchFor(path, result.text, applyEdits(result.text, result.edits));
      const applied = spawnSync('apply_patch', [], { input: patch, cwd: repoRoot, encoding: 'utf8' });
      if (applied.status !== 0) throw new Error(`${relative(repoRoot, path)}: ${applied.error?.message || applied.stderr || applied.stdout || `apply_patch failed (${applied.signal ?? applied.status})`}`);
    }
    for (const site of result.sites) console.log(JSON.stringify(site));
  }
}
