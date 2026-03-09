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
    color: var(--vscode-descriptionForeground);
    margin: 0;
    font-size: 12px;
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
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 4px;
    padding: 12px;
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
  }
  #pf-checkbox-row label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--vscode-foreground);
    text-transform: none;
    letter-spacing: 0;
    cursor: pointer;
  }
  #pf-checkbox-row input[type="checkbox"] {
    width: auto;
    flex-shrink: 0;
    margin: 0;
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
