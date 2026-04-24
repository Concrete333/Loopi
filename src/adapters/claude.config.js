// Claude Code's /model picker is discovered from the installed CLI bundle at
// runtime, so Loopi follows CLI updates instead of carrying a model list here.
module.exports = {
  agent: 'claude',
  selection: {
    model: {
      mode: 'startup_flag',
      flag: '--model',
      passThrough: true,
      defaultSentinelValues: ['default'],
      defaultOptionMode: 'discovered',
      discovery: {
        type: 'claude-bundle-model-options'
      }
    },
    effort: {
      mode: 'separate_flag',
      label: 'Effort',
      flag: '--effort',
      values: ['low', 'medium', 'high', 'max']
    }
  },
  writeMode: {
    readOnly: ['--permission-mode', 'plan'],
    writable: ['--permission-mode', 'bypassPermissions']
  },
  defaults: {
    canWrite: false
  }
};
