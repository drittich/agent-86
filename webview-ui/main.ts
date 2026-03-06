// Webview-side entry point — full UI layout (Phase 0)

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const acquireVsCodeApi: () => any;
const vscode = acquireVsCodeApi();

// ── DOM bootstrap ────────────────────────────────────────────────────────────

const root = document.getElementById('root')!;
root.innerHTML = `
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
    <div id="settings-footer">
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
    <select id="model-select"></select>
    <span id="provider-status-dot" class="status-dot status-unknown" title="Unknown"></span>
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

// Inline styles — keeps the webview self-contained (no external CSS file needed)
const style = document.createElement('style');
style.textContent = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  [hidden] { display: none !important; }

  html, body {
    height: 100%;
    overflow: hidden;
  }

  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, Canvas);
    display: flex;
    flex-direction: column;
  }

  #root {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  #app {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 6px;
    gap: 6px;
  }

  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 2px;
    font-size: inherit;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.45; cursor: default; }

  .icon-button {
    background: transparent;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    border: 1px solid transparent;
    padding: 3px 6px;
    min-width: 28px;
    min-height: 28px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s ease, transform 0.1s ease, color 0.15s ease;
  }
  .icon-button svg { width: 16px; height: 16px; display: block; }
  .icon-button:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18));
    transform: translateY(-1px);
  }
  .icon-button:active:not(:disabled) {
    transform: scale(0.85);
    transition-duration: 0.05s;
  }

  #attached-files {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-height: 0;
  }

  #attached-files li {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  #attached-files li button {
    background: none;
    color: inherit;
    padding: 0 2px;
    font-size: 11px;
    line-height: 1;
    opacity: 0.7;
  }
  #attached-files li button:hover { opacity: 1; }

  #output-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }

  #output-toolbar {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
    flex-shrink: 0;
    z-index: 2;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }

  #output-wrapper:hover #output-toolbar,
  #output-wrapper:focus-within #output-toolbar {
    opacity: 1;
    pointer-events: auto;
  }

  #output-toolbar button {
    font-size: 11px;
  }

  #output {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--vscode-widget-border, ButtonBorder);
    padding: 8px;
    word-break: break-word;
    line-height: 1.5;
    background: var(--vscode-editor-background, Canvas);
    color: var(--vscode-editor-foreground, CanvasText);
    border-radius: 2px;
    min-height: 60px;
  }

  #typing-indicator {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 6px 8px;
  }
  #typing-indicator[hidden] { display: none; }
  #typing-indicator span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vscode-foreground);
    opacity: 0.15;
    animation: typing-wave 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  #typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
  #typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing-wave {
    0%, 60%, 100% { opacity: 0.15; transform: translateY(0); }
    30% { opacity: 0.9; transform: translateY(-4px); }
  }

  /* Markdown prose styles */
  #output p { margin: 0 0 0.6em; }
  #output p:last-child { margin-bottom: 0; }
  #output h1, #output h2, #output h3,
  #output h4, #output h5, #output h6 {
    margin: 0.8em 0 0.3em;
    line-height: 1.3;
  }
  #output h1 { font-size: 1.4em; }
  #output h2 { font-size: 1.2em; }
  #output h3 { font-size: 1.05em; }
  #output ul, #output ol {
    margin: 0 0 0.6em 1.4em;
    padding: 0;
  }
  #output li { margin-bottom: 0.2em; }
  #output code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }
  #output pre {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 3px;
    padding: 8px;
    overflow-x: auto;
    margin: 0 0 0.6em;
  }
  #output pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 0.88em;
    white-space: pre;
  }
  #output blockquote {
    border-left: 3px solid var(--vscode-widget-border, #555);
    margin: 0 0 0.6em 0;
    padding: 0 0 0 10px;
    color: var(--vscode-descriptionForeground);
  }
  #output hr {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, #444);
    margin: 0.8em 0;
  }
  #output a {
    color: var(--vscode-textLink-foreground, #4e9fde);
  }

  /* Tool call accordions (edits, search_file, request_chunks, etc.) */
  #output details.edit-accordion {
    margin: 0 0 0.6em;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  }
  #output details.edit-accordion summary {
    cursor: pointer;
    padding: 4px 8px;
    font-size: 0.9em;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    user-select: none;
    list-style: none;
  }
  #output details.edit-accordion summary::before {
    content: '▶ ';
    font-size: 0.75em;
  }
  #output details.edit-accordion[open] summary::before {
    content: '▼ ';
  }
  #output details.edit-accordion pre {
    margin: 0;
    border: none;
    border-top: 1px solid var(--vscode-panel-border, #444);
    border-radius: 0 0 3px 3px;
  }
  #output table {
    border-collapse: collapse;
    margin: 0 0 0.6em;
    font-size: 0.9em;
  }
  #output th, #output td {
    border: 1px solid var(--vscode-panel-border, #444);
    padding: 3px 8px;
  }
  #output th { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); }

  #status-bar {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    min-height: 16px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .status-badge.completed {
    background: var(--vscode-testing-passedBackground, #1e3a1e);
    color: var(--vscode-testing-passedForeground, #4ec94e);
  }

  .status-badge.cancelled {
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    color: var(--vscode-inputValidation-warningForeground, #cca700);
  }

  /* Dimmed output content when cancelled */
  #output.cancelled {
    opacity: 0.7;
    border-color: var(--vscode-inputValidation-warningBorder, #b89500);
  }

  #approvals-container {
    flex-shrink: 0;
  }

  #input-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }

  #prompt-input {
    width: 100%;
    resize: none;
    overflow-y: hidden;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 6px;
    padding-bottom: 28px;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
    transition: border-color 0.15s ease;
  }
  #prompt-input:focus { outline: 1px solid var(--vscode-focusBorder); }

  #prompt-wrap {
    position: relative;
    width: 100%;
  }

  #prompt-overlay-left {
    position: absolute;
    left: 6px;
    bottom: 6px;
    display: flex;
    gap: 4px;
    align-items: center;
    pointer-events: auto;
  }

  #prompt-overlay-right {
    position: absolute;
    right: 6px;
    bottom: 6px;
    display: flex;
    gap: 4px;
    align-items: center;
    pointer-events: auto;
  }

  #input-buttons {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }

  #composer-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  #thinking-row {
    padding: 4px 0 2px 0;
    font-size: 0.85em;
    color: var(--vscode-foreground);
    display: flex;
    gap: 12px;
    align-items: center;
  }
  #thinking-row input { margin-right: 4px; }

  /* Settings overlay */
  #settings-overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--vscode-sideBar-background, #000) 50%, transparent);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #settings-overlay[hidden] { display: none; }

  #settings-panel {
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 4px;
    width: 320px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 40px);
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow: hidden;
  }

  #settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
  }
  #settings-title {
    font-weight: 600;
    font-size: 13px;
  }
  #btn-settings-close {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0.7;
    font-size: 16px;
    padding: 0 4px;
    cursor: pointer;
    line-height: 1;
  }
  #btn-settings-close:hover { opacity: 1; background: none; }

  #settings-body {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
  }
  #settings-body label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  #settings-body input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 5px 7px;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
  }
  #settings-body input:focus { outline: 1px solid var(--vscode-focusBorder); }

  #settings-footer {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid var(--vscode-widget-border, #454545);
  }
  #btn-settings-cancel {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  #btn-settings-cancel:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  #settings-divider {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, #454545);
    margin: 8px 0;
  }

  #providers-header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground, #888);
    margin-bottom: 6px;
  }

  #providers-list {
    list-style: none;
    margin-bottom: 6px;
  }

  #providers-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px;
    border-radius: 3px;
    font-size: 12px;
    transition: background 0.1s ease;
  }

  #providers-list li:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }

  .provider-item-name { flex: 1; }

  .provider-item-actions { display: flex; gap: 4px; }

  .provider-item-actions button {
    padding: 1px 6px;
    font-size: 11px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .provider-item-actions button:hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }

  #btn-add-provider {
    font-size: 12px;
    background: none;
    border: 1px dashed var(--vscode-widget-border, #454545);
    color: var(--vscode-foreground, #ccc);
    width: 100%;
    padding: 4px;
    cursor: pointer;
    border-radius: 3px;
    margin-bottom: 4px;
  }

  #btn-add-provider:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }

  #provider-form {
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 4px;
    padding: 8px;
    margin-top: 6px;
  }

  #provider-form-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 6px;
  }

  #pf-checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
    font-size: 12px;
  }

  #pf-buttons {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    justify-content: flex-end;
  }

  #btn-pf-cancel {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }

  /* Model selector row */
  #model-selector-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-top: 1px solid var(--vscode-widget-border, #454545);
    font-size: 12px;
  }

  #model-select {
    flex: 1;
    background: var(--vscode-dropdown-background, #3c3c3c);
    color: var(--vscode-dropdown-foreground, #ccc);
    border: 1px solid var(--vscode-dropdown-border, #454545);
    border-radius: 2px;
    padding: 2px 4px;
    font-size: 12px;
    font-family: inherit;
    transition: border-color 0.15s ease;
  }
  #model-select:hover {
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.status-online { background: var(--vscode-testing-passedForeground, #4ec94e); }
  .status-dot.status-offline { background: var(--vscode-testing-errorForeground, #e05555); }
  .status-dot.status-checking { background: var(--vscode-inputValidation-warningBorder, #d4a017); animation: pulse 1s infinite; }
  .status-dot.status-unknown { background: var(--vscode-descriptionForeground, #888); }

  .status-dot.hidden {
    display: none;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* Focus-visible rings for keyboard navigation */
  button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
  }
  .icon-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
  }

  /* ── Delight ─────────────────────────────────────────────────── */

  /* Copy feedback — briefly turns green */
  .icon-button.flash-success {
    color: var(--vscode-testing-passedForeground, #4ec94e) !important;
    transform: scale(1.2) !important;
  }

  /* Attached file chips — slide + fade in */
  @keyframes chip-enter {
    from { opacity: 0; transform: translateY(-5px) scale(0.93); }
    to   { opacity: 1; transform: none; }
  }
  #attached-files li {
    animation: chip-enter 0.18s ease-out both;
  }

  /* Settings panel — fade + slide down on open */
  @keyframes panel-enter {
    from { opacity: 0; transform: translateY(-8px) scale(0.97); }
    to   { opacity: 1; transform: none; }
  }
  #settings-overlay:not([hidden]) #settings-panel {
    animation: panel-enter 0.2s cubic-bezier(0.25, 1, 0.5, 1) both;
  }

  /* Approval/warning card entrance */
  @keyframes card-enter {
    from { opacity: 0; transform: translateY(-5px); }
    to   { opacity: 1; transform: none; }
  }

  /* Respect user's motion preference */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
`;
document.head.appendChild(style);

// ── Element refs ─────────────────────────────────────────────────────────────

const outputEl         = document.getElementById('output')!;
const typingIndicator  = document.getElementById('typing-indicator')!;
const promptInput  = document.getElementById('prompt-input') as HTMLTextAreaElement;
const btnSend      = document.getElementById('btn-send') as HTMLButtonElement;
const btnStop      = document.getElementById('btn-stop') as HTMLButtonElement;
const btnAttach    = document.getElementById('btn-attach') as HTMLButtonElement;
  const btnAttachEditor = document.getElementById('btn-attach-editor') as HTMLButtonElement;
const settingsOverlay   = document.getElementById('settings-overlay')!;
const btnSettingsClose  = document.getElementById('btn-settings-close') as HTMLButtonElement;
const btnSettingsCancel = document.getElementById('btn-settings-cancel') as HTMLButtonElement;
const btnCopyMd    = document.getElementById('btn-copy-markdown') as HTMLButtonElement;
const btnCopyRaw   = document.getElementById('btn-copy-raw') as HTMLButtonElement;
const filesList    = document.getElementById('attached-files') as HTMLUListElement;
const statusBar    = document.getElementById('status-bar')!;
const chkThinking  = document.getElementById('chk-thinking') as HTMLInputElement;
const chkAgentsMd  = document.getElementById('chk-agents-md') as HTMLInputElement;
const lblAgentsMd  = document.getElementById('lbl-agents-md') as HTMLElement;
const modelSelect        = document.getElementById('model-select') as HTMLSelectElement;
const providerStatusDot  = document.getElementById('provider-status-dot')!;
const modelSelectorRowEl  = document.getElementById('model-selector-row')!;
const providersList      = document.getElementById('providers-list') as HTMLUListElement;
const btnAddProvider     = document.getElementById('btn-add-provider') as HTMLButtonElement;
const providerForm       = document.getElementById('provider-form')!;
const providerFormTitle  = document.getElementById('provider-form-title')!;
const pfName             = document.getElementById('pf-name') as HTMLInputElement;
const pfBaseUrl          = document.getElementById('pf-base-url') as HTMLInputElement;
const pfModel            = document.getElementById('pf-model') as HTMLInputElement;
const pfApiKey           = document.getElementById('pf-api-key') as HTMLInputElement;
const pfToolUse          = document.getElementById('pf-tool-use') as HTMLInputElement;
const pfContext          = document.getElementById('pf-context') as HTMLInputElement;
const btnPfSave          = document.getElementById('btn-pf-save') as HTMLButtonElement;
const btnPfCancel        = document.getElementById('btn-pf-cancel') as HTMLButtonElement;

// ── State ────────────────────────────────────────────────────────────────────

interface AttachedFile { uri: string; relativePath: string; }

interface ProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  toolUse: boolean;
  context: number;
}

let attachedFiles: AttachedFile[] = [];
let isGenerating = false;

// Provider state
let providers: ProviderConfig[] = [];
let activeProviderIndex = 0;
let editingProviderIndex = -1; // -1 = adding new

// Ensure initial composer button state is correct
setGenerating(false);

function renderProvidersList(): void {
  providersList.innerHTML = '';
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="provider-item-name">${escapeHtml(p.name)}</span>
      <span class="provider-item-actions">
        <button data-idx="${i}" class="btn-edit-provider" aria-label="Edit ${escapeHtml(p.name)}">Edit</button>
        <button data-idx="${i}" class="btn-delete-provider" aria-label="Delete ${escapeHtml(p.name)}">×</button>
      </span>
    `;
    providersList.appendChild(li);
  }

  providersList.querySelectorAll('.btn-edit-provider').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx ?? '0', 10);
      openProviderForm(idx);
    });
  });

  providersList.querySelectorAll('.btn-delete-provider').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx ?? '0', 10);
      providers.splice(idx, 1);
      if (activeProviderIndex >= providers.length) {
        activeProviderIndex = Math.max(0, providers.length - 1);
      }
      vscode.postMessage({ type: 'saveSettings', providers });
      renderProvidersList();
      renderModelDropdown();
    });
  });
}

function openProviderForm(idx: number): void {
  editingProviderIndex = idx;
  if (idx === -1) {
    providerFormTitle.textContent = 'Add Provider';
    pfName.value = '';
    pfBaseUrl.value = '';
    pfModel.value = '';
    pfApiKey.value = '';
    pfToolUse.checked = true;
    pfContext.value = '32768';
  } else {
    const p = providers[idx];
    providerFormTitle.textContent = 'Edit Provider';
    pfName.value = p.name;
    pfBaseUrl.value = p.baseUrl;
    pfModel.value = p.model;
    pfApiKey.value = p.apiKey ?? '';
    pfToolUse.checked = p.toolUse;
    pfContext.value = String(p.context);
  }
  providerForm.hidden = false;
  pfName.focus();
}

function closeProviderForm(): void {
  providerForm.hidden = true;
  editingProviderIndex = -1;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderModelDropdown(): void {
  const prev = modelSelect.value;
  modelSelect.innerHTML = '';
  for (let i = 0; i < providers.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = providers[i].name;
    modelSelect.appendChild(opt);
  }
  // Restore selection or use activeProviderIndex
  if (prev && modelSelect.querySelector(`option[value="${prev}"]`)) {
    modelSelect.value = prev;
  } else {
    modelSelect.value = String(activeProviderIndex);
  }
  updateProviderStatusVisibility();
}

function setProviderStatus(status: 'online' | 'offline' | 'checking' | 'unknown'): void {
  providerStatusDot.className = `status-dot status-${status}`;
  const labels: Record<string, string> = { online: 'Online', offline: 'Offline', checking: 'Checking...', unknown: 'Unknown' };
  providerStatusDot.title = labels[status] ?? 'Unknown';
}

function updateProviderStatusVisibility(): void {
  const hasValidSelection = providers.length > 0 && activeProviderIndex >= 0 && activeProviderIndex < providers.length;
  if (hasValidSelection) {
    providerStatusDot.classList.remove('hidden');
  } else {
    providerStatusDot.classList.add('hidden');
  }
}
/** Tracks whether the current generation was explicitly cancelled by the user. */
let wasExplicitlyCancelled = false;
/** Tracks whether there is an active editor in VS Code. */
let hasActiveEditor = false;

/** Tracks edit outcomes by URI so accordions can show "Edited" vs "Editing". */
const editOutcomes = new Map<string, 'applied' | 'cancelled'>();

// Markdown rendering — buffer incoming deltas and flush on a timer
let markdownBuffer = '';
let renderTimer: ReturnType<typeof setTimeout> | null = null;
const RENDER_INTERVAL_MS = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(text: string): void {
  statusBar.textContent = text;
}

function setStatusBadge(badgeClass: string, badgeText: string, detail?: string): void {
  statusBar.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `status-badge ${badgeClass}`;
  badge.textContent = badgeText;
  statusBar.appendChild(badge);
  if (detail) {
    statusBar.appendChild(document.createTextNode(' ' + detail));
  }
}

// Known tool keys and their display labels
const TOOL_KEYS: Record<string, string> = {
  edits: 'edits',
  search_file: 'search_file',
  request_chunks: 'request_chunks',
  request_files: 'request_files',
  request_search: 'request_search',
};

/**
 * Detect which tool key (if any) a parsed JSON object represents.
 * Returns the key name or null.
 */
function detectToolKey(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) { return null; }
  for (const key of Object.keys(TOOL_KEYS)) {
    if (Array.isArray((parsed as Record<string, unknown>)[key])) {
      return key;
    }
  }
  return null;
}

/**
 * Replace JSON tool blocks (bare or ```json fenced) with collapsed <details>
 * accordions. Handles edits, search_file, request_chunks, request_files, etc.
 */
function replaceEditJsonWithAccordions(md: string): string {
  const result: string[] = [];
  let lastIndex = 0;

  // Regex: matches ```json\n{...}\n``` fenced blocks
  const fencedRe = /```json\s*(\{[\s\S]*?\})\s*```/g;
  let fencedMatch: RegExpExecArray | null;
  const fencedMatches: Array<{ index: number; end: number; json: string; key: string }> = [];
  while ((fencedMatch = fencedRe.exec(md)) !== null) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      const key = detectToolKey(parsed);
      if (key) {
        fencedMatches.push({ index: fencedMatch.index, end: fencedMatch.index + fencedMatch[0].length, json: fencedMatch[1], key });
      }
    } catch { /* not valid JSON */ }
  }

  const fencedRanges = fencedMatches.map(m => [m.index, m.end]);
  function isInFencedRange(idx: number): boolean {
    return fencedRanges.some(([s, e]) => idx >= s && idx < e);
  }

  // Extract bare JSON candidates (top-level { }) not inside fences
  const bareMatches: Array<{ index: number; end: number; json: string; key: string }> = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < md.length; i++) {
    const ch = md[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) { start = i; }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        if (!isInFencedRange(start)) {
          const candidate = md.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            const key = detectToolKey(parsed);
            if (key) {
              bareMatches.push({ index: start, end: i + 1, json: candidate, key });
            }
          } catch { /* not valid JSON */ }
        }
        start = -1;
      }
    }
  }

  // Merge and sort all matches by index
  const allMatches = [...fencedMatches, ...bareMatches].sort((a, b) => a.index - b.index);

  for (const match of allMatches) {
    result.push(md.slice(lastIndex, match.index));
    result.push(buildToolAccordionHtml(match.key, match.json));
    lastIndex = match.end;
  }
  result.push(md.slice(lastIndex));
  return result.join('');
}

function buildToolAccordionHtml(key: string, json: string): string {
  let title: string;

  if (key === 'edits') {
    let files: string[] = [];
    try {
      const parsed = JSON.parse(json);
      if (parsed && Array.isArray(parsed.edits)) {
        const uris: string[] = parsed.edits.map((e: { uri?: string }) => e.uri).filter(Boolean);
        files = [...new Set(uris)];
      }
    } catch { /* ignore */ }

    if (files.length === 0) {
      title = 'edits';
    } else {
      const outcome = editOutcomes.get(files[0]);
      const verb = outcome === 'applied' ? 'Edited' : outcome === 'cancelled' ? 'Edit cancelled:' : 'Editing';
      title = `${verb} ${files.join(', ')}`;
    }
  } else {
    title = key;
  }

  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `\n<details class="edit-accordion"><summary>${title}</summary><pre><code>${escaped}</code></pre></details>\n`;
}

const EMPTY_STATE_HTML = DOMPurify.sanitize(
  '<p style="color:var(--vscode-descriptionForeground);margin:0;">Configure a provider in settings, then type a message to get started.</p>'
);

function flushMarkdown(): void {
  const wasAtBottom =
    outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 8;
  if (!markdownBuffer) {
    outputEl.innerHTML = EMPTY_STATE_HTML;
    return;
  }
  const processedMd = replaceEditJsonWithAccordions(markdownBuffer);
  outputEl.innerHTML = DOMPurify.sanitize(marked.parse(processedMd) as string);
  if (wasAtBottom) {
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}

function appendOutput(text: string): void {
  markdownBuffer += text;
  if (renderTimer === null) {
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushMarkdown();
    }, RENDER_INTERVAL_MS);
  }
}

function clearOutput(): void {
  markdownBuffer = '';
  editOutcomes.clear();
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  outputEl.innerHTML = EMPTY_STATE_HTML;
}

function setGenerating(active: boolean): void {
  isGenerating = active;
  btnSend.hidden = active;
  btnStop.hidden = !active;
  btnSend.disabled = active;
  btnStop.disabled = !active;
  promptInput.disabled = active;
  // Reset cancelled state when starting new generation
  if (active) {
    wasExplicitlyCancelled = false;
    outputEl.classList.remove('cancelled');
    typingIndicator.hidden = false;
  } else {
    typingIndicator.hidden = true;
  }
}

function setEditorState(hasEditor: boolean): void {
  hasActiveEditor = hasEditor;
  btnAttachEditor.disabled = !hasEditor;
}

function renderAttachedFiles(): void {
  filesList.innerHTML = '';

  // AGENTS.md pill — shown when the checkbox is checked
  if (chkAgentsMd.checked) {
    const li = document.createElement('li');
    li.id = 'pill-agents-md';
    const label = document.createTextNode('AGENTS.md');
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      chkAgentsMd.checked = false;
      renderAttachedFiles();
    });
    li.appendChild(label);
    li.appendChild(removeBtn);
    filesList.appendChild(li);
  }

  for (const f of attachedFiles) {
    const li = document.createElement('li');
    const label = document.createTextNode(f.relativePath);
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      attachedFiles = attachedFiles.filter(a => a.uri !== f.uri);
      renderAttachedFiles();
    });
    li.appendChild(label);
    li.appendChild(removeBtn);
    filesList.appendChild(li);
  }
}

// ── Event handlers ───────────────────────────────────────────────────────────

btnSend.addEventListener('click', sendPrompt);

// Auto-resize textarea as the user types
function autoResizeTextarea(): void {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 220) + 'px';
}
promptInput.addEventListener('input', autoResizeTextarea);

promptInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    sendPrompt();
  }
});

btnStop.addEventListener('click', () => {
  vscode.postMessage({ type: 'stop' });
  // UI update is deferred until the extension replies with done(cancelled:true)
});

btnAttach.addEventListener('click', () => {
  vscode.postMessage({ type: 'attachFiles' });
});

btnAttachEditor.addEventListener('click', () => {
  vscode.postMessage({ type: 'attachActiveEditor' });
});

/** Last focused element before settings opened — restored on close. */
let _settingsReturnFocus: HTMLElement | null = null;

function getSettingsFocusable(): HTMLElement[] {
  const panel = document.getElementById('settings-panel')!;
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.closest('[hidden]'));
}

function openSettingsPanel(): void {
  _settingsReturnFocus = document.activeElement as HTMLElement | null;
  settingsOverlay.hidden = false;
  requestAnimationFrame(() => {
    const first = getSettingsFocusable()[0];
    if (first) first.focus();
  });
}

function closeSettings(): void {
  settingsOverlay.hidden = true;
  _settingsReturnFocus?.focus();
  _settingsReturnFocus = null;
}

btnSettingsClose.addEventListener('click', closeSettings);
btnSettingsCancel.addEventListener('click', closeSettings);

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) { closeSettings(); }
});

settingsOverlay.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSettings();
    return;
  }
  if (e.key === 'Tab') {
    const focusable = getSettingsFocusable();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
});


// Sync checkbox state changes to the extension immediately
chkAgentsMd.addEventListener('change', () => {
  vscode.postMessage({ type: 'checkboxChange', includeAgentsMd: chkAgentsMd.checked });
});

// Provider form handlers
btnAddProvider.addEventListener('click', () => openProviderForm(-1));

btnPfCancel.addEventListener('click', closeProviderForm);

btnPfSave.addEventListener('click', () => {
  const p: ProviderConfig = {
    name: pfName.value.trim() || pfModel.value.trim() || 'unnamed',
    baseUrl: pfBaseUrl.value.trim(),
    model: pfModel.value.trim(),
    apiKey: pfApiKey.value || undefined,
    toolUse: pfToolUse.checked,
    context: parseInt(pfContext.value, 10) || 32768,
  };
  if (editingProviderIndex === -1) {
    providers.push(p);
  } else {
    providers[editingProviderIndex] = p;
  }
  vscode.postMessage({ type: 'saveSettings', providers });
  renderProvidersList();
  renderModelDropdown();
  closeProviderForm();
});

// Model dropdown selection
modelSelect.addEventListener('change', () => {
  const idx = parseInt(modelSelect.value, 10);
  if (!isNaN(idx)) {
    activeProviderIndex = idx;
    setProviderStatus('checking');
    vscode.postMessage({ type: 'selectModel', providerIndex: idx });
  }
});

// ── Copy actions ──────────────────────────────────────────────────────────────

/**
 * Copy the rendered markdown (HTML) to clipboard as plain text.
 * This gives the user the markdown source that was rendered.
 */
btnCopyMd.addEventListener('click', async () => {
  if (!markdownBuffer) {
    setStatus('Nothing to copy.');
    return;
  }
  try {
    await navigator.clipboard.writeText(markdownBuffer);
    setStatus('Markdown copied to clipboard.');
    btnCopyMd.classList.add('flash-success');
    setTimeout(() => btnCopyMd.classList.remove('flash-success'), 500);
  } catch {
    setStatus('Failed to copy markdown.');
  }
});

/**
 * Copy the raw text content from the output element.
 * This strips all formatting and gives plain text.
 */
btnCopyRaw.addEventListener('click', async () => {
  const rawText = outputEl.textContent ?? '';
  if (!rawText.trim()) {
    setStatus('Nothing to copy.');
    return;
  }
  try {
    await navigator.clipboard.writeText(rawText);
    setStatus('Raw text copied to clipboard.');
    btnCopyRaw.classList.add('flash-success');
    setTimeout(() => btnCopyRaw.classList.remove('flash-success'), 500);
  } catch {
    setStatus('Failed to copy raw text.');
  }
});

function sendPrompt(): void {
  const prompt = promptInput.value.trim();
  if (!prompt || isGenerating) { return; }
  clearOutput();
  setStatus('');
  setGenerating(true);
  appendOutput('**You:** ' + prompt + '\n\n---\n\n');
  vscode.postMessage({ type: 'send', prompt, thinkingMode: chkThinking.checked, includeAgentsMd: chkAgentsMd.checked });
  promptInput.value = '';
  promptInput.style.height = '';
}

// ── Warning notice ────────────────────────────────────────────────────────────

const warningStyle = document.createElement('style');
warningStyle.textContent = `
  .warning-notice {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    color: var(--vscode-inputValidation-warningForeground, #cca700);
    border-radius: 3px;
    padding: 6px 10px;
    margin: 6px 0;
    font-size: 12px;
    animation: card-enter 0.18s ease-out both;
  }
  .warning-notice .warning-icon {
    flex-shrink: 0;
    font-style: normal;
  }
  .warning-notice .warning-text {
    flex: 1;
    word-break: break-word;
  }
  .warning-notice .warning-dismiss {
    flex-shrink: 0;
    background: none;
    border: none;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    padding: 0 2px;
    font-size: 14px;
    line-height: 1;
  }
  .warning-notice .warning-dismiss:hover { opacity: 1; }
`;
document.head.appendChild(warningStyle);

function showWarningNotice(text: string): void {
  const notice = document.createElement('div');
  notice.className = 'warning-notice';

  const icon = document.createElement('span');
  icon.className = 'warning-icon';
  icon.textContent = '⚠';

  const textEl = document.createElement('span');
  textEl.className = 'warning-text';
  textEl.textContent = text;

  const dismiss = document.createElement('button');
  dismiss.className = 'warning-dismiss';
  dismiss.title = 'Dismiss';
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => notice.remove());

  notice.appendChild(icon);
  notice.appendChild(textEl);
  notice.appendChild(dismiss);
  approvalsContainer.appendChild(notice);
}

// ── Approval card ─────────────────────────────────────────────────────────────

const approvalStyle = `
  .approval-card {
    border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    border-radius: 3px;
    padding: 8px 10px;
    margin: 6px 0;
    font-size: 12px;
    animation: card-enter 0.18s ease-out both;
  }
  .approval-card .approval-title {
    font-weight: bold;
    margin-bottom: 4px;
    color: var(--vscode-foreground);
  }
  .approval-card .approval-reason {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
  }
  .approval-card .approval-preview {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 2px;
    padding: 4px 6px;
    margin-bottom: 6px;
    word-break: break-all;
    white-space: pre-wrap;
  }
  .approval-card .approval-preview .preview-label {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 2px;
  }
  .approval-card .approval-preview .preview-arrow {
    color: var(--vscode-descriptionForeground);
    margin: 2px 0;
  }
  .approval-card .approval-buttons {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .approval-card .btn-approve {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .approval-card .btn-deny {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
  .approval-card .btn-approve-always {
    background: transparent;
    color: var(--vscode-textLink-foreground, #4e9fde);
    border: none;
    font-size: 11px;
    padding: 0 4px;
    cursor: pointer;
    text-decoration: underline;
    margin-left: auto;
  }
  .approval-card .btn-approve-always:hover {
    color: var(--vscode-textLink-activeForeground, #6bb3f0);
  }
`;
const approvalStyleEl = document.createElement('style');
approvalStyleEl.textContent = approvalStyle;
document.head.appendChild(approvalStyleEl);

// Container for approval cards — inserted before the input row
const appEl = document.getElementById('app')!;
const inputRowEl = document.getElementById('input-row')!;
const approvalsContainer = document.createElement('div');
approvalsContainer.id = 'approvals-container';
// Keep approvals above the model selector, which lives at the bottom near the composer.
appEl.insertBefore(approvalsContainer, modelSelectorRowEl ?? inputRowEl);

// Actions auto-approved for this session (populated by "Approve & Don't ask again")
const sessionAutoApproved = new Set<string>();

type ApprovalPayload = {
  path?: string;
  command?: string;
  from?: string;
  to?: string;
};

// Actions that are non-destructive enough to offer "Don't ask again"
const NON_DESTRUCTIVE_ACTIONS = new Set(['moveFile', 'applyEdit']);

function buildPreviewEl(action: string, payload: ApprovalPayload | undefined): HTMLElement {
  const preview = document.createElement('div');
  preview.className = 'approval-preview';

  if (action === 'runCommand') {
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = 'Command';
    const cmd = document.createElement('div');
    cmd.textContent = payload?.command ?? '';
    preview.appendChild(label);
    preview.appendChild(cmd);
  } else if (action === 'moveFile') {
    const fromLabel = document.createElement('div');
    fromLabel.className = 'preview-label';
    fromLabel.textContent = 'From';
    const fromVal = document.createElement('div');
    fromVal.textContent = payload?.from ?? payload?.path ?? '';
    const arrow = document.createElement('div');
    arrow.className = 'preview-arrow';
    arrow.textContent = '↓';
    const toLabel = document.createElement('div');
    toLabel.className = 'preview-label';
    toLabel.textContent = 'To';
    const toVal = document.createElement('div');
    toVal.textContent = payload?.to ?? '';
    preview.appendChild(fromLabel);
    preview.appendChild(fromVal);
    preview.appendChild(arrow);
    preview.appendChild(toLabel);
    preview.appendChild(toVal);
  } else if (action === 'deleteFile') {
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = 'File (will be moved to trash)';
    const val = document.createElement('div');
    val.textContent = payload?.path ?? '';
    preview.appendChild(label);
    preview.appendChild(val);
  } else {
    // applyEdit or unknown
    const label = document.createElement('div');
    label.className = 'preview-label';
    label.textContent = 'File';
    const val = document.createElement('div');
    val.textContent = payload?.path ?? action;
    preview.appendChild(label);
    preview.appendChild(val);
  }

  return preview;
}

function getActionTitle(action: string): string {
  switch (action) {
    case 'runCommand': return 'Run terminal command?';
    case 'moveFile':   return 'Move file?';
    case 'deleteFile': return 'Delete file?';
    case 'applyEdit':  return 'Apply edit?';
    default:           return `Approve: ${action}?`;
  }
}

function getApproveLabel(action: string): string {
  switch (action) {
    case 'runCommand': return 'Run';
    case 'deleteFile': return 'Delete';
    case 'applyEdit':  return 'Apply';
    default:           return 'Approve';
  }
}

function showApprovalCard(
  approvalId: string,
  action: string,
  payload: ApprovalPayload | undefined,
  reason: string
): void {
  // If this action was auto-approved for the session, respond immediately
  if (sessionAutoApproved.has(action)) {
    vscode.postMessage({ type: 'approval/response', approvalId, approved: true });
    return;
  }

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.approvalId = approvalId;

  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = getActionTitle(action);

  if (reason) {
    const reasonEl = document.createElement('div');
    reasonEl.className = 'approval-reason';
    reasonEl.textContent = reason;
    card.appendChild(title);
    card.appendChild(reasonEl);
  } else {
    card.appendChild(title);
  }

  card.appendChild(buildPreviewEl(action, payload));

  const buttons = document.createElement('div');
  buttons.className = 'approval-buttons';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn-approve';
  approveBtn.textContent = getApproveLabel(action);
  approveBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'approval/response', approvalId, approved: true });
    card.remove();
  });

  const denyBtn = document.createElement('button');
  denyBtn.className = 'btn-deny';
  denyBtn.textContent = 'Deny';
  // Default focus: Deny (safer default)
  denyBtn.autofocus = true;
  denyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'approval/response', approvalId, approved: false });
    card.remove();
  });

  buttons.appendChild(approveBtn);
  buttons.appendChild(denyBtn);

  // "Approve & Don't ask again this session" — only for non-destructive actions
  if (NON_DESTRUCTIVE_ACTIONS.has(action)) {
    const alwaysBtn = document.createElement('button');
    alwaysBtn.className = 'btn-approve-always';
    alwaysBtn.textContent = "Approve & don't ask again this session";
    alwaysBtn.addEventListener('click', () => {
      sessionAutoApproved.add(action);
      vscode.postMessage({ type: 'approval/response', approvalId, approved: true });
      card.remove();
    });
    buttons.appendChild(alwaysBtn);
  }

  card.appendChild(buttons);
  approvalsContainer.appendChild(card);

  // Focus the deny button so keyboard users default to the safe choice
  denyBtn.focus();
}

// ── Message handler (extension → webview) ────────────────────────────────────

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as {
    type: string;
    content?: string;
    text?: string;
    message?: string;
    files?: AttachedFile[];
    approvalId?: string;
    action?: string;
    payload?: unknown;
    reason?: string;
    usage?: TokenUsage;
    cancelled?: boolean;
    finishReason?: string;
    hasActiveEditor?: boolean;
    uri?: string;
    outcome?: 'applied' | 'cancelled';
    available?: boolean;
    thinkingMode?: boolean;
    includeAgentsMd?: boolean;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    providers?: ProviderConfig[];
    activeProviderIndex?: number;
    providerName?: string;
    status?: 'online' | 'offline' | 'checking';
  };

  switch (msg.type) {
    case 'delta':
      typingIndicator.hidden = true;
      appendOutput(msg.content ?? '');
      break;

    case 'done':
      // Flush any remaining buffered markdown before marking done
      if (renderTimer !== null) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      if (markdownBuffer) { flushMarkdown(); }
      setGenerating(false);
      // Dismiss any approval cards left over from a cancelled run
      if (msg.cancelled) {
        approvalsContainer.innerHTML = '';
        setStatusBadge('cancelled', 'Cancelled');
      } else if (msg.usage) {
        const u = msg.usage;
        const fr = msg.finishReason;
        const frSuffix = fr ? ` · ${fr}` : '';
        setStatusBadge('completed', 'Done', `${u.totalTokens.toLocaleString()} tokens (${u.promptTokens.toLocaleString()} + ${u.completionTokens.toLocaleString()})${frSuffix}`);
      } else {
        const fr = msg.finishReason;
        setStatusBadge('completed', 'Done', fr || undefined);
      }
      break;

    case 'warning':
      showWarningNotice(msg.text ?? 'Unknown warning');
      break;

    case 'error':
      setGenerating(false);
      setStatus(`Error: ${msg.message ?? 'unknown'}`);
      break;

    case 'status':
      setStatus(msg.text ?? '');
      break;

    case 'attachments':
      if (msg.files) {
        attachedFiles = msg.files.map(f => ({ uri: f.uri, relativePath: f.relativePath }));
        renderAttachedFiles();
      }
      break;

    case 'approval/request': {
      const payload = msg.payload as ApprovalPayload | undefined;
      showApprovalCard(msg.approvalId ?? '', msg.action ?? '', payload, msg.reason ?? '');
      break;
    }

    case 'editorState': {
      setEditorState(msg.hasActiveEditor ?? false);
      break;
    }

    case 'editResult': {
      if (msg.uri && msg.outcome) {
        editOutcomes.set(msg.uri, msg.outcome);
        flushMarkdown();
      }
      break;
    }

    case 'agentsMdAvailable': {
      lblAgentsMd.hidden = !msg.available;
      if (!msg.available) {
        chkAgentsMd.checked = false;
      }
      break;
    }

    case 'checkboxState': {
      chkThinking.checked = msg.thinkingMode ?? false;
      chkAgentsMd.checked = msg.includeAgentsMd ?? false;
      break;
    }

    case 'newSession': {
      clearOutput();
      approvalsContainer.innerHTML = '';
      attachedFiles = [];
      chkAgentsMd.checked = false;
      chkThinking.checked = false;
      renderAttachedFiles();
      break;
    }

    case 'openSettings': {
      if (msg.providers) {
        providers = msg.providers;
        activeProviderIndex = msg.activeProviderIndex ?? 0;
        renderProvidersList();
        renderModelDropdown();
      }
      openSettingsPanel();
      break;
    }

    case 'providers': {
      if (msg.providers) {
        providers = msg.providers;
        activeProviderIndex = msg.activeProviderIndex ?? 0;
        renderModelDropdown();
        // Check health of active provider on load
        if (providers.length > 0) {
          setProviderStatus('checking');
          vscode.postMessage({ type: 'selectModel', providerIndex: activeProviderIndex });
        }
      }
      break;
    }

    case 'providerStatus': {
      if (msg.status) {
        setProviderStatus(msg.status);
      }
      break;
    }
  }
});

export {};
