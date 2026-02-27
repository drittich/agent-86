// Webview-side entry point (Phase 0: stub — UI and message bridge wired up in later todo items)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const acquireVsCodeApi: () => any;
const vscode = acquireVsCodeApi();

const root = document.getElementById('root');
if (root) {
  root.textContent = 'Agentic Coder UI loading...';
}

// Receive messages from the extension host
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (root) {
    root.textContent = JSON.stringify(message);
  }
});

export {};
