'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// New files can have missing parents. Resolve the nearest existing ancestor
// rather than treating an unresolved path as evidence that it stays in root.
function canonicalPath(target) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw error;
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
      throw error; // A dangling link cannot be checked safely.
    const parent = path.dirname(target);
    if (parent === target)
      throw error;
    return path.join(canonicalPath(parent), path.basename(target));
  }
}

/** Resolve an existing or new path, checking both its spelling and its link destinations. */
function resolveInside(root, relative) {
  const directory = path.resolve(root);
  const target = path.resolve(directory, relative);
  const outside = () => Object.assign(new Error(`Path is outside the allowed folder: ${relative}`),
    { code: 'ERR_OUTSIDE_ROOT' });
  if (!isWithin(directory, target))
    throw outside();
  const canonicalRoot = fs.realpathSync(directory);
  const resolved = canonicalPath(target);
  if (!isWithin(canonicalRoot, resolved))
    throw outside();
  return resolved;
}

module.exports = { resolveInside };
