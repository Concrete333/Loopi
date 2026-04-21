module.exports = {
  agent: 'gemini',
  selection: {
    model: {
      mode: 'startup_flag',
      flag: '--model',
      values: {
        'gemini-3-flash-preview': { cliValue: 'gemini-3-flash-preview', efforts: [] },
        'gemini-3.1-flash-lite-preview': { cliValue: 'gemini-3.1-flash-lite-preview', efforts: [] },
        'gemini-2.5-flash': { cliValue: 'gemini-2.5-flash', efforts: [] },
        'gemini-2.5-flash-lite': { cliValue: 'gemini-2.5-flash-lite', efforts: [] }
      },
      defaultValue: 'gemini-2.5-flash'
    },
    effort: {
      mode: 'unsupported'
    }
  },
  defaults: {
    canWrite: false
  }
};
