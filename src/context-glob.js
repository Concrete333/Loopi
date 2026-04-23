/**
 * Shared glob matching and phase inference helpers.
 *
 * Extracted from context-index.js and context-cache.js so both the raw-file
 * walker and the cache walker agree exactly on which files count as sources
 * and which phase they belong to.
 */

// Phase folder name mappings. `rubric/` is treated as review-phase context,
// and `schema/` is treated as implement-phase context.
const PHASE_FOLDERS = Object.freeze({
  shared: 'shared',
  plan: 'plan',
  implement: 'implement',
  review: 'review',
  examples: 'examples',
  rubric: 'review',
  schema: 'implement'
});

const DEFAULT_PHASE = 'shared';

/**
 * Converts a glob pattern to a regular expression anchored to the full path.
 * Supports `**` (any path depth) and `*` (any chars within one segment).
 * Processed character-by-character to avoid substitution collisions.
 *
 * @param {string} pattern Glob pattern (forward-slash normalized)
 * @returns {RegExp} Regular expression anchored to the full path
 */
function globToRegex(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/');
  const specialChars = new Set(['.', '+', '?', '^', '$', '{', '}', '[', ']', '|', '(', ')', '\\']);

  let result = '';
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];

    if (ch === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        // `**/` — zero or more path segments with trailing slash.
        result += '(?:.+/)?';
        i += 3;
      } else {
        // `**` at the end of the pattern — any remaining characters.
        result += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      // `*` — any characters within a single path segment.
      result += '[^/]*';
      i++;
    } else if (specialChars.has(ch)) {
      result += '\\' + ch;
      i++;
    } else {
      result += ch;
      i++;
    }
  }

  return new RegExp(`^${result}$`);
}

/**
 * Checks if a path matches a glob pattern.
 * @param {string} filePath Forward-slash normalized path
 * @param {string} pattern Glob pattern
 * @returns {boolean}
 */
function matchesGlob(filePath, pattern) {
  return globToRegex(pattern).test(String(filePath).replace(/\\/g, '/'));
}

/**
 * Returns true if `filePath` matches any of the supplied glob patterns.
 * An empty pattern list returns false (caller decides what to do).
 */
function matchesAnyPattern(filePath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  const normalizedPath = String(filePath).replace(/\\/g, '/');
  for (const pattern of patterns) {
    if (matchesGlob(normalizedPath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes a glob list into a deterministic forward-slash-sorted array.
 * Shared by cache metadata and any caller that wants stable pattern diffs.
 */
function normalizePatternList(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      patterns
        .map((pattern) => String(pattern || '').trim().replace(/\\/g, '/'))
        .filter(Boolean)
    )
  ).sort();
}

/**
 * Returns true if `relativePath` (or any directory prefix it resolves to)
 * matches one of the supplied exclusion patterns, for use by directory walkers
 * that want to skip entire subtrees like `node_modules/` or `.git/`.
 */
function matchesDirectoryExclusion(relativePath, patterns) {
  if (!relativePath || !Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }

  const normalized = String(relativePath).replace(/\\/g, '/');
  const directoryPath = normalized.endsWith('/') ? normalized : `${normalized}/`;

  return patterns.some((pattern) => {
    const normalizedPattern = String(pattern).replace(/\\/g, '/');
    if (matchesGlob(normalized, normalizedPattern) || matchesGlob(directoryPath, normalizedPattern)) {
      return true;
    }

    const subtreeNeedle = normalizedPattern
      .replace(/^\*\*\//, '')
      .replace(/\/\*\*$/, '')
      .replace(/^\//, '')
      .replace(/\/$/, '');

    if (!subtreeNeedle.includes('*') && subtreeNeedle !== '') {
      return normalized === subtreeNeedle || normalized.startsWith(`${subtreeNeedle}/`);
    }

    return false;
  });
}

/**
 * Infers the phase for a source file from its top-level folder.
 * @param {string} relativePath Forward-slash normalized relative path
 * @returns {string} One of the PHASE_FOLDERS values, or `shared` by default.
 */
function inferPhase(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return DEFAULT_PHASE;
  }
  const firstFolder = relativePath.split('/')[0];
  if (firstFolder && Object.prototype.hasOwnProperty.call(PHASE_FOLDERS, firstFolder)) {
    return PHASE_FOLDERS[firstFolder];
  }
  return DEFAULT_PHASE;
}

module.exports = {
  PHASE_FOLDERS,
  DEFAULT_PHASE,
  globToRegex,
  matchesGlob,
  matchesAnyPattern,
  normalizePatternList,
  matchesDirectoryExclusion,
  inferPhase
};
