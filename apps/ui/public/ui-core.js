(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.LoopiUiCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function defaultConfig() {
    return {
      mode: 'plan',
      prompt: '',
      agents: ['claude'],
      settings: {
        planLoops: 1,
        qualityLoops: 1,
        implementLoops: 1,
        sectionImplementLoops: 1,
        timeoutMs: 180000,
        continueOnError: false,
        writeScratchpad: true
      }
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function prettyJson(value) {
    return escapeHtml(JSON.stringify(value, null, 2));
  }

  function statusChip(status, truthy) {
    const normalized = String(status || '').toLowerCase();
    const type = truthy
      ? 'success'
      : normalized.includes('missing') || normalized.includes('fail') || normalized.includes('unusable')
        ? 'danger'
        : normalized.includes('login') || normalized.includes('warn')
          ? 'warning'
          : 'neutral';
    return `<span class="chip chip--${type}">${escapeHtml(status || 'unknown')}</span>`;
  }

  function emptyState(title, text) {
    return `
      <div class="empty-state">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text)}</p>
      </div>
    `;
  }

  function loopField(label, key, value) {
    return `
      <div class="field">
        <label>${escapeHtml(label)}</label>
        <input data-loop-field="${escapeHtml(key)}" type="number" min="1" step="1" value="${escapeHtml(value || 1)}">
      </div>
    `;
  }

  function roleSelect(role, selectedValue, optionsMarkup) {
    return `
      <div class="field">
        <label>${escapeHtml(role)}</label>
        <select data-role-field="${escapeHtml(role)}">
          <option value="" ${selectedValue ? '' : 'selected'}>Auto</option>
          ${optionsMarkup.replace(`value="${escapeHtml(selectedValue)}"`, `value="${escapeHtml(selectedValue)}" selected`)}
        </select>
      </div>
    `;
  }

  return {
    defaultConfig,
    clone,
    escapeHtml,
    prettyJson,
    statusChip,
    emptyState,
    loopField,
    roleSelect
  };
});
