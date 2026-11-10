'use strict';

// Explorer path rules shared by the new-file form, rename and delete.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFFileNames = factory();
})(function () {
  const EXTENSIONS = { robot: '.robot', resource: '.resource' };

  const baseName = (relative) => relative.slice(relative.lastIndexOf('/') + 1);
  const parentOf = (relative) => (relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '');

  /** The kind the typed name asks for, or null when its last segment has no extension. */
  function kindOf(relative) {
    const name = baseName(relative);
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1)
      return null;
    const extension = name.slice(dot).toLowerCase();
    return Object.keys(EXTENSIONS).find((kind) => EXTENSIONS[kind] === extension) || 'other';
  }

  /** The path to create: the kind's extension is added when the name has none. */
  function withExtension(relative, kind) {
    const clean = String(relative || '').trim().replace(/\\/g, '/');
    if (!baseName(clean) || kindOf(clean) || !EXTENSIONS[kind])
      return clean;
    return clean + EXTENSIONS[kind];
  }

  /** Files created in the resources folder default to .resource, elsewhere to .robot. */
  function defaultKind(folder, config) {
    const resources = String(config?.resourcesDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const clean = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return resources && (clean === resources || clean.startsWith(`${resources}/`)) ? 'resource' : 'robot';
  }

  /** True when `relative` is `target` or lies inside the folder `target`. */
  const isWithin = (relative, target) => relative === target || relative.startsWith(`${target}/`);

  /** `relative` after `from` was renamed or moved to `to`. */
  const moved = (relative, from, to) => (isWithin(relative, from) ? to + relative.slice(from.length) : relative);

  return { EXTENSIONS, baseName, parentOf, kindOf, withExtension, defaultKind, isWithin, moved };
});
