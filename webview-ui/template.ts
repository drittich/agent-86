/**
 * HTML template for the webview root element.
 */

export const TEMPLATE_HTML: string = `
<div id="history-overlay" hidden>
  <div id="history-panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
    <div id="history-header">
      <span id="history-title">Recent Tasks</span>
      <button id="btn-history-close" title="Close">×</button>
    </div>
    <div id="history-body">
      <ul id="history-list"></ul>
    </div>
  </div>
</div>

<div id="settings-overlay" hidden>
  <div id="settings-panel" role="region" aria-labelledby="settings-title">
    <div id="settings-header">
      <span id="settings-title">Settings</span>
      <button id="btn-settings-close" title="Close">×</button>
    </div>
    <div id="settings-tabs" role="tablist">
      <button id="tab-providers" class="settings-tab" role="tab" aria-selected="true">Providers<span id="tab-providers-count" class="settings-tab-count">0</span></button>
      <button id="tab-models" class="settings-tab" role="tab" aria-selected="false">Models<span id="tab-models-count" class="settings-tab-count">0</span></button>
      <button id="tab-system-prompt" class="settings-tab" role="tab" aria-selected="false">System Prompt</button>
    </div>
    <div id="settings-body">
      <!-- ── Providers (connections) ─────────────────────────────── -->
      <div id="providers-pane" class="settings-pane" role="tabpanel">
        <ul id="providers-list"></ul>
        <button id="btn-add-provider" class="btn-add-row">+ Add provider</button>
      </div>

      <!-- ── Models ──────────────────────────────────────────────── -->
      <div id="models-pane" class="settings-pane" role="tabpanel" hidden>
        <ul id="models-list"></ul>
        <button id="btn-add-model" class="btn-add-row">+ Add model</button>
      </div>

      <!-- ── System Prompt ───────────────────────────────────────── -->
      <div id="system-prompt-pane" class="settings-pane" role="tabpanel" hidden>
        <label for="system-prompt-text">Custom instructions</label>
        <textarea id="system-prompt-text" placeholder="Standing instructions appended to the system prompt on every request — style, conventions, constraints."></textarea>
        <div class="form-hint">Appended under a “User instructions” heading. Leave empty to use the base prompt only.</div>
        <div class="system-prompt-actions">
          <button id="btn-system-prompt-save">Save</button>
        </div>
      </div>
    </div>
    <details id="settings-advanced">
      <summary>Advanced</summary>
      <div class="settings-advanced-row">
        <label for="global-max-tool-rounds">Max Tool Rounds</label>
        <input id="global-max-tool-rounds" type="number" min="1" placeholder="40" value="40" />
      </div>
      <div class="settings-advanced-actions">
        <button id="btn-settings-save">Save</button>
      </div>
    </details>
    <div id="settings-footer">
      <button id="btn-settings-cancel">Close</button>
    </div>
  </div>
</div>

<!-- ── Provider dialog ─────────────────────────────────────────── -->
<div id="provider-dialog" class="dialog-overlay" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="provider-dialog-title">
    <div class="dialog-header">
      <span id="provider-dialog-title" class="dialog-title">Add provider</span>
      <button id="btn-pf-close" class="dialog-close" title="Close">×</button>
    </div>
    <div class="dialog-body">
      <label>Provider type</label>
      <div id="pf-type-chips" class="chip-row"></div>
      <label for="pf-name">Name</label>
      <input id="pf-name" type="text" placeholder="e.g. OpenRouter" />
      <label for="pf-base-url">Base URL</label>
      <input id="pf-base-url" type="text" placeholder="https://openrouter.ai/api/v1" />
      <div id="pf-detect" class="form-hint" hidden></div>
      <label for="pf-api-key">API key</label>
      <div class="key-input">
        <input id="pf-api-key" type="password" placeholder="sk-…" />
        <button id="btn-pf-toggle-key" class="key-toggle" type="button">Show</button>
      </div>
    </div>
    <div class="dialog-footer">
      <button id="btn-pf-cancel" class="btn-secondary">Cancel</button>
      <button id="btn-pf-save">Save provider</button>
    </div>
  </div>
</div>

<!-- ── Model dialog ────────────────────────────────────────────── -->
<div id="model-dialog" class="dialog-overlay" hidden>
  <div class="dialog dialog-overflow" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
    <div class="dialog-header">
      <span id="model-dialog-title" class="dialog-title">Add model</span>
      <button id="btn-mf-close" class="dialog-close" title="Close">×</button>
    </div>
    <div class="dialog-body">
      <div id="mf-no-providers" class="dialog-empty" hidden>
        <div class="dialog-empty-title">No providers configured</div>
        <div class="form-hint">Add a provider before you can attach a model.</div>
        <button id="btn-mf-add-provider" class="btn-inline-primary">+ Add provider</button>
      </div>
      <div id="mf-fields">
        <label>Provider</label>
        <div id="mf-provider-dd" class="dd" data-dd>
          <button id="mf-provider-btn" class="dd-button" type="button">
            <span id="mf-provider-label" class="dd-label">Select a provider…</span>
            <span id="mf-provider-badge" class="provider-badge" hidden></span>
            <span class="dd-caret">▾</span>
          </button>
          <div id="mf-provider-menu" class="dd-menu" hidden></div>
        </div>
        <div id="mf-model-group" hidden>
          <label for="mf-model">Model</label>
          <div id="mf-model-wrap" class="dd" data-dd>
            <input id="mf-model" type="text" placeholder="model name" autocomplete="off" />
            <button id="mf-model-caret" class="dd-caret-btn" type="button" hidden>▾</button>
            <ul id="mf-model-suggestions" class="dd-menu" hidden></ul>
          </div>
          <div id="mf-model-hint" class="form-hint" hidden></div>
          <label for="mf-label">Display name <span class="label-opt">· optional</span></label>
          <input id="mf-label" type="text" placeholder="Shown in the model picker" />
          <label for="mf-context">Context window</label>
          <input id="mf-context" type="number" placeholder="32768" value="32768" />
          <div id="mf-or-row" hidden>
            <label for="mf-or-provider">OpenRouter provider <span class="label-opt">· optional</span></label>
            <input id="mf-or-provider" type="text" placeholder="e.g. DeepSeek — pins routing, no fallback" />
          </div>
        </div>
      </div>
    </div>
    <div class="dialog-footer">
      <button id="btn-mf-cancel" class="btn-secondary">Cancel</button>
      <button id="btn-mf-save">Save model</button>
    </div>
  </div>
</div>

<div id="app">
  <ul id="attached-files"></ul>

  <div id="output-wrapper">
    <div id="output-toolbar" aria-label="Output actions">
      <button id="btn-copy-markdown" class="icon-button" title="Copy rendered markdown" aria-label="Copy rendered markdown">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="3" y="2" width="10" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
          <line x1="6" y1="4.8" x2="6" y2="9.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          <line x1="8" y1="4.8" x2="8" y2="9.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          <line x1="5.2" y1="6.2" x2="8.8" y2="6.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          <line x1="5.2" y1="7.8" x2="8.8" y2="7.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          <line x1="5" y1="11" x2="11" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.9" />
        </svg>
      </button>
      <button id="btn-copy-raw" class="icon-button" title="Copy raw text" aria-label="Copy raw text">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="3" y="2" width="10" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
          <polyline points="6.6,5.8 5.2,8 6.6,10.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
          <polyline points="9.4,5.8 10.8,8 9.4,10.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
          <line x1="7.7" y1="10.5" x2="8.6" y2="5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.9" />
        </svg>
      </button>
    </div>
    <div id="output" aria-live="polite"></div>
    <div id="typing-indicator" hidden>
      <span></span><span></span><span></span>
    </div>
  </div>

  <div id="status-bar" aria-live="polite"></div>

  <div id="model-selector-row">
    <span id="provider-status-dot" class="status-dot status-unknown" title="Unknown"></span>
    <select id="model-select"></select>
  </div>

  <div id="input-row">
    <div id="prompt-wrap">
      <textarea id="prompt-input" rows="4" placeholder="Ask the agent…"></textarea>
      <div id="prompt-overlay-left" aria-hidden="false">
        <button id="btn-attach" class="icon-button" title="Attach files" aria-label="Attach files">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="9" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
            <rect x="5" y="2" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.9" />
          </svg>
        </button>
        <button id="btn-attach-editor" class="icon-button" title="Attach active editor or selection" aria-label="Attach active editor or selection">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="3" y="2" width="10" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
            <line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            <line x1="5" y1="7.5" x2="11" y2="7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.9" />
            <line x1="5" y1="10" x2="9" y2="10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.85" />
          </svg>
        </button>
      </div>
      <div id="prompt-overlay-right" aria-hidden="false">
        <button id="btn-send" class="icon-button" title="Send" aria-label="Send">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M2.2 2.7 14 8 2.2 13.3 3.3 9.2 9.2 8 3.3 6.8 2.2 2.7Z" fill="currentColor" />
          </svg>
        </button>
        <button id="btn-stop" class="icon-button" title="Stop" aria-label="Stop" hidden>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
    <div id="thinking-row">
      <label><input type="checkbox" id="chk-thinking" checked> Thinking mode</label>
      <label id="lbl-agents-md" hidden><input type="checkbox" id="chk-agents-md"> Include AGENTS.md</label>
    </div>
    <div id="composer-actions"></div>
  </div>
</div>
`;
