// Opencode model selection mechanism is pending investigation.
// Marked as fixed until we confirm a non-interactive startup/config-file path.
module.exports = {
  agent: 'opencode',
  selection: {
    model: {
      mode: 'startup_flag',
      flag: '--model',
      values: 'open',
      discovery: {
        type: 'cli',
        command: 'models'
      }
    },
    effort: {
      mode: 'unsupported'
    },
    agent: {
      mode: 'startup_flag',
      flag: '--agent',
      values: ['plan', 'build'],
      passThrough: true,
      label: 'Agent Mode'
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
