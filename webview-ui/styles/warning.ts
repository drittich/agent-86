/**
 * CSS for the warning notice component. Injected into document.head as a <style> element.
 */

export const WARNING_CSS: string = `
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
