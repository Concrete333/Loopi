module.exports = {
  agent: 'codex',
  selection: {
    model: {
      mode: 'startup_flag',
      flag: '--model',
      values: 'open',
      discovery: {
        type: 'codex-config'
      },
      defaultValue: null
    },
    effort: {
      mode: 'separate_flag',
      label: 'Effort',
      flag: '-c',
      configKey: 'model_reasoning_effort',
      values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
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
