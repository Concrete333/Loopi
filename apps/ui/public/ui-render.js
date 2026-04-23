(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.LoopiUiRender = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createRenderers(deps) {
    const {
      state,
      dom,
      ensureConfigShape,
      currentAgents,
      currentProviderIds,
      getRunSession,
      executionTargets,
      getAdapterMeta,
      selectedUseCase,
      roleRecommendation,
      activeValidationMessage,
      actionMessageMarkup,
      invalidPersistedConfigMarkup,
      invalidPersistedConfigPanel,
      escapeHtml,
      prettyJson,
      statusChip,
      emptyState,
      loopField,
      roleSelect
    } = deps;

    function formatBuiltAt(value) {
      if (value === null || value === undefined || value === '') {
        return '';
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return String(value);
      }
      return date.toLocaleString();
    }

    function renderContextStatusMarkup() {
      if (!state.contextStatus) {
        return '<p class="muted">Loading context status...</p>';
      }

      const cs = state.contextStatus;
      if (cs.ok === false || cs.status === 'invalid-config') {
        return `<div class="message message--warning">${escapeHtml(cs.error || 'Context status is unavailable until the draft config is valid.')}</div>` +
          '<div class="button-row"><button class="button button--ghost" id="refresh-context-status">Refresh Status</button></div>';
      }

      if (cs.status === 'no-context') {
        return '<p class="muted">No context folder configured.</p>' +
          '<div class="button-row"><button class="button button--ghost" id="refresh-context-status">Refresh Status</button></div>';
      }

      const chips = [];
      if (cs.status === 'ready') {
        chips.push('<span class="chip chip--success">Ready</span>');
      } else if (cs.status === 'ready-with-warnings') {
        chips.push('<span class="chip chip--warning">Ready (warnings)</span>');
      } else if (cs.status === 'drifted') {
        chips.push('<span class="chip chip--danger">Drifted</span>');
      } else if (cs.status === 'missing') {
        chips.push('<span class="chip chip--danger">Not prepared</span>');
      } else if (cs.status === 'config-mismatch') {
        chips.push('<span class="chip chip--danger">Config mismatch</span>');
      } else {
        chips.push(statusChip(cs.status, false));
      }
      if (cs.builtAt) {
        chips.push(`<span class="chip chip--neutral">Built: ${escapeHtml(formatBuiltAt(cs.builtAt))}</span>`);
      }
      if (cs.driftedSources && cs.driftedSources.length > 0) {
        chips.push(`<span class="chip chip--danger">${cs.driftedSources.length} drifted</span>`);
      }
      if (cs.skippedSources && cs.skippedSources.length > 0) {
        chips.push(`<span class="chip chip--warning">${cs.skippedSources.length} skipped</span>`);
      }

      const mismatchList = (cs.mismatches && cs.mismatches.length > 0)
        ? '<div class="message message--error"><strong>Drift:</strong> ' +
          cs.mismatches.slice(0, 5).map(function (m) {
            return escapeHtml(m.field + ': ' + (m.reason || m.description || 'mismatch'));
          }).join('<br>') +
          '</div>'
        : '';

      const driftedList = (cs.driftedSources && cs.driftedSources.length > 0)
        ? '<div class="message message--error"><strong>Changed sources:</strong> ' +
          cs.driftedSources.slice(0, 5).map(function (d) {
            return escapeHtml(d.sourceRelativePath + ' (' + (d.change || 'changed') + ')');
          }).join('<br>') +
          '</div>'
        : '';

      const skippedList = (cs.skippedSources && cs.skippedSources.length > 0)
        ? '<div class="message message--warning"><strong>Skipped:</strong> ' +
          cs.skippedSources.slice(0, 5).map(function (s) {
            return escapeHtml(s.sourceRelativePath + ' (' + (s.reason || s.skipReason || 'skipped') + ')');
          }).join('<br>') +
          '</div>'
        : '';

      const needsPrepare = cs.status === 'missing' || cs.status === 'drifted' || cs.status === 'config-mismatch';
      return '<div class="chip-row" style="margin-bottom:0.5rem">' + chips.join('') + '</div>' +
        mismatchList + driftedList + skippedList +
        '<div class="button-row">' +
          '<button class="button button--' + (needsPrepare ? 'primary' : 'secondary') + '" id="prepare-context">' +
            (needsPrepare ? 'Prepare Context' : 'Re-prepare Context') +
          '</button>' +
          '<button class="button button--ghost" id="refresh-context-status">Refresh Status</button>' +
        '</div>';
    }

    function renderHeroSummary() {
      const adapters = state.setupStatus && Array.isArray(state.setupStatus.adapters) ? state.setupStatus.adapters : [];
      const providers = state.providerStatus && state.providerStatus.providers ? Object.values(state.providerStatus.providers) : [];
      const runs = Array.isArray(state.runs) ? state.runs : [];
      dom.heroSummary.innerHTML = `
        <div class="hero-stats">
          <div class="stat-strip">
            <span class="muted">Adapters ready</span>
            <strong>${adapters.filter((item) => item.ready).length}/${adapters.length || 0}</strong>
          </div>
          <div class="stat-strip">
            <span class="muted">Providers configured</span>
            <strong>${providers.length}</strong>
          </div>
          <div class="stat-strip">
            <span class="muted">Recorded runs</span>
            <strong>${runs.length}</strong>
          </div>
        </div>
      `;
    }

    function renderSetup() {
      const setup = state.setupStatus;
      const providers = state.providerStatus && state.providerStatus.providers
        ? Object.entries(state.providerStatus.providers)
        : [];
      const providerError = state.providerStatus && state.providerStatus.error ? state.providerStatus.error : '';

      const adapterCards = setup && Array.isArray(setup.adapters)
        ? setup.adapters.map((adapter) => `
            <article class="card">
              <div class="section-heading">
                <div>
                  <h3>${escapeHtml(adapter.displayName || adapter.agentId || adapter.id)}</h3>
                  <p>${escapeHtml(adapter.metadata && adapter.metadata.docsUrl ? adapter.metadata.docsUrl : 'CLI adapter')}</p>
                </div>
                ${statusChip(adapter.status, adapter.ready)}
              </div>
              <div class="stack">
                  <div class="chip-row">
                    <span class="chip chip--neutral">${escapeHtml(adapter.agentId || adapter.id)}</span>
                    ${adapter.resolvedPath ? `<span class="chip chip--neutral">${escapeHtml(adapter.resolvedPath)}</span>` : ''}
                  </div>
                  ${adapter.errorMessage ? `<div class="message message--error">${escapeHtml(adapter.errorMessage)}</div>` : ''}
                  <div class="split-actions">
                    ${adapter.metadata && adapter.metadata.docsUrl ? `<a class="button button--ghost" href="${escapeHtml(adapter.metadata.docsUrl)}" target="_blank" rel="noreferrer">Docs</a>` : ''}
                    ${adapter.nextAction && adapter.nextAction.type === 'install' && adapter.metadata && adapter.metadata.installCommand
                      ? `<button class="button button--primary" data-adapter-install="${escapeHtml(adapter.id)}" data-command-text="${escapeHtml(adapter.metadata.installCommand.command)}">Install In Loopi</button>`
                      : ''}
                    ${adapter.nextAction && adapter.nextAction.type === 'login' && adapter.metadata && adapter.metadata.loginCommand
                      ? `<button class="button button--primary" data-adapter-login="${escapeHtml(adapter.id)}" data-command-text="${escapeHtml(adapter.metadata.loginCommand.shellCommand)}">Launch Login</button>`
                      : ''}
                    ${adapter.metadata && adapter.metadata.installHint ? `<button class="button button--secondary" data-copy="${escapeHtml(adapter.metadata.installHint)}">Copy Install</button>` : ''}
                    ${adapter.metadata && adapter.metadata.loginHint ? `<button class="button button--ghost" data-copy="${escapeHtml(adapter.metadata.loginHint)}">Copy Login</button>` : ''}
                  </div>
                </div>
              </article>
            `).join('')
        : emptyState('No adapter status loaded yet.', 'Use the detect action to query the local setup state.');

      const providerCards = providers.length > 0
        ? providers.map(([providerId, provider]) => `
            <article class="provider-card">
              <div class="section-heading">
                <div>
                  <h3>${escapeHtml(providerId)}</h3>
                  <p>${escapeHtml(provider.baseUrl || 'No base URL')}</p>
                </div>
                ${statusChip(provider.status, provider.ready)}
              </div>
              <div class="stack">
                <div class="chip-row">
                  <span class="chip chip--neutral">${escapeHtml(provider.model || 'No model')}</span>
                  <span class="chip chip--neutral">${escapeHtml(provider.type || 'unknown')}</span>
                </div>
                ${provider.errorMessage ? `<div class="message message--error">${escapeHtml(provider.errorMessage)}</div>` : ''}
                <div class="button-row">
                  <button class="button button--secondary" data-provider-test="${escapeHtml(providerId)}">Test Provider</button>
                </div>
              </div>
            </article>
          `).join('')
        : emptyState(
            providerError || 'No configured providers yet.',
            providerError ? 'Fix the current task or draft config to test providers again.' : 'Add provider settings in the Settings screen to test the current draft here, even before saving.'
          );

      dom.setup.innerHTML = `
        <div class="section-heading">
          <div>
            <h2>Setup Status</h2>
            <p>Retest adapters and providers without leaving the local control plane.</p>
          </div>
          <div class="button-row">
            <button class="button button--primary" id="refresh-setup">Detect Adapters</button>
            <button class="button button--secondary" id="refresh-providers">Test Current Providers</button>
          </div>
        </div>
        ${actionMessageMarkup()}
        ${invalidPersistedConfigMarkup()}
        <div class="grid grid--cards">${adapterCards}</div>
        <div class="section-heading">
          <div>
            <h3>Configured Providers</h3>
            <p>Provider checks use the backend service layer, not client-side guessing.</p>
          </div>
        </div>
        <div class="grid grid--cards">${providerCards}</div>
      `;
    }

    function renderSettings() {
      if (state.persistedConfigBlocked) {
        dom.settings.innerHTML = invalidPersistedConfigPanel({
          title: 'Settings Blocked By Invalid Saved Task',
          description: 'Loopi found a saved task file, but it is invalid. Review it here before replacing it with a new draft.',
          showRaw: true
        });
        return;
      }
      if (!ensureConfigShape()) {
        dom.settings.innerHTML = emptyState('No editable draft loaded.', 'Start a new draft to configure agents, providers, and context.');
        return;
      }
      const context = state.configRaw.context || {};
      const selectedAgents = currentAgents();
      const adapterOptions = state.bootstrap && Array.isArray(state.bootstrap.adapterMetadata)
        ? state.bootstrap.adapterMetadata
        : [];
      const providers = Object.entries(state.configRaw.providers || {});

      const agentControls = adapterOptions.map((meta) => `
        <div class="check-row">
          <label>
            <input type="checkbox" data-agent-toggle="${escapeHtml(meta.id)}" ${selectedAgents.includes(meta.id) ? 'checked' : ''}>
            <span>${escapeHtml(meta.displayName)}</span>
          </label>
          <span class="chip chip--neutral">${meta.supportsWriteAccess ? 'Writable' : 'Read-only'}</span>
        </div>
      `).join('');

      const providerCards = providers.length > 0
        ? providers.map(([providerId, provider]) => `
            <div class="inline-panel">
              <div class="section-heading">
                <div>
                  <h3>${escapeHtml(providerId)}</h3>
                  <p>${escapeHtml(provider.type || 'openai-compatible')}</p>
                </div>
                <button class="button button--danger" data-provider-remove="${escapeHtml(providerId)}">Remove</button>
              </div>
              <div class="field-grid">
                <div class="field">
                  <label>Base URL</label>
                  <input data-provider-field="${escapeHtml(providerId)}:baseUrl" value="${escapeHtml(provider.baseUrl || '')}">
                </div>
                <div class="field">
                  <label>Model</label>
                  <input data-provider-field="${escapeHtml(providerId)}:model" value="${escapeHtml(provider.model || '')}">
                </div>
                <div class="field">
                  <label>API Key</label>
                  <input data-provider-field="${escapeHtml(providerId)}:apiKey" value="${escapeHtml(provider.apiKey || '')}">
                </div>
                <div class="field">
                  <label>Health Endpoint</label>
                  <input data-provider-field="${escapeHtml(providerId)}:healthEndpoint" value="${escapeHtml(provider.healthEndpoint || '')}">
                </div>
                <div class="field">
                  <label>Max Input Chars</label>
                  <input data-provider-field="${escapeHtml(providerId)}:maxInputChars" type="number" min="1" value="${escapeHtml(provider.maxInputChars || '')}">
                </div>
                <div class="field">
                  <label>Mark As Local</label>
                  <select data-provider-field="${escapeHtml(providerId)}:local">
                    <option value="false" ${provider.local ? '' : 'selected'}>No</option>
                    <option value="true" ${provider.local ? 'selected' : ''}>Yes</option>
                  </select>
                </div>
              </div>
            </div>
          `).join('')
        : emptyState('No providers configured.', 'Add one below if you want to use an OpenAI-compatible endpoint.');

      const policyCards = selectedAgents.length > 0
        ? selectedAgents.map((agentId) => {
            const option = state.configRaw.settings.agentOptions[agentId] || {};
            const policy = state.configRaw.settings.agentPolicies[agentId];
            return `
              <div class="inline-panel">
                <div class="section-heading">
                  <div>
                    <h3>${escapeHtml(agentId)}</h3>
                    <p>Model, effort, and default write policy.</p>
                  </div>
                </div>
                <div class="field-grid">
                  <div class="field">
                    <label>Model</label>
                    <input data-agent-option="${escapeHtml(agentId)}:model" value="${escapeHtml(option.model || '')}">
                  </div>
                  <div class="field">
                    <label>Effort</label>
                    <select data-agent-option="${escapeHtml(agentId)}:effort">
                      <option value="" ${option.effort ? '' : 'selected'}>Default</option>
                      <option value="low" ${option.effort === 'low' ? 'selected' : ''}>Low</option>
                      <option value="medium" ${option.effort === 'medium' ? 'selected' : ''}>Medium</option>
                      <option value="high" ${option.effort === 'high' ? 'selected' : ''}>High</option>
                    </select>
                  </div>
                  <div class="field">
                    <label>Can Write</label>
                    <select data-agent-policy="${escapeHtml(agentId)}">
                      <option value="" ${policy === undefined ? 'selected' : ''}>Default</option>
                      <option value="true" ${policy === true || (policy && policy.canWrite === true) ? 'selected' : ''}>Yes</option>
                      <option value="false" ${policy === false || (policy && policy.canWrite === false) ? 'selected' : ''}>No</option>
                    </select>
                  </div>
                </div>
              </div>
            `;
          }).join('')
        : emptyState('No agents selected.', 'Choose agents above to edit their model and policy defaults.');

      dom.settings.innerHTML = `
        <div class="section-heading">
          <div>
            <h2>Settings</h2>
            <p>Common config controls live here, with raw JSON available only as an advanced escape hatch.</p>
          </div>
        </div>
        ${state.configResult && state.configResult.exists && !state.configResult.valid && state.draftMode === 'new' ? `
          <div class="message message--warning">
            You are editing a fresh draft because the saved task file is invalid. Saving will replace ${escapeHtml(state.configResult.filePath || 'the broken task file')}.
          </div>
        ` : ''}
        ${activeValidationMessage()}
        <div class="grid grid--double">
          <div class="inline-panel">
            <div class="field">
              <label>Project Root</label>
              <input readonly value="${escapeHtml(state.bootstrap ? state.bootstrap.projectRoot : '')}">
            </div>
            <div class="field">
              <label>Context Directory</label>
              <input data-context-dir value="${escapeHtml(context.dir || './context')}">
            </div>
            <div class="check-grid">
              <div id="context-status-area">${renderContextStatusMarkup()}</div>
              <div class="check-row">
                <label>
                  <input type="checkbox" data-context-enabled ${state.configRaw.context ? 'checked' : ''}>
                  <span>Use shared context folder</span>
                </label>
              </div>
              <div class="check-row">
                <label>
                  <input type="checkbox" data-setting-toggle="continueOnError" ${state.configRaw.settings.continueOnError ? 'checked' : ''}>
                  <span>Continue on error</span>
                </label>
              </div>
              <div class="check-row">
                <label>
                  <input type="checkbox" data-setting-toggle="writeScratchpad" ${state.configRaw.settings.writeScratchpad !== false ? 'checked' : ''}>
                  <span>Write scratchpad</span>
                </label>
              </div>
            </div>
          </div>
          <div class="inline-panel">
            <div class="field">
              <label>Timeout (ms)</label>
              <input data-setting-number="timeoutMs" type="number" min="1000" step="1000" value="${escapeHtml(state.configRaw.settings.timeoutMs || 180000)}">
            </div>
            ${state.advanced ? `
              <div class="field-grid">
                <div class="field">
                  <label>Plan Max Files</label>
                  <input data-context-cap="files:plan" type="number" min="1" value="${escapeHtml(context.maxFilesPerPhase && context.maxFilesPerPhase.plan || '')}">
                </div>
                <div class="field">
                  <label>Implement Max Files</label>
                  <input data-context-cap="files:implement" type="number" min="1" value="${escapeHtml(context.maxFilesPerPhase && context.maxFilesPerPhase.implement || '')}">
                </div>
                <div class="field">
                  <label>Review Max Files</label>
                  <input data-context-cap="files:review" type="number" min="1" value="${escapeHtml(context.maxFilesPerPhase && context.maxFilesPerPhase.review || '')}">
                </div>
                <div class="field">
                  <label>Plan Max Chars</label>
                  <input data-context-cap="chars:plan" type="number" min="1" value="${escapeHtml(context.maxCharsPerPhase && context.maxCharsPerPhase.plan || '')}">
                </div>
                <div class="field">
                  <label>Implement Max Chars</label>
                  <input data-context-cap="chars:implement" type="number" min="1" value="${escapeHtml(context.maxCharsPerPhase && context.maxCharsPerPhase.implement || '')}">
                </div>
                <div class="field">
                  <label>Review Max Chars</label>
                  <input data-context-cap="chars:review" type="number" min="1" value="${escapeHtml(context.maxCharsPerPhase && context.maxCharsPerPhase.review || '')}">
                </div>
              </div>
            ` : '<p class="muted">Switch on advanced view to edit context caps and raw JSON.</p>'}
          </div>
        </div>

        <div class="section-heading">
          <div>
            <h3>Agent Enablement</h3>
            <p>Selected agents feed directly into the task composer and validation calls.</p>
          </div>
        </div>
        <div class="grid grid--cards">${agentControls}</div>

        <div class="section-heading">
          <div>
            <h3>Provider Configuration</h3>
            <p>Configure HTTP providers here, then test them from Setup or Composer.</p>
          </div>
        </div>
        <div class="stack">${providerCards}</div>
        <div class="inline-panel">
          <div class="field-grid">
            <div class="field">
              <label>New Provider ID</label>
              <input id="new-provider-id" placeholder="nim-local">
            </div>
            <div class="field">
              <label>Base URL</label>
              <input id="new-provider-baseUrl" placeholder="http://localhost:8000/v1">
            </div>
            <div class="field">
              <label>Model</label>
              <input id="new-provider-model" placeholder="Qwen/Qwen2.5-7B">
            </div>
          </div>
          <div class="button-row">
            <button class="button button--primary" id="add-provider">Add Provider</button>
          </div>
        </div>

        <div class="section-heading">
          <div>
            <h3>Agent Defaults</h3>
            <p>Set model, effort, and default write permissions without dropping into raw config.</p>
          </div>
        </div>
        <div class="stack">${policyCards}</div>

        <details class="details-toggle" ${state.advanced ? 'open' : ''}>
          <summary>Raw JSON escape hatch</summary>
          <div class="stack">
            <div class="field">
              <label>Raw task.json</label>
              <textarea id="raw-editor">${escapeHtml(state.rawEditorText)}</textarea>
            </div>
            <div class="button-row">
              <button class="button button--secondary" id="apply-raw-json">Apply Raw JSON</button>
              <button class="button button--ghost" id="validate-raw-json">Validate Raw JSON</button>
            </div>
          </div>
        </details>
      `;
    }

    function renderComposer() {
      if (state.persistedConfigBlocked) {
        dom.composer.innerHTML = invalidPersistedConfigPanel({
          title: 'Composer Blocked By Invalid Saved Task',
          description: 'The current saved task file is invalid, so save, validate, and run actions are blocked until you inspect it and start a fresh draft.',
          showRaw: false
        });
        return;
      }
      if (!ensureConfigShape()) {
        dom.composer.innerHTML = emptyState('No editable draft loaded.', 'Start a new draft before composing a task.');
        return;
      }
      const roles = state.configRaw.roles || {};
      const recs = roleRecommendation();
      const useCases = state.bootstrap && Array.isArray(state.bootstrap.useCases) ? state.bootstrap.useCases : [];
      const mode = state.configRaw.mode || 'plan';

      const executionOptions = executionTargets().map((target) => `<option value="${escapeHtml(target)}">${escapeHtml(target)}</option>`).join('');
      const useCaseField = (mode === 'plan' || mode === 'one-shot')
        ? `
          <div class="field">
            <label>Use Case</label>
            <select id="composer-use-case">
              <option value="">Choose a use case</option>
              ${useCases.map((useCase) => `<option value="${escapeHtml(useCase)}" ${selectedUseCase() === useCase ? 'selected' : ''}>${escapeHtml(useCase)}</option>`).join('')}
            </select>
          </div>
        `
        : '';

      const loopFields = [];
      if (mode === 'plan') {
        loopFields.push(loopField('Plan loops', 'planLoops', state.configRaw.settings.planLoops || 1));
      } else if (mode === 'one-shot') {
        loopFields.push(loopField('Quality loops', 'qualityLoops', state.configRaw.settings.qualityLoops || 1));
        loopFields.push(loopField('Plan loops', 'planLoops', state.configRaw.settings.planLoops || 1));
        loopFields.push(loopField('Section implementation loops', 'sectionImplementLoops', state.configRaw.settings.sectionImplementLoops || 1));
      } else if (mode === 'implement') {
        loopFields.push(loopField('Implementation loops', 'implementLoops', state.configRaw.settings.implementLoops || 1));
      }

      dom.composer.innerHTML = `
        <div class="section-heading">
          <div>
            <h2>Task Composer</h2>
            <p>Compose the next task, validate it against the backend, then save it or launch it immediately.</p>
          </div>
        </div>
        ${state.configResult && state.configResult.exists && !state.configResult.valid && state.draftMode === 'new' ? `
          <div class="message message--warning">
            This draft is detached from the invalid saved task file. Saving will replace ${escapeHtml(state.configResult.filePath || 'that file')}.
          </div>
        ` : ''}
        ${activeValidationMessage()}
        ${actionMessageMarkup()}
        <div class="grid grid--double">
          <div class="inline-panel">
            <div class="field">
              <label>Prompt</label>
              <textarea id="composer-prompt">${escapeHtml(state.configRaw.prompt || '')}</textarea>
            </div>
            <div class="field-grid">
              <div class="field">
                <label>Mode</label>
                <select id="composer-mode">
                  <option value="plan" ${mode === 'plan' ? 'selected' : ''}>plan</option>
                  <option value="review" ${mode === 'review' ? 'selected' : ''}>review</option>
                  <option value="implement" ${mode === 'implement' ? 'selected' : ''}>implement</option>
                  <option value="one-shot" ${mode === 'one-shot' ? 'selected' : ''}>one-shot</option>
                </select>
              </div>
              ${useCaseField}
            </div>
            <div class="field-grid">${loopFields.join('')}</div>
          </div>
          <div class="inline-panel">
            <div class="section-heading">
              <div>
                <h3>Recommended Roles</h3>
                <p>These are guidance defaults for the current selection, not hardcoded validation.</p>
              </div>
            </div>
            <div class="chip-row">
              ${recs.planner ? `<span class="chip chip--neutral">Planner: ${escapeHtml(recs.planner)}</span>` : ''}
              ${recs.implementer ? `<span class="chip chip--neutral">Implementer: ${escapeHtml(recs.implementer)}</span>` : ''}
              ${recs.reviewer ? `<span class="chip chip--neutral">Reviewer: ${escapeHtml(recs.reviewer)}</span>` : ''}
              ${recs.fallback ? `<span class="chip chip--neutral">Fallback: ${escapeHtml(recs.fallback)}</span>` : ''}
            </div>
            ${state.advanced ? `
              <div class="field-grid">
                ${roleSelect('planner', roles.planner || '', executionOptions)}
                ${roleSelect('implementer', roles.implementer || '', executionOptions)}
                ${roleSelect('reviewer', roles.reviewer || '', executionOptions)}
                ${roleSelect('fallback', roles.fallback || '', executionOptions)}
              </div>
            ` : '<p class="muted">Switch on advanced view to override role assignments explicitly.</p>'}
          </div>
        </div>

        <div class="inline-panel">
          <div class="field">
            <label>Preset name</label>
            <input id="preset-name" placeholder="my-safe-plan" value="${escapeHtml(state.presetDraftName || '')}">
          </div>
          <div class="button-row">
            <button class="button button--secondary" id="validate-config">Validate</button>
            <button class="button button--ghost" id="save-config">Save Task</button>
            <button class="button button--primary" id="run-config">Run Now</button>
            <button class="button button--ghost" id="save-preset">Save As Preset</button>
          </div>
        </div>
      `;
    }

    function renderRuns() {
      const storedRuns = Array.isArray(state.runs) ? state.runs : [];
      const sessions = Array.isArray(state.runSessions) ? state.runSessions : [];
      const runs = [];
      const seenRunIds = new Set();
      for (const session of sessions) {
        runs.push({
          runId: session.runId,
          mode: session.mode || 'unknown',
          prompt: session.prompt || '',
          startedAt: session.startedAt || session.launchedAt || null,
          createdAt: session.startedAt || session.launchedAt || null,
          status: session.status || 'unknown',
          readError: session.error && session.error.message ? session.error.message : session.error || null,
          isDamaged: false,
          isSession: true,
          active: Boolean(session.active)
        });
        seenRunIds.add(session.runId);
      }
      for (const run of storedRuns) {
        if (!seenRunIds.has(run.runId)) {
          runs.push(run);
        }
      }
      const details = state.runDetails;
      const detailSummary = details && details.summary ? details.summary : null;
      const liveSession = state.selectedRunId ? getRunSession(state.selectedRunId) : null;
      const artifacts = details && Array.isArray(details.artifacts) ? details.artifacts : [];
      const selectedArtifact = artifacts.find((artifact) => artifact.id === state.selectedArtifactId) || artifacts[0] || null;

      const runCards = runs.length > 0
        ? runs.map((run) => `
            <article class="run-card ${state.selectedRunId === run.runId ? 'is-selected' : ''}" data-run-select="${escapeHtml(run.runId)}">
              <h3>${escapeHtml(run.runId)}</h3>
              <div class="chip-row">
                ${statusChip(run.status, run.status === 'completed' && !run.isDamaged)}
                <span class="chip chip--neutral">${escapeHtml(run.mode)}</span>
                ${run.isSession && run.active ? '<span class="chip chip--warning">Live session</span>' : ''}
              </div>
              <p class="muted">${escapeHtml(run.prompt || '')}</p>
              ${run.readError ? `<p class="muted">${escapeHtml(run.readError)}</p>` : ''}
              <p class="status-line">${escapeHtml(run.startedAt || run.createdAt || '')}</p>
            </article>
          `).join('')
        : emptyState('No runs recorded yet.', 'Run something from the composer to populate the dashboard.');

      const stepTimeline = details && details.steps && details.steps.length > 0
        ? details.steps.map((step) => `
            <article class="timeline-step ${step.ok ? '' : 'is-failed'}">
              <h4>${escapeHtml(step.stage || 'step')} | ${escapeHtml(step.agent || 'system')}</h4>
              <div class="chip-row">
                ${statusChip(step.ok ? 'ok' : 'failed', step.ok)}
                <span class="chip chip--neutral">${escapeHtml(String(step.durationMs || 0))} ms</span>
                ${step.cycleNumber ? `<span class="chip chip--neutral">Cycle ${escapeHtml(step.cycleNumber)}</span>` : ''}
              </div>
              ${step.error && step.error.message ? `<p class="muted">${escapeHtml(step.error.message)}</p>` : ''}
            </article>
          `).join('')
        : emptyState('No step timeline yet.', 'Select a run with recorded steps to inspect the timeline.');

      const artifactCards = artifacts.length > 0
        ? artifacts.map((artifact) => `
            <article class="artifact-card ${selectedArtifact && selectedArtifact.id === artifact.id ? 'is-selected' : ''}" data-artifact-select="${escapeHtml(artifact.id)}">
              <h4>${escapeHtml(artifact.type)}</h4>
              <div class="chip-row">
                <span class="chip chip--neutral">${escapeHtml(artifact.id)}</span>
                <span class="chip chip--neutral">${escapeHtml(artifact.createdAt || '')}</span>
              </div>
            </article>
          `).join('')
        : emptyState('No artifacts recorded.', 'Artifacts appear here after a run writes collaboration-store data.');

      const detailNotice = details && details.exists === false
        ? liveSession && liveSession.active
          ? '<div class="message message--warning">This run has started, but its durable task record is not available yet. The dashboard will keep polling.</div>'
          : '<div class="message message--warning">That run is no longer available on disk.</div>'
        : details && details.isDamaged
          ? `<div class="message message--error">${escapeHtml(details.error || 'This run is damaged and could only be loaded partially.')}</div>`
          : '';
      const liveSessionNotice = liveSession && liveSession.active
        ? `<div class="message message--warning">Run ${escapeHtml(liveSession.runId)} is still in progress. The dashboard is polling for updates.</div>`
        : '';

      dom.runs.innerHTML = `
        <div class="section-heading">
          <div>
            <h2>Run Dashboard</h2>
            <p>Inspect stored run history, timeline steps, artifacts, and the latest scratchpad or log files.</p>
          </div>
          <div class="button-row">
            <button class="button button--secondary" id="refresh-runs">Refresh Runs</button>
            <button class="button button--ghost" id="refresh-files">Refresh Files</button>
          </div>
        </div>
        <div class="run-dashboard">
          <div class="run-list">${runCards}</div>
          <div class="stack">
            ${liveSessionNotice}
            ${detailNotice}
            ${details ? `
              <div class="inline-panel">
                <div class="section-heading">
                  <div>
                    <h3>${escapeHtml(details.runId)}</h3>
                    <p>${escapeHtml(details.task && details.task.prompt || liveSession && liveSession.prompt || '')}</p>
                  </div>
                </div>
                ${detailSummary ? `
                  <div class="chip-row">
                    ${statusChip(liveSession && liveSession.active ? liveSession.status : detailSummary.status, detailSummary.status === 'completed' && !detailSummary.isDamaged)}
                    <span class="chip chip--neutral">${escapeHtml(detailSummary.mode)}</span>
                    <span class="chip chip--neutral">${escapeHtml(String(detailSummary.stepCount || 0))} steps</span>
                    <span class="chip chip--neutral">${escapeHtml(String(detailSummary.snapshotCount || 0))} snapshots</span>
                    ${liveSession && liveSession.active ? '<span class="chip chip--warning">Live session</span>' : ''}
                  </div>
                ` : liveSession ? `
                  <div class="chip-row">
                    ${statusChip(liveSession.status, liveSession.status === 'completed')}
                    <span class="chip chip--neutral">${escapeHtml(liveSession.mode || 'unknown')}</span>
                    ${liveSession.active ? '<span class="chip chip--warning">Live session</span>' : ''}
                  </div>
                ` : '<p class="muted">No summary is available for this run.</p>'}
              </div>
            ` : ''}
            <div class="inline-panel">
              <div class="section-heading">
                <div>
                  <h3>Step Timeline</h3>
                  <p>Each stored step is rendered directly from collaboration-store data.</p>
                </div>
              </div>
              <div class="timeline">${stepTimeline}</div>
            </div>
            <div class="artifact-layout">
              <div class="artifact-list">${artifactCards}</div>
              <div class="json-panel">
                <div class="section-heading">
                  <div>
                    <h3>Artifact Detail</h3>
                    <p>${selectedArtifact ? escapeHtml(selectedArtifact.id) : 'Select an artifact from the list.'}</p>
                  </div>
                </div>
                <pre>${selectedArtifact ? prettyJson(selectedArtifact) : escapeHtml('No artifact selected yet.')}</pre>
              </div>
            </div>
            <div class="grid grid--double">
              <div class="json-panel">
                <div class="section-heading">
                  <div>
                    <h3>Scratchpad</h3>
                    <p>${escapeHtml(state.scratchpad && state.scratchpad.filePath || '')}</p>
                  </div>
                </div>
                <pre>${escapeHtml(state.scratchpad && state.scratchpad.content || '')}</pre>
              </div>
              <div class="json-panel">
                <div class="section-heading">
                  <div>
                    <h3>Run Log</h3>
                    <p>${escapeHtml(state.logFile && state.logFile.filePath || '')}</p>
                  </div>
                </div>
                <pre>${escapeHtml(state.logFile && state.logFile.content || '')}</pre>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    return {
      renderHeroSummary,
      renderSetup,
      renderSettings,
      renderComposer,
      renderRuns
    };
  }

  return {
    createRenderers
  };
});
