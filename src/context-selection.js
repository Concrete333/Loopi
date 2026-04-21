/**
 * Context Selection Module
 * Takes a context index and produces a curated, bounded context pack for a specific phase.
 */

// Maximum characters to include per file before truncation
const MAX_CHARS_PER_FILE = 4000;
const TRUNCATION_MARKER = '\n[...truncated]';

/**
 * Selects context files for a specific phase based on bucket ordering and budget constraints.
 * @param {Object} contextIndex - The context index from buildContextIndex
 * @param {string} phase - The phase to select context for ('plan', 'implement', 'review', 'one-shot')
 * @param {Object} options - Selection options
 * @returns {Object} Context pack with selected files and metadata
 */
function selectContextForPhase(contextIndex, phase, options = {}) {
  const {
    maxFiles = 10,
    maxChars = 24000,
    providerMaxInputChars = null,
    steeringHint = null
  } = options;

  // If no files in index, return empty pack
  if (!contextIndex.files || contextIndex.files.length === 0) {
    return {
      phase,
      files: [],
      totalChars: 0,
      skippedCount: 0,
      selectionReasons: [],
      appliedSteeringHint: steeringHint || null
    };
  }

  // Start with files that have content (not skipped)
  const availableFiles = contextIndex.files.filter(f => f.content !== null && !f.skipped);

  if (availableFiles.length === 0) {
    return {
      phase,
      files: [],
      totalChars: 0,
      skippedCount: contextIndex.files.length,
      selectionReasons: [],
      appliedSteeringHint: steeringHint || null
    };
  }

  // Calculate effective char budget
  // If providerMaxInputChars is set, use 60% of it for context
  const effectiveMaxChars = providerMaxInputChars
    ? Math.min(maxChars, Math.floor(providerMaxInputChars * 0.6))
    : maxChars;

  // Build three ordered buckets
  const exactPhaseMatch = [];
  const shared = [];
  const examples = [];
  for (const file of availableFiles) {
    if (file.phase === phase) {
      exactPhaseMatch.push(file);
    } else if (file.phase === 'shared') {
      shared.push(file);
    } else if (file.phase === 'examples') {
      examples.push(file);
    }
  }

  // Sort each bucket: priority first (desc), then size (asc)
  const sortBucket = (files) => {
    return files.sort((a, b) => {
      const priorityA = a.priority ?? 0;
      const priorityB = b.priority ?? 0;
      if (priorityA !== priorityB) {
        return priorityB - priorityA; // Higher priority first
      }
      return a.sizeBytes - b.sizeBytes; // Smaller files first
    });
  };

  const sortedExactPhase = sortBucket(exactPhaseMatch);
  const sortedShared = sortBucket(shared);
  const sortedExamples = sortBucket(examples);

  // V1 stays convention-first: current phase, then shared, then examples.
  const orderedFiles = [...sortedExactPhase, ...sortedShared, ...sortedExamples];

  // Select files within budget
  const selectedFiles = [];
  let totalChars = 0;
  const selectionReasons = [];

  for (const file of orderedFiles) {
    // Check file count budget
    if (selectedFiles.length >= maxFiles) {
      break;
    }

    const contentChars = file.content.length;
    let truncatedContent = file.content;
    let truncated = false;

    if (contentChars > MAX_CHARS_PER_FILE) {
      truncatedContent = file.content.slice(0, MAX_CHARS_PER_FILE) + TRUNCATION_MARKER;
      truncated = true;
    }

    // Budget against the actual excerpt we will send, not the full source file.
    if (totalChars + truncatedContent.length > effectiveMaxChars) {
      continue;
    }

    selectedFiles.push({
      relativePath: file.relativePath,
      phase: file.phase,
      content: truncatedContent,
      truncated,
      sizeBytes: file.sizeBytes,
      priority: file.priority,
      purpose: file.purpose || null
    });

    // Determine selection reason
    let reason = '';
    let bucket = '';
    if (file.phase === phase) {
      reason = 'phase match';
      bucket = 'phase';
    } else if (file.phase === 'shared') {
      reason = 'shared context';
      bucket = 'shared';
    } else if (file.phase === 'examples') {
      reason = 'example';
      bucket = 'examples';
    }

    if (file.priority !== undefined && file.priority !== 0) {
      reason += ` + priority(${file.priority})`;
    }

    selectionReasons.push({
      relativePath: file.relativePath,
      bucket,
      reason
    });

    totalChars += truncatedContent.length;
  }

  // Count skipped files (files that had content but weren't selected due to budget)
  const skippedCount = orderedFiles.length - selectedFiles.length;

  return {
    phase,
    files: selectedFiles,
    totalChars,
    skippedCount,
    selectionReasons,
    effectiveMaxChars,
    appliedSteeringHint: steeringHint || null
  };
}

module.exports = {
  selectContextForPhase
};
