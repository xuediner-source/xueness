# Xueness 0.2.1

Xueness is a local-first agent CLI, Web workbench, and self-contained desktop app. Its backend and bundled product capabilities are implemented by trusted TypeScript plugins.

[简体中文 README](README.md) · [Z8 guarded goals and memory notes](ts/docs/z8-guarded-goal-memory.md) · [Desktop guide](docs/xueness-desktop.md) · [Plugin architecture](docs/xueness-plugin-architecture.md)

## Local development

Use Node.js 24.11 or newer. From the repository root, install the backend workspace dependencies and run the local server:

```sh
npm --prefix ts ci
node ts/apps/server/src/main.ts --port 8138
```

Open `http://127.0.0.1:8138` and configure a model endpoint in Settings before sending a task. Use `bin/xueness` for the Agent CLI. The prebuilt Web interface is included at `webapp/dist/`; to rebuild it, run `npm --prefix webapp ci` and `npm --prefix webapp run build`. Backend checks are available with `npm --prefix ts run check`.

## Desktop app

The Electron host source is in `desktop/`. Install its dependencies with `npm --prefix desktop ci`, then build on the target operating system and architecture with `npm --prefix desktop run dist:win` or `npm --prefix desktop run dist:mac`. See the [desktop guide](docs/xueness-desktop.md) for details.

Developer release scope: release staging verifies the selected successful run's commit and downloaded installer/update-feed integrity; this TypeScript flow does not emit the legacy Python `build-info.json` metadata.