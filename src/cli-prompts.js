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
  message = 'Which agents should help?',
  supportedAgents = SUPPORTED_AGENTS
} = {}) {
  io.writeLine(`Supported agents: ${buildAgentMenu(supportedAgents)}`);
  io.writeLine('Enter agent names or numbers separated by commas.');

  while (true) {
    const result = parseAgentSelection(await io.prompt(`${message}: `), supportedAgents);
    if (result.ok) {
      return result.value;
    }
    io.writeLine(result.error);
  }
}

async function askSingleAgentSelection(io, {
  message,
  supportedAgents
}) {
  io.writeLine(`Choose one agent: ${buildAgentMenu(supportedAgents)}`);

  while (true) {
    const result = parseAgentSelection(await io.prompt(`${message}: `), supportedAgents);
    if (result.ok && result.value.length === 1) {
      return result.value[0];
    }
    if (result.ok) {
      io.writeLine('Please choose exactly one agent.');
      continue;
    }
    io.writeLine(result.error);
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

module.exports = {
  createPromptIO,
  askRequiredText,
  askYesNo,
  askAgentSelection,
  askSingleAgentSelection,
  askModeSelection,
  parseAgentSelection
};
