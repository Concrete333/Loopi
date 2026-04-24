const fs = require('fs').promises;
const path = require('path');
const taskPaths = require('./task-paths');
const { LoopiOrchestrator } = require('./orchestrator');
const { normalizeTaskConfig } = require('./task-config');
const { prepareContextIndex } = require('./context-index');
const { runBeginnerWizard, runAdvancedWizard } = require('./cli-wizard');
const { listPresets, savePreset, usePreset } = require('./cli-presets');
const { runDoctorCheck } = require('./cli-doctor');
const { createForkTaskFromRun, compareRuns } = require('./cli-audit');
const { createPromptIO, askYesNo } = require('./cli-prompts');
const {
  getSupportedAgentIds,
  getAllAdapterDisplayStatus,
  getAdapterMetadata,
  runAdapterInstall,
  runAdapterLogin
} = require('./setup-service');

function buildHelpText() {
  return [
    'Loopi CLI',
    '',
    'First time? Run: npm run cli -- doctor',
    'Then pick a mode: plan | review | implement | oneshot',
    '',
    'Usage:',
    '  npm run cli -- <command>',
    '  npm run cli -- new --advanced',
    '  npm run cli -- install <agent>',
    '  npm run cli -- login <agent>',
    '  npm run cli -- preset <save|list|use> [name]',
    '  npm run cli -- fork <runId> [stepId] [--reason "text"] [--run]',
    '  npm run cli -- compare <runIdA> <runIdB>',
    '  npm run cli -- context prepare',
    '',
    'Setup:',
    '  doctor      Check the environment and current task',
    '  install     Install a supported agent helper when available',
    '  login       Run the login flow for a supported agent',
    '  new         Start the opt-in advanced wizard',
    '',
    'Start a task:',
    '  plan        Interactive plan-mode wizard',
    '  review      Interactive review-mode wizard',
    '  implement   Interactive implement-mode wizard',
    '  oneshot     Interactive one-shot wizard',
    '',
    'Run and inspect:',
    '  run         Run the current shared/task.json through Loopi',
    '  open        Show the scratchpad path and print its contents if present',
    '  context     Prepare reusable context cache assets for the current task',
    '',
    'Manage prior work:',
    '  preset      Save, list, or use named task presets',
    '  fork        Create a forked shared/task.json from a prior run',
    '  compare     Compare two prior runs using recorded snapshots',
    '',
    '  help        Show this help text',
    ''
  ].join('\n');
}

function writeLine(stream, text = '') {
  stream.write(`${text}\n`);
}

function writeRunStartInfo(stdout, intro) {
  writeLine(stdout, intro);
  writeLine(stdout, 'Progress will appear below. Final output is written to shared/scratchpad.txt when the run finishes.');
  writeLine(stdout, 'Press Ctrl+C to cancel.');
}

async function openScratchpad({
  projectRoot,
  stdout,
  readFile,
  readdir = fs.readdir
}) {
  const scratchpadFile = taskPaths.legacyScratchpadFile(projectRoot);
  writeLine(stdout, `Scratchpad path: ${scratchpadFile}`);

  // Surface the latest V2 run directory so users know where the structured
  // run record lives in addition to the legacy scratchpad. V2 task IDs are
  // ISO-timestamp prefixed and sort lexicographically, so the max entry is
  // the most recent run.
  const latestRunDir = await findLatestV2RunDir({ projectRoot, readdir });
  if (latestRunDir) {
    writeLine(stdout, `Latest run directory: ${latestRunDir}`);
  }

  let content;
  try {
    content = await readFile(scratchpadFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      writeLine(stdout, 'No scratchpad exists yet. Run "npm run cli -- run" first.');
      return 0;
    }

    throw error;
  }

  if (!content || content.trim() === '') {
    writeLine(stdout, 'Scratchpad is empty.');
    return 0;
  }

  writeLine(stdout);
  stdout.write(content);
  if (!content.endsWith('\n')) {
    writeLine(stdout);
  }

  return 0;
}

async function findLatestV2RunDir({ projectRoot, readdir }) {
  const tasksRoot = taskPaths.tasksRootDir(projectRoot);
  let entries;
  try {
    entries = await readdir(tasksRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    // Surface unexpected errors by returning null rather than failing the
    // open command; the legacy scratchpad path is still the primary output.
    return null;
  }

  const dirNames = entries
    .filter((entry) => entry && typeof entry.isDirectory === 'function' && entry.isDirectory())
    .map((entry) => entry.name);

  if (dirNames.length === 0) {
    return null;
  }

  dirNames.sort((a, b) => b.localeCompare(a));
  return path.join(tasksRoot, dirNames[0]);
}

async function runCurrentTask({
  projectRoot,
  createOrchestrator,
  stat = fs.stat,
  stdout = process.stdout,
  intro = null,
  stderr = process.stderr
}) {
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  try {
    await stat(taskFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      writeLine(stderr, `No task file at ${taskFile}.`);
      writeLine(stderr, '- If this is your first run: `npm run cli -- doctor` to check your setup.');
      writeLine(stderr, '- Then: `npm run cli -- plan` (or `review`, `implement`, `oneshot`) to write one.');
      return 1;
    }
    throw error;
  }

  if (intro) {
    writeRunStartInfo(stdout, intro);
  }

  const orchestrator = await createOrchestrator(projectRoot);
  if (!orchestrator || typeof orchestrator.init !== 'function' || typeof orchestrator.runTask !== 'function') {
    throw new Error('CLI run command requires an orchestrator with init() and runTask() methods.');
  }

  await orchestrator.init();
  await orchestrator.runTask();
  return 0;
}

async function loadNormalizedTaskConfig({
  projectRoot,
  readFile = fs.readFile
}) {
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  let rawTask;
  try {
    rawTask = await readFile(taskFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`No task file at ${taskFile}.`);
    }
    throw error;
  }

  let parsedTask;
  try {
    parsedTask = JSON.parse(rawTask);
  } catch (error) {
    throw new Error(`Task file at ${taskFile} is not valid JSON: ${error.message}`);
  }

  return normalizeTaskConfig(parsedTask, { projectRoot });
}

async function runWizardCommand(command, {
  projectRoot,
  runWizard,
  createOrchestrator,
  getAdapterStatuses,
  stdout = process.stdout,
  stderr = process.stderr,
  stat = fs.stat
}) {
  const result = await runWizard(command, { projectRoot, getAdapterStatuses });
  if (result && result.runNow) {
    return runCurrentTask({
      projectRoot,
      createOrchestrator,
      stat,
      stdout,
      intro: 'Task written. Starting run...',
      stderr
    });
  }
  return 0;
}

async function runAdvancedWizardCommand(args, {
  projectRoot,
  stdout,
  stderr,
  runAdvanced,
  createOrchestrator,
  getAdapterStatuses,
  stat = fs.stat
}) {
  if (!args.includes('--advanced')) {
    writeLine(stderr, 'Usage: npm run cli -- new --advanced');
    return 1;
  }

  const result = await runAdvanced({ projectRoot, getAdapterStatuses });
  if (result && result.runNow) {
    return runCurrentTask({
      projectRoot,
      createOrchestrator,
      stat,
      stdout,
      intro: 'Task written. Starting run...',
      stderr
    });
  }
  return 0;
}

async function runPresetCommand(args, {
  projectRoot,
  stdout,
  stderr,
  listPresetEntries,
  savePresetFile,
  usePresetFile
}) {
  const action = args[0] ? String(args[0]).trim().toLowerCase() : '';
  const name = args[1] ? String(args[1]).trim() : '';

  if (!action || action === 'help') {
    writeLine(stderr, 'Usage: npm run cli -- preset <save|list|use> [name]');
    return 1;
  }

  if (action === 'list') {
    const presets = await listPresetEntries({ projectRoot });
    if (presets.length === 0) {
      writeLine(stdout, 'No presets saved yet.');
      return 0;
    }

    writeLine(stdout, 'Saved presets:');
    for (const preset of presets) {
      writeLine(stdout, `- ${preset}`);
    }
    return 0;
  }

  if ((action === 'save' || action === 'use') && !name) {
    writeLine(stderr, `Preset name is required for "${action}".`);
    writeLine(stderr, 'Usage: npm run cli -- preset <save|use> <name>');
    return 1;
  }

  if (action === 'save') {
    const result = await savePresetFile(name, { projectRoot });
    writeLine(stdout, `Preset "${name}" saved to ${result.presetFile}`);
    return 0;
  }

  if (action === 'use') {
    const result = await usePresetFile(name, { projectRoot });
    writeLine(stdout, `Preset "${name}" copied to ${result.taskFile}`);
    writeLine(stdout, 'Run it with: npm run cli -- run');
    return 0;
  }

  writeLine(stderr, `Unknown preset action "${action}".`);
  writeLine(stderr, 'Usage: npm run cli -- preset <save|list|use> [name]');
  return 1;
}

async function runDoctorCommand({
  projectRoot,
  stdout,
  runDoctor
}) {
  const result = await runDoctor({ projectRoot });
  for (const line of result.lines) {
    writeLine(stdout, line);
  }
  return result.ok ? 0 : 1;
}

function formatSupportedAgents() {
  return getSupportedAgentIds().join(', ');
}

async function runAdapterHelperCommand(action, args, {
  projectRoot,
  stdout,
  stderr,
  createIO = createPromptIO,
  installHelper = runAdapterInstall,
  loginHelper = runAdapterLogin
}) {
  const agentId = args[0] ? String(args[0]).trim().toLowerCase() : '';
  if (!agentId) {
    writeLine(stderr, `Usage: npm run cli -- ${action} <agent>`);
    writeLine(stderr, `Supported agents: ${formatSupportedAgents()}`);
    return 1;
  }

  const metadata = getAdapterMetadata(agentId);
  if (!metadata) {
    writeLine(stderr, `Unknown agent "${agentId}".`);
    writeLine(stderr, `Supported agents: ${formatSupportedAgents()}`);
    return 1;
  }

  const commandText = action === 'install'
    ? metadata.installCommand && metadata.installCommand.command
    : metadata.loginCommand && metadata.loginCommand.shellCommand;

  if (!commandText) {
    writeLine(stderr, `${metadata.displayName} does not have a built-in ${action} helper.`);
    return 1;
  }

  const io = createIO();
  try {
    const approved = await askYesNo(
      io,
      `This will run: ${commandText}. Continue?`,
      { defaultValue: false }
    );
    if (!approved) {
      writeLine(stdout, `${action === 'install' ? 'Install' : 'Login'} cancelled.`);
      return 0;
    }
  } finally {
    if (io && typeof io.close === 'function') {
      await io.close();
    }
  }

  const helper = action === 'install' ? installHelper : loginHelper;
  const result = await helper(agentId, {
    approved: true,
    cwd: projectRoot
  });

  writeLine(stdout, result.message);
  if (result.statusAfter) {
    const readyText = result.statusAfter.ready ? 'yes' : 'no';
    writeLine(stdout, `Status after ${action}: ${result.statusAfter.status} (ready: ${readyText})`);
  }
  return result.success ? 0 : 1;
}

function parseForkArgs(args) {
  const usage = 'Usage: npm run cli -- fork <runId> [stepId] [--reason "text"] [--run]';
  const positionals = [];
  let reason = null;
  let runNow = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '').trim();
    if (!arg) {
      continue;
    }

    if (arg === '--run') {
      runNow = true;
      continue;
    }

    if (arg === '--reason') {
      const nextValue = args[i + 1];
      if (
        typeof nextValue !== 'string'
        || nextValue.trim() === ''
        || nextValue.trim().startsWith('-')
      ) {
        throw new Error(usage);
      }
      reason = nextValue.trim();
      i += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(usage);
    }

    positionals.push(arg);
    if (positionals.length > 2) {
      throw new Error(usage);
    }
  }

  if (positionals.length < 1 || !positionals[0]) {
    throw new Error(usage);
  }

  return {
    sourceRunId: positionals[0],
    sourceStepId: positionals[1] || null,
    reason,
    runNow
  };
}

async function runForkCommand(args, {
  projectRoot,
  stdout,
  stderr,
  stat = fs.stat,
  createOrchestrator,
  createForkTask = createForkTaskFromRun
}) {
  let parsed;
  try {
    parsed = parseForkArgs(args);
  } catch (error) {
    writeLine(stderr, error.message);
    return 1;
  }

  const result = await createForkTask({
    projectRoot,
    sourceRunId: parsed.sourceRunId,
    sourceStepId: parsed.sourceStepId,
    reason: parsed.reason
  });

  writeLine(stdout, `Forked task written to ${result.taskFile}`);
  writeLine(stdout, `Source run: ${result.sourceRunId}`);
  if (result.sourceStepId) {
    writeLine(stdout, `Source step: ${result.sourceStepId}`);
  }
  if (result.baseCommit) {
    writeLine(stdout, `Base commit: ${result.baseCommit}`);
  }

  if (parsed.runNow) {
    return runCurrentTask({
      projectRoot,
      createOrchestrator,
      stat,
      stdout,
      intro: 'Task written. Starting run...',
      stderr
    });
  }

  writeLine(stdout, 'Run it with: npm run cli -- run');
  return 0;
}

async function runCompareCommand(args, {
  projectRoot,
  stdout,
  stderr,
  compareRunsHelper = compareRuns
}) {
  const leftRunId = args[0] ? String(args[0]).trim() : '';
  const rightRunId = args[1] ? String(args[1]).trim() : '';

  if (!leftRunId || !rightRunId) {
    writeLine(stderr, 'Usage: npm run cli -- compare <runIdA> <runIdB>');
    return 1;
  }

  const result = await compareRunsHelper({
    projectRoot,
    leftRunId,
    rightRunId
  });

  for (const line of result.lines) {
    writeLine(stdout, line);
  }
  return 0;
}

async function runContextCommand(args, {
  projectRoot,
  stdout,
  stderr,
  readFile = fs.readFile,
  prepareContext = prepareContextIndex
}) {
  const action = args[0] ? String(args[0]).trim().toLowerCase() : '';
  if (!action || action === 'help') {
    writeLine(stderr, 'Usage: npm run cli -- context prepare');
    return 1;
  }

  if (action !== 'prepare') {
    writeLine(stderr, `Unknown context action "${action}".`);
    writeLine(stderr, 'Usage: npm run cli -- context prepare');
    return 1;
  }

  let config;
  try {
    config = await loadNormalizedTaskConfig({ projectRoot, readFile });
  } catch (error) {
    writeLine(stderr, error.message);
    writeLine(stderr, '- If this is your first run: `npm run cli -- doctor` to check your setup.');
    writeLine(stderr, '- Then: `npm run cli -- plan` (or `review`, `implement`, `oneshot`) to write one.');
    return 1;
  }

  if (!config.context) {
    writeLine(stderr, 'The current task does not configure a context root.');
    writeLine(stderr, 'Add a "context" object to shared/task.json, then rerun `npm run cli -- context prepare`.');
    return 1;
  }

  const result = await prepareContext(config.context, projectRoot);
  const stats = result.manifest && result.manifest.stats ? result.manifest.stats : {};
  const sources = result.manifest && Array.isArray(result.manifest.sources)
    ? result.manifest.sources
    : [];

  writeLine(stdout, `Prepared context cache: ${result.cacheDir}`);
  writeLine(stdout, `Context root: ${result.rootDir}`);
  writeLine(stdout, `Built at: ${new Date(result.builtAt).toISOString()}`);
  writeLine(
    stdout,
    `Sources: total=${stats.total || 0}, rebuilt=${stats.rebuilt || 0}, reused=${stats.reused || 0}, skipped=${stats.skipped || 0}`
  );

  const skippedEntries = sources.filter((entry) => entry.skipped);
  if (skippedEntries.length > 0) {
    writeLine(stdout, '');
    writeLine(
      stdout,
      `Preparation completed with warnings: ${skippedEntries.length} source${skippedEntries.length === 1 ? '' : 's'} ${skippedEntries.length === 1 ? 'was' : 'were'} skipped.`
    );
    writeLine(stdout, 'Skipped sources:');
    const cap = Math.min(skippedEntries.length, 10);
    for (let i = 0; i < cap; i += 1) {
      const entry = skippedEntries[i];
      writeLine(stdout, `  - ${entry.sourceRelativePath}: ${entry.skipReason || 'unsupported format'}`);
    }
    if (skippedEntries.length > cap) {
      writeLine(stdout, `  ... and ${skippedEntries.length - cap} more`);
    }
    writeLine(stdout, '');
    writeLine(stdout, 'Skipped files are not indexed. Runs will still work but will not include their content.');
  }

  writeLine(
    stdout,
    'Runs will now reuse this prepared context until the source files, include/exclude rules, or manifest overrides change.'
  );
  return 0;
}

async function runCommand(command, {
  projectRoot = taskPaths.getProjectRoot(),
  stdout = process.stdout,
  stderr = process.stderr,
  args = [],
  readFile = fs.readFile,
  stat = fs.stat,
  createOrchestrator = async (root) => new LoopiOrchestrator({ projectRoot: root }),
  runWizard = runBeginnerWizard,
  runAdvanced = runAdvancedWizard,
  createIO = createPromptIO,
  getAdapterStatuses = getAllAdapterDisplayStatus,
  listPresetEntries = listPresets,
  savePresetFile = savePreset,
  usePresetFile = usePreset,
  runDoctor = runDoctorCheck,
  createForkTask = createForkTaskFromRun,
  compareRunsHelper = compareRuns,
  installHelper = runAdapterInstall,
  loginHelper = runAdapterLogin,
  prepareContext = prepareContextIndex
} = {}) {
  const normalizedCommand = typeof command === 'string' && command.trim() !== ''
    ? command.trim().toLowerCase()
    : 'help';

  if (normalizedCommand === 'help') {
    stdout.write(buildHelpText());
    return 0;
  }

  if (normalizedCommand === 'run') {
    return runCurrentTask({
      projectRoot,
      createOrchestrator,
      stat,
      stdout,
      intro: 'Starting run...',
      stderr
    });
  }

  if (normalizedCommand === 'open') {
    return openScratchpad({ projectRoot, stdout, readFile });
  }

  if (normalizedCommand === 'context') {
    return runContextCommand(args, {
      projectRoot,
      stdout,
      stderr,
      readFile,
      prepareContext
    });
  }

  if (normalizedCommand === 'preset') {
    return runPresetCommand(args, {
      projectRoot,
      stdout,
      stderr,
      listPresetEntries,
      savePresetFile,
      usePresetFile
    });
  }

  if (normalizedCommand === 'doctor') {
    return runDoctorCommand({
      projectRoot,
      stdout,
      runDoctor
    });
  }

  if (normalizedCommand === 'install' || normalizedCommand === 'login') {
    return runAdapterHelperCommand(normalizedCommand, args, {
      projectRoot,
      stdout,
      stderr,
      createIO,
      installHelper,
      loginHelper
    });
  }

  if (normalizedCommand === 'fork') {
    return runForkCommand(args, {
      projectRoot,
      stdout,
      stderr,
      stat,
      createOrchestrator,
      createForkTask
    });
  }

  if (normalizedCommand === 'compare') {
    return runCompareCommand(args, {
      projectRoot,
      stdout,
      stderr,
      compareRunsHelper
    });
  }

  if (normalizedCommand === 'new') {
    return runAdvancedWizardCommand(args, {
      projectRoot,
      stdout,
      stderr,
      runAdvanced,
      createOrchestrator,
      getAdapterStatuses,
      stat
    });
  }

  if (normalizedCommand === 'plan'
    || normalizedCommand === 'review'
    || normalizedCommand === 'implement'
    || normalizedCommand === 'oneshot') {
    return runWizardCommand(normalizedCommand, {
      projectRoot,
      runWizard,
      createOrchestrator,
      getAdapterStatuses,
      stdout,
      stderr,
      stat
    });
  }

  writeLine(stderr, `Unknown command "${normalizedCommand}".`);
  stdout.write(buildHelpText());
  return 1;
}

module.exports = {
  buildHelpText,
  runCommand
};
