const path = require('path');
const { DialecticOrchestrator } = require('../src/orchestrator');
const { normalizeTaskConfig } = require('../src/task-config');
const { getModePromptBuilders } = require('../src/prompts');

const PROJECT_ROOT = path.join(__dirname, '..');
const ORIGIN_AGENT = 'claude';
const REVIEWERS = ['codex', 'gemini', 'qwen'];

function makeContent(title, paragraphCount) {
  const paragraphs = [];
  for (let i = 1; i <= paragraphCount; i += 1) {
    paragraphs.push(
      `${title} paragraph ${i}: verify behavior against the request, check regressions, review edge cases, and note any risky assumptions before accepting the implementation.`
    );
  }
  return `# ${title}\n\n${paragraphs.join('\n\n')}`;
}

function createSyntheticContextIndex() {
  return {
    rootDir: path.join(PROJECT_ROOT, 'context'),
    builtAt: 0,
    files: [
      {
        relativePath: 'review/rubric.md',
        phase: 'review',
        sizeBytes: 0,
        content: makeContent('Review Rubric', 14),
        skipped: false,
        priority: 10,
        purpose: 'Primary review rubric'
      },
      {
        relativePath: 'review/regressions.md',
        phase: 'review',
        sizeBytes: 0,
        content: makeContent('Regression Checklist', 12),
        skipped: false,
        priority: 8,
        purpose: 'Regression review checklist'
      },
      {
        relativePath: 'shared/architecture.md',
        phase: 'shared',
        sizeBytes: 0,
        content: makeContent('Architecture Notes', 10),
        skipped: false,
        priority: 5,
        purpose: 'Shared system background'
      },
      {
        relativePath: 'examples/review-examples.md',
        phase: 'examples',
        sizeBytes: 0,
        content: makeContent('Review Examples', 8),
        skipped: false,
        priority: 3,
        purpose: 'Reference examples'
      }
    ]
  };
}

function buildConfig(reviewParallelDelivery) {
  return normalizeTaskConfig({
    mode: 'review',
    prompt: 'Review the current implementation for correctness, regressions, risky logic, missing validation, and anything that would block shipping.',
    agents: [ORIGIN_AGENT, ...REVIEWERS],
    context: {
      dir: './context',
      maxFilesPerPhase: {
        review: 4
      },
      maxCharsPerPhase: {
        review: 12000
      },
      deliveryPolicy: {
        reviewParallel: reviewParallelDelivery
      }
    },
    settings: {
      cwd: '.',
      timeoutMs: 10000,
      qualityLoops: 1
    }
  }, { projectRoot: PROJECT_ROOT });
}

function formatRow({ stage, delivery, promptChars }) {
  return `- ${stage} (${delivery}): ${promptChars} chars`;
}

async function measureScenario(reviewParallelDelivery) {
  const config = buildConfig(reviewParallelDelivery);
  const orchestrator = new DialecticOrchestrator();
  const modeBuilders = getModePromptBuilders('review');
  orchestrator._contextIndex = createSyntheticContextIndex();

  const initialReviewText = [
    '1. Findings',
    'The implementation mostly matches the request, but it still needs careful regression review.',
    '',
    '2. Risks',
    'A few workflow branches look fragile.',
    '',
    '3. Recommended changes',
    'Tighten validation and confirm failure-path behavior.'
  ].join('\n');

  const feedbackEntries = REVIEWERS.map((reviewer, index) => ({
    agent: reviewer,
    ok: true,
    text: [
      `Reviewer ${index + 1}: ${reviewer}`,
      'Found a few follow-up concerns worth checking before shipping.'
    ].join('\n')
  }));

  const metrics = [];
  const originalSilent = process.env.DIALECTIC_SILENT;
  process.env.DIALECTIC_SILENT = '1';

  try {
    const initialDelivery = config.context.deliveryPolicy.reviewInitial;
    const initialContextPack = await orchestrator.getPromptContextForPhase(config, 'review', {
      agentName: ORIGIN_AGENT,
      delivery: initialDelivery,
      stageKey: 'reviewInitial'
    });
    const initialPrompt = modeBuilders.buildInitialPrompt(config.prompt, {
      contextPack: initialContextPack
    });
    metrics.push({
      stage: 'reviewInitial',
      delivery: initialDelivery,
      promptChars: initialPrompt.length
    });

    for (let i = 0; i < REVIEWERS.length; i += 1) {
      const reviewer = REVIEWERS[i];
      const reviewDelivery = config.context.deliveryPolicy.reviewParallel;
      const reviewContextPack = await orchestrator.getPromptContextForPhase(config, 'review', {
        agentName: reviewer,
        delivery: reviewDelivery,
        stageKey: 'reviewParallel'
      });
      const prompt = i === 0
        ? modeBuilders.buildSpecCompliancePrompt({
          prompt: config.prompt,
          initialOutput: initialReviewText,
          context: { contextPack: reviewContextPack }
        })
        : modeBuilders.buildCodeQualityPrompt({
          prompt: config.prompt,
          initialOutput: initialReviewText,
          context: { contextPack: reviewContextPack }
        });

      metrics.push({
        stage: `reviewParallel:${reviewer}`,
        delivery: reviewDelivery,
        promptChars: prompt.length
      });
    }

    const synthesisDelivery = config.context.deliveryPolicy.reviewSynthesis;
    const synthesisContextPack = await orchestrator.getPromptContextForPhase(config, 'review', {
      agentName: ORIGIN_AGENT,
      delivery: synthesisDelivery,
      stageKey: 'reviewSynthesis'
    });
    const synthesisPrompt = modeBuilders.buildFinalPrompt({
      prompt: config.prompt,
      initialOutput: initialReviewText,
      feedbackEntries,
      context: { contextPack: synthesisContextPack }
    });
    metrics.push({
      stage: 'reviewSynthesis',
      delivery: synthesisDelivery,
      promptChars: synthesisPrompt.length
    });
  } finally {
    if (originalSilent === undefined) {
      delete process.env.DIALECTIC_SILENT;
    } else {
      process.env.DIALECTIC_SILENT = originalSilent;
    }
  }

  const totalPromptChars = metrics.reduce((sum, step) => sum + step.promptChars, 0);
  return { reviewParallelDelivery, metrics, totalPromptChars };
}

function printScenario(result) {
  console.log(`Scenario: reviewParallel=${result.reviewParallelDelivery}`);
  for (const row of result.metrics) {
    console.log(formatRow(row));
  }
  console.log(`Total prompt chars: ${result.totalPromptChars}`);
  console.log('');
}

async function main() {
  const fullResult = await measureScenario('full');
  const digestResult = await measureScenario('digest');
  const totalSavings = fullResult.totalPromptChars - digestResult.totalPromptChars;
  const percentSavings = fullResult.totalPromptChars > 0
    ? ((totalSavings / fullResult.totalPromptChars) * 100).toFixed(1)
    : '0.0';

  console.log('Review-mode context delivery measurement');
  console.log('Synthetic setup: 1 origin reviewer, 3 parallel reviewers, fixed synthetic context, no provider calls.');
  console.log('');
  printScenario(fullResult);
  printScenario(digestResult);
  console.log(`Total savings with reviewParallel=digest: ${totalSavings} chars (${percentSavings}%)`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
