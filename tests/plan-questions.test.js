const assert = require('assert');
const { collectPlanAnswers, normalizeClarifications } = require('../src/plan-questions');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  [PASS] ${name}`);
        passed += 1;
      }).catch((error) => {
        console.error(`  [FAIL] ${name}`);
        console.error(`    ${error.message}`);
        failed += 1;
      });
    }

    console.log(`  [PASS] ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${error.message}`);
    failed += 1;
  }
}

async function runTests() {
  console.log('plan-questions: ordered collection');

  await test('collectPlanAnswers collects answers in order', async () => {
    const questions = [
      { id: 'q1', question: 'First question?', impact: 'Impact 1', agentDefault: 'default1' },
      { id: 'q2', question: 'Second question?', impact: 'Impact 2', agentDefault: 'default2' },
      { id: 'q3', question: 'Third question?', impact: 'Impact 3', agentDefault: 'default3' }
    ];

    const mockLogs = [];
    const logFn = (msg) => mockLogs.push(msg);

    const mockAnswers = ['answer1', '', 'answer3'];
    let answerIndex = 0;

    const questionFn = () => Promise.resolve(mockAnswers[answerIndex++]);

    const answers = await collectPlanAnswers(questions, { logFn, questionFn });

    assert.strictEqual(answers.length, 3);
    assert.strictEqual(answers[0].id, 'q1');
    assert.strictEqual(answers[0].answer, 'answer1');
    assert.strictEqual(answers[0].usedDefault, false);

    assert.strictEqual(answers[1].id, 'q2');
    assert.strictEqual(answers[1].answer, 'default2');
    assert.strictEqual(answers[1].usedDefault, true);

    assert.strictEqual(answers[2].id, 'q3');
    assert.strictEqual(answers[2].answer, 'answer3');
    assert.strictEqual(answers[2].usedDefault, false);
  });

  await test('blank answer uses default', async () => {
    const questions = [
      { id: 'q1', question: 'Question?', impact: 'Impact', agentDefault: 'the default' }
    ];

    const mockLogs = [];
    const logFn = (msg) => mockLogs.push(msg);

    const answers = await collectPlanAnswers(questions, {
      logFn,
      questionFn: () => Promise.resolve('')
    });

    assert.strictEqual(answers.length, 1);
    assert.strictEqual(answers[0].answer, 'the default');
    assert.strictEqual(answers[0].usedDefault, true);
  });

  await test('whitespace-only answer uses default', async () => {
    const questions = [
      { id: 'q1', question: 'Question?', impact: 'Impact', agentDefault: 'the default' }
    ];

    const mockLogs = [];
    const logFn = (msg) => mockLogs.push(msg);

    const answers = await collectPlanAnswers(questions, {
      logFn,
      questionFn: () => Promise.resolve('   ')
    });

    assert.strictEqual(answers.length, 1);
    assert.strictEqual(answers[0].answer, 'the default');
    assert.strictEqual(answers[0].usedDefault, true);
  });

  await test('usedDefault is set correctly', async () => {
    const questions = [
      { id: 'q1', question: 'Question 1?', impact: 'Impact', agentDefault: 'default1' },
      { id: 'q2', question: 'Question 2?', impact: 'Impact', agentDefault: 'default2' },
      { id: 'q3', question: 'Question 3?', impact: 'Impact', agentDefault: 'default3' }
    ];

    const answers = await collectPlanAnswers(questions, {
      logFn: () => {},
      questionFn: () => Promise.resolve('') // All use defaults
    });

    assert.strictEqual(answers.length, 3);
    assert.ok(answers.every((a) => a.usedDefault === true));
  });

  await test('non-blank answer overrides default and sets usedDefault to false', async () => {
    const questions = [
      { id: 'q1', question: 'Question?', impact: 'Impact', agentDefault: 'the default' }
    ];

    const answers = await collectPlanAnswers(questions, {
      logFn: () => {},
      questionFn: () => Promise.resolve('custom answer')
    });

    assert.strictEqual(answers.length, 1);
    assert.strictEqual(answers[0].answer, 'custom answer');
    assert.strictEqual(answers[0].usedDefault, false);
  });

  await test('empty questions array returns empty array', async () => {
    const answers = await collectPlanAnswers([], {
      logFn: () => {},
      questionFn: () => Promise.resolve('')
    });

    assert.deepStrictEqual(answers, []);
  });

  await test('null or undefined questions returns empty array', async () => {
    const answers1 = await collectPlanAnswers(null, {
      logFn: () => {},
      questionFn: () => Promise.resolve('')
    });

    const answers2 = await collectPlanAnswers(undefined, {
      logFn: () => {},
      questionFn: () => Promise.resolve('')
    });

    assert.deepStrictEqual(answers1, []);
    assert.deepStrictEqual(answers2, []);
  });

  await test('non-array questions returns empty array', async () => {
    const answers = await collectPlanAnswers('not an array', {
      logFn: () => {},
      questionFn: () => Promise.resolve('')
    });

    assert.deepStrictEqual(answers, []);
  });

  await test('logFn is called with expected messages', async () => {
    const questions = [
      { id: 'q1', question: 'Test question?', impact: 'Test impact', agentDefault: 'test default' }
    ];

    const mockLogs = [];
    const logFn = (msg) => mockLogs.push(msg);

    await collectPlanAnswers(questions, {
      logFn,
      questionFn: () => Promise.resolve('test answer')
    });

    assert.ok(mockLogs.some((msg) => msg.includes('Planning Clarifications Needed')));
    assert.ok(mockLogs.some((msg) => msg.includes('1. Question q1')));
    assert.ok(mockLogs.some((msg) => msg.includes('Question: Test question?')));
    assert.ok(mockLogs.some((msg) => msg.includes('Impact: Test impact')));
    assert.ok(mockLogs.some((msg) => msg.includes('Default: test default')));
    assert.ok(mockLogs.some((msg) => msg.includes('Clarifications Complete')));
  });

  await test('injected rl is not closed when provided', async () => {
    const questions = [
      { id: 'q1', question: 'Question?', impact: 'Impact', agentDefault: 'default' }
    ];

    let closeCalled = false;
    const mockRl = {
      close: () => { closeCalled = true; }
    };

    await collectPlanAnswers(questions, {
      rl: mockRl,
      logFn: () => {},
      questionFn: () => Promise.resolve('')
    });

    assert.strictEqual(closeCalled, false, 'Injected rl should not be closed');
  });

  console.log('plan-questions: normalizeClarifications');

  test('normalizeClarifications returns empty array for empty input', () => {
    const result = normalizeClarifications([]);
    assert.deepStrictEqual(result, []);
  });

  test('normalizeClarifications returns empty array for null input', () => {
    const result = normalizeClarifications(null);
    assert.deepStrictEqual(result, []);
  });

  test('normalizeClarifications returns empty array for undefined input', () => {
    const result = normalizeClarifications(undefined);
    assert.deepStrictEqual(result, []);
  });

  test('normalizeClarifications produces correct shape for autonomous mode', () => {
    const questions = [
      { id: 'q1', question: 'Question 1?', impact: 'Impact 1', agentDefault: 'default1' },
      { id: 'q2', question: 'Question 2?', impact: 'Impact 2', agentDefault: 'default2' }
    ];

    const result = normalizeClarifications(questions);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, 'q1');
    assert.strictEqual(result[0].question, 'Question 1?');
    assert.strictEqual(result[0].answer, 'default1');
    assert.strictEqual(result[0].usedDefault, true);

    assert.strictEqual(result[1].id, 'q2');
    assert.strictEqual(result[1].question, 'Question 2?');
    assert.strictEqual(result[1].answer, 'default2');
    assert.strictEqual(result[1].usedDefault, true);
  });

  test('normalizeClarifications handles missing id', () => {
    const questions = [
      { question: 'Question?', impact: 'Impact', agentDefault: 'default' }
    ];

    const result = normalizeClarifications(questions);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'unknown');
  });

  test('normalizeClarifications handles missing question', () => {
    const questions = [
      { id: 'q1', impact: 'Impact', agentDefault: 'default' }
    ];

    const result = normalizeClarifications(questions);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].question, '');
  });

  test('normalizeClarifications handles missing agentDefault', () => {
    const questions = [
      { id: 'q1', question: 'Question?', impact: 'Impact' }
    ];

    const result = normalizeClarifications(questions);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].answer, '');
    assert.strictEqual(result[0].usedDefault, false);
  });

  test('normalizeClarifications marks non-empty planner defaults as used', () => {
    const questions = [
      { id: 'q1', question: 'Question?', impact: 'Impact', agentDefault: 'default' }
    ];

    const result = normalizeClarifications(questions);

    assert.strictEqual(result[0].usedDefault, true);
  });

  console.log(` [PASS] Results: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests();
