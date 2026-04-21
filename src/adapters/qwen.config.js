module.exports = {
  agent: 'qwen',
  selection: {
    model: {
      mode: 'fixed',
      fixedValue: 'coder-model'
    },
    effort: {
      mode: 'unsupported'
    }
  },
  writeMode: {
    readOnly: ['--approval-mode', 'plan'],
    writable: ['--approval-mode', 'full']
  },
  defaults: {
    canWrite: false
  }
};
