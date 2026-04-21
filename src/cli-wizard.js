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
  askModeSelection
} = require('./cli-prompts');

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
  customImplementPrompt = null
}) {
  const rawConfig = {
    mode,
    prompt,
    agents
  };

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

async function chooseWriteAgent(io, agents) {
  while (true) {
    const allowWrites = await askYesNo(io, 'Should one agent be allowed to edit files?', {
      defaultValue: false
    });

    if (allowWrites) {
      return askSingleAgentSelection(io, {
        message: 'Which agent may edit files',
        supportedAgents: agents
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

async function collectWizardAnswers(mode, {
  io,
  projectRoot,
  stat = fs.stat,
  includeRunNow = true
}) {
  const prompt = await askRequiredText(io, 'What do you want the agents to do', {
    emptyMessage: 'Please enter a non-empty prompt.'
  });
  const agents = await askAgentSelection(io, {
    message: 'Which agents should help'
  });

  let writeAgent = null;
  if (isWriteMode(mode)) {
    writeAgent = await chooseWriteAgent(io, agents);
  }

  const contextDir = path.join(projectRoot, 'context');
  const contextAvailable = await pathExists(contextDir, stat);
  let includeContext = false;
  if (contextAvailable) {
    includeContext = await askYesNo(io, 'Use the ./context folder for reference material?', {
      defaultValue: false
    });
  }

  const runNow = includeRunNow
    ? await askYesNo(io, 'Run now?', {
      defaultValue: true
    })
    : null;

  return {
    prompt,
    agents,
    writeAgent,
    includeContext,
    runNow
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
  stat = fs.stat
} = {}) {
  const mode = resolveWizardMode(command);
  const taskFile = taskPaths.legacyTaskFile(projectRoot);
  const sharedDir = taskPaths.sharedDir(projectRoot);

  try {
    const answers = await collectWizardAnswers(mode, {
      io,
      projectRoot,
      stat,
      includeRunNow: true
    });

    const rawConfig = buildWizardTaskConfig({
      mode,
      prompt: answers.prompt,
      agents: answers.agents,
      includeContext: answers.includeContext,
      writeAgent: answers.writeAgent
    });

    const normalizedConfig = normalizeConfig(rawConfig, { projectRoot });

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
      taskFile
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
  stat = fs.stat
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
      includeRunNow: false
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
      defaultValue: true
    });

    const rawConfig = buildWizardTaskConfig({
      mode,
      prompt: answers.prompt,
      agents: answers.agents,
      includeContext: answers.includeContext,
      writeAgent: answers.writeAgent,
      reviewPrompt,
      synthesisPrompt,
      customImplementPrompt
    });

    const normalizedConfig = normalizeConfig(rawConfig, { projectRoot });

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
      taskFile
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
