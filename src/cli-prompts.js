const readline = require('readline');
const { SUPPORTED_AGENTS } = require('./supported-agents');

function normalizeAnswer(value) {
  return String(value == null ? '' : value).trim();
}

function buildAgentMenu(agents) {
  return agents
    .map((agent, index) => `${index + 1}) ${agent}`)
    .join(', ');
}

function formatAgentStatus(displayStatus) {
  if (!displayStatus) {
    return null;
  }

  if (displayStatus.ready) {
    return 'ready';
  }

  if (displayStatus.status === 'installed_but_needs_login') {
    const command = displayStatus.nextAction && displayStatus.nextAction.command
      ? ` - run: ${displayStatus.nextAction.command}`
      : '';
    return `needs login${command}`;
  }

  if (displayStatus.status === 'missing') {
    return 'not installed';
  }

  if (displayStatus.errorMessage) {
    return `unavailable - ${displayStatus.errorMessage}`;
  }

  return 'needs setup';
}

function writeAgentMenu(io, supportedAgents, agentDisplayStatuses = null) {
  if (!agentDisplayStatuses || agentDisplayStatuses.length === 0) {
    io.writeLine(`Supported agents: ${buildAgentMenu(supportedAgents)}`);
    return;
  }

  const statusById = new Map(
    agentDisplayStatuses.map((entry) => [String(entry.id || '').trim().toLowerCase(), entry])
  );
  const longestAgent = supportedAgents.reduce((max, agent) => Math.max(max, agent.length), 0);

  io.writeLine('Supported agents:');
  supportedAgents.forEach((agent, index) => {
    const displayStatus = statusById.get(agent);
    const formattedStatus = formatAgentStatus(displayStatus);
    const paddedAgent = agent.padEnd(longestAgent, ' ');
    const suffix = formattedStatus ? ` [${formattedStatus}]` : '';
    io.writeLine(`  ${index + 1}) ${paddedAgent}${suffix}`);
  });
}

function parseYesNo(value, defaultValue = null) {
  const normalized = normalizeAnswer(value).toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (normalized === 'y' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'n' || normalized === 'no') {
    return false;
  }
  return null;
}

function parseAgentSelection(value, supportedAgents = SUPPORTED_AGENTS) {
  const normalized = normalizeAnswer(value);
  if (!normalized) {
    return {
      ok: false,
      error: `Please choose one or more agents from: ${supportedAgents.join(', ')}.`
    };
  }

  const tokens = normalized
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return {
      ok: false,
      error: `Please choose one or more agents from: ${supportedAgents.join(', ')}.`
    };
  }

  const values = [];
  const seen = new Set();

  for (const token of tokens) {
    let agent = null;
    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1;
      if (index >= 0 && index < supportedAgents.length) {
        agent = supportedAgents[index];
      }
    } else {
      const lowered = token.toLowerCase();
      if (supportedAgents.includes(lowered)) {
        agent = lowered;
      }
    }

    if (!agent) {
      return {
        ok: false,
        error: `Unknown agent selection "${token}". Choose from: ${supportedAgents.join(', ')}.`
      };
    }

    if (!seen.has(agent)) {
      seen.add(agent);
      values.push(agent);
    }
  }

  return { ok: true, value: values };
}

function createPromptIO({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean(input && input.isTTY && output && output.isTTY)
  });
  const queue = [];
  const waiters = [];
  let closed = false;

  rl.on('line', (line) => {
    if (waiters.length > 0) {
      waiters.shift()(line);
      return;
    }
    queue.push(line);
  });

  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()('');
    }
  });

  return {
    async prompt(message) {
      output.write(String(message || ''));

      if (queue.length > 0) {
        return queue.shift();
      }

      if (closed) {
        return '';
      }

      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    writeLine(message = '') {
      output.write(`${message}\n`);
    },
    async close() {
      rl.close();
    }
  };
}

async function askRequiredText(io, message, {
  emptyMessage = 'Please enter a value.'
} = {}) {
  while (true) {
    const answer = normalizeAnswer(await io.prompt(`${message}: `));
    if (answer) {
      return answer;
    }
    io.writeLine(emptyMessage);
  }
}

async function askYesNo(io, message, {
  defaultValue = null
} = {}) {
  const suffix = defaultValue === true
    ? ' [Y/n]'
    : defaultValue === false
      ? ' [y/N]'
      : ' [y/n]';

  while (true) {
    const parsed = parseYesNo(await io.prompt(`${message}${suffix}: `), defaultValue);
    if (parsed !== null) {
      return parsed;
    }
    io.writeLine('Please answer yes or no.');
  }
}

async function askAgentSelection(io, {
  message = 'Which agents should help? (one or more, comma-separated)',
  supportedAgents = SUPPORTED_AGENTS,
  agentDisplayStatuses = null
} = {}) {
  writeAgentMenu(io, supportedAgents, agentDisplayStatuses);
  io.writeLine('Enter agent names or numbers separated by commas.');

  while (true) {
    const result = parseAgentSelection(await io.prompt(`${message}: `), supportedAgents);
    if (result.ok) {
      return result.value;
    }
    io.writeLine(result.error);
    writeAgentMenu(io, supportedAgents, agentDisplayStatuses);
  }
}

async function askSingleAgentSelection(io, {
  message,
  supportedAgents,
  agentDisplayStatuses = null
}) {
  io.writeLine('Choose exactly one agent:');
  writeAgentMenu(io, supportedAgents, agentDisplayStatuses);

  while (true) {
    const result = parseAgentSelection(await io.prompt(`${message}: `), supportedAgents);
    if (result.ok && result.value.length === 1) {
      return result.value[0];
    }
    if (result.ok) {
      io.writeLine('Please choose exactly one agent.');
      writeAgentMenu(io, supportedAgents, agentDisplayStatuses);
      continue;
    }
    io.writeLine(result.error);
    writeAgentMenu(io, supportedAgents, agentDisplayStatuses);
  }
}

async function askModeSelection(io, {
  message = 'Which mode do you want to use?'
} = {}) {
  const supportedModes = [
    { label: 'plan', value: 'plan' },
    { label: 'review', value: 'review' },
    { label: 'implement', value: 'implement' },
    { label: 'oneshot', value: 'one-shot' }
  ];

  io.writeLine(`Modes: ${supportedModes.map((entry, index) => `${index + 1}) ${entry.label}`).join(', ')}`);

  while (true) {
    const answer = normalizeAnswer(await io.prompt(`${message}: `)).toLowerCase();
    if (!answer) {
      io.writeLine('Please choose a mode.');
      continue;
    }

    const byNumber = /^\d+$/.test(answer)
      ? supportedModes[Number(answer) - 1]
      : null;
    if (byNumber) {
      return byNumber.value;
    }

    const byName = supportedModes.find((entry) => entry.label === answer || entry.value === answer);
    if (byName) {
      return byName.value;
    }

    io.writeLine('Choose one of: plan, review, implement, oneshot.');
  }
}

async function askUseCase(io, {
  projectRoot,
  message = 'Which use case do you want to use?',
  listUseCases = null
} = {}) {
  const { listAvailableUseCases } = require('./use-case-loader');
  const loader = typeof listUseCases === 'function' ? listUseCases : listAvailableUseCases;
  const availableUseCases = loader(projectRoot);

  if (availableUseCases.length === 0) {
    throw new Error('No use cases are available. Add config/use-cases/*.json before using this wizard flow.');
  }

  io.writeLine(`Available use cases: ${availableUseCases.map((name, index) => `${index + 1}) ${name}`).join(', ')}`);
  io.writeLine('Enter a use case name or number.');

  while (true) {
    const answer = normalizeAnswer(await io.prompt(`${message}: `));
    if (!answer) {
      io.writeLine('Please choose a use case.');
      continue;
    }

    const byNumber = /^\d+$/.test(answer);
    const index = byNumber ? Number(answer) - 1 : -1;

    if (index >= 0 && index < availableUseCases.length) {
      return availableUseCases[index];
    }

    if (byNumber && index >= availableUseCases.length) {
      io.writeLine('Invalid number. Try again.');
      continue;
    }

    if (availableUseCases.includes(answer)) {
      return answer;
    }

    io.writeLine(`Unknown use case "${answer}". Available: ${availableUseCases.join(', ')}`);
  }
}

async function askPositiveInteger(io, {
  message,
  fieldName,
  defaultValue = null
} = {}) {
  while (true) {
    const suffix = Number.isInteger(defaultValue) && defaultValue > 0 ? ` [${defaultValue}]` : '';
    const answer = normalizeAnswer(await io.prompt(`${message}${suffix}: `));
    if (!answer && Number.isInteger(defaultValue) && defaultValue > 0) {
      return defaultValue;
    }
    const parsed = Number(answer);

    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    io.writeLine(`${fieldName} must be a positive integer.`);
  }
}

module.exports = {
  createPromptIO,
  askRequiredText,
  askYesNo,
  askAgentSelection,
  askSingleAgentSelection,
  askModeSelection,
  askUseCase,
  askPositiveInteger,
  parseAgentSelection
};
