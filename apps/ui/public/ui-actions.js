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
      ensureConfigShape,
      syncRawEditor,
      setConfigRaw,
      assertDraftAvailable,
      getRunSession,
      findPreferredActiveSessionId
    } = deps;

    let sessionPollTimer = null;

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
        clearTimeout(sessionPollTimer);
        sessionPollTimer = null;
      }
    }

    function scheduleSessionPolling() {
      stopSessionPolling();
      if (state.activeTab !== 'runs') {
        return;
      }
      state.activeSessionId = findPreferredActiveSessionId();
      if (!state.activeSessionId) {
        return;
      }
      const session = getRunSession(state.activeSessionId);
      if (!session || !session.active) {
        state.activeSessionId = null;
        return;
      }
      sessionPollTimer = setTimeout(async () => {
        try {
          await refreshRuns();
          await refreshFiles();
        } catch (error) {
          state.lastActionError = error.message;
        }
        render();
        scheduleSessionPolling();
      }, 1500);
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
        state.lastActionError = result.error || 'Run failed.';
        state.lastActionMessage = result.runId ? `Run ${result.runId} failed.` : '';
      } else {
        state.lastActionMessage = `Run ${result.runId} started.`;
        state.lastActionError = '';
        state.activeSessionId = result.runId;
        state.selectedRunId = result.runId;
        state.activeTab = 'runs';
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

    async function performAction(fn) {
      state.lastActionMessage = '';
      state.lastActionError = '';
      try {
        await fn();
      } catch (error) {
        state.lastActionError = error.message;
      }
      render();
    }

    async function init() {
      try {
        await refreshBootstrap();
        await refreshConfig();
        await Promise.all([
          refreshSetup(),
          refreshProviderStatus(),
          refreshRuns(),
          refreshFiles()
        ]);
      } catch (error) {
        state.lastActionError = error.message;
        if (!state.configRaw) {
          state.configRaw = defaultConfig();
          ensureConfigShape();
          syncRawEditor();
        }
      }
      render();
    }

    return {
      init,
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
      performAction
    };
  }

  return {
    createUiActions
  };
});
