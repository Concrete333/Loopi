const SUPPORTED_AGENTS = ['claude', 'codex', 'gemini', 'kilo', 'qwen', 'opencode'];
const SUPPORTED_AGENT_SET = new Set(SUPPORTED_AGENTS);

module.exports = {
  SUPPORTED_AGENTS,
  SUPPORTED_AGENT_SET
};
