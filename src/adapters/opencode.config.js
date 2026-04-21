// Opencode model selection mechanism is pending investigation.
// Marked as fixed until we confirm a non-interactive startup/config-file path.
module.exports = {
  agent: 'opencode',
  selection: {
    model: {
      mode: 'fixed',
      fixedValue: 'MinMax M2.5 Free'
    },
    effort: {
      mode: 'unsupported'
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
