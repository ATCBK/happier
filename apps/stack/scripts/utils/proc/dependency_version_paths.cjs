const { isAbsolute, relative, resolve, sep } = require('node:path');

/** Shared by Node and Metro: keep dependency lookup in the admitted physical
 * workspace, while authored modules continue to come from the live source. */
function mapDependencyVersionParent(originPath, env = process.env) {
  const source = env.HAPPIER_DEPENDENCY_SOURCE_ROOT;
  const version = env.HAPPIER_DEPENDENCY_VERSION_ROOT;
  if (!source && !version) return originPath;
  if (!source || !version || !isAbsolute(source) || !isAbsolute(version)) {
    throw Object.assign(new Error('Dependency lookup requires absolute source and physical version roots'),
      { code: 'HAPPIER_DEPENDENCY_VERSION_UNAVAILABLE' });
  }
  const path = relative(resolve(source), resolve(originPath));
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return originPath;
  return resolve(version, path);
}

module.exports = { mapDependencyVersionParent };
