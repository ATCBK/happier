#!/usr/bin/env node
// Run through apps/stack/bin/hstack-exec for repository-wide scans.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ts } from 'ts-morph';
import { transformSource } from './index.mjs';

const args = process.argv.slice(2);
let repo = realpathSync(resolve(import.meta.dirname, '../../..'));
if (args[0] === '--root') {
  args.shift();
  const root = args.shift();
  if (!root || !isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('--root requires an existing absolute directory');
  }
  repo = realpathSync(root);
}
const command = args.shift() ?? 'scan';
const write = args[0] === '--write';
if (write) args.shift();
if (!['scan', 'apply', 'bridge'].includes(command) || command === 'scan' && write || write && !args.length) {
  throw new Error('Usage: cli.mjs [--root <absolute directory>] scan [file ...] | apply [file ...] | apply --write <bounded files> | bridge [file ...] | bridge --write <bounded files>');
}
// apps/ui/tools/password/buildPasswordKdfWorker.mjs writes this minified public asset.
const generatedOrBuilt = path => path === 'apps/ui/public/happier-password-kdf-worker.js'
  || path === 'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js'
  || path.split('/').some(part => /^(?:node_modules|coverage|generated|vendor|\.expo|\.next|\.happier-plugin)$/.test(part)
  || /^dist(?:[.-].*)?$/.test(part)) || /\.generated\.[cm]?[jt]sx?$/.test(path);
const sourcePath = path => /\.(?:[cm]?[jt]sx?)$/.test(path) && !/\.d\.[cm]?ts$/.test(path) && !generatedOrBuilt(path);
const withinRoot = path => path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
function selectedPath(path) {
  const absolute = resolve(repo, path);
  if (!existsSync(absolute)) throw new Error('Paths must be existing, bounded locations within this root');
  const bounded = relative(repo, realpathSync(absolute));
  if (!withinRoot(bounded)) throw new Error('Paths must be existing, bounded locations within this root');
  return bounded;
}
const selected = (args.length ? args : ['apps', 'packages', 'scripts']).map(selectedPath);
function sourceFilesUnder(path) {
  try {
    return execFileSync('rg', ['--files', '--no-ignore', '-g', '!**/node_modules/**',
      '-g', '!**/dist/**', '-g', '!**/dist.*/**', '-g', '!**/dist-*/**',
      '-g', '!**/coverage/**', '-g', '!**/generated/**', '-g', '!**/*.generated.*',
      '-g', '!**/.happier-plugin/**', '-g', '!**/.git/**', '--', path],
    { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n').filter(sourcePath);
  } catch (error) {
    if (error.status === 1 && !error.stdout && !error.stderr) return [];
    throw error;
  }
}
const paths = [...new Set(selected.flatMap(path => sourcePath(path) ? [path] : sourceFilesUnder(path)))];
const candidateSource = source => /\bzod(?:\/|['"]|\b)|\bZod[A-Z]|\.(?:optional|nullable|nullish|default|prefault|catch|readonly|brand|array|or|and|pipe|transform|refine|superRefine|strict|strip|passthrough|catchall|extend|safeExtend|merge|pick|omit|partial|required|keyof|unwrap|removeDefault|removeCatch|toJSONSchema|extract|exclude|describe|meta|check|min|max|length|size|nonempty|int|safe|finite|gt|gte|lt|lte|step|nonnegative|positive|nonpositive|negative|multipleOf|trim|toLowerCase|toUpperCase|regex|email|url|uuid|datetime|parse|safeParse|format|flatten)\s*\(/.test(source)
  || /\.shape\.[\w$]+\.value\b|\.(?:valueType|minValue|maxValue)\b/.test(source);
if (write && selected.some(path => ['apps', 'packages', 'scripts'].includes(path))) throw new Error('--write requires a bounded subdirectory or explicit files');

function sourceFile(path) {
  if (!existsSync(path)) return null;
  const source = readFileSync(path, 'utf8');
  return { source, ast: ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true) };
}
function resolveSource(base) {
  const sourceBase = base.replace(/\.[cm]?js$/, '');
  const sourceCandidates = [`${sourceBase}.ts`, `${sourceBase}.tsx`, `${sourceBase}.mts`, `${sourceBase}.cts`];
  const candidates = /\.[cm]?js$/.test(base) ? [...sourceCandidates, base]
    : [base, ...sourceCandidates, `${sourceBase}.js`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (candidate.startsWith(`${repo}/`) && existsSync(candidate) && sourcePath(candidate)) return candidate;
  }
  return null;
}
const configAliases = new Map(), workspaceManifests = new Map();
function localAlias(from, specifier) {
  if (!specifier.startsWith('@/')) return null;
  for (let folder = dirname(from); folder.startsWith(`${repo}/`); folder = dirname(folder)) {
    const configPath = resolve(folder, 'tsconfig.json');
    if (!existsSync(configPath)) continue;
    if (!configAliases.has(configPath)) {
      const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
      configAliases.set(configPath, parsed.error ? null : parsed.config?.compilerOptions?.paths?.['@/*'] ?? null);
    }
    const paths = configAliases.get(configPath);
    if (!paths) continue;
    if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string' || !paths[0].endsWith('*')) return null;
    return resolveSource(resolve(folder, paths[0].slice(0, -1), specifier.slice(2)));
  }
  return null;
}
function workspaceExport(specifier) {
  const match = /^@happier-dev\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (!match) return null;
  const packageDir = resolve(repo, 'packages', match[1]);
  const manifestPath = resolve(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  if (!workspaceManifests.has(manifestPath)) workspaceManifests.set(manifestPath, JSON.parse(readFileSync(manifestPath, 'utf8')));
  const manifest = workspaceManifests.get(manifestPath);
  if (manifest.name !== `@happier-dev/${match[1]}`) return null;
  const entry = manifest.exports?.[match[2] ? `./${match[2]}` : '.'];
  if (!entry) return null;
  const sources = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value['happier-source'] === 'string') sources.add(value['happier-source']);
    for (const [condition, branch] of Object.entries(value)) if (condition !== 'happier-source') visit(branch);
  };
  visit(entry);
  if (sources.size !== 1) return null;
  const source = [...sources][0];
  return resolveSource(resolve(packageDir, source));
}
function resolveModule(from, specifier) {
  if (specifier.startsWith('.')) return resolveSource(resolve(dirname(from), specifier));
  return localAlias(from, specifier) ?? workspaceExport(specifier);
}
// Direct export lineage is proven from an exported declaration's Zod factory or
// explicit Zod annotation. Re-exports are followed; opaque package barrels are
// reported as unresolved rather than guessed from a Schema suffix.
const provenExports = new Map();
function provesSchema(path, name, visited = new Set()) {
  const key = `${path}:${name}`;
  if (visited.has(key)) return null;
  if (provenExports.has(key)) return provenExports.get(key);
  visited.add(key);
  const remember = proof => {
    provenExports.set(key, proof);
    return proof;
  };
  const file = sourceFile(path);
  if (!file) return null;
  const { ast } = file;
  const z = new Set(), miniZ = new Set(), namedZodTypes = new Set(), importedNames = new Map(), localVariables = new Map(), localFunctions = new Map();
  for (const item of ast.statements) {
    if (ts.isFunctionDeclaration(item) && item.name) localFunctions.set(item.name.text, item);
    if (ts.isVariableStatement(item)) for (const declaration of item.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) localVariables.set(declaration.name.text, declaration);
    }
    if (ts.isImportDeclaration(item)) {
      const target = resolveModule(path, item.moduleSpecifier.text);
      const binding = item.importClause?.namedBindings;
      if (target && binding && ts.isNamedImports(binding)) {
        for (const member of binding.elements) importedNames.set(member.name.text, { target, name: member.propertyName?.text ?? member.name.text });
      }
      if (!['zod', 'zod/v4', 'zod/mini'].includes(item.moduleSpecifier.text)) continue;
      if (binding && ts.isNamespaceImport(binding)) {
        z.add(binding.name.text);
        if (item.moduleSpecifier.text === 'zod/mini') miniZ.add(binding.name.text);
      }
      if (binding && ts.isNamedImports(binding)) for (const member of binding.elements) if ((member.propertyName?.text ?? member.name.text) === 'z') {
        z.add(member.name.text);
        if (item.moduleSpecifier.text === 'zod/mini') miniZ.add(member.name.text);
      }
      if (binding && ts.isNamedImports(binding)) for (const member of binding.elements) {
        if (/^Zod(?:Mini)?(?:Type|Object|Array|String|Number)/.test(member.propertyName?.text ?? member.name.text)) namedZodTypes.add(member.name.text);
      }
    }
  }
  const isExport = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const voiceSchemaType = ast.statements.find(item => ts.isTypeAliasDeclaration(item)
    && item.name.text === 'VoiceSchema' && ts.isTypeReferenceNode(item.type)
    && ts.isIdentifier(item.type.typeName) && item.type.typeName.text === 'Readonly'
    && item.type.typeArguments?.length === 1 && ts.isTypeLiteralNode(item.type.typeArguments[0])
    && ['parse', 'safeParse', 'optional', 'array'].every(name => item.type.typeArguments[0].members.some(member =>
      ts.isMethodSignature(member) && ts.isIdentifier(member.name) && member.name.text === name)));
  const annotationProof = type => {
    if (!type || !ts.isTypeReferenceNode(type)) return null;
    if (voiceSchemaType && ts.isIdentifier(type.typeName) && type.typeName.text === 'VoiceSchema') {
      return { neutral: true };
    }
    const name = type.typeName.getText(ast);
    if ([...z].some(alias => new RegExp(`^${alias}\\.(?:Zod|core\\.\\$Zod)(?!Error|Issue|SafeParse|RawShape)`).test(name))
      || namedZodTypes.has(name)) {
      return { kind: 'unknown', cold: false, factory: false, mini: /ZodMini/.test(name) };
    }
    return null;
  };
  const kindOf = method => ['string', 'email', 'url', 'uuid', 'base64', 'base64url', 'hex', 'datetime'].includes(method) ? 'string'
    : ['number', 'int'].includes(method) ? 'number'
    : ['array', 'tuple', 'set'].includes(method) ? 'array'
    : ['record', 'partialRecord'].includes(method) ? 'recordSchema'
    : ['object', 'strictObject', 'looseObject', 'extend', 'safeExtend', 'pick', 'omit', 'partial', 'required', 'catchall'].includes(method) ? 'object'
    : method === 'literal' ? 'literal'
    : ['enum', 'nativeEnum', 'keyof'].includes(method) ? 'enum'
    : ['union', 'discriminatedUnion'].includes(method) ? 'union' : 'unknown';
  const neutralConstructors = new Set(['defineProtocolObject', 'defineProtocolUnion', 'createProtocolComposableSchema']);
  const schemaFactories = new Set('string number bigint boolean date object strictObject looseObject extend safeExtend pick omit partial required catchall keyof array tuple record partialRecord set map file enum nativeEnum literal union discriminatedUnion intersection lazy optional nullable nullish nonoptional _default prefault catch readonly pipe transform preprocess custom instanceof unknown any never null undefined void nan int email url uuid datetime json base64 base64url hex promise templateLiteral'.split(' '));
  function localDeclaration(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isBlock(parent)) continue;
      for (const statement of parent.statements) {
        if (statement.pos >= node.pos) break;
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text) return declaration;
        }
      }
    }
    return null;
  }
  function isZodNamespaceParameter(node) {
    if (!ts.isIdentifier(node) || localDeclaration(node)) return false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isFunctionLike(parent)) continue;
      const parameter = parent.parameters.find(item => ts.isIdentifier(item.name) && item.name.text === node.text);
      if (parameter) return !!parameter.type && ts.isTypeQueryNode(parameter.type)
        && ts.isIdentifier(parameter.type.exprName) && z.has(parameter.type.exprName.text);
    }
    return false;
  }
  function singleLiteralArgument(node) {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)
      || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (!ts.isIdentifier(node) || localDeclaration(node)) return false;
    const primitive = type => type && [ts.SyntaxKind.StringKeyword,
      ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword].includes(type.kind);
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isFunctionLike(parent)) continue;
      const parameter = parent.parameters.find(item => ts.isIdentifier(item.name) && item.name.text === node.text);
      if (!parameter?.type) return false;
      if (primitive(parameter.type)) return true;
      if (!ts.isTypeReferenceNode(parameter.type) || !ts.isIdentifier(parameter.type.typeName)) return false;
      const generic = parent.typeParameters?.find(item => item.name.text === parameter.type.typeName.text);
      return !!generic && primitive(generic.constraint);
    }
    return false;
  }
  function identitySchemaArgument(fn) {
    if (!fn.body || !ts.isBlock(fn.body) || !fn.type || !ts.isTypeReferenceNode(fn.type)
      || !ts.isIdentifier(fn.type.typeName)) return null;
    const parameterType = fn.typeParameters?.find(item => item.name.text === fn.type.typeName.text);
    if (!parameterType || !annotationProof(parameterType.constraint)) return null;
    const matches = fn.parameters.flatMap((item, index) => item.type && ts.isTypeReferenceNode(item.type)
      && ts.isIdentifier(item.type.typeName) && item.type.typeName.text === parameterType.name.text ? [index] : []);
    // The source signature itself promises the same constrained subtype T;
    // projection owners can return a lazy clone rather than `return schema`.
    return matches.length === 1 ? matches[0] : null;
  }
  function shapeFields(node, seenLocal = new Set()) {
    if (!node) return null;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return shapeFields(node.expression, seenLocal);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'shape') {
      const owner = expressionProof(node.expression, new Set(seenLocal));
      return owner?.kind === 'object' ? owner.fields ?? null : null;
    }
    if (ts.isIdentifier(node)) {
      if (seenLocal.has(node.text)) return null;
      const initializer = localVariables.get(node.text)?.initializer;
      return initializer ? shapeFields(initializer, new Set([...seenLocal, node.text])) : null;
    }
    if (!ts.isObjectLiteralExpression(node)) return null;
    const fields = Object.create(null);
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) Object.assign(fields, shapeFields(property.expression, seenLocal));
      else if (ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        const proof = expressionProof(property.initializer, new Set(seenLocal));
        if (proof && !proof.neutral) fields[property.name.text] = proof;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const proof = expressionProof(property.name, new Set(seenLocal));
        if (proof && !proof.neutral) fields[property.name.text] = proof;
      }
    }
    return fields;
  }
  function schemaRecord(node, body, seenLocal) {
    if (!node) return null;
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node))) node = node.expression;
    const literal = ts.isObjectLiteralExpression(node) ? node
      : ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object'
        && node.expression.name.text === 'freeze' && ts.isObjectLiteralExpression(node.arguments[0]) ? node.arguments[0] : null;
    if (!literal) return null;
    const locals = new Map();
    for (const statement of body.statements) if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) locals.set(declaration.name.text, declaration.initializer);
      }
    }
    const fields = Object.create(null);
    for (const property of literal.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        const initializer = locals.get(property.name.text);
        const proof = initializer && expressionProof(initializer, new Set(seenLocal));
        if (proof && !proof.neutral) fields[property.name.text] = proof;
      } else if (ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        const proof = expressionProof(property.initializer, new Set(seenLocal));
        if (proof && !proof.neutral) fields[property.name.text] = proof;
      }
    }
    return Object.keys(fields).length ? { kind: 'record', fields } : null;
  }
  function expressionProof(node, seenLocal = new Set()) {
    if (!node) return null;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)) return expressionProof(node.expression, seenLocal);
    if (ts.isArrayLiteralExpression(node) && node.elements.length) {
      const elements = node.elements.map(item => expressionProof(item, new Set(seenLocal)));
      if (elements.every(item => item && !item.neutral && item.kind === 'object')) {
        return { kind: 'schemaArray', elements, mini: elements.every(item => item.mini) };
      }
    }
    if (ts.isConditionalExpression(node)) {
      const yes = expressionProof(node.whenTrue, new Set(seenLocal));
      const no = expressionProof(node.whenFalse, new Set(seenLocal));
      return yes && no ? { kind: yes.kind === no.kind ? yes.kind : 'unknown', cold: yes.cold || no.cold,
        mini: yes.mini && no.mini, bridge: yes.bridge && no.bridge } : null;
    }
    if (ts.isIdentifier(node)) {
      if (seenLocal.has(node.text)) return null;
      const next = new Set([...seenLocal, node.text]);
      const declaration = localDeclaration(node) ?? localVariables.get(node.text);
      if (declaration) return expressionProof(declaration.initializer, next)
        ?? annotationProof(declaration.type);
      const imported = importedNames.get(node.text);
      return imported ? provesSchema(imported.target, imported.name, new Set(visited)) : null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = expressionProof(node.expression, seenLocal);
      if (node.name.text === 'shape' && base?.kind === 'object') return { ...base, kind: 'shape' };
      if (['shape', 'record'].includes(base?.kind)) return base.fields?.[node.name.text] ?? null;
      if (node.name.text === 'element' && base?.kind === 'array') return base.element ?? null;
      return null;
    }
    if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'options' && ts.isNumericLiteral(node.argumentExpression)) {
      const base = expressionProof(node.expression.expression, seenLocal);
      return base?.kind === 'union' ? base.options?.[Number(node.argumentExpression.text)] ?? null : null;
    }
    if (!ts.isCallExpression(node)) return null;
    // A few existing strict-object definitions use an immediately invoked,
    // typed core clone. Follow that exact transparent expression, not an
    // arbitrary IIFE or a schema-looking assertion.
    const invoked = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
    if (ts.isArrowFunction(invoked) && node.arguments.length === 2 && invoked.parameters.length === 2
      && invoked.parameters.every(parameter => ts.isIdentifier(parameter.name))
      && ts.isAsExpression(invoked.body) && ts.isTypeReferenceNode(invoked.body.type)
      && ts.isQualifiedName(invoked.body.type.typeName)
      && ts.isIdentifier(invoked.body.type.typeName.left)
      && miniZ.has(invoked.body.type.typeName.left.text)
      && invoked.body.type.typeName.right.text === 'ZodMiniPipe'
      && ts.isNewExpression(invoked.body.expression)
      && ts.isPropertyAccessExpression(invoked.body.expression.expression)
      && invoked.body.expression.expression.name.text === 'ZodMiniPipe'
      && (ts.isIdentifier(invoked.body.expression.expression.expression)
        && miniZ.has(invoked.body.expression.expression.expression.text)
        || isZodNamespaceParameter(invoked.body.expression.expression.expression))
      && invoked.body.expression.arguments?.length === 1
      && ts.isObjectLiteralExpression(invoked.body.expression.arguments[0])) {
      const properties = invoked.body.expression.arguments[0].properties;
      const field = name => properties.find(property => ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name) && property.name.text === name);
      const type = field('type')?.initializer, input = field('in')?.initializer, output = field('out')?.initializer;
      if (properties.length === 3 && type && ts.isStringLiteral(type) && type.text === 'pipe'
        && input && ts.isIdentifier(input) && input.text === invoked.parameters[0].name.text
        && output && ts.isIdentifier(output) && output.text === invoked.parameters[1].name.text
        && node.arguments.every(argument => {
          const proof = expressionProof(argument, new Set(seenLocal));
          return proof && !proof.neutral;
        })) return { kind: 'unknown', mini: true, bridge: true };
    }
    if (ts.isArrowFunction(invoked) && node.arguments.length === 1 && invoked.parameters.length === 1
      && invoked.typeParameters?.length === 1 && ts.isIdentifier(invoked.parameters[0].name)
      && ts.isTypeReferenceNode(invoked.typeParameters[0].constraint)
      && ts.isQualifiedName(invoked.typeParameters[0].constraint.typeName)
      && ts.isIdentifier(invoked.typeParameters[0].constraint.typeName.left)
      && miniZ.has(invoked.typeParameters[0].constraint.typeName.left.text)
      && invoked.typeParameters[0].constraint.typeName.right.text === 'ZodMiniObject'
      && invoked.parameters[0].type && ts.isTypeReferenceNode(invoked.parameters[0].type)
      && ts.isIdentifier(invoked.parameters[0].type.typeName)
      && invoked.parameters[0].type.typeName.text === invoked.typeParameters[0].name.text
      && ts.isAsExpression(invoked.body) && ts.isTypeReferenceNode(invoked.body.type)
      && ts.isQualifiedName(invoked.body.type.typeName)
      && ts.isIdentifier(invoked.body.type.typeName.left)
      && miniZ.has(invoked.body.type.typeName.left.text)
      && invoked.body.type.typeName.right.text === 'ZodMiniObject'
      && ts.isCallExpression(invoked.body.expression)
      && ts.isPropertyAccessExpression(invoked.body.expression.expression)
      && invoked.body.expression.expression.name.text === 'clone'
      && ts.isPropertyAccessExpression(invoked.body.expression.expression.expression)
      && invoked.body.expression.expression.expression.name.text === 'core'
      && ts.isIdentifier(invoked.body.expression.expression.expression.expression)
      && (miniZ.has(invoked.body.expression.expression.expression.expression.text)
        || isZodNamespaceParameter(invoked.body.expression.expression.expression.expression))
      && ts.isIdentifier(invoked.body.expression.arguments[0])
      && invoked.body.expression.arguments[0].text === invoked.parameters[0].name.text) {
      const input = expressionProof(node.arguments[0], seenLocal);
      if (input?.kind === 'object') return { ...input, kind: 'object', mini: true, bridge: true };
    }
    if (ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (neutralConstructors.has(name)) return { neutral: true };
      if (name === 'lazyZodSchema') {
        const callback = node.arguments[0];
        const returned = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ? ts.isBlock(callback.body)
            ? [...callback.body.statements].reverse().find(ts.isReturnStatement)?.expression
            : callback.body : null;
        const inferred = returned ? expressionProof(returned, seenLocal) : null;
        return { ...inferred, kind: inferred?.kind ?? 'unknown', cold: true, facade: !!inferred, enumSimple: inferred?.enumSimple ?? false,
          mini: inferred?.mini ?? false, bridge: inferred?.bridge ?? false };
      }
      if (seenLocal.has(name)) return null;
      const local = localFunctions.get(name) ?? localVariables.get(name)?.initializer;
      const returned = local && (ts.isFunctionDeclaration(local) || ts.isArrowFunction(local) || ts.isFunctionExpression(local))
        ? ts.isBlock(local.body)
          ? [...local.body.statements].reverse().find(ts.isReturnStatement)?.expression
          : local.body : null;
      if (returned) {
        const next = new Set([...seenLocal, name]);
        const proof = ts.isBlock(local.body) ? schemaRecord(returned, local.body, next) ?? expressionProof(returned, next)
          : expressionProof(returned, next);
        if (proof) return { ...proof, factory: true };
      }
      const imported = importedNames.get(name);
      if (imported) {
        const proof = provesSchema(imported.target, imported.name, new Set(visited));
        if (proof?.passthroughArg !== undefined) return expressionProof(node.arguments[proof.passthroughArg], seenLocal);
        if (proof?.factory) return { ...proof, bridge: proof.mini || proof.bridge };
      }
      return null;
    }
    if (!ts.isPropertyAccessExpression(node.expression)) return null;
    const target = node.expression.expression, method = node.expression.name.text;
    if (ts.isIdentifier(target) && (z.has(target.text) || isZodNamespaceParameter(target))
      || ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && z.has(target.expression.text)) {
      const alias = ts.isIdentifier(target) ? target.text : target.expression.text;
      if (!schemaFactories.has(method)) return null;
      const wrapped = ['optional', 'nullable', 'nullish', '_default', 'prefault', 'catch', 'readonly'].includes(method)
        ? expressionProof(node.arguments[0], new Set(seenLocal)) : null;
      return { kind: kindOf(method), cold: method === 'lazy', enumSimple: method === 'enum' && node.arguments.length === 1,
        literalSingleton: method === 'literal' && node.arguments.length === 1 && singleLiteralArgument(node.arguments[0]),
        mini: miniZ.has(alias), bridge: miniZ.has(alias),
        wrapper: ['optional', 'nullable', 'nullish', '_default', 'prefault', 'catch', 'readonly', 'lazy'].includes(method) ? method : undefined,
        fields: ['object', 'strictObject', 'looseObject'].includes(method) ? shapeFields(node.arguments[0], seenLocal)
          : ['extend', 'safeExtend'].includes(method)
            ? { ...expressionProof(node.arguments[0], new Set(seenLocal))?.fields, ...shapeFields(node.arguments[1], seenLocal) }
            : undefined,
        element: method === 'array' ? expressionProof(node.arguments[0], new Set(seenLocal))
          : ['record', 'partialRecord'].includes(method) ? expressionProof(node.arguments[1], new Set(seenLocal)) : undefined,
        options: ['union', 'discriminatedUnion'].includes(method)
          && ts.isArrayLiteralExpression(method === 'discriminatedUnion' ? node.arguments[1] : node.arguments[0])
          ? (method === 'discriminatedUnion' ? node.arguments[1] : node.arguments[0]).elements.map(option => expressionProof(option, new Set(seenLocal))) : undefined,
        ...(wrapped ? { kind: wrapped.kind, element: wrapped.element, fields: wrapped.fields } : {}) };
    }
    if (['parse', 'safeParse', 'parseAsync', 'safeParseAsync', 'apply'].includes(method)) return null;
    const base = expressionProof(target, seenLocal);
    if (!base) return null;
    return { ...base, kind: ['extend', 'safeExtend', 'pick', 'omit', 'partial', 'required', 'catchall'].includes(method) ? 'object'
      : method === 'keyof' ? 'enum'
      : method === 'array' ? 'array' : ['or', 'and', 'pipe', 'transform'].includes(method) ? 'unknown' : base.kind,
      wrapper: ['optional', 'nullable', 'nullish', 'default', 'prefault', 'catch', 'readonly'].includes(method) ? method
        : ['describe', 'meta', 'refine', 'superRefine', 'check', 'brand'].includes(method) ? base.wrapper : undefined,
      facade: ['describe', 'meta', 'refine', 'superRefine', 'check', 'brand'].includes(method) ? base.facade : false,
      fields: ['extend', 'safeExtend'].includes(method) ? { ...base.fields, ...shapeFields(node.arguments[0], seenLocal) }
        : ['partial', 'required', 'array', 'or', 'and', 'pipe', 'transform'].includes(method) ? undefined : base.fields,
      element: method === 'array' ? base : base.element };
  }
  for (const item of ast.statements) {
    if (ts.isFunctionDeclaration(item) && isExport(item) && item.name?.text === name) {
      const passthroughArg = identitySchemaArgument(item);
      if (passthroughArg !== null) return remember({ kind: 'unknown', factory: true, passthroughArg });
      const proof = annotationProof(item.type)
        ?? (item.body ? (() => {
          const returned = [...item.body.statements].reverse().find(ts.isReturnStatement)?.expression;
          return returned && (schemaRecord(returned, item.body, new Set()) ?? expressionProof(returned));
        })() : null);
      if (proof) return remember({ ...proof, factory: true });
    }
    if (ts.isVariableStatement(item) && isExport(item)) {
      for (const declaration of item.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
        const proof = schemaRecord(declaration.initializer, ast, new Set())
          ?? expressionProof(declaration.initializer) ?? annotationProof(declaration.type);
        return remember(proof && { ...proof, factory: false });
      }
    }
    if (ts.isExportDeclaration(item) && item.exportClause && ts.isNamedExports(item.exportClause)) {
      for (const member of item.exportClause.elements) {
        if (member.name.text !== name) continue;
        const original = member.propertyName?.text ?? member.name.text;
        const target = item.moduleSpecifier && resolveModule(path, item.moduleSpecifier.text);
        const proof = target ? provesSchema(target, original, new Set(visited)) : expressionProof(ts.factory.createIdentifier(original));
        if (proof) return remember(proof);
      }
    }
    if (ts.isExportDeclaration(item) && !item.exportClause && item.moduleSpecifier) {
      const target = resolveModule(path, item.moduleSpecifier.text);
      const proof = target && provesSchema(target, name, new Set(visited));
      if (proof) return remember(proof);
    }
  }
  return remember(null);
}
const literalStringObjects = new Map();
function provesLiteralStringObject(path, name) {
  const key = `${path}:${name}`;
  if (literalStringObjects.has(key)) return literalStringObjects.get(key);
  const file = sourceFile(path);
  let proof = null;
  if (file) for (const statement of file.ast.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name
        || !declaration.initializer || !ts.isAsExpression(declaration.initializer)
        || !ts.isConstTypeReference(declaration.initializer.type)
        || !ts.isObjectLiteralExpression(declaration.initializer.expression)) continue;
      const properties = declaration.initializer.expression.properties;
      if (!properties.length || !properties.every(property => ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        && ts.isStringLiteral(property.initializer))) continue;
      proof = Object.create(null);
      for (const property of properties) proof[property.name.text] = property.initializer.text;
    }
  }
  literalStringObjects.set(key, proof);
  return proof;
}
function importedSchemaNames(path, file = sourceFile(path)) {
  const names = new Map(), factories = new Map(), neutral = new Set(), literalObjects = new Map();
  if (!file) return { names, factories, neutral, literalObjects };
  const needsLiteralObjects = /\.extract\s*\(/.test(file.source);
  for (const item of file.ast.statements) {
    if (!ts.isImportDeclaration(item) || !item.importClause?.namedBindings || !ts.isNamedImports(item.importClause.namedBindings)) continue;
    const target = resolveModule(path, item.moduleSpecifier.text);
    if (!target) continue;
    for (const member of item.importClause.namedBindings.elements) {
      const literalObject = needsLiteralObjects && provesLiteralStringObject(target, member.propertyName?.text ?? member.name.text);
      if (literalObject) literalObjects.set(member.name.text, literalObject);
      const proof = provesSchema(target, member.propertyName?.text ?? member.name.text);
      if (proof?.neutral) neutral.add(member.name.text);
      else if (proof?.factory && (command !== 'bridge' || proof.mini)) factories.set(member.name.text, proof);
      else if (proof) names.set(member.name.text, proof);
    }
  }
  return { names, factories, neutral, literalObjects };
}
const functionContractExports = new Map();
function provesFunctionContract(path, name, contract, accepts, visited = new Set()) {
  const key = `${path}:${name}:${contract}`;
  if (functionContractExports.has(key)) return functionContractExports.get(key);
  if (visited.has(key)) return false;
  const file = sourceFile(path);
  if (!file) return false;
  const next = new Set([...visited, key]);
  const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const functionBody = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node))) node = node.expression;
    return node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) ? node : null;
  };
  const accepted = fn => accepts(fn, file);
  const matches = [];
  for (const item of file.ast.statements) {
    if (ts.isFunctionDeclaration(item) && exported(item) && item.name?.text === name)
      matches.push(accepted(item));
    if (ts.isVariableStatement(item) && exported(item)) for (const declaration of item.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
        matches.push(accepted(functionBody(declaration.initializer)));
    }
    if (ts.isExportDeclaration(item) && item.exportClause && ts.isNamedExports(item.exportClause)) {
      for (const member of item.exportClause.elements) {
        if (member.name.text !== name) continue;
        const original = member.propertyName?.text ?? member.name.text;
        const target = item.moduleSpecifier && resolveModule(path, item.moduleSpecifier.text);
        if (target) matches.push(provesFunctionContract(target, original, contract, accepts, next));
        else {
          const declarations = file.ast.statements.filter(statement =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === original
            || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
              ts.isIdentifier(declaration.name) && declaration.name.text === original));
          matches.push(declarations.length === 1 && (ts.isFunctionDeclaration(declarations[0])
            ? accepted(declarations[0])
            : accepted(functionBody(declarations[0].declarationList.declarations.find(declaration =>
              ts.isIdentifier(declaration.name) && declaration.name.text === original)?.initializer))));
        }
      }
    }
    if (ts.isExportDeclaration(item) && !item.exportClause && item.moduleSpecifier) {
      const target = resolveModule(path, item.moduleSpecifier.text);
      if (target && provesFunctionContract(target, name, contract, accepts, next)) matches.push(true);
    }
  }
  const proven = matches.length === 1 && matches[0] === true;
  functionContractExports.set(key, proven);
  return proven;
}
function provesPureFunction(path, name) {
  return provesFunctionContract(path, name, 'one-context-free-parameter', fn => {
    if (!fn?.body || fn.typeParameters?.length || fn.parameters.length !== 1 || fn.parameters[0].dotDotDotToken) return false;
    const pending = [fn.body];
    while (pending.length) {
      const node = pending.pop();
      if (ts.isIdentifier(node) && node.text === 'arguments') return false;
      ts.forEachChild(node, child => { pending.push(child); });
    }
    return true;
  });
}
function provesNativePayloadParameter(path, name, index) {
  return provesFunctionContract(path, name, `native-payload-${index}`, (fn, file) => {
    const parameter = fn?.parameters[index];
    if (!fn?.body || fn.typeParameters?.length || !parameter || !ts.isIdentifier(parameter.name)
      || parameter.dotDotDotToken || parameter.questionToken || parameter.initializer
      || !parameter.type || !ts.isTypeReferenceNode(parameter.type) || parameter.type.typeArguments?.length) return false;
    const parts = [];
    let type = parameter.type.typeName;
    while (ts.isQualifiedName(type)) { parts.unshift(type.right.text); type = type.left; }
    if (!ts.isIdentifier(type) || parts.join('.') !== 'core.ParsePayload') return false;
    const nativeNamespace = file.ast.statements.some(item => ts.isImportDeclaration(item)
      && ['zod', 'zod/v4', 'zod/mini'].includes(item.moduleSpecifier.text)
      && item.importClause?.namedBindings && (ts.isNamespaceImport(item.importClause.namedBindings)
        ? item.importClause.namedBindings.name.text === type.text
        : ts.isNamedImports(item.importClause.namedBindings) && item.importClause.namedBindings.elements.some(member =>
          member.name.text === type.text && (member.propertyName?.text ?? member.name.text) === 'z')));
    if (!nativeNamespace) return false;
    const pending = [fn.body];
    while (pending.length) {
      const node = pending.pop();
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return false;
      if (ts.isIdentifier(node) && node.text === 'arguments') return false;
      if (ts.isIdentifier(node) && node.text === parameter.name.text
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
          && ['issues', 'value'].includes(node.parent.name.text))) return false;
      ts.forEachChild(node, child => { pending.push(child); });
    }
    return true;
  });
}
function importedNativePayloadContexts(path, file) {
  const calls = new Map(), names = new Map(), pending = [file.ast];
  while (pending.length) {
    const node = pending.pop();
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const indices = calls.get(node.expression.text) ?? new Set();
      node.arguments.forEach((argument, index) => { if (ts.isIdentifier(argument)) indices.add(index); });
      calls.set(node.expression.text, indices);
    }
    ts.forEachChild(node, child => { pending.push(child); });
  }
  for (const item of file.ast.statements) {
    if (!ts.isImportDeclaration(item) || !item.importClause?.namedBindings
      || !ts.isNamedImports(item.importClause.namedBindings)) continue;
    const target = resolveModule(path, item.moduleSpecifier.text);
    if (!target) continue;
    for (const member of item.importClause.namedBindings.elements) {
      const indices = [...(calls.get(member.name.text) ?? [])].filter(index =>
        provesNativePayloadParameter(target, member.propertyName?.text ?? member.name.text, index));
      if (indices.length) names.set(member.name.text, new Set(indices));
    }
  }
  return names;
}
function importedPureTransforms(path, file) {
  const names = new Set();
  const callbacks = new Set();
  const pending = [file.ast];
  while (pending.length) {
    const node = pending.pop();
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'transform' && ts.isIdentifier(node.arguments[0]))
      callbacks.add(node.arguments[0].text);
    ts.forEachChild(node, child => { pending.push(child); });
  }
  if (!callbacks.size) return names;
  for (const item of file.ast.statements) {
    if (!ts.isImportDeclaration(item) || !item.importClause?.namedBindings
      || !ts.isNamedImports(item.importClause.namedBindings)) continue;
    const target = resolveModule(path, item.moduleSpecifier.text);
    if (!target) continue;
    for (const member of item.importClause.namedBindings.elements) {
      if (callbacks.has(member.name.text)
        && provesPureFunction(target, member.propertyName?.text ?? member.name.text)) names.add(member.name.text);
    }
  }
  return names;
}
function protocolLazyImportFor(path) {
  if (!workspaceExport('@happier-dev/protocol/lazyZodSchema')) return undefined;
  for (let folder = dirname(path); folder.startsWith(`${repo}/`); folder = dirname(folder)) {
    const manifestPath = resolve(folder, 'package.json');
    if (!existsSync(manifestPath)) continue;
    if (!workspaceManifests.has(manifestPath)) workspaceManifests.set(manifestPath, JSON.parse(readFileSync(manifestPath, 'utf8')));
    return workspaceManifests.get(manifestPath).dependencies?.['@happier-dev/protocol']
      ? '@happier-dev/protocol/lazyZodSchema' : undefined;
  }
  return undefined;
}
const byPackage = Object.create(null), files = [], failures = [];
for (const path of paths) {
  if (!sourcePath(path)) continue;
  try {
    const absolute = resolve(repo, path);
    if (!existsSync(absolute)) { failures.push({ file: path, reason: 'missing' }); continue; }
    const source = readFileSync(absolute, 'utf8');
    if (!candidateSource(source)) continue;
    const file = { source, ast: ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true) };
    const imported = importedSchemaNames(absolute, file);
    const protocolSource = resolve(repo, 'packages/protocol/src');
    const serverSource = resolve(repo, 'apps/server/sources');
    const helperPath = resolve(protocolSource, 'lazyZodSchema.ts');
    const relativeHelper = absolute.startsWith(`${protocolSource}/`) && absolute !== helperPath
      ? relative(dirname(absolute), helperPath).replace(/\\/g, '/').replace(/\.ts$/, '.js') : null;
    const lazyHelperImport = relativeHelper ? relativeHelper.startsWith('.') ? relativeHelper : `./${relativeHelper}`
      : absolute.startsWith(`${serverSource}/`) ? '@happier-dev/protocol/lazyZodSchema'
        : protocolLazyImportFor(absolute);
    const result = transformSource(file.source, path, {
      importedSchemas: imported.names,
      importedSchemaFactories: imported.factories,
      importedNeutralSchemas: imported.neutral,
      importedLiteralObjects: imported.literalObjects,
      importedPureTransforms: importedPureTransforms(absolute, file),
      importedNativePayloadContexts: importedNativePayloadContexts(absolute, file),
      factoryOnly: command === 'bridge',
      lazyHelperImport,
    });
    const owner = path.startsWith('packages/plugins/') ? path.split('/').slice(0, 3).join('/') : path.split('/').slice(0, 2).join('/');
    if (!byPackage[owner]) byPackage[owner] = { files: 0, imports: Object.create(null), api: Object.create(null), unresolved: 0, convertible: 0 };
    const bucket = byPackage[owner];
    if (result.imports.length || result.unresolved.length || result.changed) {
      bucket.files++;
      for (const item of result.imports) bucket.imports[item.module] = (bucket.imports[item.module] ?? 0) + 1;
      for (const [method, count] of Object.entries(result.api)) bucket.api[method] = (bucket.api[method] ?? 0) + count;
      bucket.unresolved += result.unresolved.length;
      if (result.changed) bucket.convertible++;
      files.push({ file: path, imports: result.imports, api: result.api, unresolved: result.unresolved, changed: result.changed });
    }
    if (write && result.changed && !result.unresolved.length) {
      if (readFileSync(absolute, 'utf8') !== file.source) { failures.push({ file: path, reason: 'changed during scan' }); continue; }
      writeFileSync(absolute, result.output);
      provenExports.clear();
    }
  } catch (error) {
    failures.push({ file: path, reason: `${error.name}: ${error.message}` });
  }
}
const report = { command, root: repo, write, scanned: paths.length, byPackage, files, failures };
console.log(JSON.stringify(report));
if (failures.length) process.exitCode = 1;
