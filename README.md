# YAMS Blackboard (VS Code)

VS Code extension for multi-agent coordination on top of YAMS.

This extension ports the OpenCode blackboard plugin to VS Code and talks to the YAMS daemon directly over Unix domain socket IPC (protobuf + framed transport). It registers `bb_*` Language Model tools and an `@blackboard` chat participant. 

## Requirements

- VS Code `^1.95.0`
- GitHub Copilot Chat enabled (for chat participant + LM tools)
- YAMS daemon running locally (the extension connects via Unix domain socket)

## Usage

Open the Chat view and message the participant:

```
@blackboard show stats
@blackboard show recent activity
@blackboard list pending tasks
```

You can also invoke the tools directly (the exact tool names are `bb_*`).

### Autonomous agent identity

The extension maintains a default agent identity (persisted per workspace) and will register it on the blackboard when the daemon is connected.

- Tools that accept `agent_id` / `created_by` will default these fields when omitted.
- If you want a custom identity (e.g., to emulate an external agent), call `bb_register_agent` and then pass that `agent_id` explicitly.

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

GPL-3.0-only (see LICENSE)