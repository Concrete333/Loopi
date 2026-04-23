(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.LoopiUiState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createUiState(deps) {
    const {
      state,
      defaultConfig,
      clone,
      escapeHtml,
      render
    } = deps;

    function ensureConfigShape() {
      if (!state.configRaw || typeof state.configRaw !== 'object') {
        return false;
      }
      if (!Array.isArray(state.configRaw.agents)) {
        state.configRaw.agents = [];
      }
      if (!state.configRaw.settings || typeof state.configRaw.settings !== 'object') {
        state.configRaw.settings = {};
      }
      if (!state.configRaw.providers || typeof state.configRaw.providers !== 'object' || Array.isArray(state.configRaw.providers)) {
        state.configRaw.providers = {};
      }
      if (!state.configRaw.roles || typeof state.configRaw.roles !== 'object' || Array.isArray(state.configRaw.roles)) {
        state.configRaw.roles = {};
      }
      if (!state.configRaw.settings.agentPolicies || typeof state.configRaw.settings.agentPolicies !== 'object') {
        state.configRaw.settings.agentPolicies = {};
      }
      if (!state.configRaw.settings.agentOptions || typeof state.configRaw.settings.agentOptions !== 'object') {
        state.configRaw.settings.agentOptions = {};
      }
      return true;
    }

    function syncRawEditor() {
      if (state.configRaw && typeof state.configRaw === 'object') {
        state.rawEditorText = JSON.stringify(state.configRaw, null, 2);
        return;
      }
      state.rawEditorText = state.configResult && typeof state.configResult.rawText === 'string'
        ? state.configResult.rawText
        : '';
    }

    function setConfigRaw(nextConfig, { renderNow = true, draftMode = 'persisted' } = {}) {
      state.configRaw = clone(nextConfig || defaultConfig());
      ensureConfigShape();
      state.draftVersion += 1;
      state.draftMode = draftMode;
      state.persistedConfigBlocked = false;
      state.validationResult = null;
      state.validationDraftVersion = null;
      syncRawEditor();
      if (renderNow) {
        render();
      }
    }

    function hasDraftConfig() {
      return Boolean(state.configRaw && typeof state.configRaw === 'object' && !state.persistedConfigBlocked);
    }

    function markDraftChanged() {
      state.draftVersion += 1;
    }

    function mutateDraft(mutator, { renderNow = true } = {}) {
      if (!ensureConfigShape()) {
        return;
      }
      mutator(state.configRaw);
      markDraftChanged();
      syncRawEditor();
      if (renderNow) {
        render();
      }
    }

    function assertDraftAvailable(actionLabel) {
      if (state.persistedConfigBlocked) {
        throw new Error('The persisted task file is invalid. Inspect it first or click "Start New Draft" before trying to save, validate, or run.');
      }
      if (!state.configRaw || typeof state.configRaw !== 'object') {
        throw new Error(`${actionLabel} requires an editable draft config.`);
      }
    }

    function startNewDraft() {
      setConfigRaw(defaultConfig(), { renderNow: false, draftMode: 'new' });
      state.lastActionMessage = 'Started a new draft. The broken task file will stay untouched until you save.';
      state.lastActionError = '';
      render();
    }

    function currentAgents() {
      return state.configRaw && Array.isArray(state.configRaw.agents) ? state.configRaw.agents : [];
    }

    function currentProviderIds() {
      return state.configRaw ? Object.keys(state.configRaw.providers || {}) : [];
    }

    function getRunSession(runId) {
      return (state.runSessions || []).find((session) => session.runId === runId) || null;
    }

    function findPreferredActiveSessionId(preferredRunId = state.activeSessionId) {
      const sessions = Array.isArray(state.runSessions) ? state.runSessions : [];
      if (preferredRunId) {
        const preferredSession = sessions.find((session) => session.runId === preferredRunId && session.active);
        if (preferredSession) {
          return preferredSession.runId;
        }
      }
      const fallbackSession = sessions.find((session) => session.active);
      return fallbackSession ? fallbackSession.runId : null;
    }

    function executionTargets() {
      return [...new Set([...currentAgents(), ...currentProviderIds()])];
    }

    function getAdapterMeta(agentId) {
      const items = state.bootstrap && Array.isArray(state.bootstrap.adapterMetadata)
        ? state.bootstrap.adapterMetadata
        : [];
      return items.find((item) => item.id === agentId) || null;
    }

    function setField(pathKeys, value) {
      mutateDraft((draft) => {
        let target = draft;
        for (let index = 0; index < pathKeys.length - 1; index += 1) {
          const key = pathKeys[index];
          if (!target[key] || typeof target[key] !== 'object') {
            target[key] = {};
          }
          target = target[key];
        }
        target[pathKeys[pathKeys.length - 1]] = value;
      });
    }

    function deleteField(pathKeys) {
      mutateDraft((draft) => {
        let target = draft;
        for (let index = 0; index < pathKeys.length - 1; index += 1) {
          const key = pathKeys[index];
          if (!target[key] || typeof target[key] !== 'object') {
            return;
          }
          target = target[key];
        }
        delete target[pathKeys[pathKeys.length - 1]];
      });
    }

    function setMode(mode) {
      mutateDraft((draft) => {
        draft.mode = mode;
        if (mode !== 'plan' && mode !== 'one-shot') {
          delete draft.useCase;
        }
        if (mode !== 'one-shot') {
          delete draft.settings.sectionImplementLoops;
          delete draft.settings.oneShotOrigins;
        }
        if (mode !== 'implement') {
          delete draft.settings.implementLoops;
        }
      });
    }

    function toggleAgent(agentId, enabled) {
      mutateDraft((draft) => {
        const nextAgents = new Set(Array.isArray(draft.agents) ? draft.agents : []);
        if (enabled) {
          nextAgents.add(agentId);
        } else {
          nextAgents.delete(agentId);
          delete draft.settings.agentPolicies[agentId];
          delete draft.settings.agentOptions[agentId];
          if (draft.roles) {
            Object.keys(draft.roles).forEach((role) => {
              if (draft.roles[role] === agentId) {
                delete draft.roles[role];
              }
            });
          }
        }
        draft.agents = Array.from(nextAgents);
      });
    }

    function upsertProvider(providerId, patch) {
      mutateDraft((draft) => {
        const current = draft.providers[providerId] || { type: 'openai-compatible' };
        draft.providers[providerId] = Object.assign({}, current, patch);
      });
    }

    function removeProvider(providerId) {
      mutateDraft((draft) => {
        delete draft.providers[providerId];
        if (draft.roles) {
          Object.keys(draft.roles).forEach((role) => {
            if (draft.roles[role] === providerId) {
              delete draft.roles[role];
            }
          });
        }
      });
    }

    function selectedUseCase() {
      return state.configRaw ? state.configRaw.useCase || '' : '';
    }

    function roleRecommendation() {
      const agents = currentAgents();
      const providerIds = currentProviderIds();
      const allTargets = executionTargets();
      const writableCli = agents.find((agentId) => {
        const meta = getAdapterMeta(agentId);
        return meta && meta.supportsWriteAccess;
      }) || agents[0] || null;
      const planner = agents[0] || providerIds[0] || null;
      const reviewer = allTargets.find((target) => target !== writableCli) || planner;
      return {
        planner,
        implementer: writableCli,
        reviewer,
        fallback: planner
      };
    }

    function activeValidationMessage() {
      if (!hasDraftConfig()) {
        return '';
      }
      if (state.validationResult && state.validationDraftVersion !== state.draftVersion) {
        return '<div class="message message--warning">Draft changed since the last validation. Validate again before saving or running.</div>';
      }
      if (state.validationResult && state.validationResult.valid) {
        return '<div class="message message--success">Config is valid and ready to save or run.</div>';
      }
      if (state.validationResult && state.validationResult.error) {
        return `<div class="message message--error">${escapeHtml(state.validationResult.error)}</div>`;
      }
      return '';
    }

    function actionMessageMarkup() {
      const blocks = [];
      if (state.lastActionMessage) {
        blocks.push(`<div class="message message--success">${escapeHtml(state.lastActionMessage)}</div>`);
      }
      if (state.lastActionError) {
        blocks.push(`<div class="message message--error">${escapeHtml(state.lastActionError)}</div>`);
      }
      return blocks.join('');
    }

    function invalidPersistedConfigMarkup() {
      if (!state.configResult || !state.configResult.exists || state.configResult.valid) {
        return '';
      }
      return `
        <div class="stack">
          <div class="message message--error">
            ${escapeHtml(state.configResult.error || 'The saved task file is invalid.')}
          </div>
          <div class="message message--warning">
            Persisted task file: ${escapeHtml(state.configResult.filePath || '')}
          </div>
        </div>
      `;
    }

    function invalidPersistedConfigPanel(options) {
      const title = options && options.title ? options.title : 'Invalid Saved Task';
      const description = options && options.description
        ? options.description
        : 'The saved task file could not be loaded. Inspect the raw contents below, then start a fresh draft explicitly if you want to replace it.';
      const showRaw = !options || options.showRaw !== false;
      return `
        <div class="inline-panel">
          <div class="section-heading">
            <div>
              <h2>${escapeHtml(title)}</h2>
              <p>${escapeHtml(description)}</p>
            </div>
          </div>
          ${invalidPersistedConfigMarkup()}
          <div class="button-row">
            <button class="button button--primary" data-start-new-draft>Start New Draft</button>
          </div>
          ${showRaw ? `
            <div class="json-panel">
              <div class="section-heading">
                <div>
                  <h3>Invalid Raw Task File</h3>
                  <p>${escapeHtml(state.configResult && state.configResult.filePath || '')}</p>
                </div>
              </div>
              <pre>${escapeHtml(state.configResult && state.configResult.rawText || '')}</pre>
            </div>
          ` : ''}
        </div>
      `;
    }

    return {
      ensureConfigShape,
      syncRawEditor,
      setConfigRaw,
      hasDraftConfig,
      mutateDraft,
      assertDraftAvailable,
      startNewDraft,
      currentAgents,
      currentProviderIds,
      getRunSession,
      findPreferredActiveSessionId,
      executionTargets,
      getAdapterMeta,
      setField,
      deleteField,
      setMode,
      toggleAgent,
      upsertProvider,
      removeProvider,
      selectedUseCase,
      roleRecommendation,
      activeValidationMessage,
      actionMessageMarkup,
      invalidPersistedConfigMarkup,
      invalidPersistedConfigPanel
    };
  }

  return {
    createUiState
  };
});
