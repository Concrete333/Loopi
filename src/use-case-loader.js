const fs = require('fs');
const path = require('path');

const VALID_NUMBERINGS = new Set(['sequential', 'commit', 'decimal-outline', 'phase']);
const RESERVED_UNIT_KEYS = new Set(['id', 'title', 'children']);

const ALLOWED_TOP_KEYS = new Set(['name', 'description', 'plan', 'review', 'synthesis']);
const ALLOWED_PLAN_KEYS = new Set(['role', 'objective', 'output_style', 'required_fields_per_unit', 'guidance']);
const ALLOWED_REVIEW_KEYS = new Set(['guidance']);
const ALLOWED_SYNTHESIS_KEYS = new Set(['guidance']);
const ALLOWED_OUTPUT_STYLE_KEYS = new Set(['unit_kind', 'numbering', 'allow_children']);

function validateUseCaseConfig(config, expectedName) {
  const label = expectedName || '(unknown)';

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Use case "${label}": config must be an object, got ${config === null ? 'null' : typeof config}.`);
  }

  // Strict unknown-key validation at top level
  const unknownTop = Object.keys(config).filter(k => !ALLOWED_TOP_KEYS.has(k));
  if (unknownTop.length > 0) {
    throw new Error(`Use case "${label}": unknown top-level key(s): ${unknownTop.join(', ')}. Allowed: ${[...ALLOWED_TOP_KEYS].join(', ')}.`);
  }

  // name is required
  if (!config.name || typeof config.name !== 'string' || config.name.trim() === '') {
    throw new Error(`Use case "${label}": must include a non-empty string "name".`);
  }

  if (config.name !== expectedName) {
    throw new Error(`Use case "${config.name}": name does not match expected name "${expectedName}".`);
  }

  // description is optional, but if present must be string
  if (config.description !== undefined && typeof config.description !== 'string') {
    throw new Error(`Use case "${label}": "description" must be a string.`);
  }

  // plan is required
  if (!config.plan || typeof config.plan !== 'object' || Array.isArray(config.plan)) {
    throw new Error(`Use case "${label}": must include a "plan" object.`);
  }

  // Strict unknown-key validation on plan
  const unknownPlan = Object.keys(config.plan).filter(k => !ALLOWED_PLAN_KEYS.has(k));
  if (unknownPlan.length > 0) {
    throw new Error(`Use case "${label}": unknown "plan" key(s): ${unknownPlan.join(', ')}. Allowed: ${[...ALLOWED_PLAN_KEYS].join(', ')}.`);
  }

  // plan.role / plan.objective are optional strings
  if (config.plan.role !== undefined && typeof config.plan.role !== 'string') {
    throw new Error(`Use case "${label}": "plan.role" must be a string.`);
  }
  if (config.plan.objective !== undefined && typeof config.plan.objective !== 'string') {
    throw new Error(`Use case "${label}": "plan.objective" must be a string.`);
  }

  // plan.guidance is optional string
  if (config.plan.guidance !== undefined && typeof config.plan.guidance !== 'string') {
    throw new Error(`Use case "${label}": "plan.guidance" must be a string.`);
  }

  // plan.output_style is required
  if (!config.plan.output_style || typeof config.plan.output_style !== 'object' || Array.isArray(config.plan.output_style)) {
    throw new Error(`Use case "${label}": "plan.output_style" must be an object.`);
  }

  // Strict unknown-key validation on output_style
  const unknownOutputStyle = Object.keys(config.plan.output_style).filter(k => !ALLOWED_OUTPUT_STYLE_KEYS.has(k));
  if (unknownOutputStyle.length > 0) {
    throw new Error(`Use case "${label}": unknown "plan.output_style" key(s): ${unknownOutputStyle.join(', ')}. Allowed: ${[...ALLOWED_OUTPUT_STYLE_KEYS].join(', ')}.`);
  }

  // plan.output_style.unit_kind is required, non-empty string
  if (!config.plan.output_style.unit_kind || typeof config.plan.output_style.unit_kind !== 'string') {
    throw new Error(`Use case "${label}": "plan.output_style.unit_kind" must be a non-empty string.`);
  }

  // plan.output_style.numbering is required, must be one of allowed values
  if (!config.plan.output_style.numbering || typeof config.plan.output_style.numbering !== 'string') {
    throw new Error(`Use case "${label}": "plan.output_style.numbering" must be a string.`);
  }
  if (!VALID_NUMBERINGS.has(config.plan.output_style.numbering)) {
    throw new Error(`Use case "${label}": "plan.output_style.numbering" must be one of: ${[...VALID_NUMBERINGS].join(', ')}. Got "${config.plan.output_style.numbering}".`);
  }

  // plan.output_style.allow_children is required, must be boolean
  if (typeof config.plan.output_style.allow_children !== 'boolean') {
    throw new Error(`Use case "${label}": "plan.output_style.allow_children" must be a boolean.`);
  }

  // plan.required_fields_per_unit is required, non-empty string array
  if (!Array.isArray(config.plan.required_fields_per_unit) || config.plan.required_fields_per_unit.length === 0) {
    throw new Error(`Use case "${label}": "plan.required_fields_per_unit" must be a non-empty array of strings.`);
  }
  for (const field of config.plan.required_fields_per_unit) {
    if (typeof field !== 'string' || field.trim() === '') {
      throw new Error(`Use case "${label}": each entry in "plan.required_fields_per_unit" must be a non-empty string.`);
    }
    // Guard reserved unit keys from being listed as dynamic fields
    if (RESERVED_UNIT_KEYS.has(field)) {
      throw new Error(`Use case "${label}": "plan.required_fields_per_unit" must not include reserved key "${field}".`);
    }
  }

  // review is required
  if (!config.review || typeof config.review !== 'object' || Array.isArray(config.review)) {
    throw new Error(`Use case "${label}": must include a "review" object.`);
  }

  // Strict unknown-key validation on review
  const unknownReview = Object.keys(config.review).filter(k => !ALLOWED_REVIEW_KEYS.has(k));
  if (unknownReview.length > 0) {
    throw new Error(`Use case "${label}": unknown "review" key(s): ${unknownReview.join(', ')}. Allowed: ${[...ALLOWED_REVIEW_KEYS].join(', ')}.`);
  }

  // review.guidance is optional string
  if (config.review.guidance !== undefined && typeof config.review.guidance !== 'string') {
    throw new Error(`Use case "${label}": "review.guidance" must be a string.`);
  }

  // synthesis is required
  if (!config.synthesis || typeof config.synthesis !== 'object' || Array.isArray(config.synthesis)) {
    throw new Error(`Use case "${label}": must include a "synthesis" object.`);
  }

  // Strict unknown-key validation on synthesis
  const unknownSynthesis = Object.keys(config.synthesis).filter(k => !ALLOWED_SYNTHESIS_KEYS.has(k));
  if (unknownSynthesis.length > 0) {
    throw new Error(`Use case "${label}": unknown "synthesis" key(s): ${unknownSynthesis.join(', ')}. Allowed: ${[...ALLOWED_SYNTHESIS_KEYS].join(', ')}.`);
  }

  // synthesis.guidance is optional string
  if (config.synthesis.guidance !== undefined && typeof config.synthesis.guidance !== 'string') {
    throw new Error(`Use case "${label}": "synthesis.guidance" must be a string.`);
  }
}

function loadUseCaseSync(name, projectRoot) {
  const normalizedName = String(name).trim().toLowerCase();
  if (!normalizedName) {
    throw new Error('Use case name must be a non-empty string.');
  }

  const configDir = path.join(projectRoot, 'config', 'use-cases');
  const filePath = path.join(configDir, `${normalizedName}.json`);

  if (!fs.existsSync(filePath)) {
    const available = listAvailableUseCases(projectRoot);
    throw new Error(
      `Use case "${normalizedName}" not found. ` +
      `Available use cases: ${available.length > 0 ? available.join(', ') : '(none)'}.`
    );
  }

  let raw;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    raw = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse use case config "${normalizedName}.json": ${error.message}`);
    }
    throw error;
  }

  validateUseCaseConfig(raw, normalizedName);
  return raw;
}

function listAvailableUseCases(projectRoot) {
  const configDir = path.join(projectRoot, 'config', 'use-cases');

  if (!fs.existsSync(configDir) || !fs.statSync(configDir).isDirectory()) {
    return [];
  }

  return fs.readdirSync(configDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

module.exports = {
  loadUseCaseSync,
  validateUseCaseConfig,
  listAvailableUseCases
};
