/**
 * Base CSS for the webview. Injected into document.head as a <style> element.
 */

export const BASE_CSS: string = `
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
  #output p { margin: 0 0 8px; }
  #output p:last-child { margin-bottom: 0; }
  #output h1, #output h2, #output h3,
  #output h4, #output h5, #output h6 {
    margin: 10px 0 4px;
    line-height: 1.3;
    font-weight: 600;
  }
  #output h1 { font-size: 16px; }
  #output h2 { font-size: 14px; }
  #output h3 { font-size: 13px; }
  #output h4, #output h5, #output h6 { font-size: 12px; }
  #output ul, #output ol {
    margin: 0 0 8px 16px;
    padding: 0;
  }
  #output li { margin-bottom: 2px; }
  #output code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    padding: 1px 4px;
    border-radius: 3px;
  }
  #output pre {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 3px;
    padding: 8px;
    overflow-x: auto;
    margin: 0 0 8px;
  }
  #output pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 11px;
    white-space: pre;
  }
  #output blockquote {
    border-left: 3px solid var(--vscode-widget-border, #555);
    margin: 0 0 8px 0;
    padding: 0 0 0 10px;
    color: var(--vscode-descriptionForeground);
  }
  #output hr {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, #444);
    margin: 10px 0;
  }
  #output a {
    color: var(--vscode-textLink-foreground, #4e9fde);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-height: 60vh;
    color: var(--vscode-descriptionForeground);
    margin: 0;
  }

  .empty-state-logo {
    margin: 0;
    padding: 0;
    background: none;
    border: none;
    border-radius: 0;
    overflow: visible;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px;
    line-height: 1.1;
    white-space: pre;
    color: var(--vscode-foreground);
    opacity: 0.85;
    user-select: none;
  }

  .empty-state-text {
    margin: 0;
    font-size: 12px;
    text-align: center;
  }

  @media (prefers-reduced-motion: no-preference) {
    .empty-state {
      animation: empty-state-in 240ms ease-out;
    }
  }

  @keyframes empty-state-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* User prompt bubbles */
  .user-bubble {
    background: var(--vscode-input-background, #2d2d2d);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px;
    padding: 8px 10px;
    margin: 10px 0 6px;
  }

  .user-bubble:first-child {
    margin-top: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13px;
    line-height: 1.5;
  }

  /* Tool call accordions (edits, search_file, request_chunks, etc.) */
  #output details.edit-accordion {
    margin: 0 0 8px;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  }
  #output details.edit-accordion summary {
    cursor: pointer;
    padding: 4px 8px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    user-select: none;
    list-style: none;
  }
  #output details.edit-accordion summary::before {
    content: '▶ ';
    font-size: 10px;
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
    margin: 0 0 8px;
    font-size: 12px;
  }
  #output th, #output td {
    border: 1px solid var(--vscode-panel-border, #444);
    padding: 3px 8px;
  }
  #output th { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); }

  .tool-activity {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 2px 0;
    opacity: 0.8;
  }
  .tool-activity .file-link {
    color: var(--vscode-textLink-foreground, #4e9fde);
    text-decoration: none;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .tool-activity .file-link:hover { text-decoration: underline; }

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
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 12px;
    align-items: center;
  }
  #thinking-row input { margin-right: 4px; }

  /* Settings overlay */
  #settings-overlay {
    position: fixed;
    inset: 0;
    background: var(--vscode-sideBar-background, #252526);
    z-index: 100;
    display: flex;
    flex-direction: column;
  }
  #settings-overlay[hidden] { display: none; }

  #settings-panel {
    background: var(--vscode-sideBar-background, #252526);
    width: 100%;
    height: 100%;
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
    justify-content: flex-start;
    gap: 6px;
    flex: 1 1 auto;
    min-height: 0;
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
  #settings-advanced {
    border-top: 1px solid var(--vscode-widget-border, #454545);
  }
  #settings-advanced > summary {
    list-style: none;
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  #settings-advanced > summary::-webkit-details-marker { display: none; }
  #settings-advanced > summary::before {
    content: '';
    width: 0;
    height: 0;
    border-left: 4px solid currentColor;
    border-top: 3px solid transparent;
    border-bottom: 3px solid transparent;
    opacity: 0.7;
    transition: transform 0.12s ease-out;
  }
  #settings-advanced[open] > summary::before { transform: rotate(90deg); }
  #settings-advanced > summary:hover { color: var(--vscode-foreground); }
  .settings-advanced-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 10px;
  }
  .settings-advanced-row label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .settings-advanced-row input {
    width: 72px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 4px 6px;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
  }
  .settings-advanced-row input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .settings-advanced-actions {
    display: flex;
    justify-content: flex-end;
    padding: 0 12px 10px;
  }
  #btn-settings-save {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  #btn-settings-save:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  #btn-settings-cancel {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, #555);
  }
  #btn-settings-cancel:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
  }

  /* Settings tabs */
  #settings-tabs {
    display: flex;
    gap: 4px;
    padding: 0 12px;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
  }
  .settings-tab {
    appearance: none;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground, #888);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 8px 6px;
    margin-bottom: -1px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: color 0.12s ease, border-color 0.12s ease;
  }
  .settings-tab:hover { background: none; color: var(--vscode-foreground); }
  .settings-tab[aria-selected="true"] {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder, #007fd4);
  }
  .settings-tab-count {
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }

  .settings-pane[hidden] { display: none; }

  /* System Prompt pane */
  #system-prompt-pane {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1 1 auto;
    min-height: 0;
  }
  #system-prompt-text {
    flex: 1 1 auto;
    min-height: 160px;
    resize: vertical;
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 6px 8px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.5;
    border-radius: 2px;
    box-sizing: border-box;
  }
  #system-prompt-text:focus { outline: 1px solid var(--vscode-focusBorder); }
  .system-prompt-actions {
    display: flex;
    justify-content: flex-end;
  }

  #providers-list,
  #models-list {
    list-style: none;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  #providers-list li,
  #models-list li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 13px;
    border: 1px solid var(--vscode-widget-border, #3a3a3a);
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,0.04));
    font-size: 13px;
    transition: background 0.1s ease, border-color 0.1s ease;
  }
  #providers-list li.settings-empty,
  #models-list li.settings-empty {
    border-style: dashed;
    background: none;
  }

  #providers-list li:not(.settings-empty):hover,
  #models-list li:not(.settings-empty):hover {
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  .provider-item-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .provider-item-titlerow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .provider-item-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .provider-item-sub {
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground, #888);
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .provider-item-meta {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground, #888);
    white-space: nowrap;
  }
  .provider-item-meta .mono { font-family: var(--vscode-editor-font-family, monospace); }

  /* Provider-type badge (OpenRouter / OpenAI / Anthropic / Compatible) */
  .provider-badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    white-space: nowrap;
  }
  .provider-badge[hidden] { display: none; }
  .provider-badge.type-openrouter {
    background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 22%, transparent);
    color: var(--vscode-charts-purple, #b180d7);
  }
  .provider-badge.type-openai {
    background: color-mix(in srgb, var(--vscode-charts-green, #6fc26f) 22%, transparent);
    color: var(--vscode-charts-green, #6fc26f);
  }
  .provider-badge.type-anthropic {
    background: color-mix(in srgb, var(--vscode-charts-orange, #d98c5a) 22%, transparent);
    color: var(--vscode-charts-orange, #d98c5a);
  }

  .provider-item-actions { display: flex; gap: 2px; flex-shrink: 0; align-items: center; }

  .provider-item-actions button {
    padding: 3px 7px;
    font-size: 12px;
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
  }
  .provider-item-actions .btn-edit-conn,
  .provider-item-actions .btn-edit-model {
    color: var(--vscode-textLink-foreground, #4e9fde);
    font-weight: 500;
  }
  .provider-item-actions .btn-edit-conn:hover,
  .provider-item-actions .btn-edit-model:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18));
  }
  .provider-item-actions .btn-delete {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 14px;
    line-height: 1;
  }
  .provider-item-actions .btn-delete:hover {
    color: var(--vscode-errorForeground, #e05555);
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18));
  }

  #btn-add-provider,
  #btn-add-model {
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
  #btn-add-provider:hover,
  #btn-add-model:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  .settings-empty {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    padding: 6px;
    text-align: center;
  }

  /* ── Modal dialogs (add/edit provider + model) ────────────────── */
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--vscode-editor-background, #000) 55%, transparent);
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .dialog-overlay[hidden] { display: none; }

  .dialog {
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, #252526));
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 6px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    width: 100%;
    max-width: 560px;
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* Model dialog needs popups to escape the body, so it doesn't clip overflow. */
  .dialog.dialog-overflow { overflow: visible; }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
  }
  .dialog-title { font-weight: 600; font-size: 14px; }
  .dialog-close {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0.7;
    font-size: 17px;
    padding: 0 4px;
    cursor: pointer;
    line-height: 1;
  }
  .dialog-close:hover { opacity: 1; background: none; }

  .dialog-body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
  }
  .dialog.dialog-overflow .dialog-body { overflow: visible; }
  .dialog-body label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-top: 6px;
  }
  .dialog-body > label:first-child { margin-top: 0; }
  .dialog-body input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 6px 8px;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
  }
  .dialog-body input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .label-opt {
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.65;
    font-weight: 400;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-widget-border, #454545);
  }
  .dialog-footer .btn-secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
  .dialog-footer .btn-secondary:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }

  /* Provider-type chips */
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    appearance: none;
    font-family: inherit;
    font-size: 12px;
    padding: 5px 11px;
    border-radius: 2px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid transparent;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .chip:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .chip.active {
    background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 20%, transparent);
    border-color: var(--vscode-focusBorder, #007fd4);
    color: var(--vscode-foreground);
  }

  /* API-key input with show/hide toggle */
  .key-input { position: relative; }
  .key-input input { padding-right: 58px; }
  .key-toggle {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground, #4e9fde);
    font-family: inherit;
    font-size: 11px;
    padding: 4px 7px;
    border-radius: 2px;
    cursor: pointer;
  }
  .key-toggle:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }

  /* Detect hint with status dot */
  .form-hint {
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--vscode-descriptionForeground, #888);
    text-transform: none;
    letter-spacing: 0;
    display: flex;
    align-items: baseline;
    gap: 5px;
  }
  .form-hint[hidden] { display: none; }
  .form-hint .form-hint-dot {
    flex-shrink: 0;
    align-self: center;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground, #888);
  }
  .form-hint.detected .form-hint-dot {
    background: var(--vscode-testing-passedForeground, #4ec94e);
  }

  /* Custom dropdown (provider select) + model autocomplete share .dd / .dd-menu */
  .dd { position: relative; }
  .dd-button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 2px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  .dd-button:hover { border-color: var(--vscode-focusBorder, #007fd4); }
  .dd-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dd-label.placeholder { color: var(--vscode-descriptionForeground, #888); }
  .dd-caret { flex-shrink: 0; font-size: 10px; color: var(--vscode-descriptionForeground, #888); }
  .dd-caret-btn {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 10px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 2px;
  }
  .dd-caret-btn:hover { color: var(--vscode-foreground); }
  #mf-model { padding-right: 30px; }

  .dd-menu {
    list-style: none;
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 10;
    max-height: 260px;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    background: var(--vscode-dropdown-background, #2d2d2d);
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .dd-menu[hidden] { display: none; }
  .dd-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    appearance: none;
    background: none;
    border: none;
    color: var(--vscode-foreground);
    font-family: inherit;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
  .dd-option:hover,
  .dd-option.active {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #fff);
  }
  .dd-option-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .dd-option-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dd-option-sub {
    font-size: 10.5px;
    opacity: 0.7;
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sg-id {
    flex: 1;
    min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sg-ctx { flex-shrink: 0; font-size: 10px; opacity: 0.7; }
  .dd-empty {
    padding: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    line-height: 1.45;
  }
  .dd-sep { height: 1px; background: var(--vscode-widget-border, #454545); margin: 4px 6px; }
  .dd-add {
    display: flex;
    align-items: center;
    width: 100%;
    appearance: none;
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground, #4e9fde);
    font-family: inherit;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
  .dd-add:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }

  /* Empty state inside the model dialog (no providers yet) */
  .dialog-empty { text-align: center; padding: 10px 4px; }
  .dialog-empty-title { font-size: 13px; margin-bottom: 4px; }
  .dialog-empty .form-hint { justify-content: center; margin-bottom: 12px; }
  .btn-inline-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  /* Model selector row */
  #model-selector-row {
    position: relative;
    padding: 4px 0px;
    border-top: 1px solid var(--vscode-widget-border, #454545);
    font-size: 12px;
  }

  #model-select {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-dropdown-background, #3c3c3c);
    color: var(--vscode-dropdown-foreground, #ccc);
    border: 1px solid var(--vscode-dropdown-border, #454545);
    border-radius: 2px;
    padding: 2px 4px 2px 18px;
    font-size: 12px;
    font-family: inherit;
    transition: border-color 0.15s ease;
  }
  #model-select:hover {
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  .status-dot {
    position: absolute;
    left: 6px;
    top: 50%;
    transform: translateY(-50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    pointer-events: none;
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

  /* Settings pane — fade in on open */
  @keyframes panel-enter {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  #settings-overlay:not([hidden]) #settings-panel {
    animation: panel-enter 0.15s ease-out both;
  }

  /* Approval/warning card entrance */
  @keyframes card-enter {
    from { opacity: 0; transform: translateY(-5px); }
    to   { opacity: 1; transform: none; }
  }

  /* History overlay */
  #history-overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--vscode-sideBar-background, #000) 50%, transparent);
    z-index: 100;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 8px;
  }
  #history-overlay[hidden] { display: none; }

  #history-panel {
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 3px;
    width: 100%;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 24px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  #history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
    flex-shrink: 0;
  }
  #history-title {
    font-weight: 600;
    font-size: 13px;
  }
  #btn-history-close {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0.7;
    font-size: 16px;
    padding: 0 4px;
    cursor: pointer;
    line-height: 1;
  }
  #btn-history-close:hover { opacity: 1; background: none; }

  #history-body {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  #history-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  #history-list li {
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
    padding: 10px 12px;
    cursor: pointer;
    transition: background 0.1s ease;
  }
  #history-list li:last-child { border-bottom: none; }
  #history-list li:not(.history-date-sep):hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  #history-list li:not(.history-date-sep):active { background: var(--vscode-list-activeSelectionBackground, #094771); }

  .history-date-sep {
    padding: 4px 12px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-sideBarSectionHeader-background, transparent);
    cursor: default;
    pointer-events: none;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
  }

  .history-item-title {
    font-size: 13px;
    color: var(--vscode-foreground);
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .history-item-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .history-item-meta-sep {
    opacity: 0.4;
    user-select: none;
  }

  .history-item-duration {
    color: var(--vscode-descriptionForeground);
    opacity: 0.75;
  }

  .history-empty {
    padding: 16px 12px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
  }

  @keyframes history-panel-enter {
    from { opacity: 0; transform: translateY(-6px) scale(0.98); }
    to   { opacity: 1; transform: none; }
  }
  #history-overlay:not([hidden]) #history-panel {
    animation: history-panel-enter 0.18s cubic-bezier(0.25, 1, 0.5, 1) both;
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
