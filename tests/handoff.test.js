const assert = require('assert');
const {
  HANDOFF_BLOCK_START,
  HANDOFF_BLOCK_END,
  extractHandoff,
  renderHandoffForHumans,
  summarizeReviewHistory,
  modeUsesStructuredHandoff
} = require('../src/handoff');
const { loadUseCaseSync } = require('../src/use-case-loader');

const PROJECT_ROOT = __dirname + '/..';

function testImplementHandoffExtraction() {
  const extracted = extractHandoff(
    'implement',
    [
      '1. Implementation summary',
      'Applied the migration and updated tests.',
      '',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        status: 'DONE',
        summary: 'Applied the migration and updated tests.',
        completed_work: ['Applied the migration.', 'Updated tests.'],
        remaining_work: [],
        validation: ['Ran targeted tests.'],
        files_changed: ['src/migrate.js', 'tests/migrate.test.js'],
        remaining_risks: [],
        concerns: []
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData.status, 'DONE');
  assert.equal(extracted.handoffData.summary, 'Applied the migration and updated tests.');
  assert.deepEqual(extracted.handoffData.completed_work, ['Applied the migration.', 'Updated tests.']);
  assert.deepEqual(extracted.handoffData.files_changed, ['src/migrate.js', 'tests/migrate.test.js']);
  assert.equal(extracted.handoffParseError, null);
  assert.match(extracted.proseText, /Applied the migration/);
}

function testImplementHandoffRejectsInvalidStatus() {
  const extracted = extractHandoff(
    'implement',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        status: 'MAYBE',
        summary: 'Tried.',
        completed_work: [],
        remaining_work: [],
        validation: ['Checked logs.']
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /status/);
}

function testImplementHandoffRejectsMissingNewRequiredFields() {
  const extracted = extractHandoff(
    'implement',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        status: 'DONE',
        summary: 'Tried.',
        files_changed: ['src/file.js']
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /completed_work/);
}

function testImplementUnitHandoffExtraction() {
  const extracted = extractHandoff(
    'implement-unit',
    [
      '1. Implementation summary',
      'Finished the auth middleware unit.',
      '',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        status: 'DONE',
        summary: 'Finished the auth middleware unit.',
        unit_id: 'commit-1',
        unit_title: 'Add JWT validation middleware',
        unit_kind: 'commit',
        completed_work: ['Added middleware.', 'Added targeted tests.'],
        remaining_work: [],
        validation: ['Ran auth unit tests.'],
        files_changed: ['src/auth.js']
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData.unit_id, 'commit-1');
  assert.equal(extracted.handoffData.unit_title, 'Add JWT validation middleware');
  assert.equal(extracted.handoffData.unit_kind, 'commit');
  assert.equal(extracted.handoffParseError, null);
}

function testImplementUnitHandoffRejectsMissingUnitFields() {
  const extracted = extractHandoff(
    'implement-unit',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        status: 'DONE',
        summary: 'Finished work.',
        completed_work: ['Did the work.'],
        remaining_work: [],
        validation: ['Ran tests.']
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /unit_id/);
}

function testImplementHandoffRendering() {
  const text = renderHandoffForHumans({
    status: 'DONE_WITH_CONCERNS',
    summary: 'Built the feature but the retry logic is fragile.',
    completed_work: ['Built the feature.'],
    remaining_work: ['Add exponential backoff.'],
    validation: ['Ran retry tests.'],
    files_changed: ['src/retry.js'],
    remaining_risks: ['Retry storm under high load.'],
    concerns: ['No backoff implemented yet.']
  });

  assert.match(text, /Status: DONE_WITH_CONCERNS/);
  assert.match(text, /Summary: Built the feature/);
  assert.match(text, /Completed work:/);
  assert.match(text, /Remaining work:/);
  assert.match(text, /Validation:/);
  assert.match(text, /Files changed:/);
  assert.match(text, /src\/retry\.js/);
  assert.match(text, /Remaining risks:/);
  assert.match(text, /Concerns:/);
}

function testNoSchemaHandoffReturnsProseDirect() {
  const extracted = extractHandoff('prose', 'The implementation looks complete.');
  assert.equal(extracted.handoffText, 'The implementation looks complete.');
  assert.equal(extracted.handoffData, null);
  assert.equal(extracted.handoffParseError, null);
  assert.doesNotMatch(extracted.handoffText, /fallback_text/);
}

function testStructuredPlanHandoffExtraction() {
  const extracted = extractHandoff(
    'plan',
    [
      '1. Goal',
      'Ship the feature safely.',
      '',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        goal: 'Ship the feature safely.',
        steps: ['Update the adapter.', 'Run tests.'],
        risks: ['CLI incompatibility.'],
        validation: ['Run unit tests.'],
        open_questions: [],
        assumptions: ['Default to feature-area units.'],
        questions: [
          {
            id: 'q1',
            question: 'Feature area or technical layer?',
            impact: 'Changes the structure of all units.',
            agentDefault: 'feature area'
          }
        ]
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.proseText, '1. Goal\nShip the feature safely.');
  assert.equal(extracted.handoffData.goal, 'Ship the feature safely.');
  assert.equal(extracted.handoffParseError, null);
}

function testPlanQuestionsMissingQuestionFailsValidation() {
  const extracted = extractHandoff(
    'plan',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        goal: 'Ship the feature safely.',
        steps: ['Update the adapter.', 'Run tests.'],
        risks: ['CLI incompatibility.'],
        validation: ['Run unit tests.'],
        questions: [
          {
            id: 'q1',
            impact: 'Changes structure.',
            agentDefault: 'feature area'
          }
        ]
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /questions\[0\]\.question/);
}

function testPlanQuestionsMissingAgentDefaultFailsValidation() {
  const extracted = extractHandoff(
    'plan',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        goal: 'Ship the feature safely.',
        steps: ['Update the adapter.', 'Run tests.'],
        risks: ['CLI incompatibility.'],
        validation: ['Run unit tests.'],
        questions: [
          {
            id: 'q1',
            question: 'Feature area or technical layer?',
            impact: 'Changes structure.'
          }
        ]
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /questions\[0\]\.agentDefault/);
}

function testPlanHandoffWithoutQuestionsStillParses() {
  const extracted = extractHandoff(
    'plan',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        goal: 'Ship the feature safely.',
        steps: ['Update the adapter.', 'Run tests.'],
        risks: ['CLI incompatibility.'],
        validation: ['Run unit tests.']
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffParseError, null);
  assert.ok(extracted.handoffData);
}

function testStructuredHandoffFallsBackWhenInvalid() {
  const extracted = extractHandoff(
    'review',
    [
      'Findings go here.',
      '',
      HANDOFF_BLOCK_START,
      '{"summary":"oops","findings":"not-an-array"}',
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffText, /fallback_text/);
  assert.match(extracted.handoffParseError, /Invalid HANDOFF_JSON block/);
}

function testReviewHistorySummaryUsesStructuredData() {
  const summary = summarizeReviewHistory([
    {
      cycleNumber: 1,
      handoffData: {
        summary: 'Initial review found two gaps.',
        findings: [
          {
            severity: 'high',
            area: 'src/orchestrator.js',
            issue: 'Timeout handling is brittle.',
            recommendation: 'Add clearer failure logging.'
          }
        ],
        risks: ['Timeout budget is too low for deep reviews.'],
        recommended_changes: ['Increase Codex timeout for deep review mode.']
      },
      handoffText: null
    }
  ]);

  assert.match(summary, /## Observed Findings/);
  assert.match(summary, /HIGH: Timeout handling is brittle/);
  assert.match(summary, /## Open Risks/);
  assert.match(summary, /## Recommended Changes/);
}

function testReviewHistorySummaryFallsBackToHandoffText() {
  const summary = summarizeReviewHistory([
    {
      cycleNumber: 2,
      handoffData: null,
      handoffText: '{"fallback_text":"Need stronger validation around adapter resolution."}'
    }
  ]);

  assert.match(summary, /## Observed Findings/);
  assert.match(summary, /Cycle 2:/);
  assert.match(summary, /Need stronger validation around adapter resolution/);
}

function testSummarizeReviewHistoryToleratesMalformedData() {
  const summary = summarizeReviewHistory([
    {
      cycleNumber: 1,
      handoffData: {
        summary: 'Partial review.',
        findings: [
          { severity: null, issue: 'Missing guard.' },
          { severity: 'high' },
          'not-an-object',
          null,
          { severity: 'low', issue: 'Unused import', area: 42, recommendation: true }
        ],
        risks: ['Real risk.', 42, null],
        recommended_changes: [true, 'Real change.']
      },
      handoffText: null
    }
  ]);

  assert.match(summary, /UNKNOWN: Missing guard\./, 'null severity degrades to UNKNOWN');
  assert.match(summary, /HIGH: \(no issue text\)/, 'missing issue degrades to placeholder');
  assert.match(summary, /Real risk\./, 'valid risk is preserved');
  assert.doesNotMatch(summary, /42/, 'non-string risk is skipped');
  assert.match(summary, /Real change\./, 'valid change is preserved');
  assert.doesNotMatch(summary, /true/, 'non-string change is skipped');
}

function testPlanSchemaRequiresNonEmptySteps() {
  const extracted = extractHandoff(
    'plan',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        goal: 'Do the thing.',
        steps: [],
        risks: [],
        validation: ['Run tests.']
      }),
      HANDOFF_BLOCK_END
    ].join('\n')
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /steps.*at least one/i);
}

function testUseCasePlanRejectsChildrenWhenNotAllowed() {
  const useCase = loadUseCaseSync('coding', PROJECT_ROOT);
  const extracted = extractHandoff(
    'plan',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        goal: 'Do the thing.',
        plan_type: 'coding',
        unit_kind: 'commit',
        units: [
          {
            id: 'commit-1',
            title: 'Add parser',
            purpose: 'Parse input',
            why: 'Needed for downstream logic',
            validation: ['Run parser tests'],
            children: [
              {
                id: 'commit-1.1',
                title: 'Nested child',
                purpose: 'Should not be allowed',
                why: 'Invalid nesting',
                validation: ['No-op']
              }
            ]
          }
        ],
        risks: [],
        validation: ['Run tests']
      }),
      HANDOFF_BLOCK_END
    ].join('\n'),
    { useCase }
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /children is not allowed/i);
}

function testUseCasePlanRejectsMismatchedPlanType() {
  const useCase = loadUseCaseSync('coding', PROJECT_ROOT);
  const extracted = extractHandoff(
    'plan',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        goal: 'Do the thing.',
        plan_type: 'academic-paper',
        unit_kind: 'commit',
        units: [
          {
            id: 'commit-1',
            title: 'Add parser',
            purpose: 'Parse input',
            why: 'Needed for downstream logic',
            validation: ['Run parser tests']
          }
        ],
        risks: [],
        validation: ['Run tests']
      }),
      HANDOFF_BLOCK_END
    ].join('\n'),
    { useCase }
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /plan_type.*must match selected use case "coding"/i);
}

function testUseCasePlanRejectsMismatchedUnitKind() {
  const useCase = loadUseCaseSync('coding', PROJECT_ROOT);
  const extracted = extractHandoff(
    'plan',
    [
      'Some prose.',
      HANDOFF_BLOCK_START,
      JSON.stringify({
        goal: 'Do the thing.',
        plan_type: 'coding',
        unit_kind: 'section',
        units: [
          {
            id: 'commit-1',
            title: 'Add parser',
            purpose: 'Parse input',
            why: 'Needed for downstream logic',
            validation: ['Run parser tests']
          }
        ],
        risks: [],
        validation: ['Run tests']
      }),
      HANDOFF_BLOCK_END
    ].join('\n'),
    { useCase }
  );

  assert.equal(extracted.handoffData, null);
  assert.match(extracted.handoffParseError, /unit_kind.*must match selected use case unit_kind "commit"/i);
}

function testHandoffRenderingForHumans() {
  const planText = renderHandoffForHumans({
    goal: 'Ship the feature.',
    steps: ['Write tests.', 'Deploy.'],
    risks: ['Downtime risk.'],
    validation: ['CI passes.']
  });
  assert.match(planText, /Goal: Ship the feature\./);
  assert.match(planText, /Write tests\./);

  const reviewText = renderHandoffForHumans({
    summary: 'One critical issue.',
    findings: [{ severity: 'critical', area: 'src/foo.js', issue: 'Null deref.', recommendation: 'Add guard.' }],
    recommended_changes: ['Add null check.']
  });
  assert.match(reviewText, /Summary: One critical issue\./);
  assert.match(reviewText, /\[CRITICAL\]/);
  assert.match(reviewText, /Null deref\./);

  assert.equal(renderHandoffForHumans(null), '');
  assert.equal(renderHandoffForHumans({}), '');
}

function testReviewArtifactGatingCondition() {
  const builders = require('../src/prompts');

  const planBuilders = builders.getModePromptBuilders('plan');
  assert.equal(planBuilders.reviewHandoffSchema, 'review', 'plan review stage uses review schema');

  const implBuilders = builders.getModePromptBuilders('implement');
  assert.equal(implBuilders.reviewHandoffSchema, 'prose', 'implement review stage uses prose, not review');
  assert.equal(implBuilders.finalHandoffSchema, 'prose', 'implement finalize stage uses prose, not review');

  const reviewBuilders = builders.getModePromptBuilders('review');
  assert.equal(reviewBuilders.initialHandoffSchema, 'review', 'review initial stage uses review schema');
  assert.equal(reviewBuilders.reviewHandoffSchema, 'review', 'review parallel stage uses review schema');
  assert.equal(reviewBuilders.finalHandoffSchema, 'review', 'review synthesis uses review schema');

  assert.ok(modeUsesStructuredHandoff('review'), 'modeUsesStructuredHandoff("review") is true');
  assert.ok(!modeUsesStructuredHandoff('prose'), 'modeUsesStructuredHandoff("prose") is false');
  assert.ok(modeUsesStructuredHandoff('plan'), 'modeUsesStructuredHandoff("plan") is true');
  assert.ok(modeUsesStructuredHandoff('implement'), 'modeUsesStructuredHandoff("implement") is true');
}

function main() {
  testImplementHandoffExtraction();
  testImplementHandoffRejectsInvalidStatus();
  testImplementHandoffRejectsMissingNewRequiredFields();
  testImplementUnitHandoffExtraction();
  testImplementUnitHandoffRejectsMissingUnitFields();
  testImplementHandoffRendering();
  testNoSchemaHandoffReturnsProseDirect();
  testStructuredPlanHandoffExtraction();
  testPlanQuestionsMissingQuestionFailsValidation();
  testPlanQuestionsMissingAgentDefaultFailsValidation();
  testPlanHandoffWithoutQuestionsStillParses();
  testStructuredHandoffFallsBackWhenInvalid();
  testReviewHistorySummaryUsesStructuredData();
  testReviewHistorySummaryFallsBackToHandoffText();
  testSummarizeReviewHistoryToleratesMalformedData();
  testPlanSchemaRequiresNonEmptySteps();
  testUseCasePlanRejectsChildrenWhenNotAllowed();
  testUseCasePlanRejectsMismatchedPlanType();
  testUseCasePlanRejectsMismatchedUnitKind();
  testHandoffRenderingForHumans();
  testReviewArtifactGatingCondition();
  console.log('handoff tests passed');
}

main();
