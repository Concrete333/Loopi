const fs = require('fs').promises;
const path = require('path');
const { normalizeTaskConfig } = require('./task-config');
const taskPaths = require('./task-paths');
const { atomicWriteText } = require('./atomic-write');
const {
  createPromptIO,
  askRequiredText,
  askYesNo,
  askAgentSelection,
  askSingleAgentSelection,
  askModeSelection,
  askUseCase,
  askPositiveInteger
} = require('./cli-prompts');
const { getAllAdapterDisplayStatus } = require('./setup-service');

const COMMAND_TO_MODE = {
  plan: 'plan',
  review: 'review',
  implement: 'implement',
  oneshot: 'one-shot'
};

function isWriteMode(mode) {
  return mode === 'implement' || mode === 'one-shot';
}

function resolveWizardMode(command) {
  const normalized = String(command || '').trim().toLowerCase();
  const mode = COMMAND_TO_MODE[normalized];
  if (!mode) {
    throw new Error(`Unsupported beginner wizard command "${command}". Expected one of: plan, review, implement, oneshot.`);
  }
  return mode;
}

function buildWizardTaskConfig({
  mode,
  prompt,
  agents,
  includeContext = false,
  writeAgent = null,
  reviewPrompt = null,
  synthesisPrompt = null,
  customImplementPrompt = null,
  useCase = null,
  planLoops = null,
  qualityLoops = null,
  sectionImplementLoops = null,
  implementLoops = null
}) {
  const rawConfig = {
    mode,
    prompt,
    agents
  };

  if (useCase !== null) {
    rawConfig.useCase = useCase;
  }

  if (includeContext) {
    rawConfig.context = { dir: './context' };
  }

  if (writeAgent) {
    rawConfig.settings = {
      agentPolicies: {
        [writeAgent]: { canWrite: true }
      }
    };
  }

  if (reviewPrompt) {
    rawConfig.reviewPrompt = reviewPrompt;
  }
  if (synthesisPrompt) {
    rawConfig.synthesisPrompt = synthesisPrompt;
  }
  if (customImplementPrompt) {
    rawConfig.customImplementPrompt = customImplementPrompt;
  }

  if (planLoops !== null) {
    if (!rawConfig.settings) {
      rawConfig.settings = {};
    }
    rawConfig.settings.planLoops = planLoops;
  }

  if (qualityLoops !== null) {
    if (!rawConfig.settings) {
      rawConfig.settings = {};
    }
    rawConfig.settings.qualityLoops = qualityLoops;
  }

  if (sectionImplementLoops !== null) {
    if (!rawConfig.settings) {
      rawConfig.settings = {};
    }
    rawConfig.settings.sectionImplementLoops = sectionImplementLoops;
  }

  if (implementLoops !== null) {
    if (!rawConfig.settings) {
      rawConfig.settings = {};
    }
    rawConfig.settings.implementLoops = implementLoops;
  }

  return rawConfig;
}

async function pathExists(targetPath, stat = fs.stat) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function countFilesInDirectory(targetPath, readdir = fs.readdir) {
  let total = 0;
  const stack = [targetPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (entry.isFile()) {
        total += 1;
      }
    }
  }

  return total;
}

function summarizeLoopSettings({
  mode,
  planLoops,
  qualityLoops,
  sectionImplementLoops,
  implementLoops
}) {
  const lines = [];

  if (mode === 'plan' && planLoops !== null) {
    lines.push(`plan loops: ${planLoops}`);
  }

  if (mode === 'one-shot') {
    if (qualityLoops !== null) {
      lines.push(`quality loops: ${qualityLoops}`);
    }
    if (planLoops !== null) {
      lines.push(`plan loops: ${planLoops}`);
    }
    if (sectionImplementLoops !== null) {
      lines.push(`section loops: ${sectionImplementLoops}`);
    }
  }

  if (mode === 'implement' && implementLoops !== null) {
    lines.push(`implementation loops: ${implementLoops}`);
  }

  return lines;
}

async function confirmTaskWrite(io, {
  taskFile,
  mode,
  prompt,
  agents,
  useCase,
  includeContext,
  contextFileCount,
  contextFileCountKnown,
  planLoops,
  qualityLoops,
  sectionImplementLoops,
  implementLoops
}) {
  io.writeLine('About to write:');
  io.writeLine(`  file:        ${taskFile}`);
  io.writeLine(`  mode:        ${mode}`);
  io.writeLine(`  prompt:      ${prompt}`);
  io.writeLine(`  agents:      ${agents.join(', ')}`);
  io.writeLine(`  use case:    ${useCase || 'none'}`);
  io.writeLine(
    `  context:     ${includeContext
      ? (contextFileCountKnown ? `./context (${contextFileCount} file(s))` : './context (file count unavailable)')
      : 'none'}`
  );
  for (const line of summarizeLoopSettings({
    mode,
    planLoops,
    qualityLoops,
    sectionImplementLoops,
    implementLoops
  })) {
    io.writeLine(`  ${line}`);
  }

  return askYesNo(io, 'Write this task file?', {
    defaultValue: true
  });
}

async function chooseWriteAgent(io, agents, agentDisplayStatuses = null) {
  while (true) {
    const allowWrites = await askYesNo(io, 'Should one agent be allowed to edit files?', {
      defaultValue: false
    });

    if (allowWrites) {
      return askSingleAgentSelection(io, {
        message: 'Which one agent may edit files? (choose exactly one)',
        supportedAgents: agents,
        agentDisplayStatuses
      });
    }

    const continueWithoutWrites = await askYesNo(
      io,
      'Continue without file edits? This run will not be able to make repository changes',
      { defaultValue: false }
    );

    if (continueWithoutWrites) {
      return null;
    }
  }
}

function resolveUseCaseLoader(listUseCases) {
  const { listAvailableUseCases } = require('./use-case-loader');
  return typeof listUseCases === 'function' ? listUseCases : listAvailableUseCases;
}

async function resolveUseCaseSelection({
  io,
  mode,
  projectRoot,
  listUseCases
}) {
  if (mode === 'one-shot') {
    return askUseCase(io, { projectRoot, listUseCases });
  }

  if (mode !== 'plan') {
    return null;
  }

  let availableUseCases = [];
  try {
    availableUseCases = resolveUseCaseLoader(listUseCases)(projectRoot);
  } catch (error) {
    io.writeLine(`[warn] Could not read available use cases: ${error.message}. Continuing without a use case.`);
    return null;
  }

  if (availableUseCases.length === 0) {
    return null;
  }

  return askUseCase(io, { projectRoot, listUseCases });
}

async function collectWizardAnswers(mode, {
  io,
  projectRoot,
  stat = fs.stat,
  readdir = fs.readdir,
  includeRunNow = true,
  listUseCases = null,
  defaultLoopValue = null,
  runNowDefault = false,
  getAdapterStatuses = null
}) {
  const prompt = await askRequiredText(io, 'What do you want the agents to do', {
    emptyMessage: 'Please enter a non-empty prompt.'
  });
  let agentDisplayStatuses = [];
  if (typeof getAdapterStatuses === 'function') {
    try {
      agentDisplayStatuses = await getAdapterStatuses({ cwd: projectRoot });
    } catch {
      agentDisplayStatuses = [];
    }
  }
  const agents = await askAgentSelection(io, {
    agentDisplayStatuses
  });

  const useCase = await resolveUseCaseSelection({
    io,
    mode,
    projectRoot,
    listUseCases
  });

  // Ask for loop settings based on mode
  let planLoops = null;
  let qualityLoops = null;
  let sectionImplementLoops = null;
  let implementLoops = null;

  if (mode === 'plan') {
    planLoops = await askPositiveInteger(io, {
      message: 'Plan loops (how many plan-review-synthesis cycles)',
      fieldName: 'planLoops',
      defaultValue: defaultLoopValue
    });
  } else if (mode === 'one-shot') {
    qualityLoops = await askPositiveInteger(io, {
      message: 'Quality loops (outer one-shot reruns)',
      fieldName: 'qualityLoops',
      defaultValue: defaultLoopValue
    });
    planLoops = await askPositiveInteger(io, {
      message: 'Plan loops (cycles per quality loop)',
      fieldName: 'planLoops',
      defaultValue: defaultLoopValue
    });
    sectionImplementLoops = await askPositiveInteger(io, {
      message: 'Section implementation loops (per-section implement-review-repair cycles)',
      fieldName: 'sectionImplementLoops',
      defaultValue: defaultLoopValue
    });
  } else if (mode === 'implement') {
    implementLoops = await askPositiveInteger(io, {
      message: 'Implementation loops (implement-review-repair cycles)',
      fieldName: 'implementLoops',
      defaultValue: defaultLoopValue
    });
  }

  let writeAgent = null;
  if (isWriteMode(mode)) {
    const selectedStatuses = agentDisplayStatuses.filter((entry) => agents.includes(entry.id));
    writeAgent = await chooseWriteAgent(io, agents, selectedStatuses);
  }

  const contextDir = path.join(projectRoot, 'context');
  const contextAvailable = await pathExists(contextDir, stat);
  let includeContext = false;
  let contextFileCount = 0;
  let contextFileCountKnown = false;
  if (contextAvailable) {
    try {
      contextFileCount = await countFilesInDirectory(contextDir, readdir);
      contextFileCountKnown = true;
    } catch (error) {
      io.writeLine(`[warn] Could not inspect ./context: ${error.message}. You can still choose to include it.`);
    }

    if (!contextFileCountKnown) {
      includeContext = await askYesNo(io, 'Use the ./context folder for reference material? (file count unavailable)', {
        defaultValue: false
      });
    } else if (contextFileCount > 0) {
      includeContext = await askYesNo(
        io,
        `Use the ./context folder for reference material? (${contextFileCount} file(s) found)`,
        {
          defaultValue: false
        }
      );
    }
  }

  const runNow = includeRunNow
    ? await askYesNo(io, 'Run now?', {
      defaultValue: runNowDefault
    })
    : null;

  return {
    prompt,
    agents,
    writeAgent,
    includeContext,
    runNow,
    useCase,
    planLoops,
    qualityLoops,
    sectionImplementLoops,
    implementLoops,
    contextFileCount,
    contextFileCountKnown
  };
}

async function askOptionalText(io, enableMessage, promptMessage) {
  const enabled = await askYesNo(io, enableMessage, {
    defaultValue: false
  });

  if (!enabled) {
    return null;
  }

  return askRequiredText(io, promptMessage, {
    emptyMessage: 'Please enter a non-empty value.'
  });
}

async function runBeginnerWizard(command, {
  io = createPromptIO(),
  projectRoot = taskPaths.getProjectRoot(),
  normalizeConfig = normalizeTaskConfig,
  writeFile = fs.writeFile,
  rename = fs.rename,
  unlink = fs.unlink,
  mkdir = fs.mkdir,
  stat = fs.stat,
  readdir = fs.readdir,
  listUseCases = null,
  getAdapterStatuses = null
} = {}) {
  const mode = resolveWizardMode(command);
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  const sharedDir = taskPaths.sharedDir(projectRoot);

  try {
    const answers = await collectWizardAnswers(mode, {
      io,
      projectRoot,
      stat,
      readdir,
      includeRunNow: true,
      listUseCases,
      defaultLoopValue: 1,
      runNowDefault: false,
      getAdapterStatuses
    });

    const rawConfig = buildWizardTaskConfig({
      mode,
      prompt: answers.prompt,
      agents: answers.agents,
      includeContext: answers.includeContext,
      writeAgent: answers.writeAgent,
      useCase: answers.useCase,
      planLoops: answers.planLoops,
      qualityLoops: answers.qualityLoops,
      sectionImplementLoops: answers.sectionImplementLoops,
      implementLoops: answers.implementLoops
    });

    const normalizedConfig = normalizeConfig(rawConfig, { projectRoot });
    const confirmed = await confirmTaskWrite(io, {
      taskFile,
      mode,
      prompt: answers.prompt,
      agents: answers.agents,
      useCase: answers.useCase,
      includeContext: answers.includeContext,
      contextFileCount: answers.contextFileCount,
      contextFileCountKnown: answers.contextFileCountKnown,
      planLoops: answers.planLoops,
      qualityLoops: answers.qualityLoops,
      sectionImplementLoops: answers.sectionImplementLoops,
      implementLoops: answers.implementLoops
    });

    if (!confirmed) {
      io.writeLine('Task not written.');
      return {
        mode,
        rawConfig,
        normalizedConfig,
        runNow: false,
        taskFile,
        wroteTask: false
      };
    }

    await mkdir(sharedDir, { recursive: true });
    await atomicWriteText(taskFile, JSON.stringify(rawConfig, null, 2) + '\n', {
      writeFile,
      rename,
      unlink
    });

    if (!answers.runNow) {
      io.writeLine(`Task written to ${taskFile}`);
      io.writeLine('Run it later with: npm run cli -- run');
    }

    return {
      mode,
      rawConfig,
      normalizedConfig,
      runNow: answers.runNow,
      taskFile,
      wroteTask: true
    };
  } finally {
    if (io && typeof io.close === 'function') {
      await io.close();
    }
  }
}

async function runAdvancedWizard({
  io = createPromptIO(),
  projectRoot = taskPaths.getProjectRoot(),
  normalizeConfig = normalizeTaskConfig,
  writeFile = fs.writeFile,
  rename = fs.rename,
  unlink = fs.unlink,
  mkdir = fs.mkdir,
  stat = fs.stat,
  readdir = fs.readdir,
  listUseCases = null,
  getAdapterStatuses = null
} = {}) {
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  const sharedDir = taskPaths.sharedDir(projectRoot);

  try {
    const mode = await askModeSelection(io, {
      message: 'Which mode do you want to configure'
    });
    const answers = await collectWizardAnswers(mode, {
      io,
      projectRoot,
      stat,
      readdir,
      includeRunNow: false,
      listUseCases,
      defaultLoopValue: null,
      runNowDefault: false,
      getAdapterStatuses
    });

    let reviewPrompt = null;
    let synthesisPrompt = null;
    let customImplementPrompt = null;

    if (mode === 'plan') {
      reviewPrompt = await askOptionalText(
        io,
        'Add a custom review prompt override?',
        'Custom review prompt'
      );
      synthesisPrompt = await askOptionalText(
        io,
        'Add a custom synthesis prompt override?',
        'Custom synthesis prompt'
      );
    }

    if (mode === 'implement' || mode === 'one-shot') {
      customImplementPrompt = await askOptionalText(
        io,
        'Add custom implement guidance?',
        'Custom implement guidance'
      );
    }

    const runNow = await askYesNo(io, 'Run now?', {
      defaultValue: false
    });

    const rawConfig = buildWizardTaskConfig({
      mode,
      prompt: answers.prompt,
      agents: answers.agents,
      includeContext: answers.includeContext,
      writeAgent: answers.writeAgent,
      reviewPrompt,
      synthesisPrompt,
      customImplementPrompt,
      useCase: answers.useCase,
      planLoops: answers.planLoops,
      qualityLoops: answers.qualityLoops,
      sectionImplementLoops: answers.sectionImplementLoops,
      implementLoops: answers.implementLoops
    });

    const normalizedConfig = normalizeConfig(rawConfig, { projectRoot });
    const confirmed = await confirmTaskWrite(io, {
      taskFile,
      mode,
      prompt: answers.prompt,
      agents: answers.agents,
      useCase: answers.useCase,
      includeContext: answers.includeContext,
      contextFileCount: answers.contextFileCount,
      contextFileCountKnown: answers.contextFileCountKnown,
      planLoops: answers.planLoops,
      qualityLoops: answers.qualityLoops,
      sectionImplementLoops: answers.sectionImplementLoops,
      implementLoops: answers.implementLoops
    });

    if (!confirmed) {
      io.writeLine('Task not written.');
      return {
        mode,
        rawConfig,
        normalizedConfig,
        runNow: false,
        taskFile,
        wroteTask: false
      };
    }

    await mkdir(sharedDir, { recursive: true });
    await atomicWriteText(taskFile, JSON.stringify(rawConfig, null, 2) + '\n', {
      writeFile,
      rename,
      unlink
    });

    if (!runNow) {
      io.writeLine(`Task written to ${taskFile}`);
      io.writeLine('Run it later with: npm run cli -- run');
    }

    return {
      mode,
      rawConfig,
      normalizedConfig,
      runNow,
      taskFile,
      wroteTask: true
    };
  } finally {
    if (io && typeof io.close === 'function') {
      await io.close();
    }
  }
}

module.exports = {
  resolveWizardMode,
  buildWizardTaskConfig,
  runBeginnerWizard,
  runAdvancedWizard
};
