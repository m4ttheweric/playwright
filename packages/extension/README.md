# Fast Browser Chrome Extension

## Introduction

The Fast Browser Chrome Extension allows you to connect to pages in your existing browser and leverage the state of your default user profile. This means Claude Code and Codex can interact with websites where you're already logged in, using your existing cookies, sessions, and browser state, providing a seamless experience without requiring separate authentication or setup.

## Prerequisites

- Chrome/Edge/Chromium browser

## Installation Steps

### Install the Extension

Install [Fast Browser](https://github.com/m4ttheweric/mattstack/tree/main/plugins/fast-browser).

Until a Fast Browser Chrome Web Store listing exists, install the extension zip
unpacked from the release artifact.

### Build release artifacts

Build the runtime tarball, unpacked extension zip, and release manifest locally:

```bash
npm ci
npm run build
node utils/fast_browser/build_artifacts.mjs --version 0.1.0-alpha.1 --out-dir fast-browser-dist
```

The release JSON is the only file that `mattstack/runtime-lock.json` should
consume. It names the runtime and extension artifacts and pins their checksums.

### Configure Fast Browser MCP server

Configure Fast Browser MCP server to connect to the browser using the extension by passing the `--extension` option when running the MCP server:

```json
{
  "mcpServers": {
    "fast-browser-extension": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--extension",
        "--extension-id=bjlfojdaaanoliidngocnbcalhpfmlie"
      ]
    }
  }
}
```

## Usage

### Browser Tab Selection

When the LLM interacts with the browser for the first time, it will load a page where you can select which browser tab the LLM will connect to. This allows you to control which specific page the AI assistant will interact with during the session.

### Bypassing the Connection Approval Dialog

By default, you'll need to approve each connection when the MCP server tries to connect to your browser. To bypass this approval dialog and allow automatic connections, you can use an authentication token.

#### Using Your Unique Authentication Token

1. After installing the extension, click on the extension icon or navigate to the extension's status page
2. Copy the `PLAYWRIGHT_MCP_EXTENSION_TOKEN` value displayed in the extension UI
3. Add it to your MCP server configuration:

```json
{
  "mcpServers": {
    "fast-browser-extension": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--extension",
        "--extension-id=bjlfojdaaanoliidngocnbcalhpfmlie"
      ],
      "env": {
        "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "your-token-here"
      }
    }
  }
}
```

This token is unique to your browser profile and provides secure authentication between the MCP server and the extension. Once configured, you won't need to manually approve connections each time.
