// OpenCode exposes these controls through `opencode run --help`.
// Model and agent lists are discovered from the installed CLI at runtime.
module.exports = {
  agent: 'opencode',
  selection: {
    model: {
      mode: 'startup_flag',
      flag: '--model',
      values: 'open',
      discovery: {
        type: 'cli',
        command: 'models',
        verbose: true
      }
    },
    effort: {
      mode: 'model_dependent',
      flag: '--variant',
      passThrough: true
    },
    agent: {
      mode: 'startup_flag',
      flag: '--agent',
      values: ['plan', 'build'],
      passThrough: true,
      label: 'Agent Mode',
      discovery: {
        type: 'cli',
        command: 'agents'
      }
    },
    showThinking: {
      mode: 'boolean_flag',
      flag: '--thinking',
      label: 'Show Thinking'
    }
  },
  writeMode: {
    readOnly: ['--agent', 'plan'],
    writable: ['--agent', 'build']
  },
  defaults: {
    canWrite: false
  }
};
