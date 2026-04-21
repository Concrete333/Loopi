const fs = require('fs').promises;
const taskPaths = require('./task-paths');
const { DialecticOrchestrator } = require('./orchestrator');
const { runBeginnerWizard, runAdvancedWizard } = require('./cli-wizard');
const { listPresets, savePreset, usePreset } = require('./cli-presets');
const { runDoctorCheck } = require('./cli-doctor');

function buildHelpText() {
  return [
    'Dialectic CLI',
    '',
    'Usage:',
    '  npm run cli -- <command>',
    '  npm run cli -- new --advanced',
    '  npm run cli -- preset <save|list|use> [name]',
    '',
    'Available commands:',
    '  help        Show this help text',
    '  run         Run the current shared/task.json through Dialectic',
    '  open        Show the scratchpad path and print its contents if present',
    '  plan        Interactive plan-mode wizard',
    '  review      Interactive review-mode wizard',
    '  implement   Interactive implement-mode wizard',
    '  oneshot     Interactive one-shot wizard',
    '  preset      Save, list, or use named task presets',
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

async function runCommand(command, {
  projectRoot = taskPaths.getProjectRoot(),
  stdout = process.stdout,
  stderr = process.stderr,
  args = [],
  readFile = fs.readFile,
  stat = fs.stat,
  createOrchestrator = async (root) => new DialecticOrchestrator({ projectRoot: root }),
  runWizard = runBeginnerWizard,
  runAdvanced = runAdvancedWizard,
  listPresetEntries = listPresets,
  savePresetFile = savePreset,
  usePresetFile = usePreset,
  runDoctor = runDoctorCheck
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
