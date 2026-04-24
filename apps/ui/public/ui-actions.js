(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.LoopiUiActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createUiActions(deps) {
    const {
      state,
      defaultConfig,
      api,
      render,
      documentImpl,
      setTimeoutImpl,
      clearTimeoutImpl,
      ensureConfigShape,
      syncRawEditor,
      setConfigRaw,
      assertDraftAvailable,
      getRunSession,
      findPreferredActiveSessionId
    } = deps;

    const BASE_SESSION_POLL_DELAY_MS = 1500;
    const HIDDEN_SESSION_POLL_DELAY_MS = 10000;
    const MAX_SESSION_POLL_DELAY_MS = 12000;

    let sessionPollTimer = null;
    let sessionPollFailureCount = 0;

    function actionErrorMessage(errorLike) {
      if (!errorLike) {
        return 'Unknown error.';
      }
      if (typeof errorLike === 'string') {
        return errorLike;
      }
      if (typeof errorLike.message === 'string' && errorLike.message.trim() !== '') {
        return errorLike.message;
      }
      if (typeof errorLike.instructions === 'string' && errorLike.instructions.trim() !== '') {
        return errorLike.instructions;
      }
      return 'Unknown error.';
    }

    async function refreshBootstrap() {
      state.bootstrap = await api('/api/bootstrap');
    }

    async function refreshSetup() {
      state.setupStatus = await api('/api/setup/status');
    }

    async function runAdapterInstall(agentId) {
      const result = await api(`/api/setup/adapters/${encodeURIComponent(agentId)}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true })
      });
      await refreshSetup();
      state.lastActionMessage = result.message || 'Install command finished.';
      if (result.error) {
        state.lastActionError = result.error;
      }
      return result;
    }

    async function runAdapterLogin(agentId) {
      const result = await api(`/api/setup/adapters/${encodeURIComponent(agentId)}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true })
      });
      await refreshSetup();
      state.lastActionMessage = result.message || 'Login command finished.';
      if (result.error) {
        state.lastActionError = result.error;
      }
      return result;
    }

    async function refreshProviderStatus() {
      if (state.configRaw && typeof state.configRaw === 'object' && !state.persistedConfigBlocked) {
        state.providerStatus = await api('/api/providers/test-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawConfig: state.configRaw })
        });
        return;
      }

      state.providerStatus = await api('/api/providers/test-current', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
    }

    async function refreshConfig() {
      state.configResult = await api('/api/config');
      if (state.configResult.exists && !state.configResult.valid) {
        state.persistedConfigBlocked = true;
        state.configRaw = null;
        state.draftMode = null;
        state.validationResult = null;
        state.validationDraftVersion = null;
        syncRawEditor();
        return;
      }
      const raw = state.configResult && state.configResult.raw ? state.configResult.raw : defaultConfig();
      setConfigRaw(raw, {
        renderNow: false,
        draftMode: state.configResult && state.configResult.exists ? 'persisted' : 'new'
      });
    }

    async function refreshRuns() {
      const [runs, runSessions] = await Promise.all([
        api('/api/runs'),
        api('/api/runs/sessions')
      ]);
      state.runs = runs;
      state.runSessions = Array.isArray(runSessions) ? runSessions : [];
      state.activeSessionId = findPreferredActiveSessionId();
      if (!state.activeSessionId) {
        stopSessionPolling();
      }
      const selectedStillExists = state.runs.some((run) => run.runId === state.selectedRunId)
        || state.runSessions.some((run) => run.runId === state.selectedRunId);
      if (!selectedStillExists) {
        state.selectedRunId = state.activeSessionId
          || (state.runSessions[0]
            ? state.runSessions[0].runId
            : state.runs[0]
              ? state.runs[0].runId
              : null);
      }
      if (state.selectedRunId) {
        await loadRunDetails(state.selectedRunId);
      } else {
        state.runDetails = null;
      }
    }

    async function refreshFiles() {
      state.scratchpad = await api('/api/files/scratchpad');
      state.logFile = await api('/api/files/log');
    }

    async function loadRunDetails(runId) {
      state.selectedRunId = runId;
      state.runDetails = await api(`/api/runs/${encodeURIComponent(runId)}`);
      state.selectedArtifactId = state.runDetails && state.runDetails.artifacts && state.runDetails.artifacts[0]
        ? state.runDetails.artifacts[0].id
        : null;
    }

    function stopSessionPolling() {
      if (sessionPollTimer) {
        clearTimeoutImpl(sessionPollTimer);
        sessionPollTimer = null;
      }
    }

    function resetSessionPollingBackoff() {
      sessionPollFailureCount = 0;
    }

    function currentVisibilityState() {
      return documentImpl && typeof documentImpl.visibilityState === 'string'
        ? documentImpl.visibilityState
        : 'visible';
    }

    function nextSessionPollDelayMs() {
      if (currentVisibilityState() === 'hidden') {
        return HIDDEN_SESSION_POLL_DELAY_MS;
      }
      if (sessionPollFailureCount <= 0) {
        return BASE_SESSION_POLL_DELAY_MS;
      }
      return Math.min(
        BASE_SESSION_POLL_DELAY_MS * Math.pow(2, sessionPollFailureCount),
        MAX_SESSION_POLL_DELAY_MS
      );
    }

    function scheduleSessionPolling() {
      stopSessionPolling();
      if (state.activeTab !== 'runs') {
        return;
      }
      state.activeSessionId = findPreferredActiveSessionId();
      if (!state.activeSessionId) {
        resetSessionPollingBackoff();
        return;
      }
      const session = getRunSession(state.activeSessionId);
      if (!session || !session.active) {
        state.activeSessionId = null;
        resetSessionPollingBackoff();
        return;
      }
      sessionPollTimer = setTimeoutImpl(async () => {
        if (currentVisibilityState() === 'hidden') {
          render();
          scheduleSessionPolling();
          return;
        }
        try {
          await refreshRuns();
          await refreshFiles();
          resetSessionPollingBackoff();
        } catch (error) {
          sessionPollFailureCount += 1;
          state.lastActionError = actionErrorMessage(error);
        }
        render();
        scheduleSessionPolling();
      }, nextSessionPollDelayMs());
    }

    async function validateCurrentConfig() {
      assertDraftAvailable('Validation');
      state.validationResult = await api('/api/config/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawConfig: state.configRaw })
      });
      state.validationDraftVersion = state.draftVersion;
      render();
    }

    async function saveCurrentConfig() {
      assertDraftAvailable('Saving');
      const result = await api('/api/config/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawConfig: state.configRaw })
      });
      if (!result.success) {
        throw new Error(result.error || 'Save failed.');
      }
      state.lastActionMessage = `Task saved to ${result.filePath}`;
      state.lastActionError = '';
      await refreshConfig();
      await refreshProviderStatus();
      await refreshContextStatus();
      render();
    }

    async function runCurrentConfig() {
      assertDraftAvailable('Running');
      const result = await api('/api/runs/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawConfig: state.configRaw })
      });
      if (!result.success) {
        const isContextError = Boolean(result.error && result.error.code && String(result.error.code).startsWith('CONTEXT_'));
        state.lastActionError = actionErrorMessage(result.error) || 'Run failed.';
        state.lastActionMessage = isContextError
          ? 'Context preparation is required before running.'
          : (result.runId ? `Run ${result.runId} failed.` : '');
        if (result.contextStatus) {
          state.contextStatus = result.contextStatus;
        } else if (result.error && result.error.contextStatus) {
          state.contextStatus = result.error.contextStatus;
        }
        if (isContextError) {
          // Instead of teleporting the user to Settings, surface the blocker
          // inline on whichever tab they launched from. The banner rendered
          // from state.contextBlocker carries the specific instructions and a
          // link to the Settings panel where context is prepared.
          state.contextBlocker = {
            code: result.error && result.error.code ? result.error.code : 'CONTEXT_BLOCKED',
            message: actionErrorMessage(result.error) || 'Prepared context is not ready.',
            instructions: (result.error && result.error.instructions)
              || (result.contextStatus && result.contextStatus.instructions)
              || null,
            contextStatus: result.contextStatus || (result.error && result.error.contextStatus) || null
          };
        } else {
          state.contextBlocker = null;
        }
      } else {
        state.lastActionMessage = `Run ${result.runId} started.`;
        state.lastActionError = '';
        state.activeSessionId = result.runId;
        state.selectedRunId = result.runId;
        state.activeTab = 'runs';
        state.contextBlocker = null;
        resetSessionPollingBackoff();
      }
      await refreshRuns();
      await refreshFiles();
      scheduleSessionPolling();
      render();
    }

    async function savePreset() {
      if (!state.presetDraftName.trim()) {
        throw new Error('Enter a preset name before saving.');
      }
      await saveCurrentConfig();
      const result = await api('/api/presets/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetName: state.presetDraftName.trim() })
      });
      if (!result.success) {
        throw new Error(result.error || 'Preset save failed.');
      }
      state.lastActionMessage = `Preset "${result.presetName}" saved.`;
      state.lastActionError = '';
      render();
    }

    function ensureProviderStatus() {
      if (!state.providerStatus) {
        state.providerStatus = {
          success: true,
          providers: {},
          normalized: null,
          error: null
        };
      }
      if (!state.providerStatus.providers) {
        state.providerStatus.providers = {};
      }
    }

    function setPending(name, value) {
      if (!state.pendingActions || typeof state.pendingActions !== 'object') {
        state.pendingActions = {};
      }
      if (!name) {
        return;
      }
      if (value) {
        state.pendingActions[name] = true;
      } else {
        delete state.pendingActions[name];
      }
    }

    async function performAction(fn, options = {}) {
      const pendingKey = options && typeof options.pending === 'string' ? options.pending : null;
      state.lastActionMessage = '';
      state.lastActionError = '';
      if (pendingKey) {
        if (state.pendingActions && state.pendingActions[pendingKey]) {
          // Duplicate click while the action is still in flight. Silently
          // ignore rather than queuing a second run.
          return;
        }
        setPending(pendingKey, true);
        // Render immediately so the button reflects busy state before the
        // async work begins.
        render();
      }
      try {
        await fn();
      } catch (error) {
        state.lastActionError = error.message;
      } finally {
        if (pendingKey) {
          setPending(pendingKey, false);
        }
      }
      render();
    }

    async function refreshContextStatus() {
      if (state.configRaw && typeof state.configRaw === 'object' && !state.persistedConfigBlocked) {
        state.contextStatus = await api('/api/context/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawConfig: state.configRaw })
        });
        return;
      }

      state.contextStatus = await api('/api/context/status');
    }

    async function prepareContext() {
      const result = await api('/api/context/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawConfig: state.configRaw && !state.persistedConfigBlocked ? state.configRaw : null
        })
      });
      if (!result.ok) {
        throw new Error(result.error || 'Context preparation failed.');
      }
      await refreshContextStatus();
      // Preparation succeeded; whatever blocked an earlier run is either
      // resolved or will be re-detected by the next launch. Drop the stale
      // blocker banner either way.
      state.contextBlocker = null;
      // Report honest counts: distinguish "some files were skipped" from
      // "everything indexed" so the user never assumes skipped files were
      // used successfully.
      if (result.skippedCount > 0) {
        state.lastActionMessage = `Context prepared: ${result.indexedCount} indexed, ${result.skippedCount} skipped.`;
      } else {
        state.lastActionMessage = `Context prepared: ${result.sourceCount} sources indexed.`;
      }
    }

    async function init() {
      state.initErrors = [];
      state.lastActionError = '';
      try {
        await refreshBootstrap();
      } catch (error) {
        state.initErrors.push({ refresher: 'bootstrap', message: error.message });
      }
      try {
        await refreshConfig();
      } catch (error) {
        state.initErrors.push({ refresher: 'config', message: error.message });
      }

      const refreshers = [
        { name: 'setup', fn: refreshSetup },
        { name: 'providers', fn: refreshProviderStatus },
        { name: 'runs', fn: refreshRuns },
        { name: 'files', fn: refreshFiles },
        { name: 'context', fn: refreshContextStatus }
      ];

      const settled = await Promise.allSettled(refreshers.map(function (r) { return r.fn(); }));
      settled.forEach(function (result, i) {
        if (result.status === 'rejected') {
          state.initErrors.push({
            refresher: refreshers[i].name,
            message: result.reason && result.reason.message ? result.reason.message : 'Unknown error'
          });
        }
      });

      if (state.initErrors.length > 0) {
        state.lastActionError = state.initErrors.map(function (e) { return e.refresher + ': ' + e.message; }).join('; ');
      }

      if (!state.configRaw) {
        state.configRaw = defaultConfig();
        ensureConfigShape();
        syncRawEditor();
      }
      render();
    }

    async function retryInit() {
      await init();
      if (!state.initErrors || state.initErrors.length === 0) {
        state.lastActionMessage = 'Startup checks refreshed.';
        state.lastActionError = '';
        render();
      }
    }

    return {
      init,
      retryInit,
      refreshBootstrap,
      refreshSetup,
      runAdapterInstall,
      runAdapterLogin,
      refreshProviderStatus,
      refreshConfig,
      refreshRuns,
      refreshFiles,
      loadRunDetails,
      stopSessionPolling,
      scheduleSessionPolling,
      validateCurrentConfig,
      saveCurrentConfig,
      runCurrentConfig,
      savePreset,
      ensureProviderStatus,
      performAction,
      refreshContextStatus,
      prepareContext
    };
  }

  return {
    createUiActions
  };
});
