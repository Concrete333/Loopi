const assert = require('assert');
const path = require('path');
const { loadUseCaseSync, validateUseCaseConfig, listAvailableUseCases } = require('../src/use-case-loader');

const PROJECT_ROOT = path.join(__dirname, '..');

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

function minimalValid(name) {
  return {
    name,
    description: 'Test use case',
    plan: {
      role: 'You are a test agent.',
      objective: 'Create a test plan.',
      output_style: {
        unit_kind: 'step',
        numbering: 'sequential',
        allow_children: false
      },
      required_fields_per_unit: ['purpose'],
      guidance: 'Keep it simple.'
    },
    review: {
      guidance: 'Review carefully.'
    },
    synthesis: {
      guidance: 'Synthesize cleanly.'
    }
  };
}

console.log('use-case-loader');

// -- loadUseCaseSync --

test('valid use case loads correctly', () => {
  const uc = loadUseCaseSync('coding', PROJECT_ROOT);
  assert.strictEqual(uc.name, 'coding');
  assert.strictEqual(uc.plan.output_style.unit_kind, 'commit');
});

test('nonexistent use case error includes available names', () => {
  assert.throws(() => {
    loadUseCaseSync('nonexistent-use-case', PROJECT_ROOT);
  }, /Available use cases:/);
});

test('malformed JSON file parse error includes filename', () => {
  const fs = require('fs');
  const badPath = path.join(PROJECT_ROOT, 'config', 'use-cases');
  const badFile = path.join(badPath, 'malformed-test.json');
  fs.writeFileSync(badFile, '{ "name": "malformed-test" bad json }', 'utf8');
  try {
    assert.throws(() => {
      loadUseCaseSync('malformed-test', PROJECT_ROOT);
    }, /Failed to parse use case config "malformed-test\.json"/);
  } finally {
    fs.unlinkSync(badFile);
  }
});

test('empty name throws', () => {
  assert.throws(() => {
    loadUseCaseSync('', PROJECT_ROOT);
  }, /must be a non-empty string/);
});

// -- validateUseCaseConfig --

test('minimal valid config passes validation', () => {
  const config = minimalValid('test-case');
  validateUseCaseConfig(config, 'test-case');
});

test('missing name rejected', () => {
  const config = minimalValid('test-case');
  delete config.name;
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*must include a non-empty string "name"/);
});

test('filename/name mismatch rejected', () => {
  const config = minimalValid('wrong-name');
  assert.throws(() => {
    validateUseCaseConfig(config, 'expected-name');
  }, /Use case "wrong-name".*does not match expected name/);
});

test('missing plan.output_style rejected', () => {
  const config = minimalValid('test-case');
  delete config.plan.output_style;
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*"plan\.output_style" must be an object/);
});

test('missing plan.required_fields_per_unit rejected', () => {
  const config = minimalValid('test-case');
  delete config.plan.required_fields_per_unit;
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*"plan\.required_fields_per_unit" must be a non-empty array/);
});

test('empty plan.required_fields_per_unit rejected', () => {
  const config = minimalValid('test-case');
  config.plan.required_fields_per_unit = [];
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*must be a non-empty array/);
});

test('bad numbering rejected', () => {
  const config = minimalValid('test-case');
  config.plan.output_style.numbering = 'bad-value';
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*must be one of/);
});

test('unknown top-level keys rejected', () => {
  const config = minimalValid('test-case');
  config.unknown_field = 'oops';
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*unknown top-level key/);
});

test('unknown plan keys rejected', () => {
  const config = minimalValid('test-case');
  config.plan.extra_field = 'oops';
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*unknown "plan" key/);
});

test('unknown review keys rejected', () => {
  const config = minimalValid('test-case');
  config.review.extra_field = 'oops';
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*unknown "review" key/);
});

test('unknown synthesis keys rejected', () => {
  const config = minimalValid('test-case');
  config.synthesis.extra_field = 'oops';
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*unknown "synthesis" key/);
});

test('unknown output_style keys rejected', () => {
  const config = minimalValid('test-case');
  config.plan.output_style.extra_field = 'oops';
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*unknown "plan\.output_style" key/);
});

test('allow_children must be boolean', () => {
  const config = minimalValid('test-case');
  config.plan.output_style.allow_children = 'yes';
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*must be a boolean/);
});

test('plan.role must be string if present', () => {
  const config = minimalValid('test-case');
  config.plan.role = 123;
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*"plan\.role" must be a string/);
});

test('plan.objective must be string if present', () => {
  const config = minimalValid('test-case');
  config.plan.objective = 456;
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*"plan\.objective" must be a string/);
});

test('plan.guidance must be string if present', () => {
  const config = minimalValid('test-case');
  config.plan.guidance = 789;
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*"plan\.guidance" must be a string/);
});

test('review.guidance must be string if present', () => {
  const config = minimalValid('test-case');
  config.review.guidance = 111;
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*"review\.guidance" must be a string/);
});

test('synthesis.guidance must be string if present', () => {
  const config = minimalValid('test-case');
  config.synthesis.guidance = 222;
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*"synthesis\.guidance" must be a string/);
});

test('null config rejected', () => {
  assert.throws(() => {
    validateUseCaseConfig(null, 'test');
  }, /Use case "test".*must be an object/);
});

test('array config rejected', () => {
  assert.throws(() => {
    validateUseCaseConfig([], 'test');
  }, /Use case "test".*must be an object/);
});

test('reserved key "title" rejected in required_fields_per_unit', () => {
  const config = minimalValid('test-case');
  config.plan.required_fields_per_unit = ['title', 'purpose'];
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*must not include reserved key "title"/);
});

test('reserved key "id" rejected in required_fields_per_unit', () => {
  const config = minimalValid('test-case');
  config.plan.required_fields_per_unit = ['id'];
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*must not include reserved key "id"/);
});

test('reserved key "children" rejected in required_fields_per_unit', () => {
  const config = minimalValid('test-case');
  config.plan.required_fields_per_unit = ['children'];
  assert.throws(() => {
    validateUseCaseConfig(config, 'test-case');
  }, /Use case "test-case".*must not include reserved key "children"/);
});

// -- listAvailableUseCases --

test('available use cases listed correctly', () => {
  const cases = listAvailableUseCases(PROJECT_ROOT);
  assert.ok(Array.isArray(cases));
  assert.ok(cases.includes('coding'));
  assert.ok(cases.includes('academic-paper'));
  assert.ok(cases.includes('business-plan'));
  assert.ok(cases.includes('investor-presentation'));
  assert.ok(cases.includes('financial-model'));
  assert.ok(cases.includes('marketing-plan'));
  assert.strictEqual(cases.length, 6);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
