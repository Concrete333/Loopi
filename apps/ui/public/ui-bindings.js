(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.LoopiUiBindings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createUiBindings(deps) {
    const {
      document,
      navigatorImpl,
      confirmImpl,
      state,
      dom,
      render,
      mutateDraft,
      setField,
      deleteField,
      setMode,
      toggleAgent,
      upsertProvider,
      removeProvider,
      assertDraftAvailable,
      startNewDraft,
      api,
      setConfigRaw,
      actions
    } = deps;

    let tabButtonsBound = false;

    function bindTabButtons() {
      if (tabButtonsBound) {
        return;
      }
      tabButtonsBound = true;
      document.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          state.activeTab = button.getAttribute('data-tab');
          if (state.activeTab === 'runs') {
            actions.scheduleSessionPolling();
          } else {
            actions.stopSessionPolling();
          }
          syncActiveTabUi();
        });
      });
    }

    function syncActiveTabUi() {
      document.querySelectorAll('.tab-button').forEach((button) => {
        button.classList.toggle('is-active', button.getAttribute('data-tab') === state.activeTab);
      });
      document.querySelectorAll('.panel').forEach((panel) => {
        panel.classList.toggle('is-active', panel.id === `tab-${state.activeTab}`);
      });
    }

    function bindSetup() {
      const refreshSetupButton = document.getElementById('refresh-setup');
      if (refreshSetupButton) {
        refreshSetupButton.addEventListener('click', async () => actions.performAction(async () => {
          await actions.refreshSetup();
          state.lastActionMessage = 'Adapter detection refreshed.';
        }));
      }

      const refreshProvidersButton = document.getElementById('refresh-providers');
      if (refreshProvidersButton) {
        refreshProvidersButton.addEventListener('click', async () => actions.performAction(async () => {
          await actions.refreshProviderStatus();
          state.lastActionMessage = 'Provider test results refreshed.';
        }));
      }

      document.querySelectorAll('[data-provider-test]').forEach((button) => {
        button.addEventListener('click', async () => actions.performAction(async () => {
          assertDraftAvailable('Provider testing');
          const providerId = button.getAttribute('data-provider-test');
          const providerConfig = state.configRaw.providers[providerId];
          const result = await api('/api/providers/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerId, providerConfig })
          });
          actions.ensureProviderStatus();
          state.providerStatus.providers[providerId] = result;
          state.lastActionMessage = `Provider "${providerId}" tested.`;
        }));
      });

      document.querySelectorAll('[data-copy]').forEach((button) => {
        button.addEventListener('click', async () => actions.performAction(async () => {
          const text = button.getAttribute('data-copy');
          if (!navigatorImpl.clipboard || !navigatorImpl.clipboard.writeText) {
            throw new Error('Clipboard write is not available in this browser context.');
          }
          await navigatorImpl.clipboard.writeText(text);
          state.lastActionMessage = 'Command copied to clipboard.';
        }));
      });

      document.querySelectorAll('[data-adapter-install]').forEach((button) => {
        button.addEventListener('click', async () => actions.performAction(async () => {
          const agentId = button.getAttribute('data-adapter-install');
          const commandText = button.getAttribute('data-command-text') || 'npm install -g ...';
          const approved = typeof confirmImpl === 'function'
            ? confirmImpl(`Install ${agentId} with this command?\n\n${commandText}`)
            : true;
          if (!approved) {
            state.lastActionMessage = 'Install cancelled.';
            return;
          }
          await actions.runAdapterInstall(agentId);
        }));
      });

      document.querySelectorAll('[data-adapter-login]').forEach((button) => {
        button.addEventListener('click', async () => actions.performAction(async () => {
          const agentId = button.getAttribute('data-adapter-login');
          const commandText = button.getAttribute('data-command-text') || `${agentId} auth login`;
          const approved = typeof confirmImpl === 'function'
            ? confirmImpl(`Launch the ${agentId} login command?\n\n${commandText}`)
            : true;
          if (!approved) {
            state.lastActionMessage = 'Login launch cancelled.';
            return;
          }
          await actions.runAdapterLogin(agentId);
        }));
      });
    }

    function bindSettings() {
      document.querySelectorAll('[data-agent-toggle]').forEach((input) => {
        input.addEventListener('change', () => {
          toggleAgent(input.getAttribute('data-agent-toggle'), input.checked);
        });
      });

      const contextEnabled = document.querySelector('[data-context-enabled]');
      if (contextEnabled) {
        contextEnabled.addEventListener('change', () => {
          mutateDraft((draft) => {
            if (contextEnabled.checked) {
              draft.context = draft.context || { dir: './context' };
            } else {
              delete draft.context;
            }
          });
        });
      }

      const contextDir = document.querySelector('[data-context-dir]');
      if (contextDir) {
        contextDir.addEventListener('input', () => {
          mutateDraft((draft) => {
            draft.context = draft.context || {};
            draft.context.dir = contextDir.value;
          }, { renderNow: false });
        });
        contextDir.addEventListener('change', render);
      }

      document.querySelectorAll('[data-setting-toggle]').forEach((input) => {
        input.addEventListener('change', () => {
          setField(['settings', input.getAttribute('data-setting-toggle')], input.checked);
        });
      });

      document.querySelectorAll('[data-setting-number]').forEach((input) => {
        input.addEventListener('change', () => {
          setField(['settings', input.getAttribute('data-setting-number')], Number(input.value));
        });
      });

      document.querySelectorAll('[data-context-cap]').forEach((input) => {
        input.addEventListener('change', () => {
          const parts = input.getAttribute('data-context-cap').split(':');
          const bucket = parts[0] === 'files' ? 'maxFilesPerPhase' : 'maxCharsPerPhase';
          mutateDraft((draft) => {
            draft.context = draft.context || { dir: './context' };
            draft.context[bucket] = draft.context[bucket] || {};
            if (!input.value) {
              delete draft.context[bucket][parts[1]];
            } else {
              draft.context[bucket][parts[1]] = Number(input.value);
            }
          }, { renderNow: false });
        });
      });

      document.querySelectorAll('[data-provider-field]').forEach((input) => {
        input.addEventListener('change', () => {
          const parts = input.getAttribute('data-provider-field').split(':');
          const providerId = parts[0];
          const field = parts[1];
          let value = input.value;
          if (field === 'local') {
            value = value === 'true';
          } else if (field === 'maxInputChars') {
            value = value ? Number(value) : undefined;
          }
          upsertProvider(providerId, { [field]: value });
        });
      });

      document.querySelectorAll('[data-provider-remove]').forEach((button) => {
        button.addEventListener('click', () => removeProvider(button.getAttribute('data-provider-remove')));
      });

      const addProviderButton = document.getElementById('add-provider');
      if (addProviderButton) {
        addProviderButton.addEventListener('click', () => {
          const providerId = document.getElementById('new-provider-id').value.trim().toLowerCase();
          const baseUrl = document.getElementById('new-provider-baseUrl').value.trim();
          const model = document.getElementById('new-provider-model').value.trim();
          if (!providerId) {
            state.lastActionError = 'Provider ID is required.';
            render();
            return;
          }
          upsertProvider(providerId, {
            type: 'openai-compatible',
            baseUrl,
            model
          });
          state.lastActionMessage = `Provider "${providerId}" added to the draft config.`;
        });
      }

      document.querySelectorAll('[data-agent-option]').forEach((input) => {
        input.addEventListener('change', () => {
          const parts = input.getAttribute('data-agent-option').split(':');
          const agentId = parts[0];
          const field = parts[1];
          mutateDraft((draft) => {
            draft.settings.agentOptions[agentId] = draft.settings.agentOptions[agentId] || {};
            if (!input.value) {
              delete draft.settings.agentOptions[agentId][field];
            } else {
              draft.settings.agentOptions[agentId][field] = input.value;
            }
          }, { renderNow: false });
        });
      });

      document.querySelectorAll('[data-agent-policy]').forEach((input) => {
        input.addEventListener('change', () => {
          const agentId = input.getAttribute('data-agent-policy');
          mutateDraft((draft) => {
            if (!input.value) {
              delete draft.settings.agentPolicies[agentId];
            } else {
              draft.settings.agentPolicies[agentId] = { canWrite: input.value === 'true' };
            }
          }, { renderNow: false });
        });
      });

      const applyRawButton = document.getElementById('apply-raw-json');
      if (applyRawButton) {
        applyRawButton.addEventListener('click', () => {
          try {
            const parsed = JSON.parse(document.getElementById('raw-editor').value);
            setConfigRaw(parsed, { draftMode: 'new' });
            state.lastActionMessage = 'Raw JSON applied to the draft config.';
          } catch (error) {
            state.lastActionError = error.message;
            render();
          }
        });
      }

      const validateRawButton = document.getElementById('validate-raw-json');
      if (validateRawButton) {
        validateRawButton.addEventListener('click', async () => actions.performAction(async () => {
          const rawText = document.getElementById('raw-editor').value;
          const parsed = JSON.parse(rawText);
          state.validationResult = await api('/api/config/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawConfig: parsed })
          });
          state.validationDraftVersion = rawText === state.rawEditorText ? state.draftVersion : null;
        }));
      }
    }

    function bindComposer() {
      const prompt = document.getElementById('composer-prompt');
      if (prompt) {
        prompt.addEventListener('input', () => {
          mutateDraft((draft) => {
            draft.prompt = prompt.value;
          }, { renderNow: false });
        });
      }

      const mode = document.getElementById('composer-mode');
      if (mode) {
        mode.addEventListener('change', () => setMode(mode.value));
      }

      const useCase = document.getElementById('composer-use-case');
      if (useCase) {
        useCase.addEventListener('change', () => {
          if (useCase.value) {
            setField(['useCase'], useCase.value);
          } else {
            deleteField(['useCase']);
          }
        });
      }

      document.querySelectorAll('[data-loop-field]').forEach((input) => {
        input.addEventListener('change', () => {
          setField(['settings', input.getAttribute('data-loop-field')], Number(input.value));
        });
      });

      document.querySelectorAll('[data-role-field]').forEach((input) => {
        input.addEventListener('change', () => {
          const role = input.getAttribute('data-role-field');
          mutateDraft((draft) => {
            if (!input.value) {
              delete draft.roles[role];
            } else {
              draft.roles[role] = input.value;
            }
          }, { renderNow: false });
        });
      });

      const presetName = document.getElementById('preset-name');
      if (presetName) {
        presetName.addEventListener('input', () => {
          state.presetDraftName = presetName.value;
        });
      }

      const validateButton = document.getElementById('validate-config');
      if (validateButton) {
        validateButton.addEventListener('click', async () => actions.performAction(actions.validateCurrentConfig));
      }

      const saveButton = document.getElementById('save-config');
      if (saveButton) {
        saveButton.addEventListener('click', async () => actions.performAction(actions.saveCurrentConfig));
      }

      const runButton = document.getElementById('run-config');
      if (runButton) {
        runButton.addEventListener('click', async () => actions.performAction(actions.runCurrentConfig));
      }

      const savePresetButton = document.getElementById('save-preset');
      if (savePresetButton) {
        savePresetButton.addEventListener('click', async () => actions.performAction(actions.savePreset));
      }
    }

    function bindRuns() {
      const refreshRunsButton = document.getElementById('refresh-runs');
      if (refreshRunsButton) {
        refreshRunsButton.addEventListener('click', async () => actions.performAction(actions.refreshRuns));
      }

      const refreshFilesButton = document.getElementById('refresh-files');
      if (refreshFilesButton) {
        refreshFilesButton.addEventListener('click', async () => actions.performAction(actions.refreshFiles));
      }

      document.querySelectorAll('[data-run-select]').forEach((button) => {
        button.addEventListener('click', async () => actions.performAction(async () => {
          await actions.loadRunDetails(button.getAttribute('data-run-select'));
        }));
      });

      document.querySelectorAll('[data-artifact-select]').forEach((button) => {
        button.addEventListener('click', () => {
          state.selectedArtifactId = button.getAttribute('data-artifact-select');
          render();
        });
      });
    }

    function bindShared() {
      dom.advancedToggle.checked = state.advanced;
      dom.advancedToggle.onchange = () => {
        state.advanced = dom.advancedToggle.checked;
        render();
      };
      document.querySelectorAll('[data-start-new-draft]').forEach((button) => {
        button.addEventListener('click', () => {
          startNewDraft();
        });
      });
    }

    return {
      bindTabButtons,
      syncActiveTabUi,
      bindSetup,
      bindSettings,
      bindComposer,
      bindRuns,
      bindShared
    };
  }

  return {
    createUiBindings
  };
});
