// Claude model values are pending verification of exact --model CLI tokens.
// passThrough: true means unrecognized model strings are passed through to the
// CLI with an unverified_model_value warning, rather than blocked entirely.
// This avoids false validation failures while the real CLI tokens are confirmed.
module.exports = {
  agent: 'claude',
  selection: {
    model: {
      mode: 'startup_flag',
      flag: '--model',
      passThrough: true,
      values: {
        sonnet: { cliValue: 'sonnet', efforts: ['low', 'medium', 'high'] },
        opus: { cliValue: 'opus', efforts: ['low', 'medium', 'high', 'max'] },
        haiku: { cliValue: 'haiku', efforts: [] }
      },
      defaultValue: 'sonnet'
    },
    effort: {
      mode: 'model_dependent'
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
