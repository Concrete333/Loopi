const readline = require('readline');

/**
 * Collects interactive answers for planning clarification questions.
 * In production, this reads from process.stdin and writes to process.stdout.
 * For testing, streams can be injected via the options parameter.
 *
 * @param {Array} questions - Array of question objects from plan handoff
 * @param {Object} options - Optional configuration
 * @param {import('readline').Interface} options.rl - Pre-configured readline interface (for testing)
 * @param {Function} options.questionFn - Custom question function (for testing)
 * @param {Function} options.logFn - Custom log function (for testing)
 * @returns {Promise<Array>} Array of normalized answers with usedDefault flag
 */
async function collectPlanAnswers(questions, options = {}) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return [];
  }

  const rl = options.rl || readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const questionFn = options.questionFn || ((prompt) => new Promise((resolve) => {
    rl.question(prompt, resolve);
  }));
  const logFn = options.logFn || console.log;
  const answers = [];

  logFn('\n========================================');
  logFn('   Planning Clarifications Needed');
  logFn('========================================\n');
  logFn('The planner has identified strategic questions that need clarification.');
  logFn('Please answer each question. Press Enter to accept the default.\n');

  for (let index = 0; index < questions.length; index += 1) {
    const q = questions[index];
    const id = q.id || 'unknown';
    const question = q.question || '(no question)';
    const impact = q.impact || '(no impact description)';
    const defaultAnswer = q.agentDefault || '';

    logFn(`${index + 1}. Question ${id}`);
    logFn(`Question: ${question}`);
    logFn(`Impact: ${impact}`);
    logFn(`Default: ${defaultAnswer || '(none)'}`);
    logFn('');

    const answer = await questionFn('Your answer: ');
    const trimmedAnswer = (answer || '').trim();
    const usedDefault = trimmedAnswer === '';

    answers.push({
      id,
      question,
      answer: usedDefault ? defaultAnswer : trimmedAnswer,
      usedDefault
    });

    logFn(`  -> Using: ${usedDefault ? defaultAnswer : trimmedAnswer}\n`);
  }

  if (!options.rl) {
    rl.close();
  }

  logFn('========================================');
  logFn('   Clarifications Complete');
  logFn('========================================\n');

  return answers;
}

/**
 * Normalizes questions into clarifications using agent defaults.
 * Used in autonomous mode when no user interaction is desired.
 *
 * @param {Array} questions - Array of question objects from plan handoff
 * @returns {Array} Array of normalized answers using planner defaults when present
 */
function normalizeClarifications(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return [];
  }

  return questions.map((q) => {
    const defaultAnswer = typeof q.agentDefault === 'string' ? q.agentDefault : '';
    const hasDefault = defaultAnswer.trim() !== '';
    return {
      id: q.id || 'unknown',
      question: q.question || '',
      answer: hasDefault ? defaultAnswer : '',
      usedDefault: hasDefault
    };
  });
}

module.exports = {
  collectPlanAnswers,
  normalizeClarifications
};
