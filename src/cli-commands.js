const fs = require('fs').promises;
const taskPaths = require('./task-paths');
const { LoopiOrchestrator } = require('./orchestrator');
const { runBeginnerWizard, runAdvancedWizard } = require('./cli-wizard');
const { listPresets, savePreset, usePreset } = require('./cli-presets');
const { runDoctorCheck } = require('./cli-doctor');
const { createForkTaskFromRun, compareRuns } = require('./cli-audit');

function buildHelpText() {
  return [
    'Loopi CLI',
    '',
    'Usage:',
    '  npm run cli -- <command>',
    '  npm run cli -- new --advanced',
    '  npm run cli -- preset <save|list|use> [name]',
    '  npm run cli -- fork <runId> [stepId] [--reason "text"] [--run]',
    '  npm run cli -- compare <runIdA> <runIdB>',
    '',
    'Available commands:',
    '  help        Show this help text',
    '  run         Run the current shared/task.json through Loopi',
    '  open        Show the scratchpad path and print its contents if present',
    '  plan        Interactive plan-mode wizard',
    '  review      Interactive review-mode wizard',
    '  implement   Interactive implement-mode wizard',
    '  oneshot     Interactive one-shot wizard',
    '  preset      Save, list, or use named task presets',
    '  fork        Create a forked shared/task.json from a prior run',
    '  compare     Compare two prior runs using recorded snapshots',
    '  doctor      Check the current task file and selected agents',
    '  new         Start the opt-in advanced wizard',
    ''
  ].join('\n');
}

function writeLine(stream, text = '') {
  stream.write(`${text}\n`);
}

async function openScratchpad({
  projectRoot,
  stdout,
  readFile
}) {
  const scratchpadFile = taskPaths.legacyScratchpadFile(projectRoot);
  writeLine(stdout, `Scratchpad path: ${scratchpadFile}`);

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

async function runCurrentTask({
  projectRoot,
  createOrchestrator,
  stat = fs.stat,
  stderr = process.stderr
}) {
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  try {
    await stat(taskFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      writeLine(stderr, `No task file at ${taskFile}.`);
      writeLine(stderr, 'Create one with `npm run cli -- plan`, `review`, `implement`, or `oneshot` first.');
      return 1;
    }
    throw error;
  }

  const orchestrator = await createOrchestrator(projectRoot);
  if (!orchestrator || typeof orchestrator.init !== 'function' || typeof orchestrator.runTask !== 'function') {
    throw new Error('CLI run command requires an orchestrator with init() and runTask() methods.');
  }

  await orchestrator.init();
  await orchestrator.runTask();
  return 0;
}

async function runWizardCommand(command, {
  projectRoot,
  runWizard,
  createOrchestrator,
  stdout = process.stdout,
  stderr = process.stderr,
  stat = fs.stat
}) {
  const result = await runWizard(command, { projectRoot });
  if (result && result.runNow) {
    writeLine(stdout, 'Task written. Starting run...');
    return runCurrentTask({ projectRoot, createOrchestrator, stat, stderr });
  }
  return 0;
}

async function runAdvancedWizardCommand(args, {
  projectRoot,
  stdout,
  stderr,
  runAdvanced,
  createOrchestrator,
  stat = fs.stat
}) {
  if (!args.includes('--advanced')) {
    writeLine(stderr, 'Usage: npm run cli -- new --advanced');
    return 1;
  }

  const result = await runAdvanced({ projectRoot });
  if (result && result.runNow) {
    writeLine(stdout, 'Task written. Starting run...');
    return runCurrentTask({ projectRoot, createOrchestrator, stat, stderr });
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
      if (typeof nextValue !== 'string' || nextValue.trim() === '') {
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
    writeLine(stdout, 'Task written. Starting run...');
    return runCurrentTask({ projectRoot, createOrchestrator, stat, stderr });
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
  listPresetEntries = listPresets,
  savePresetFile = savePreset,
  usePresetFile = usePreset,
  runDoctor = runDoctorCheck,
  createForkTask = createForkTaskFromRun,
  compareRunsHelper = compareRuns
} = {}) {
  const normalizedCommand = typeof command === 'string' && command.trim() !== ''
    ? command.trim().toLowerCase()
    : 'help';

  if (normalizedCommand === 'help') {
    stdout.write(buildHelpText());
    return 0;
  }

  if (normalizedCommand === 'run') {
    return runCurrentTask({ projectRoot, createOrchestrator, stat, stderr });
  }

  if (normalizedCommand === 'open') {
    return openScratchpad({ projectRoot, stdout, readFile });
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
