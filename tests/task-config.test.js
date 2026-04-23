const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeTaskConfig } = require('../src/task-config');

const PROJECT_ROOT = __dirname + '/..';

function baseTask(overrides = {}) {
  return {
    mode: 'plan',
    prompt: 'Test prompt',
    agents: ['claude'],
    settings: { cwd: '.', timeoutMs: 10000 },
    ...overrides
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

console.log('task-config: normalizeCustomPrompts + useCase');

test('reviewPrompt and synthesisPrompt accepted for plan mode, trimmed', () => {
  const config = normalizeTaskConfig(baseTask({
    reviewPrompt: '  Focus on edge cases  ',
    synthesisPrompt: '  Keep it concise  '
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.reviewPrompt, 'Focus on edge cases');
  assert.strictEqual(config.synthesisPrompt, 'Keep it concise');
});

test('reviewPrompt defaults to null when absent', () => {
  const config = normalizeTaskConfig(baseTask(), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.reviewPrompt, null);
});

test('synthesisPrompt defaults to null when absent', () => {
  const config = normalizeTaskConfig(baseTask(), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.synthesisPrompt, null);
});

test('customImplementPrompt defaults to null when absent', () => {
  const config = normalizeTaskConfig(baseTask({ mode: 'implement' }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.customImplementPrompt, null);
});

test('reviewPrompt rejected for non-plan modes with clear error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ mode: 'implement', reviewPrompt: 'extra' }), { projectRoot: PROJECT_ROOT });
  }, /"reviewPrompt" is only valid for mode "plan"/);
});

test('synthesisPrompt rejected for non-plan modes with clear error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ mode: 'review', synthesisPrompt: 'extra' }), { projectRoot: PROJECT_ROOT });
  }, /"synthesisPrompt" is only valid for mode "plan"/);
});

test('customImplementPrompt accepted for implement mode, trimmed', () => {
  const config = normalizeTaskConfig(baseTask({
    mode: 'implement',
    customImplementPrompt: '  Keep migrations isolated  '
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.customImplementPrompt, 'Keep migrations isolated');
});

test('customImplementPrompt accepted for one-shot mode, trimmed', () => {
  const config = normalizeTaskConfig(baseTask({
    mode: 'one-shot',
    useCase: 'coding',
    customImplementPrompt: '  Favor small commits  '
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.customImplementPrompt, 'Favor small commits');
});

test('customImplementPrompt rejected for plan mode with clear error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ customImplementPrompt: 'extra' }), { projectRoot: PROJECT_ROOT });
  }, /"customImplementPrompt" is only valid for modes "implement" and "one-shot"/);
});

test('reviewPrompt rejected when empty string', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ reviewPrompt: '' }), { projectRoot: PROJECT_ROOT });
  }, /"reviewPrompt" must be a non-empty string/);
});

test('synthesisPrompt rejected when empty string', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ synthesisPrompt: '   ' }), { projectRoot: PROJECT_ROOT });
  }, /"synthesisPrompt" must be a non-empty string/);
});

test('reviewPrompt rejected when non-string', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ reviewPrompt: 123 }), { projectRoot: PROJECT_ROOT });
  }, /"reviewPrompt" must be a non-empty string/);
});

test('synthesisPrompt rejected when non-string', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ synthesisPrompt: {} }), { projectRoot: PROJECT_ROOT });
  }, /"synthesisPrompt" must be a non-empty string/);
});

test('customImplementPrompt rejected when empty string', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ mode: 'implement', customImplementPrompt: '   ' }), { projectRoot: PROJECT_ROOT });
  }, /"customImplementPrompt" must be a non-empty string/);
});

test('customImplementPrompt rejected when non-string', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ mode: 'one-shot', useCase: 'coding', customImplementPrompt: {} }), { projectRoot: PROJECT_ROOT });
  }, /"customImplementPrompt" must be a non-empty string/);
});

test('useCase loads when present in plan mode', () => {
  const config = normalizeTaskConfig(baseTask({ useCase: 'coding' }), { projectRoot: PROJECT_ROOT });
  assert.ok(config.useCase);
  assert.strictEqual(config.useCase.name, 'coding');
});

test('useCase loads when present in one-shot mode', () => {
  const config = normalizeTaskConfig(baseTask({ mode: 'one-shot', useCase: 'coding' }), { projectRoot: PROJECT_ROOT });
  assert.ok(config.useCase);
  assert.strictEqual(config.useCase.name, 'coding');
});

test('useCase defaults to null when absent', () => {
  const config = normalizeTaskConfig(baseTask(), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.useCase, null);
});

test('fork defaults to null when absent', () => {
  const config = normalizeTaskConfig(baseTask(), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.fork, null);
});

test('fork accepts required and optional lineage fields, trimmed', () => {
  const config = normalizeTaskConfig(baseTask({
    fork: {
      forkedFromRunId: '  run-001  ',
      forkedFromStepId: '  implement-2  ',
      baseCommit: '  abc123  ',
      reason: '  Retry with stronger review  ',
      recordedBy: '  manual  '
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.fork, {
    forkedFromRunId: 'run-001',
    forkedFromStepId: 'implement-2',
    baseCommit: 'abc123',
    reason: 'Retry with stronger review',
    recordedBy: 'manual'
  });
});

test('fork defaults recordedBy to manual when omitted', () => {
  const config = normalizeTaskConfig(baseTask({
    fork: {
      forkedFromRunId: 'run-001'
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.fork.recordedBy, 'manual');
});

test('fork rejects non-object values', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ fork: 'run-001' }), { projectRoot: PROJECT_ROOT });
  }, /"fork" must be an object/);
});

test('fork rejects missing forkedFromRunId', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ fork: {} }), { projectRoot: PROJECT_ROOT });
  }, /fork\.forkedFromRunId must be a non-empty string/);
});

test('fork rejects blank optional strings', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      fork: {
        forkedFromRunId: 'run-001',
        reason: '   '
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /fork\.reason must be a non-empty string when provided/);
});

test('useCase rejected for unsupported modes with explicit error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ mode: 'review', useCase: 'coding' }), { projectRoot: PROJECT_ROOT });
  }, /useCase is currently supported only in modes "plan" and "one-shot"/);
});

test('unknown useCase name throws', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ useCase: 'not-real' }), { projectRoot: PROJECT_ROOT });
  }, /Available use cases:/);
});

console.log('\ntask-config: implementLoops, planLoops, and sectionImplementLoops');

test('implementLoops defaults to qualityLoops when not set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.implementLoops, 3);
});

test('implementLoops defaults to 1 when neither implementLoops nor qualityLoops is set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.implementLoops, 1);
});

test('implementLoops uses explicit value when set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, implementLoops: 5 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.implementLoops, 5);
});

test('implementLoops ignores qualityLoops when explicit', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2, implementLoops: 4 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.implementLoops, 4);
});

test('implementLoops rejects zero', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, implementLoops: 0 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.implementLoops must be a positive integer/);
});

test('implementLoops rejects negative', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, implementLoops: -1 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.implementLoops must be a positive integer/);
});

test('implementLoops rejects non-integer', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, implementLoops: 2.5 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.implementLoops must be a positive integer/);
});

test('one-shot mode requires useCase at config load time', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      mode: 'one-shot',
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 1 }
    }), { projectRoot: PROJECT_ROOT });
  }, /mode "one-shot" requires a non-empty "useCase"/);
});

test('sectionImplementLoops defaults to implementLoops when not set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, implementLoops: 4 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 4);
});

test('sectionImplementLoops defaults to qualityLoops via legacy planLoops fallback when no other loop values are set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 3);
});

test('sectionImplementLoops defaults to 1 when nothing is set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 1);
});

test('sectionImplementLoops uses deprecated implementLoopsPerUnit input when set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, implementLoopsPerUnit: 2, implementLoops: 5, qualityLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 2);
});

test('deprecated implementLoopsPerUnit rejects zero through sectionImplementLoops normalization', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, implementLoopsPerUnit: 0 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.implementLoopsPerUnit must be a positive integer/);
});

test('deprecated implementLoopsPerUnit rejects negative through sectionImplementLoops normalization', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, implementLoopsPerUnit: -2 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.implementLoopsPerUnit must be a positive integer/);
});

test('deprecated implementLoopsPerUnit rejects non-integer through sectionImplementLoops normalization', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, implementLoopsPerUnit: 1.5 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.implementLoopsPerUnit must be a positive integer/);
});

test('qualityLoops: 0 throws instead of silently defaulting to 1', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 0 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.qualityLoops must be a positive integer/);
});

test('qualityLoops: 0 propagates error through implementLoops fallback', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 0 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.qualityLoops must be a positive integer/);
});

test('qualityLoops: 0 propagates error through sectionImplementLoops fallback', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 0 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.qualityLoops must be a positive integer/);
});

console.log('\ntask-config: agentPolicies canWrite validation');

test('null policy remains canWrite=false (no error)', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: null } }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.settings.agentPolicies.claude.canWrite, false);
});

test('undefined policy remains canWrite=false (no error)', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000 }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.settings.agentPolicies.claude.canWrite, false);
});

test('boolean policy true sets canWrite=true', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: true } }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.settings.agentPolicies.claude.canWrite, true);
});

test('boolean policy false sets canWrite=false', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: false } }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.settings.agentPolicies.claude.canWrite, false);
});

test('object with canWrite true sets canWrite=true', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: { canWrite: true } } }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.settings.agentPolicies.claude.canWrite, true);
});

test('object with canWrite false sets canWrite=false', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: { canWrite: false } } }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.settings.agentPolicies.claude.canWrite, false);
});

test('string policy value throws with clear message', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: 'write' } }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.agentPolicies.claude must be a boolean or an object with a "canWrite" key/);
});

test('object without canWrite key throws with clear message', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: { enabled: true } } }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.agentPolicies.claude must be a boolean or an object with a "canWrite" key/);
});

test('number policy value throws with clear message', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: 1 } }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.agentPolicies.claude must be a boolean or an object with a "canWrite" key/);
});

test('array policy value throws with clear message', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, agentPolicies: { claude: [true] } }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings.agentPolicies.claude must be a boolean or an object with a "canWrite" key/);
});

console.log('\ntask-config: providers normalization');

test('Valid provider config normalizes without errors', () => {
  const config = normalizeTaskConfig(baseTask({
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        apiKey: 'dummy-or-token',
        model: 'Qwen/Qwen2.5-0.5B',
        healthEndpoint: '/health/ready',
        maxInputChars: 12000,
        local: true,
        chatTemplateMode: 'openai',
        requestDefaults: {
          temperature: 0.7,
          max_tokens: 2048,
          timeoutMs: 30000,
          top_p: 0.9
        },
        retryPolicy: {
          maxAttempts: 2,
          backoffMs: 750
        }
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.ok(config.providers);
  assert.ok(config.providers['nim-local']);
  assert.strictEqual(config.providers['nim-local'].type, 'openai-compatible');
  assert.strictEqual(config.providers['nim-local'].baseUrl, 'http://localhost:8000/v1');
  assert.strictEqual(config.providers['nim-local'].model, 'Qwen/Qwen2.5-0.5B');
  assert.strictEqual(config.providers['nim-local'].apiKey, 'dummy-or-token');
  assert.strictEqual(config.providers['nim-local'].healthEndpoint, '/health/ready');
  assert.strictEqual(config.providers['nim-local'].maxInputChars, 12000);
  assert.strictEqual(config.providers['nim-local'].local, true);
  assert.strictEqual(config.providers['nim-local'].chatTemplateMode, 'openai');
  assert.strictEqual(config.providers['nim-local'].requestDefaults.temperature, 0.7);
  assert.strictEqual(config.providers['nim-local'].requestDefaults.max_tokens, 2048);
  assert.strictEqual(config.providers['nim-local'].requestDefaults.timeoutMs, 30000);
  assert.strictEqual(config.providers['nim-local'].requestDefaults.top_p, 0.9);
  assert.strictEqual(config.providers['nim-local'].retryPolicy.maxAttempts, 2);
  assert.strictEqual(config.providers['nim-local'].retryPolicy.backoffMs, 750);
});

test('Missing baseUrl throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          model: 'Qwen/Qwen2.5-0.5B'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /Provider "nim-local" must have a "baseUrl" field/);
});

test('Missing model throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /Provider "nim-local" must have a "model" field/);
});

test('Invalid URL format throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'ftp://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-0.5B'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /baseUrl must start with "http:\/\/" or "https:\/\/"/);
});

test('Non-boolean local flag throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-0.5B',
          local: 'yes'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /Provider "nim-local" local must be a boolean if provided/);
});

test('Malformed absolute URL throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://',
          model: 'Qwen/Qwen2.5-0.5B'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /baseUrl must be a valid absolute URL|baseUrl must include a hostname/);
});

test('Unsupported type throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'unknown-type',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-0.5B'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /has unsupported type "unknown-type"/);
});

test('Invalid temperature value throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-0.5B',
          requestDefaults: {
            temperature: 3.5
          }
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /requestDefaults.temperature must be a number between 0 and 2/);
});

test('Invalid retryPolicy.maxAttempts throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-0.5B',
          retryPolicy: {
            maxAttempts: 10
          }
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /retryPolicy.maxAttempts must not exceed 5/);
});

test('Partial retryPolicy is completed during config normalization', () => {
  const config = normalizeTaskConfig(baseTask({
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'Qwen/Qwen2.5-0.5B',
        retryPolicy: {
          maxAttempts: 3
        }
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.providers['nim-local'].retryPolicy, { maxAttempts: 3, backoffMs: 750 });
});

test('Absent retryPolicy normalizes to the default retry policy', () => {
  const config = normalizeTaskConfig(baseTask({
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'Qwen/Qwen2.5-0.5B'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.providers['nim-local'].retryPolicy, { maxAttempts: 2, backoffMs: 750 });
});

test('Unsupported chatTemplateMode throws a descriptive error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-0.5B',
          chatTemplateMode: 'xml'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /chatTemplateMode.*openai.*raw/i);
});

test('Absent providers key results in empty providers: {}', () => {
  const config = normalizeTaskConfig(baseTask({}), { projectRoot: PROJECT_ROOT });
  assert.ok(config.providers);
  assert.strictEqual(Object.keys(config.providers).length, 0);
});

test('Existing CLI-only task config still normalizes cleanly', () => {
  const config = normalizeTaskConfig(baseTask({
    mode: 'plan',
    prompt: 'Test prompt',
    agents: ['claude', 'codex'],
    settings: { cwd: '.', timeoutMs: 10000 }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.mode, 'plan');
  assert.strictEqual(config.prompt, 'Test prompt');
  assert.deepStrictEqual(config.agents, ['claude', 'codex']);
  assert.ok(config.providers);
  assert.strictEqual(Object.keys(config.providers).length, 0);
});

console.log('\ntask-config: context normalization');

test('Valid context config normalizes cleanly', () => {
  const config = normalizeTaskConfig(baseTask({
    context: {
      dir: './context',
      include: ['**/*.md', '**/*.txt', '**/*.json', '**/*.yaml', '**/*.sql'],
      exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/*.png', '**/*.zip'],
      maxFilesPerPhase: {
        plan: 8,
        implement: 12,
        review: 10
      },
      maxCharsPerPhase: {
        plan: 20000,
        implement: 30000,
        review: 24000
      },
      manifest: './context/context.json'
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.ok(config.context);
  assert.strictEqual(config.context.dir, './context');
  assert.deepStrictEqual(config.context.include, ['**/*.md', '**/*.txt', '**/*.json', '**/*.yaml', '**/*.sql']);
  assert.deepStrictEqual(config.context.exclude, ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/*.png', '**/*.zip']);
  assert.strictEqual(config.context.maxFilesPerPhase.plan, 8);
  assert.strictEqual(config.context.maxFilesPerPhase.implement, 12);
  assert.strictEqual(config.context.maxFilesPerPhase.review, 10);
  assert.strictEqual(config.context.maxCharsPerPhase.plan, 20000);
  assert.strictEqual(config.context.maxCharsPerPhase.implement, 30000);
  assert.strictEqual(config.context.maxCharsPerPhase.review, 24000);
  assert.strictEqual(config.context.manifest, './context/context.json');
  assert.deepStrictEqual(config.context.deliveryPolicy, {
    planInitial: 'full',
    planReview: 'digest',
    reviewInitial: 'full',
    reviewParallel: 'full',
    reviewSynthesis: 'digest',
    implementInitial: 'full',
    implementReview: 'full',
    implementRepair: 'digest'
  });
  assert.deepStrictEqual(config.context.deliveryPolicyOverrides, {});
});

test('Mixed-case context phase caps normalize to lowercase keys', () => {
  const config = normalizeTaskConfig(baseTask({
    context: {
      dir: './context',
      maxFilesPerPhase: {
        Plan: 8,
        Implement: 12,
        REVIEW: 10
      },
      maxCharsPerPhase: {
        Plan: 20000,
        Implement: 30000,
        REVIEW: 24000
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.context.maxFilesPerPhase, {
    plan: 8,
    implement: 12,
    review: 10
  });
  assert.deepStrictEqual(config.context.maxCharsPerPhase, {
    plan: 20000,
    implement: 30000,
    review: 24000
  });
});

test('Context deliveryPolicy merges partial overrides with current defaults', () => {
  const config = normalizeTaskConfig(baseTask({
    context: {
      dir: './context',
      deliveryPolicy: {
        reviewParallel: 'digest',
        implementRepair: 'none'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.context.deliveryPolicy, {
    planInitial: 'full',
    planReview: 'digest',
    reviewInitial: 'full',
    reviewParallel: 'digest',
    reviewSynthesis: 'digest',
    implementInitial: 'full',
    implementReview: 'full',
    implementRepair: 'none'
  });
  assert.deepStrictEqual(config.context.deliveryPolicyOverrides, {
    reviewParallel: true,
    implementRepair: true
  });
});

test('Context deliveryPolicy default fills all stages without marking overrides', () => {
  const config = normalizeTaskConfig(baseTask({
    context: {
      dir: './context',
      deliveryPolicy: {
        default: 'digest'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.context.deliveryPolicy, {
    planInitial: 'digest',
    planReview: 'digest',
    reviewInitial: 'digest',
    reviewParallel: 'digest',
    reviewSynthesis: 'digest',
    implementInitial: 'digest',
    implementReview: 'digest',
    implementRepair: 'digest'
  });
  assert.deepStrictEqual(config.context.deliveryPolicyOverrides, {});
});

test('Context deliveryPolicy explicit stage keys win over default fills', () => {
  const config = normalizeTaskConfig(baseTask({
    context: {
      dir: './context',
      deliveryPolicy: {
        default: 'digest',
        planInitial: 'full'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.context.deliveryPolicy, {
    planInitial: 'full',
    planReview: 'digest',
    reviewInitial: 'digest',
    reviewParallel: 'digest',
    reviewSynthesis: 'digest',
    implementInitial: 'digest',
    implementReview: 'digest',
    implementRepair: 'digest'
  });
  assert.deepStrictEqual(config.context.deliveryPolicyOverrides, {
    planInitial: true
  });
});

test('reviewParallel remains full by default until explicitly overridden', () => {
  const config = normalizeTaskConfig(baseTask({
    context: {
      dir: './context'
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.context.deliveryPolicy.reviewParallel, 'full');

  const overriddenConfig = normalizeTaskConfig(baseTask({
    context: {
      dir: './context',
      deliveryPolicy: {
        reviewParallel: 'digest'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(overriddenConfig.context.deliveryPolicy.reviewParallel, 'digest');
});

test('shared/task.example.json examples stay valid and normalize cleanly', () => {
  const examplePath = path.join(PROJECT_ROOT, 'shared', 'task.example.json');
  const examples = JSON.parse(fs.readFileSync(examplePath, 'utf8'));

  const aggressiveConfig = normalizeTaskConfig(examples.oneShotAggressiveContextSavingsExample, { projectRoot: PROJECT_ROOT });
  assert.deepStrictEqual(aggressiveConfig.context.deliveryPolicy, {
    planInitial: 'digest',
    planReview: 'digest',
    reviewInitial: 'digest',
    reviewParallel: 'digest',
    reviewSynthesis: 'digest',
    implementInitial: 'full',
    implementReview: 'digest',
    implementRepair: 'none'
  });
  assert.deepStrictEqual(aggressiveConfig.context.deliveryPolicyOverrides, {
    implementInitial: true,
    implementRepair: true
  });

  const reviewConfig = normalizeTaskConfig(examples.reviewWithLocalProviderExample, { projectRoot: PROJECT_ROOT });
  assert.deepStrictEqual(reviewConfig.context.deliveryPolicyOverrides, {
    reviewInitial: true,
    reviewParallel: true
  });
});

test('Unknown context deliveryPolicy key throws clear load-time error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context',
        deliveryPolicy: {
          planFinal: 'digest'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /Unknown context\.deliveryPolicy key "planFinal"\. Allowed keys:/i);
});

test('planSynthesis typo points users to reviewSynthesis', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context',
        deliveryPolicy: {
          planSynthesis: 'digest'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /Unknown context\.deliveryPolicy key "planSynthesis"\. Plan-mode synthesis is governed by "reviewSynthesis"\. Allowed keys:/i);
});

test('Unknown context deliveryPolicy value throws clear load-time error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context',
        deliveryPolicy: {
          implementRepair: 'compact'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /context\.deliveryPolicy\.implementRepair must be one of: full, digest, none/i);
});

test('Invalid context deliveryPolicy default value throws clear load-time error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context',
        deliveryPolicy: {
          default: 'compact'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /context\.deliveryPolicy\.default must be one of: full, digest, none/i);
});

test('Missing dir when context key is present throws an error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        include: ['**/*.md']
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /context.dir is required/);
});

test('Missing context directory fails at config load time', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context/does-not-exist'
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /context.dir does not exist/i);
});

test('Context maxCharsPerPhase with non-integer value throws an error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context',
        maxCharsPerPhase: {
          review: 12.5
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /context.maxCharsPerPhase.review must be a positive integer/i);
});

test('Invalid maxFilesPerPhase value (e.g. negative number) throws an error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context',
        maxFilesPerPhase: {
          plan: -5
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /context.maxFilesPerPhase.plan must be a positive integer/);
});

test('Unknown maxFilesPerPhase key throws clear load-time error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context',
        maxFilesPerPhase: {
          reveiw: 5
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /context.maxFilesPerPhase.reveiw is invalid/i);
});

test('Unknown maxCharsPerPhase key throws clear load-time error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      context: {
        dir: './context',
        maxCharsPerPhase: {
          reveiw: 5000
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /context.maxCharsPerPhase.reveiw is invalid/i);
});

test('Absent context key results in config.context === null', () => {
  const config = normalizeTaskConfig(baseTask({}), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.context, null);
});

test('Context config and provider config can coexist in the same task config', () => {
  const config = normalizeTaskConfig(baseTask({
    context: {
      dir: './context',
      include: ['**/*.md']
    },
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'Qwen/Qwen2.5-0.5B'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.ok(config.context);
  assert.strictEqual(config.context.dir, './context');
  assert.ok(config.providers);
  assert.ok(config.providers['nim-local']);
  assert.strictEqual(config.providers['nim-local'].type, 'openai-compatible');
});

test('Configured provider IDs are allowed in the agents list', () => {
  const config = normalizeTaskConfig(baseTask({
    mode: 'review',
    agents: ['nim-local', 'claude'],
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'Qwen/Qwen2.5-0.5B'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.agents, ['nim-local', 'claude']);
});

test('oneShotOrigins can reference configured provider IDs present in agents list', () => {
  const config = normalizeTaskConfig(baseTask({
    mode: 'one-shot',
    useCase: 'coding',
    agents: ['claude', 'nim-local'],
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'Qwen/Qwen2.5-0.5B'
      }
    },
    settings: {
      cwd: '.',
      timeoutMs: 10000,
      oneShotOrigins: {
        review: 'nim-local'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.strictEqual(config.settings.oneShotOrigins.review, 'nim-local');
});

test('Mixed-case provider key is normalized to lowercase', () => {
  const config = normalizeTaskConfig(baseTask({
    providers: {
      'NIM-Local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'Qwen/Qwen2.5-0.5B'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  // Provider should be stored under lowercase key
  assert.ok(config.providers['nim-local']);
  // Original mixed-case key should NOT exist
  assert.strictEqual(config.providers['NIM-Local'], undefined);
  // The id field should match the normalized key
  assert.strictEqual(config.providers['nim-local'].id, 'nim-local');
});

test('agents: ["nim-local"] matches providers: { "NIM-Local": ... }', () => {
  const config = normalizeTaskConfig(baseTask({
    agents: ['nim-local'],
    providers: {
      'NIM-Local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'Qwen/Qwen2.5-0.5B'
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  // Agents are normalized to lowercase
  assert.deepStrictEqual(config.agents, ['nim-local']);
  // Provider should be accessible via lowercase key
  assert.ok(config.providers['nim-local']);
  assert.strictEqual(config.providers['nim-local'].type, 'openai-compatible');
});

test('Duplicate provider IDs after normalization throw clearly', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        'NIM-Local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-0.5B'
        },
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8001/v1',
          model: 'Qwen/Qwen2.5-7B'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /Provider ID collision.*"nim-local"/i);
});

test('Whitespace-only provider key is normalized to empty, then throws', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      providers: {
        '   ': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'Qwen/Qwen2.5-0.5B'
        }
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /Provider ID "\s+" is empty after normalization/);
});

console.log('\ntask-config: planQuestionMode normalization');

test('Absent planQuestionMode defaults to "autonomous"', () => {
  const config = normalizeTaskConfig(baseTask({}), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.planQuestionMode, 'autonomous');
});

test('planQuestionMode "autonomous" normalizes cleanly', () => {
  const config = normalizeTaskConfig(baseTask({ planQuestionMode: 'autonomous' }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.planQuestionMode, 'autonomous');
});

test('planQuestionMode "interactive" normalizes cleanly', () => {
  const config = normalizeTaskConfig(baseTask({ planQuestionMode: 'interactive' }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.planQuestionMode, 'interactive');
});

test('Invalid planQuestionMode throws an error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ planQuestionMode: 'manual' }), { projectRoot: PROJECT_ROOT });
  }, /planQuestionMode.*must be.*autonomous.*interactive/i);
});

test('Non-string planQuestionMode throws an error', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({ planQuestionMode: true }), { projectRoot: PROJECT_ROOT });
  }, /planQuestionMode.*must be a string/i);
});

console.log('\ntask-config: roles normalization');

test('Valid roles config normalizes cleanly', () => {
  const config = normalizeTaskConfig(baseTask({
    agents: ['claude', 'nim-local'],
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'test-model'
      }
    },
    roles: {
      planner: 'nim-local',
      reviewer: 'claude',
      fallback: 'claude'
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.roles, {
    planner: 'nim-local',
    reviewer: 'claude',
    fallback: 'claude'
  });
});

test('Role targets are tracked separately from the declared agents list', () => {
  const config = normalizeTaskConfig(baseTask({
    agents: ['claude'],
    providers: {
      'nim-local': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:8000/v1',
        model: 'test-model'
      }
    },
    roles: {
      planner: 'nim-local',
      reviewer: 'codex',
      fallback: 'claude'
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.agents, ['claude']);
  assert.deepStrictEqual(config.executionTargets, ['claude', 'nim-local', 'codex']);
});

test('Agent policies can target agents introduced by roles', () => {
  const config = normalizeTaskConfig(baseTask({
    agents: ['claude'],
    roles: {
      reviewer: 'codex'
    },
    settings: {
      cwd: '.',
      timeoutMs: 10000,
      agentPolicies: {
        codex: true
      }
    }
  }), { projectRoot: PROJECT_ROOT });

  assert.deepStrictEqual(config.agents, ['claude']);
  assert.deepStrictEqual(config.executionTargets, ['claude', 'codex']);
  assert.strictEqual(config.settings.agentPolicies.codex.canWrite, true);
});

test('HTTP provider as implementer fails validation', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      mode: 'implement',
      agents: ['claude', 'nim-local'],
      providers: {
        'nim-local': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'test-model'
        }
      },
      roles: {
        implementer: 'nim-local'
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /roles\.implementer cannot reference HTTP provider/i);
});

test('Unknown provider name in roles fails validation', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      roles: {
        planner: 'not-real'
      }
    }), { projectRoot: PROJECT_ROOT });
  }, /roles\.planner references unknown provider\/agent/i);
});

console.log('\ntask-config: Phase 2A loop normalization (planLoops, sectionImplementLoops)');

test('planLoops uses explicit value when set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, planLoops: 5 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.planLoops, 5);
});

test('planLoops falls back to qualityLoops when not set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.planLoops, 3);
});

test('planLoops defaults to 1 when neither planLoops nor qualityLoops is set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.planLoops, 1);
});

test('planLoops ignores qualityLoops when explicit planLoops is set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2, planLoops: 4 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.planLoops, 4);
});

test('planLoops rejects zero', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, planLoops: 0 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings\.planLoops must be a positive integer/);
});

test('planLoops rejects negative', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, planLoops: -1 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings\.planLoops must be a positive integer/);
});

test('planLoops rejects non-integer', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, planLoops: 2.5 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings\.planLoops must be a positive integer/);
});

test('sectionImplementLoops uses explicit value when set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 3);
});

test('sectionImplementLoops falls back to deprecated implementLoopsPerUnit when not set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, implementLoopsPerUnit: 2 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 2);
});

test('sectionImplementLoops falls back to implementLoops when neither sectionImplementLoops nor implementLoopsPerUnit is set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, implementLoops: 4 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 4);
});

test('sectionImplementLoops falls back to planLoops when implementLoopsPerUnit and implementLoops are not set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, planLoops: 2 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 2);
});

test('sectionImplementLoops falls back to qualityLoops when other loop values are not set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 3);
});

test('sectionImplementLoops defaults to 1 when no loop values are set', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 1);
});

test('sectionImplementLoops prefers explicit value over all fallbacks', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 5, implementLoopsPerUnit: 2, implementLoops: 3, planLoops: 4, qualityLoops: 1 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 5);
});

test('sectionImplementLoops respects fallback chain: sectionImplementLoops -> implementLoopsPerUnit -> implementLoops -> planLoops -> qualityLoops -> 1', () => {
  // Only qualityLoops set
  const config1 = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config1.settings.sectionImplementLoops, 2);

  // qualityLoops and planLoops set
  const config2 = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2, planLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config2.settings.sectionImplementLoops, 3);

  // qualityLoops, planLoops, and implementLoops set
  const config3 = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2, planLoops: 3, implementLoops: 4 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config3.settings.sectionImplementLoops, 4);

  // qualityLoops, planLoops, implementLoops, and implementLoopsPerUnit set
  const config4 = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2, planLoops: 3, implementLoops: 4, implementLoopsPerUnit: 5 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config4.settings.sectionImplementLoops, 5);
});

test('sectionImplementLoops rejects zero', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 0 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings\.sectionImplementLoops must be a positive integer/);
});

test('sectionImplementLoops rejects negative', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: -2 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings\.sectionImplementLoops must be a positive integer/);
});

test('sectionImplementLoops rejects non-integer', () => {
  assert.throws(() => {
    normalizeTaskConfig(baseTask({
      settings: { cwd: '.', timeoutMs: 10000, sectionImplementLoops: 1.5 }
    }), { projectRoot: PROJECT_ROOT });
  }, /settings\.sectionImplementLoops must be a positive integer/);
});

test('qualityLoops remains separate from planLoops for one-shot mode', () => {
  const config = normalizeTaskConfig(baseTask({
    mode: 'one-shot',
    useCase: 'coding',
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2, planLoops: 4, sectionImplementLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.qualityLoops, 2);
  assert.strictEqual(config.settings.planLoops, 4);
  assert.strictEqual(config.settings.sectionImplementLoops, 3);
});

test('one-shot config with all three loop controls normalizes correctly', () => {
  const config = normalizeTaskConfig(baseTask({
    mode: 'one-shot',
    useCase: 'coding',
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 2, planLoops: 4, sectionImplementLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.qualityLoops, 2);
  assert.strictEqual(config.settings.planLoops, 4);
  assert.strictEqual(config.settings.sectionImplementLoops, 3);
});

test('deprecated implementLoopsPerUnit is still accepted and normalized', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, implementLoopsPerUnit: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.sectionImplementLoops, 3);
  assert.ok(!Object.prototype.hasOwnProperty.call(config.settings, 'implementLoopsPerUnit'));
});

test('deprecated qualityLoops as planLoops source works for backward compatibility', () => {
  const config = normalizeTaskConfig(baseTask({
    settings: { cwd: '.', timeoutMs: 10000, qualityLoops: 3 }
  }), { projectRoot: PROJECT_ROOT });
  assert.strictEqual(config.settings.planLoops, 3);
  assert.strictEqual(config.settings.qualityLoops, 3);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
