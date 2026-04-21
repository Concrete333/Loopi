const ARTIFACT_TYPES = Object.freeze({
  task: 'task',
  proposal: 'proposal',
  review: 'review',
  decision: 'decision',
  'context-pack': 'context-pack',
  'provider-readiness': 'provider-readiness',
  'provider-execution': 'provider-execution',
  'context-selection': 'context-selection',
  'plan-clarifications': 'plan-clarifications'
});

const ARTIFACT_TYPE_SET = new Set(Object.values(ARTIFACT_TYPES));

function isArtifactType(value) {
  return ARTIFACT_TYPE_SET.has(value);
}

module.exports = {
  ARTIFACT_TYPES,
  isArtifactType
};
