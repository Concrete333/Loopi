const fs = require('fs').promises;
const path = require('path');

// Phase folder name mappings
const PHASE_FOLDERS = {
  'shared': 'shared',
  'plan': 'plan',
  'implement': 'implement',
  'review': 'review',
  'examples': 'examples',
  'rubric': 'review',
  'schema': 'implement'
};

// Default include patterns if none specified
const DEFAULT_INCLUDE = ['**/*.md', '**/*.txt', '**/*.json', '**/*.yaml', '**/*.sql', '**/*.csv'];

// Maximum file size to read content (200KB)
const MAX_CONTENT_SIZE = 200 * 1024;

/**
 * Builds a context index by scanning the configured context folder.
 * @param {Object} contextConfig - Normalized context configuration
 * @param {string} taskRootDir - Root directory of the task (for resolving relative paths)
 * @returns {Promise<Object>} Context index with files array
 */
async function buildContextIndex(contextConfig, taskRootDir) {
  // Resolve the context directory relative to task root
  const contextDir = path.resolve(taskRootDir, contextConfig.dir);

  // Check that the directory exists
  try {
    const stats = await fs.stat(contextDir);
    if (!stats.isDirectory()) {
      throw new Error(`Context directory "${contextDir}" exists but is not a directory.`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Context directory "${contextDir}" does not exist.`);
    }
    throw error;
  }

  // Get include and exclude patterns
  const includePatterns = contextConfig.include || DEFAULT_INCLUDE;
  const excludePatterns = contextConfig.exclude || [];

  // Walk the directory and collect files
  const files = await walkDirectory(contextDir, contextDir, includePatterns, excludePatterns);

  // Load manifest if configured
  let manifest = null;
  if (contextConfig.manifest) {
    const manifestPath = path.resolve(taskRootDir, contextConfig.manifest);
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(manifestContent);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Warning: Failed to load context manifest at "${manifestPath}": ${error.message}`);
      }
    }
  }

  // Merge manifest annotations into file entries
  if (manifest && typeof manifest === 'object') {
    for (const file of files) {
      const manifestEntry = manifest[file.relativePath];
      if (manifestEntry && typeof manifestEntry === 'object') {
        if (manifestEntry.phase) file.phase = manifestEntry.phase;
        if (manifestEntry.priority !== undefined) file.priority = manifestEntry.priority;
        if (manifestEntry.purpose) file.purpose = manifestEntry.purpose;
      }
    }
  }

  return {
    rootDir: contextDir,
    files,
    builtAt: Date.now()
  };
}

/**
 * Walks a directory recursively and returns file entries matching include/exclude patterns.
 * @param {string} rootDir - The context root (used for computing relative paths consistently)
 * @param {string} dir - Current directory being walked
 * @param {string[]} includePatterns - Glob patterns to include
 * @param {string[]} excludePatterns - Glob patterns to exclude
 * @returns {Promise<Array>} Array of file entries
 */
async function walkDirectory(rootDir, dir, includePatterns, excludePatterns) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // Always compute relative path from the context root, not the current dir
    const relativePath = path.relative(rootDir, fullPath);
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');

    if (entry.isDirectory()) {
      // Skip excluded subtrees entirely so large folders like node_modules/.git
      // do not get traversed just to drop their files later.
      if (matchesDirectoryExclusion(normalizedRelativePath, excludePatterns)) {
        continue;
      }
      // Recursively walk subdirectories
      const subFiles = await walkDirectory(rootDir, fullPath, includePatterns, excludePatterns);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      // Check if file matches include patterns
      if (!matchesAnyPattern(normalizedRelativePath, includePatterns)) {
        continue;
      }

      // Check if file matches exclude patterns
      if (matchesAnyPattern(normalizedRelativePath, excludePatterns)) {
        continue;
      }

      // Get file stats
      const stats = await fs.stat(fullPath);
      const sizeBytes = stats.size;

      // Determine if we should read content
      let content = null;
      let skipped = false;
      let skipReason = null;

      if (sizeBytes <= MAX_CONTENT_SIZE && isLikelyTextFile(entry.name)) {
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch (error) {
          skipped = true;
          skipReason = `Failed to read: ${error.message}`;
        }
      } else if (sizeBytes > MAX_CONTENT_SIZE) {
        skipped = true;
        skipReason = `File too large (${sizeBytes} bytes, max ${MAX_CONTENT_SIZE})`;
      } else {
        skipped = true;
        skipReason = `Likely binary file`;
      }

      // Infer phase from folder structure
      const phase = inferPhase(normalizedRelativePath);

      files.push({
        filePath: fullPath,
        relativePath: normalizedRelativePath,
        phase,
        sizeBytes,
        content,
        skipped,
        skipReason
      });
    }
  }

  return files;
}

/**
 * Infers the phase from the file's relative path.
 * @param {string} relativePath - Relative path of the file (normalized to forward slashes)
 * @returns {string} Inferred phase
 */
function inferPhase(relativePath) {
  // Split by forward slash (normalized path)
  const pathParts = relativePath.split('/');
  const firstFolder = pathParts[0];

  if (firstFolder && PHASE_FOLDERS[firstFolder]) {
    return PHASE_FOLDERS[firstFolder];
  }

  return 'shared';
}

/**
 * Checks if a path matches any of the given glob patterns.
 * Supports simple **, * patterns.
 * @param {string} filePath - File path to check
 * @param {string[]} patterns - Glob patterns
 * @returns {boolean} True if path matches any pattern
 */
function matchesAnyPattern(filePath, patterns) {
  if (patterns.length === 0) return false;

  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const pattern of patterns) {
    if (matchesGlob(normalizedPath, pattern)) {
      return true;
    }
  }

  return false;
}

function matchesDirectoryExclusion(relativePath, patterns) {
  if (!relativePath || patterns.length === 0) {
    return false;
  }

  const normalized = relativePath.replace(/\\/g, '/');
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
 * Checks if a path matches a glob pattern.
 * Supports ** (any path segments), * (any characters in segment).
 * @param {string} filePath - File path to check
 * @param {string} pattern - Glob pattern
 * @returns {boolean} True if path matches pattern
 */
function matchesGlob(filePath, pattern) {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const regex = globToRegex(normalizedPattern);
  return regex.test(filePath);
}

/**
 * Converts a glob pattern to a regular expression.
 * Supports ** (any path depth) and * (any chars within one segment).
 * Processes the pattern character-by-character to avoid substitution collisions.
 * @param {string} pattern - Glob pattern (forward-slash normalized)
 * @returns {RegExp} Regular expression anchored to the full path
 */
function globToRegex(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  // Characters that have special meaning in regex and must be escaped
  const specialChars = new Set(['.', '+', '?', '^', '$', '{', '}', '[', ']', '|', '(', ')', '\\']);

  let result = '';
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];

    if (ch === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        // **/ — zero or more path segments with trailing slash
        result += '(?:.+/)?';
        i += 3;
      } else {
        // ** at end of pattern — any remaining characters
        result += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      // * — any characters within a single path segment
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
 * Checks if a file is likely a text file based on its extension.
 * @param {string} filename - File name
 * @returns {boolean} True if likely text file
 */
function isLikelyTextFile(filename) {
  const textExtensions = [
    '.txt', '.md', '.json', '.yaml', '.yml', '.sql', '.csv', '.tsv',
    '.toml', '.ini', '.cfg', '.conf', '.log', '.xml'
  ];

  const ext = path.extname(filename).toLowerCase();
  return textExtensions.includes(ext);
}

module.exports = {
  buildContextIndex
};
