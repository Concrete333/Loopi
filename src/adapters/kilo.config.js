module.exports = {
  agent: 'kilo',
  selection: {
    model: {
      mode: 'startup_flag',
      flag: '--model',
      values: {
        'Kilo Auto Frontier': {
          cliValue: 'Kilo Auto Frontier',
          label: 'Kilo Auto Frontier',
          efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        },
        'Kilo Auto Balanced': {
          cliValue: 'Kilo Auto Balanced',
          label: 'Kilo Auto Balanced',
          efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        },
        'Kilo Auto Free': {
          cliValue: 'Kilo Auto Free',
          label: 'Kilo Auto Free',
          efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        }
      },
      passThrough: true,
      warnOnPassThrough: false,
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
      values: ['code', 'ask', 'debug', 'plan'],
      passThrough: true,
      label: 'Agent Mode'
    },
    thinking: {
      mode: 'boolean_flag',
      flag: '--thinking',
      label: 'Thinking',
      modelDependent: true
    }
  },
  defaults: {
    canWrite: false
  }
};
