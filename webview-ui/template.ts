/**
 * HTML template for the webview root element.
 */

export const TEMPLATE_HTML: string = `
<div id="settings-overlay" hidden>
  <div id="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div id="settings-header">
      <span id="settings-title">Settings</span>
      <button id="btn-settings-close" title="Close">×</button>
    </div>
    <div id="settings-body">
      <div id="providers-section">
        <div id="providers-header">Providers</div>
        <ul id="providers-list"></ul>
        <button id="btn-add-provider">+ Add Provider</button>
      </div>
      <div id="provider-form" hidden>
        <div id="provider-form-title">Add Provider</div>
        <label for="pf-name">Name</label>
        <input id="pf-name" type="text" placeholder="e.g. qwen3-coder:a3b" />
        <label for="pf-base-url">Base URL</label>
        <input id="pf-base-url" type="text" placeholder="http://localhost:8080/v1" />
        <label for="pf-model">Model</label>
        <input id="pf-model" type="text" placeholder="model name" />
        <label for="pf-api-key">API Key (optional)</label>
        <input id="pf-api-key" type="password" placeholder="(none required for local)" />
        <div id="pf-checkbox-row">
          <label><input type="checkbox" id="pf-tool-use" checked /> Tool Use</label>
        </div>
        <label for="pf-context">Context Window</label>
        <input id="pf-context" type="number" placeholder="32768" value="32768" />
        <div id="pf-buttons">
          <button id="btn-pf-save">Save Provider</button>
          <button id="btn-pf-cancel">Cancel</button>
        </div>
      </div>
    </div>
    <div id="settings-global">
      <label for="global-max-tool-rounds">Max Tool Rounds</label>
      <input id="global-max-tool-rounds" type="number" min="1" placeholder="40" value="40" />
    </div>
    <div id="settings-footer">
      <button id="btn-settings-save">Save</button>
      <button id="btn-settings-cancel">Close</button>
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
      <label><input type="checkbox" id="chk-thinking"> Thinking mode</label>
      <label id="lbl-agents-md" hidden><input type="checkbox" id="chk-agents-md"> Include AGENTS.md</label>
    </div>
    <div id="composer-actions"></div>
  </div>
</div>
`;
