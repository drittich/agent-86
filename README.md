# Agent 86

A VS Code extension that provides a local LLM-powered agentic coding assistant with file read/write capabilities and terminal command execution with user approval.

## Features

- **Chat Interface**: Interactive chat panel in the VS Code sidebar
- **File Attachments**: Attach files to provide context to the LLM
- **Code Edits**: The assistant can propose code changes with diff preview and approval
- **Terminal Commands**: Execute shell commands with user approval
- **File Operations**: Move and delete files with user confirmation
- **Session Persistence**: Conversations are saved and restored across VS Code restarts
- **OpenAI-Compatible API**: Works with local LLM servers (e.g., llama.cpp, ollama)

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- [Visual Studio Code](https://code.visualstudio.com/) (v1.85.0 or later)
- A local LLM server with OpenAI-compatible API (e.g., llama.cpp, ollama, vLLM)

## Building and Installing

### Prerequisites

Install the `@vscode/vsce` packaging tool globally:
```bash
npm install -g @vscode/vsce
```

### Packaging for Sideloading

```bash
npm run package
```

This single command installs dependencies, type-checks the source, builds a production bundle (minified, no sourcemaps), auto-bumps the patch version, and produces a `.vsix` file.

### Installing the VSIX

In VS Code: **Extensions** (`Ctrl+Shift+X`) → `...` menu → **Install from VSIX...** → select the `.vsix` file.

Or from the command line:
```bash
code --install-extension agent-86-x.y.z.vsix
```

### Updating

```bash
git pull origin main
npm run package
```

Then reinstall the new `.vsix`.

### Development

For development builds (with sourcemaps, no minification):
```bash
npm run build
```

For watch mode (auto-rebuilds on file changes):
```bash
npm run watch
```

To run in VS Code's Extension Development Host, press `F5` (requires a standard `launch.json` with `extensionDevelopmentPath`).

## Configuration

Configure the extension in VS Code settings:

### Recommended LLM Servers

- **Ollama**: `http://localhost:11434/v1`
- **llama.cpp (cpp-server)**: `http://localhost:8080/v1`
- **LM Studio**: `http://localhost:1234/v1`
- **vLLM**: `http://localhost:8000/v1`

1. Open Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "Agent 86"
3. Configure the following options:

| Setting | Description | Default |
|---------|-------------|---------|
| `agent86.baseUrl` | Base URL for the OpenAI-compatible LLM endpoint | `http://127.0.0.1:8083/v1` |
| `agent86.model` | Model name to use | `OpenAI-20B-NEO-CODEPlus-Uncensored-IQ4_NL.gguf` |
| `agent86.maxContextTokens` | Maximum context tokens for the model | `16384` |
| `agent86.provider` | LLM provider type (`openai-compatible` or `anthropic`) | `openai-compatible` |

Alternatively, add to your `settings.json`:

```json
{
  "agent86.baseUrl": "http://127.0.0.1:8083/v1",
  "agent86.model": "your-model-name",
  "agent86.maxContextTokens": 16384,
  "agent86.provider": "openai-compatible"
}
```

## Usage

### Opening the Panel

- Click the robot icon in the Activity Bar (left sidebar)
- Or run the command: **Agent 86: Open Panel** (`Ctrl+Shift+P` → search for "Agentic")

### Starting a Conversation

1. Type your message in the input field
2. Press `Enter` or click **Send**
3. The assistant will stream its response

### Attaching Files

1. Click the paperclip icon or run **Agent 86: Attach Files**
2. Select one or more files from the workspace
3. File contents will be included as context in your first message

### Starting a New Session

- Click the **New Session** button or run **Agent 86: New Session**
- This clears the conversation history and starts fresh

### Approval Workflow

When the assistant proposes actions, you will be prompted to approve:

- **Code Edits**: A diff view opens showing proposed changes. Approve or reject each change.
- **Terminal Commands**: Review the command before execution. Approve or reject.
- **File Moves**: Confirm file move operations.
- **File Deletions**: Confirm file deletions (files are moved to trash, not permanently deleted).

> **Security Note**: All actions require explicit user approval before execution.

### Special Commands in Assistant Responses

The assistant can use special block syntax to perform actions:

| Block Type | Syntax | Description |
|------------|--------|-------------|
| `@@EDIT` | `@@EDIT path: <file>\n...\n@@END_EDIT` | Propose code changes |
| `@@RUN` | `@@RUN <command>\n...\n@@END_RUN` | Execute terminal commands |
| `@@MOVE` | `@@MOVE from: <src> to: <dst>\n@@END_MOVE` | Move files |
| `@@DELETE` | `@@DELETE path: <file>\n@@END_DELETE` | Delete files |

## Screenshots

| Chat Panel | Approval Workflow |
|------------|-------------------|
| ![Chat Panel](./assets/chat-panel.png) | ![Approval](./assets/approval.png) |

## Troubleshooting

### Extension Not Loading

1. Ensure the extension is built: `npm run build`
2. Check that `dist/extension.js` and `dist/webview.js` exist
3. Reload VS Code

### Connection Errors

1. Verify your LLM server is running
2. Check the `agent86.baseUrl` setting matches your server URL
3. Ensure the model name in `agent86.model` matches your server's model

### Session Not Persisting

Sessions are stored in VS Code's workspace state. Ensure:
- You have a workspace folder open
- VS Code has write access to the workspace storage

## Development

### Project Structure

```
vscode-agent-extension/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── chat/
│   │   ├── ChatPanel.ts      # Main chat webview provider
│   │   └── messageProtocol.ts # Message types between webview and extension
│   ├── config/
│   │   └── ConfigManager.ts  # Session persistence
│   ├── providers/
│   │   ├── IProvider.ts      # LLM provider interface
│   │   └── OpenAIProvider.ts # OpenAI-compatible implementation
│   └── tools/
│       ├── FileTools.ts      # File reading utilities
│       ├── editParser.ts     # @@EDIT block parsing
│       ├── TerminalTool.ts   # @@RUN block handling
│       ├── MoveFileTool.ts   # @@MOVE block handling
│       └── DeleteFileTool.ts # @@DELETE block handling
├── webview-ui/
│   └── main.ts               # Webview UI implementation
├── dist/                     # Compiled output
├── esbuild.js                # Build configuration
├── package.json              # Extension manifest
└── tsconfig.json             # TypeScript configuration
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
