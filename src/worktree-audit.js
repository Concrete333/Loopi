const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runGit(args, { projectRoot, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true
  });

  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null
  };
}

function trimOrNull(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parsePorcelainStatus(outputText) {
  return String(outputText || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
}

function parseChangedFiles(outputText) {
  const entries = [];
  const lines = String(outputText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) {
      continue;
    }

    const status = parts[0];
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({
        status,
        previousPath: parts[1] || null,
        path: parts[2] || parts[1]
      });
      continue;
    }

    entries.push({
      status,
      previousPath: null,
      path: parts[1]
    });
  }

  return entries;
}

function extractUntrackedFiles(statusPorcelain) {
  return statusPorcelain
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3))
    .filter((line) => line.trim() !== '');
}

function normalizePatchPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function appendPatchChunk(baseText, chunkText) {
  const chunk = String(chunkText || '');
  if (!chunk) {
    return String(baseText || '');
  }

  let combined = String(baseText || '');
  if (combined && !combined.endsWith('\n')) {
    combined += '\n';
  }
  combined += chunk;
  if (combined && !combined.endsWith('\n')) {
    combined += '\n';
  }
  return combined;
}

function isLikelyBinary(buffer) {
  return Buffer.isBuffer(buffer) && buffer.includes(0);
}

function buildTextAdditionHunk(fileContent) {
  const normalized = String(fileContent || '').replace(/\r\n/g, '\n');
  const hasTrailingNewline = normalized.endsWith('\n');
  const body = hasTrailingNewline ? normalized.slice(0, -1) : normalized;
  const lines = body === '' ? [] : body.split('\n');
  const startLine = lines.length > 0 ? 1 : 0;
  const hunkHeader = `@@ -0,0 +${startLine},${lines.length} @@\n`;
  const prefixedLines = lines.map((line) => `+${line}`).join('\n');
  let patch = hunkHeader;
  if (prefixedLines) {
    patch += `${prefixedLines}\n`;
  }
  if (!hasTrailingNewline && lines.length > 0) {
    patch += '\\ No newline at end of file\n';
  }
  return patch;
}

function buildSyntheticUntrackedPatch(relativePath, fileBuffer) {
  const patchPath = normalizePatchPath(relativePath);
  let patch = [
    `diff --git a/${patchPath} b/${patchPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${patchPath}`
  ].join('\n') + '\n';

  if (isLikelyBinary(fileBuffer)) {
    patch += `Binary files /dev/null and b/${patchPath} differ\n`;
    return patch;
  }

  patch += buildTextAdditionHunk(fileBuffer.toString('utf8'));
  return patch;
}

function buildSyntheticUntrackedPatches(projectRoot, untrackedFiles) {
  let patchText = '';
  const errors = [];

  for (const relativePath of untrackedFiles) {
    const absolutePath = path.join(projectRoot, relativePath);
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        continue;
      }
      const fileBuffer = fs.readFileSync(absolutePath);
      patchText = appendPatchChunk(patchText, buildSyntheticUntrackedPatch(relativePath, fileBuffer));
    } catch (error) {
      errors.push(`Failed to snapshot untracked file "${relativePath}": ${error.message}`);
    }
  }

  return {
    patchText,
    errors
  };
}

function buildUnavailableSnapshot({ scope, step, message }) {
  return {
    scope,
    stepId: step && step.id ? step.id : null,
    stage: step && step.stage ? step.stage : null,
    agent: step && step.agent ? step.agent : null,
    canWrite: Boolean(step && step.canWrite),
    gitAvailable: false,
    gitHead: null,
    gitHeadShort: null,
    statusPorcelain: [],
    changedFiles: [],
    untrackedFiles: [],
    patchText: '',
    stagedPatchText: '',
    dirty: false,
    captureError: message
  };
}

function captureWorktreeSnapshot({ projectRoot, scope, step = null, includePatches = null, spawnSyncImpl = spawnSync } = {}) {
  const workTreeResult = runGit(['rev-parse', '--is-inside-work-tree'], { projectRoot, spawnSyncImpl });
  if (!workTreeResult.ok || trimOrNull(workTreeResult.stdout) !== 'true') {
    const errorMessage = workTreeResult.error
      ? `Git unavailable: ${workTreeResult.error.message}`
      : trimOrNull(workTreeResult.stderr) || 'Project root is not inside a Git repository.';
    return buildUnavailableSnapshot({ scope, step, message: errorMessage });
  }

  const headResult = runGit(['rev-parse', '--verify', 'HEAD'], { projectRoot, spawnSyncImpl });
  const hasHead = headResult.ok;
  const shortHeadResult = hasHead
    ? runGit(['rev-parse', '--short', 'HEAD'], { projectRoot, spawnSyncImpl })
    : { ok: false, stdout: '', stderr: '', error: null };
  const statusResult = runGit(['status', '--porcelain=v1', '--untracked-files=all'], { projectRoot, spawnSyncImpl });
  const changedFilesResult = hasHead
    ? runGit(['diff', '--name-status', '--find-renames', 'HEAD'], { projectRoot, spawnSyncImpl })
    : runGit(['diff', '--cached', '--name-status', '--find-renames', '--root'], { projectRoot, spawnSyncImpl });
  const shouldIncludePatches = includePatches === null
    ? scope !== 'pre-step'
    : Boolean(includePatches);
  const patchResult = shouldIncludePatches
    ? (hasHead
      ? runGit(['diff', '--binary', '--no-color', 'HEAD'], { projectRoot, spawnSyncImpl })
      : { ok: true, status: 0, stdout: '', stderr: '', error: null })
    : { ok: true, status: 0, stdout: '', stderr: '', error: null };
  const stagedPatchResult = shouldIncludePatches
    ? (hasHead
      ? runGit(['diff', '--cached', '--binary', '--no-color', 'HEAD'], { projectRoot, spawnSyncImpl })
      : runGit(['diff', '--cached', '--binary', '--no-color', '--root'], { projectRoot, spawnSyncImpl }))
    : { ok: true, status: 0, stdout: '', stderr: '', error: null };

  const statusPorcelain = parsePorcelainStatus(statusResult.stdout);
  const untrackedFiles = extractUntrackedFiles(statusPorcelain);
  const syntheticUntracked = shouldIncludePatches
    ? buildSyntheticUntrackedPatches(projectRoot, untrackedFiles)
    : { patchText: '', errors: [] };
  const changedFiles = [
    ...parseChangedFiles(changedFilesResult.stdout),
    ...untrackedFiles.map((filePath) => ({
      status: '??',
      previousPath: null,
      path: filePath
    }))
  ];
  const patchText = appendPatchChunk(String(patchResult.stdout || ''), syntheticUntracked.patchText);
  const stagedPatchText = String(stagedPatchResult.stdout || '');
  const dirty = statusPorcelain.length > 0;

  const errorMessages = [
    statusResult,
    changedFilesResult,
    patchResult,
    stagedPatchResult
  ]
    .filter((result) => !result.ok)
    .map((result) => result.error ? result.error.message : trimOrNull(result.stderr))
    .concat(syntheticUntracked.errors)
    .filter(Boolean);

  return {
    scope,
    stepId: step && step.id ? step.id : null,
    stage: step && step.stage ? step.stage : null,
    agent: step && step.agent ? step.agent : null,
    canWrite: Boolean(step && step.canWrite),
    gitAvailable: true,
    gitHead: trimOrNull(headResult.stdout),
    gitHeadShort: shortHeadResult.ok ? trimOrNull(shortHeadResult.stdout) : null,
    statusPorcelain,
    changedFiles,
    untrackedFiles,
    patchText,
    stagedPatchText,
    dirty,
    captureError: errorMessages.length > 0 ? errorMessages.join(' | ') : null
  };
}

module.exports = {
  captureWorktreeSnapshot,
  __test: {
    runGit,
    parsePorcelainStatus,
    parseChangedFiles,
    extractUntrackedFiles,
    normalizePatchPath,
    appendPatchChunk,
    isLikelyBinary,
    buildTextAdditionHunk,
    buildSyntheticUntrackedPatch
  }
};
