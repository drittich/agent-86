/**
 * CSS for the approval card and question card components.
 * Injected into document.head as a <style> element.
 */

export const APPROVAL_CSS: string = `
  @keyframes card-enter {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .approval-card {
    border: 1px solid var(--vscode-panel-border, #444);
    border-left: 3px solid var(--vscode-panel-border, #555);
    background: var(--vscode-editor-background, #1e1e1e);
    border-radius: 3px;
    padding: 10px 12px;
    margin: 4px 0;
    font-size: 12px;
    animation: card-enter 0.18s ease-out both;
  }
  /* Destructive actions get an amber left accent */
  .approval-card.risk-warn {
    border-left-color: var(--vscode-inputValidation-warningBorder, #b89500);
  }
  /* Highly destructive actions (delete, run command) get a red left accent */
  .approval-card.risk-danger {
    border-left-color: var(--vscode-inputValidation-errorBorder, #be1100);
  }

  .approval-card .approval-title {
    font-weight: 600;
    margin-bottom: 4px;
    color: var(--vscode-foreground);
  }
  .approval-card .approval-reason {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
    line-height: 1.4;
  }
  .approval-card .approval-preview {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 2px;
    padding: 5px 8px;
    margin-bottom: 10px;
    overflow-wrap: anywhere;
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
    margin: 3px 0;
  }
  .approval-card .approval-buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  /* Primary approve: use VS Code's primary button token */
  .approval-card .btn-approve {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    padding: 4px 12px;
  }
  .approval-card .btn-approve:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  /* Deny: outline/ghost — secondary weight, clearly less prominent */
  .approval-card .btn-deny {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, #555);
    padding: 3px 12px;
  }
  .approval-card .btn-deny:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12));
  }
  /* Tertiary "don't ask again" — subdued but legible, not a hidden link */
  .approval-card .btn-approve-always {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid transparent;
    font-size: 11px;
    padding: 3px 6px;
    cursor: pointer;
    margin-left: auto;
  }
  .approval-card .btn-approve-always:hover:not(:disabled) {
    color: var(--vscode-foreground);
    border-color: var(--vscode-panel-border, #555);
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12));
  }

  .question-card {
    border: 1px solid var(--vscode-panel-border, #444);
    border-left: 3px solid var(--vscode-focusBorder, #007fd4);
    background: var(--vscode-editor-background, #1e1e1e);
    border-radius: 3px;
    padding: 10px 12px;
    margin: 4px 0;
    font-size: 12px;
    animation: card-enter 0.18s ease-out both;
  }
  .question-card .question-text {
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--vscode-foreground);
    line-height: 1.4;
  }
  .question-card .question-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 2px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    margin-bottom: 8px;
  }
  .question-card .question-input:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
  }
  .question-card .question-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }
  .question-card .pick-list {
    margin: 0 0 8px 0;
    padding-left: 20px;
    font-size: 12px;
    color: var(--vscode-foreground);
    line-height: 1.6;
  }
  .question-card .pick-list li {
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
  }
`;
