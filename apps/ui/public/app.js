const loopiUiCore = typeof module !== 'undefined' && module.exports
  ? require('./ui-core.js')
  : globalThis.LoopiUiCore;
const loopiUiRender = typeof module !== 'undefined' && module.exports
  ? require('./ui-render.js')
  : globalThis.LoopiUiRender;
const loopiUiState = typeof module !== 'undefined' && module.exports
  ? require('./ui-state.js')
  : globalThis.LoopiUiState;
const loopiUiActions = typeof module !== 'undefined' && module.exports
  ? require('./ui-actions.js')
  : globalThis.LoopiUiActions;
const loopiUiBindings = typeof module !== 'undefined' && module.exports
  ? require('./ui-bindings.js')
  : globalThis.LoopiUiBindings;

function createLoopiApp(env = {}) {
  const document = env.document || globalThis.document;
  const fetchImpl = env.fetch || globalThis.fetch;
  const navigatorImpl = env.navigator || globalThis.navigator || {};
  const confirmImpl = env.confirm || globalThis.confirm;
  const {
    defaultConfig,
    clone,
    escapeHtml,
    prettyJson,
    statusChip,
    emptyState,
    loopField,
    roleSelect
  } = loopiUiCore;
  const state = {
    activeTab: 'setup',
    advanced: false,
    bootstrap: null,
    setupStatus: null,
    providerStatus: null,
    configResult: null,
    configRaw: null,
    validationResult: null,
    validationDraftVersion: null,
    draftVersion: 0,
    draftMode: null,
    persistedConfigBlocked: false,
    runSessions: [],
    activeSessionId: null,
    runs: [],
    runDetails: null,
    selectedRunId: null,
    selectedArtifactId: null,
    scratchpad: null,
    logFile: null,
    lastActionMessage: '',
    lastActionError: '',
    presetDraftName: '',
    rawEditorText: '',
    contextStatus: null
  };

  const dom = {
    heroSummary: document.getElementById('hero-summary'),
    setup: document.getElementById('tab-setup'),
    settings: document.getElementById('tab-settings'),
    composer: document.getElementById('tab-composer'),
    runs: document.getElementById('tab-runs'),
    advancedToggle: document.getElementById('advanced-toggle')
  };

  function api(path, options) {
    return fetchImpl(path, options).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Request failed for ${path}`);
      }
      return payload.data;
    });
  }
  const uiState = loopiUiState.createUiState({
    state,
    defaultConfig,
    clone,
    escapeHtml,
    render
  });
  const renderers = loopiUiRender.createRenderers({
    state,
    dom,
    ensureConfigShape: uiState.ensureConfigShape,
    currentAgents: uiState.currentAgents,
    currentProviderIds: uiState.currentProviderIds,
    getRunSession: uiState.getRunSession,
    executionTargets: uiState.executionTargets,
    getAdapterMeta: uiState.getAdapterMeta,
    selectedUseCase: uiState.selectedUseCase,
    roleRecommendation: uiState.roleRecommendation,
    activeValidationMessage: uiState.activeValidationMessage,
    actionMessageMarkup: uiState.actionMessageMarkup,
    invalidPersistedConfigMarkup: uiState.invalidPersistedConfigMarkup,
    invalidPersistedConfigPanel: uiState.invalidPersistedConfigPanel,
    escapeHtml,
    prettyJson,
    statusChip,
    emptyState,
    loopField,
    roleSelect
  });
  const actions = loopiUiActions.createUiActions({
    state,
    defaultConfig,
    api,
    render,
    ensureConfigShape: uiState.ensureConfigShape,
    syncRawEditor: uiState.syncRawEditor,
    setConfigRaw: uiState.setConfigRaw,
    assertDraftAvailable: uiState.assertDraftAvailable,
    getRunSession: uiState.getRunSession,
    findPreferredActiveSessionId: uiState.findPreferredActiveSessionId
  });
  const bindings = loopiUiBindings.createUiBindings({
    document,
    navigatorImpl,
    confirmImpl,
    state,
    dom,
    render,
    mutateDraft: uiState.mutateDraft,
    setField: uiState.setField,
    deleteField: uiState.deleteField,
    setMode: uiState.setMode,
    toggleAgent: uiState.toggleAgent,
    upsertProvider: uiState.upsertProvider,
    removeProvider: uiState.removeProvider,
    assertDraftAvailable: uiState.assertDraftAvailable,
    startNewDraft: uiState.startNewDraft,
    api,
    setConfigRaw: uiState.setConfigRaw,
    actions
  });

  function render() {
    renderers.renderHeroSummary();
    renderers.renderSetup();
    renderers.renderSettings();
    renderers.renderComposer();
    renderers.renderRuns();
    bindings.bindTabButtons();
    bindings.bindShared();
    bindings.bindSetup();
    bindings.bindSettings();
    bindings.bindComposer();
    bindings.bindRuns();
    bindings.syncActiveTabUi();
  }

  return {
    init: actions.init,
    render,
    state,
    __test: {
      setConfigRaw: uiState.setConfigRaw,
      mutateDraft: uiState.mutateDraft,
      validateCurrentConfig: actions.validateCurrentConfig,
      refreshProviderStatus: actions.refreshProviderStatus,
      refreshRuns: actions.refreshRuns,
      refreshContextStatus: actions.refreshContextStatus,
      prepareContext: actions.prepareContext,
      runCurrentConfig: actions.runCurrentConfig,
      activeValidationMessage: uiState.activeValidationMessage,
      getPanelHtml(panelName) {
        if (panelName === 'hero') {
          return dom.heroSummary.innerHTML;
        }
        return dom[panelName] ? dom[panelName].innerHTML : '';
      }
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createLoopiApp
  };
}

if (typeof window !== 'undefined' && window.document) {
  createLoopiApp().init();
}
