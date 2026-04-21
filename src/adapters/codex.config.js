module.exports = {
  agent: 'codex',
  selection: {
    model: {
      mode: 'startup_flag',
      flag: '--model',
      values: 'open',
      defaultValue: null
    },
    effort: {
      mode: 'separate_flag',
      flag: '--reasoning-effort',
      values: ['low', 'medium', 'high']
    }
  },
  writeMode: {
    readOnly: ['--sandbox', 'read-only'],
    writable: ['--sandbox', 'workspace-write']
  },
  defaults: {
    canWrite: false
  }
};
