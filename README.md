# YAMS Blackboard (VS Code)

VS Code extension for multi-agent coordination on top of YAMS.

This extension ports the OpenCode blackboard plugin to VS Code and talks to the YAMS daemon directly over Unix domain socket IPC (protobuf + framed transport). It registers `bb_*` Language Model tools and an `@blackboard` chat participant.

## Features

- `@blackboard` chat participant
- `bb_*` tools for:
  - agents (register/list)
  - findings (post/query/search/get/ack/resolve)
  - tasks (create/query/claim/update/complete/fail/get-ready)
  - contexts (create/set/summary)
  - stats + recent activity
  - subscriptions + notifications

## Requirements

- VS Code `^1.95.0`
- GitHub Copilot Chat enabled (for chat participant + LM tools)
- YAMS daemon running locally (the extension connects via Unix domain socket)

Socket path resolution order:

1. `$YAMS_DAEMON_SOCKET`
2. `$XDG_RUNTIME_DIR/yams-daemon.sock`
3. `/tmp/yams-daemon-<uid>.sock`

## Install (VSIX)

From this repo:

```bash
npm install
npm run build
npx vsce package
code --install-extension ./vscode-blackboard-0.1.0.vsix
```

Or in VS Code:

- Command Palette  `Extensions: Install from VSIX...`

## Usage

Open the Chat view and message the participant:

```
@blackboard show stats
@blackboard show recent activity
@blackboard list pending tasks
```

You can also invoke the tools directly (the exact tool names are `bb_*`).

## Development

```bash
npm install
npm run watch
```

Then launch the extension via VS Code's extension host (F5) from this folder.

Proto regeneration (if YAMS IPC schema changes):

```bash
npm run proto:generate
```

## Notes

- This extension is designed to degrade gracefully if the daemon is not running; tools will fail with a connection error until the daemon becomes available.
- The extension bundles via `esbuild` into `dist/extension.js`.

## License

MIT
