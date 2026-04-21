const HANDOFF_BLOCK_START = 'BEGIN_HANDOFF_JSON';
const HANDOFF_BLOCK_END = 'END_HANDOFF_JSON';

const planExample = {
  goal: 'Harden the orchestration flow for production use.',
  steps: [
    'Validate task config and supported agents before starting any model calls.',
    'Run a planner pass, then sequential reviewer passes, then synthesize a revised plan.'
  ],
  risks: [
    'Agent CLI incompatibilities can cause timeouts or malformed output.'
  ],
  validation: [
    'Run syntax checks and unit tests.',
    'Smoke test each mode against the installed CLIs.'
  ],
  open_questions: [
    'Which agents should have write access during implement mode?'
  ]
};

const reviewExample = {
  summary: 'The review found one critical orchestration bug and two medium-priority hardening gaps.',
  findings: [
    {
      severity: 'critical',
      area: 'src/orchestrator.js',
      issue: 'Parallel reviewer prompts do not share reviewer context.',
      recommendation: 'Build prompts after collecting the needed context or explicitly fan out with only the initial review.'
    }
  ],
  risks: [
    'Large prompts can slow the loop and increase timeout risk.'
  ],
  recommended_changes: [
    'Add structured handoffs and compact one-shot review history.'
  ]
};

const implementExample = {
  status: 'DONE',
  summary: 'Implemented the migration script and updated associated tests.',
  completed_work: [
    'Added the migration script.',
    'Updated the associated tests.'
  ],
  remaining_work: [],
  validation: [
    'Ran the migration unit tests.',
    'Verified the updated test suite passes.'
  ],
  files_changed: ['src/migrate.js', 'tests/migrate.test.js'],
  remaining_risks: ['Rollback path not yet tested under concurrent load.'],
  concerns: []
};

const implementUnitExample = {
  status: 'DONE',
  summary: 'Finished the auth middleware unit and verified the targeted tests.',
  unit_id: 'commit-1',
  unit_title: 'Add JWT validation middleware',
  unit_kind: 'commit',
  completed_work: [
    'Added middleware that validates bearer tokens before route handlers.',
    'Covered valid, invalid, and expired token cases in tests.'
  ],
  remaining_work: [],
  validation: [
    'Ran auth middleware unit tests.'
  ],
  files_changed: ['src/auth/middleware.js', 'tests/auth/middleware.test.js'],
  remaining_risks: ['Refresh-token behavior is still deferred.'],
  concerns: []
};

function validateImplementFields(data, { requireUnitContext = false } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Implement handoff must be a JSON object.');
  }

  const validStatuses = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'];
  if (typeof data.status !== 'string' || !validStatuses.includes(data.status)) {
    throw new Error(`Implement handoff "status" must be one of: ${validStatuses.join(', ')}.`);
  }

  if (typeof data.summary !== 'string' || data.summary.trim() === '') {
    throw new Error('Implement handoff must include a non-empty string "summary".');
  }

  if (requireUnitContext) {
    if (typeof data.unit_id !== 'string' || data.unit_id.trim() === '') {
      throw new Error('Implement-unit handoff must include a non-empty string "unit_id".');
    }
    if (typeof data.unit_title !== 'string' || data.unit_title.trim() === '') {
      throw new Error('Implement-unit handoff must include a non-empty string "unit_title".');
    }
    if (typeof data.unit_kind !== 'string' || data.unit_kind.trim() === '') {
      throw new Error('Implement-unit handoff must include a non-empty string "unit_kind".');
    }
  }

  ensureStringArray(data.completed_work, 'completed_work');
  ensureStringArray(data.remaining_work, 'remaining_work');
  ensureStringArray(data.validation, 'validation');

  if (data.files_changed !== undefined) {
    ensureStringArray(data.files_changed, 'files_changed');
  }

  if (data.remaining_risks !== undefined) {
    ensureStringArray(data.remaining_risks, 'remaining_risks');
  }

  if (data.concerns !== undefined) {
    ensureStringArray(data.concerns, 'concerns');
  }

  if (data.blockers !== undefined) {
    ensureStringArray(data.blockers, 'blockers');
  }

  if (data.risks !== undefined) {
    ensureStringArray(data.risks, 'risks');
  }

  if (data.notes !== undefined) {
    ensureStringArray(data.notes, 'notes');
  }

  if (data.followups !== undefined) {
    ensureStringArray(data.followups, 'followups');
  }
}

// Dynamic plan handoff example for use-case-aware plans (units-based).
function buildPlanHandoffExample(useCase) {
  const planCfg = useCase.plan;
  const style = planCfg.output_style;
  const requiredFields = planCfg.required_fields_per_unit;

  const baseUnit = {
    id: style.numbering === 'commit' ? 'commit-1' : '1',
    title: style.unit_kind === 'commit' ? 'Add JWT validation middleware' : 'Introduction',
    purpose: style.unit_kind === 'commit' ? 'Validate incoming tokens before route handlers' : 'Frame the research question and scope'
  };

  // Add required dynamic fields
  for (const field of requiredFields) {
    if (field === 'purpose') continue; // already added
    if (field === 'validation') {
      baseUnit.validation = style.unit_kind === 'commit'
        ? ['unit tests for valid, invalid, and expired tokens']
        : ['check outline coherence'];
    } else if (field === 'why') {
      baseUnit.why = style.unit_kind === 'commit' ? 'Unblocks all authenticated endpoints' : 'Establishes context for the reader';
    } else if (field === 'research_needed') {
      baseUnit.research_needed = 'Survey of existing studies from 2020-2025';
    } else if (field === 'inputs') {
      baseUnit.inputs = 'Raw user data and configuration parameters';
    } else if (field === 'outputs') {
      baseUnit.outputs = 'Processed metrics array';
    } else if (field === 'kpis') {
      baseUnit.kpis = 'CTR, conversion rate, cost per acquisition';
    }
  }

  const unit = { ...baseUnit };

  const units = [unit];

  // Add child example if allow_children is true
  if (style.allow_children) {
    const childBase = {
      id: style.numbering === 'decimal-outline' ? '1.1' : '1.1',
      title: style.unit_kind === 'section' ? 'Background' : 'Setup',
      purpose: 'Summarize prior work / prepare environment'
    };
    for (const field of requiredFields) {
      if (field === 'purpose') continue;
      if (field === 'validation') {
        childBase.validation = ['verify setup completes'];
      } else if (field === 'why') {
        childBase.why = 'Positions this work relative to existing efforts';
      } else if (field === 'research_needed') {
        childBase.research_needed = 'Meta-analyses from prior years';
      } else if (field === 'inputs') {
        childBase.inputs = 'Configuration from parent';
      } else if (field === 'outputs') {
        childBase.outputs = 'Initialized state for parent';
      } else if (field === 'kpis') {
        childBase.kpis = 'Completion rate';
      }
    }
    unit.children = [{ ...childBase }];
  }

  return {
    goal: style.unit_kind === 'commit' ? 'Implement the authentication middleware' : 'Analyze the impact of remote work on team productivity',
    plan_type: useCase.name,
    unit_kind: style.unit_kind,
    units,
    risks: [style.unit_kind === 'commit' ? 'Token rotation edge cases under concurrent requests' : 'Self-selection bias in available datasets'],
    validation: [style.unit_kind === 'commit' ? 'Run auth middleware test suite' : 'Check outline coherence and research paths'],
    open_questions: [style.unit_kind === 'commit' ? 'Should we support refresh tokens in v1?' : 'Which metrics should anchor the analysis?']
  };
}

const handoffSchemas = {
  implement: {
    example: implementExample,
    validate(data) {
      validateImplementFields(data, { requireUnitContext: false });
    }
  },
  'implement-unit': {
    example: implementUnitExample,
    validate(data) {
      validateImplementFields(data, { requireUnitContext: true });
    }
  },
  plan: {
    example: planExample,
    validate(data, options = {}) {
      const useCase = options.useCase || null;

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Plan handoff must be a JSON object.');
      }

      if (useCase) {
        // ── New units-based format ──
        if (data.steps !== undefined) {
          throw new Error('Plan handoff with useCase must not include "steps". Use "units" instead.');
        }
        if (!Array.isArray(data.units) || data.units.length === 0) {
          throw new Error('Plan handoff with useCase must include a non-empty "units" array.');
        }

        // Required top-level keys
        const requiredTopKeys = ['goal', 'plan_type', 'unit_kind', 'units', 'risks', 'validation'];
        for (const key of requiredTopKeys) {
          if (data[key] === undefined) {
            throw new Error(`Plan handoff with useCase must include "${key}".`);
          }
        }

        if (typeof data.goal !== 'string' || data.goal.trim() === '') {
          throw new Error('Plan handoff "goal" must be a non-empty string.');
        }
        if (typeof data.plan_type !== 'string' || data.plan_type.trim() === '') {
          throw new Error('Plan handoff "plan_type" must be a non-empty string.');
        }
        if (data.plan_type !== useCase.name) {
          throw new Error(`Plan handoff "plan_type" must match selected use case "${useCase.name}".`);
        }
        if (typeof data.unit_kind !== 'string' || data.unit_kind.trim() === '') {
          throw new Error('Plan handoff "unit_kind" must be a non-empty string.');
        }
        if (data.unit_kind !== useCase.plan.output_style.unit_kind) {
          throw new Error(
            `Plan handoff "unit_kind" must match selected use case unit_kind "${useCase.plan.output_style.unit_kind}".`
          );
        }
        ensureStringArray(data.risks, 'risks');
        ensureNonEmptyStringArray(data.validation, 'validation');
        if (data.open_questions !== undefined) {
          ensureStringArray(data.open_questions, 'open_questions');
        }
        ensureOptionalAssumptionsArray(data);
        ensureOptionalQuestionsArray(data);

        // Validate each unit recursively
        const requiredFields = useCase.plan.required_fields_per_unit;
        const allowChildren = Boolean(useCase.plan.output_style.allow_children);
        for (let i = 0; i < data.units.length; i += 1) {
          validatePlanUnit(data.units[i], {
            requiredFields,
            allowChildren,
            prefix: `units[${i}]`
          });
        }
      } else {
        // ── Legacy steps-based format ──
        if (data.units !== undefined) {
          throw new Error('Plan handoff without useCase must not include "units". Use "steps" instead.');
        }

        if (typeof data.goal !== 'string' || data.goal.trim() === '') {
          throw new Error('Plan handoff must include a non-empty string "goal".');
        }

        ensureNonEmptyStringArray(data.steps, 'steps');
        ensureStringArray(data.risks, 'risks');
        ensureNonEmptyStringArray(data.validation, 'validation');
        if (data.open_questions !== undefined) {
          ensureStringArray(data.open_questions, 'open_questions');
        }
        ensureOptionalAssumptionsArray(data);
        ensureOptionalQuestionsArray(data);
      }
    }
  },
  review: {
    example: reviewExample,
    validate(data) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Review handoff must be a JSON object.');
      }

      if (data.summary !== undefined && typeof data.summary !== 'string') {
        throw new Error('Review handoff "summary" must be a string.');
      }

      if (!Array.isArray(data.findings)) {
        throw new Error('Review handoff must include a "findings" array.');
      }

      for (const finding of data.findings) {
        if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
          throw new Error('Each review finding must be an object.');
        }

        if (typeof finding.severity !== 'string' || typeof finding.issue !== 'string') {
          throw new Error('Each review finding must include string "severity" and "issue" fields.');
        }

        if (finding.area !== undefined && typeof finding.area !== 'string') {
          throw new Error('Review finding "area" must be a string when present.');
        }

        if (finding.recommendation !== undefined && typeof finding.recommendation !== 'string') {
          throw new Error('Review finding "recommendation" must be a string when present.');
        }
      }

      if (data.risks !== undefined) {
        ensureStringArray(data.risks, 'risks');
      }

      if (data.recommended_changes !== undefined) {
        ensureStringArray(data.recommended_changes, 'recommended_changes');
      }
    }
  }
};

function ensureStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`"${fieldName}" must be an array of strings.`);
  }

  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`"${fieldName}" must contain only strings.`);
    }
  }
}

function ensureNonEmptyStringArray(value, fieldName) {
  ensureStringArray(value, fieldName);

  if (value.length === 0) {
    throw new Error(`"${fieldName}" must contain at least one entry.`);
  }
}

function ensureOptionalAssumptionsArray(data) {
  if (data.assumptions === undefined) {
    return;
  }
  ensureStringArray(data.assumptions, 'assumptions');
}

function ensureOptionalQuestionsArray(data) {
  if (data.questions === undefined) {
    return;
  }

  if (!Array.isArray(data.questions)) {
    throw new Error('"questions" must be an array of question objects.');
  }

  for (let i = 0; i < data.questions.length; i += 1) {
    const q = data.questions[i];
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new Error(`questions[${i}] must be an object.`);
    }

    if (typeof q.id !== 'string' || q.id.trim() === '') {
      throw new Error(`questions[${i}].id must be a non-empty string.`);
    }
    if (typeof q.question !== 'string' || q.question.trim() === '') {
      throw new Error(`questions[${i}].question must be a non-empty string.`);
    }
    if (typeof q.impact !== 'string' || q.impact.trim() === '') {
      throw new Error(`questions[${i}].impact must be a non-empty string.`);
    }
    if (typeof q.agentDefault !== 'string' || q.agentDefault.trim() === '') {
      throw new Error(`questions[${i}].agentDefault must be a non-empty string.`);
    }
  }
}

// Validates a single plan unit and its children recursively.
// Reserved structural keys: id, title, children.
// All other keys must be in requiredFields.
const RESERVED_UNIT_KEYS = new Set(['id', 'title', 'children']);

function validatePlanUnit(unit, { requiredFields, allowChildren, prefix }) {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) {
    throw new Error(`${prefix} must be an object.`);
  }

  // id is required
  if (typeof unit.id !== 'string' || unit.id.trim() === '') {
    throw new Error(`${prefix} must include a non-empty string "id".`);
  }

  // title is required
  if (typeof unit.title !== 'string' || unit.title.trim() === '') {
    throw new Error(`${prefix} must include a non-empty string "title".`);
  }

  // Validate required dynamic fields
  const requiredSet = new Set(requiredFields);
  for (const field of requiredFields) {
    if (unit[field] === undefined) {
      throw new Error(`${prefix} must include "${field}" (required by use case config).`);
    }
  }

  // Reject unknown dynamic keys (keys not reserved and not in requiredFields)
  const unitKeys = Object.keys(unit);
  for (const key of unitKeys) {
    if (RESERVED_UNIT_KEYS.has(key)) continue;
    if (requiredSet.has(key)) continue;
    throw new Error(`${prefix} contains unexpected key "${key}". Required dynamic fields: ${requiredFields.join(', ')}.`);
  }

  // Recurse into children if present
  if (unit.children !== undefined) {
    if (!Array.isArray(unit.children)) {
      throw new Error(`${prefix}.children must be an array.`);
    }
    if (!allowChildren && unit.children.length > 0) {
      throw new Error(`${prefix}.children is not allowed for this use case.`);
    }
    for (let i = 0; i < unit.children.length; i += 1) {
      validatePlanUnit(unit.children[i], {
        requiredFields,
        allowChildren,
        prefix: `${prefix}.children[${i}]`
      });
    }
  }
}

function modeUsesStructuredHandoff(mode) {
  return Boolean(handoffSchemas[mode]);
}

function buildHandoffInstruction(mode, options = {}) {
  const schema = handoffSchemas[mode];
  if (!schema) {
    return '';
  }

  // For plan mode with useCase, generate a dynamic example
  let example = schema.example;
  if (mode === 'plan' && options.useCase) {
    example = buildPlanHandoffExample(options.useCase);
  }

  return [
    'After your normal human-readable response, append a machine-readable handoff block in exactly this format:',
    HANDOFF_BLOCK_START,
    JSON.stringify(example, null, 2),
    HANDOFF_BLOCK_END,
    'The JSON must be valid and must match the schema shown above.',
    'Do not wrap the JSON block in Markdown code fences.'
  ].join('\n');
}

function extractHandoff(mode, outputText, options = {}) {
  const normalizedOutput = String(outputText || '').trim();
  const proseText = stripHandoffBlock(normalizedOutput).trim();

  if (!modeUsesStructuredHandoff(mode)) {
    // No schema means no structured handoff was expected — handoffText is just the prose.
    // buildFallbackHandoff is reserved for cases where a block was expected but missing/invalid.
    return {
      proseText: normalizedOutput,
      handoffData: null,
      handoffText: normalizedOutput,
      handoffParseError: null
    };
  }

  const match = normalizedOutput.match(
    new RegExp(`${escapeRegexLiteral(HANDOFF_BLOCK_START)}\\s*([\\s\\S]*?)\\s*${escapeRegexLiteral(HANDOFF_BLOCK_END)}`)
  );
  if (!match) {
    return {
      proseText,
      handoffData: null,
      handoffText: buildFallbackHandoff(proseText),
      handoffParseError: 'Missing HANDOFF_JSON block.'
    };
  }

  try {
    const parsed = JSON.parse(match[1].trim());
    handoffSchemas[mode].validate(parsed, options);

    return {
      proseText,
      handoffData: parsed,
      handoffText: serializeHandoff(parsed),
      handoffParseError: null
    };
  } catch (error) {
    return {
      proseText,
      handoffData: null,
      handoffText: buildFallbackHandoff(proseText),
      handoffParseError: `Invalid HANDOFF_JSON block: ${error.message}`
    };
  }
}

function serializeHandoff(handoffData) {
  return JSON.stringify(handoffData);
}

function buildFallbackHandoff(text) {
  return JSON.stringify({
    fallback_text: String(text || '').trim()
  });
}

function stripHandoffBlock(text) {
  if (!text) {
    return '';
  }

  return text
    .replace(
      new RegExp(`\\s*${escapeRegexLiteral(HANDOFF_BLOCK_START)}[\\s\\S]*?${escapeRegexLiteral(HANDOFF_BLOCK_END)}\\s*`),
      '\n'
    )
    .trim();
}

function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHandoffForHumans(handoffData) {
  if (!handoffData || typeof handoffData !== 'object') {
    return '';
  }

  const lines = [];

  if (typeof handoffData.goal === 'string') {
    lines.push(`Goal: ${handoffData.goal}`);

    if (typeof handoffData.unit_kind === 'string') {
      lines.push(`Unit kind: ${handoffData.unit_kind}`);
    }

    if (Array.isArray(handoffData.units) && handoffData.units.length > 0) {
      lines.push('Units:');
      for (const unit of handoffData.units) {
        renderPlanUnitForHumans(lines, unit, 1);
      }
    } else if (Array.isArray(handoffData.steps) && handoffData.steps.length > 0) {
      lines.push('Steps:');
      for (const step of handoffData.steps) {
        lines.push(`  - ${step}`);
      }
    }

    if (Array.isArray(handoffData.risks) && handoffData.risks.length > 0) {
      lines.push('Risks:');
      for (const risk of handoffData.risks) {
        lines.push(`  - ${risk}`);
      }
    }
    if (Array.isArray(handoffData.validation) && handoffData.validation.length > 0) {
      lines.push('Validation:');
      for (const v of handoffData.validation) {
        lines.push(`  - ${v}`);
      }
    }
    return lines.join('\n');
  }

  if (typeof handoffData.status === 'string' || Array.isArray(handoffData.completed_work)) {
    if (typeof handoffData.unit_kind === 'string') {
      lines.push(`Unit kind: ${handoffData.unit_kind}`);
    }
    if (typeof handoffData.unit_id === 'string') {
      lines.push(`Unit ID: ${handoffData.unit_id}`);
    }
    if (typeof handoffData.unit_title === 'string') {
      lines.push(`Unit title: ${handoffData.unit_title}`);
    }

    if (typeof handoffData.status === 'string') {
      lines.push(`Status: ${handoffData.status}`);
    }
    if (typeof handoffData.summary === 'string') {
      lines.push(`Summary: ${handoffData.summary}`);
    }
    if (Array.isArray(handoffData.completed_work) && handoffData.completed_work.length > 0) {
      lines.push('Completed work:');
      for (const item of handoffData.completed_work) {
        lines.push(`  - ${item}`);
      }
    }
    if (Array.isArray(handoffData.remaining_work) && handoffData.remaining_work.length > 0) {
      lines.push('Remaining work:');
      for (const item of handoffData.remaining_work) {
        lines.push(`  - ${item}`);
      }
    }
    if (Array.isArray(handoffData.validation) && handoffData.validation.length > 0) {
      lines.push('Validation:');
      for (const item of handoffData.validation) {
        lines.push(`  - ${item}`);
      }
    }
    if (Array.isArray(handoffData.files_changed) && handoffData.files_changed.length > 0) {
      lines.push('Files changed:');
      for (const f of handoffData.files_changed) {
        lines.push(`  - ${f}`);
      }
    }
    if (Array.isArray(handoffData.remaining_risks) && handoffData.remaining_risks.length > 0) {
      lines.push('Remaining risks:');
      for (const r of handoffData.remaining_risks) {
        lines.push(`  - ${r}`);
      }
    }
    if (Array.isArray(handoffData.concerns) && handoffData.concerns.length > 0) {
      lines.push('Concerns:');
      for (const c of handoffData.concerns) {
        lines.push(`  - ${c}`);
      }
    }
    if (Array.isArray(handoffData.blockers) && handoffData.blockers.length > 0) {
      lines.push('Blockers:');
      for (const item of handoffData.blockers) {
        lines.push(`  - ${item}`);
      }
    }
    if (Array.isArray(handoffData.risks) && handoffData.risks.length > 0) {
      lines.push('Risks:');
      for (const item of handoffData.risks) {
        lines.push(`  - ${item}`);
      }
    }
    if (Array.isArray(handoffData.notes) && handoffData.notes.length > 0) {
      lines.push('Notes:');
      for (const item of handoffData.notes) {
        lines.push(`  - ${item}`);
      }
    }
    if (Array.isArray(handoffData.followups) && handoffData.followups.length > 0) {
      lines.push('Followups:');
      for (const item of handoffData.followups) {
        lines.push(`  - ${item}`);
      }
    }
    return lines.join('\n');
  }

  if (Array.isArray(handoffData.findings)) {
    if (typeof handoffData.summary === 'string') {
      lines.push(`Summary: ${handoffData.summary}`);
    }
    if (handoffData.findings.length > 0) {
      lines.push('Findings:');
      for (const f of handoffData.findings) {
        const area = f.area ? ` (${f.area})` : '';
        lines.push(`  [${String(f.severity || '').toUpperCase()}]${area} ${f.issue || ''}`);
        if (f.recommendation) {
          lines.push(`    -> ${f.recommendation}`);
        }
      }
    }
    if (Array.isArray(handoffData.recommended_changes) && handoffData.recommended_changes.length > 0) {
      lines.push('Recommended changes:');
      for (const c of handoffData.recommended_changes) {
        lines.push(`  - ${c}`);
      }
    }
    return lines.join('\n');
  }

  return '';
}

function renderPlanUnitForHumans(lines, unit, depth) {
  if (!unit || typeof unit !== 'object') {
    return;
  }

  const indent = '  '.repeat(depth);
  const unitId = typeof unit.id === 'string' ? unit.id : '(missing-id)';
  const unitTitle = typeof unit.title === 'string' ? unit.title : '(missing-title)';
  lines.push(`${indent}- ${unitId}: ${unitTitle}`);

  for (const [key, value] of Object.entries(unit)) {
    if (key === 'id' || key === 'title' || key === 'children') {
      continue;
    }

    if (Array.isArray(value)) {
      lines.push(`${indent}  ${key}: ${value.join(', ')}`);
    } else if (value !== undefined && value !== null) {
      lines.push(`${indent}  ${key}: ${String(value)}`);
    }
  }

  if (Array.isArray(unit.children) && unit.children.length > 0) {
    for (const child of unit.children) {
      renderPlanUnitForHumans(lines, child, depth + 1);
    }
  }
}

function summarizeReviewHistory(reviewHistory) {
  if (!Array.isArray(reviewHistory) || reviewHistory.length === 0) {
    return '';
  }

  const findings = new Set();
  const risks = new Set();
  const recommendedChanges = new Set();

  for (const entry of reviewHistory) {
    if (entry && entry.handoffData) {
      const { summary, findings: handoffFindings = [], risks: handoffRisks = [], recommended_changes: handoffChanges = [] } = entry.handoffData;

      if (summary) {
        findings.add(`Cycle ${entry.cycleNumber}: ${summary}`);
      }

      for (const finding of handoffFindings) {
        if (!finding || typeof finding !== 'object') {
          continue;
        }
        const severity = typeof finding.severity === 'string' ? finding.severity.toUpperCase() : 'UNKNOWN';
        const issue = typeof finding.issue === 'string' ? finding.issue : '(no issue text)';
        const area = typeof finding.area === 'string' ? ` (${finding.area})` : '';
        const recommendation = typeof finding.recommendation === 'string' ? ` -> ${finding.recommendation}` : '';
        findings.add(`${severity}: ${issue}${area}${recommendation}`);
      }

      for (const risk of handoffRisks) {
        if (typeof risk === 'string') {
          risks.add(risk);
        }
      }

      for (const change of handoffChanges) {
        if (typeof change === 'string') {
          recommendedChanges.add(change);
        }
      }
    } else if (entry && entry.handoffText) {
      let displayText = entry.handoffText;
      try {
        const parsed = JSON.parse(entry.handoffText);
        if (parsed && typeof parsed.fallback_text === 'string') {
          displayText = parsed.fallback_text;
        }
      } catch {
        // not JSON, use as-is
      }
      if (displayText) {
        findings.add(`Cycle ${entry.cycleNumber}: ${displayText}`);
      }
    }
  }

  const lines = [];

  if (findings.size > 0) {
    lines.push('## Observed Findings');
    for (const finding of findings) {
      lines.push(`- ${finding}`);
    }
  }

  if (risks.size > 0) {
    lines.push('', '## Open Risks');
    for (const risk of risks) {
      lines.push(`- ${risk}`);
    }
  }

  if (recommendedChanges.size > 0) {
    lines.push('', '## Recommended Changes');
    for (const change of recommendedChanges) {
      lines.push(`- ${change}`);
    }
  }

  return lines.join('\n').trim();
}

module.exports = {
  HANDOFF_BLOCK_START,
  HANDOFF_BLOCK_END,
  modeUsesStructuredHandoff,
  buildHandoffInstruction,
  extractHandoff,
  serializeHandoff,
  renderHandoffForHumans,
  summarizeReviewHistory
};
