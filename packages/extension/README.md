# Fast Browser Chrome Extension

## Supported release scope

This Fast Browser release supports macOS with Google Chrome. Edge and other
Chromium browsers are outside the supported release scope.

## Prerequisites

- macOS
- Google Chrome
- Node.js 20 or newer
- A Fast Browser release manifest and its two adjacent artifacts

## Verify and extract the release

Treat `fast-browser-release-<version>.json` as the authoritative runtime lock.
It supplies the filenames, SHA-256 checksums, and extension ID; do not substitute
an unpinned package or a copied extension ID.

```bash
RELEASE_JSON=/absolute/path/to/fast-browser-release-0.1.0-alpha.1.json
RELEASE_DIR="$(cd "$(dirname "$RELEASE_JSON")" && pwd)"
INSTALL_ROOT=/absolute/path/to/fast-browser-install

PRODUCT_VERSION="$(node -e "const r=require(process.argv[1]); console.log(r.productVersion)" "$RELEASE_JSON")"
RUNTIME_FILE="$(node -e "const r=require(process.argv[1]); console.log(r.runtime.file)" "$RELEASE_JSON")"
RUNTIME_SHA256="$(node -e "const r=require(process.argv[1]); console.log(r.runtime.sha256)" "$RELEASE_JSON")"
EXTENSION_FILE="$(node -e "const r=require(process.argv[1]); console.log(r.extension.file)" "$RELEASE_JSON")"
EXTENSION_SHA256="$(node -e "const r=require(process.argv[1]); console.log(r.extension.sha256)" "$RELEASE_JSON")"
EXTENSION_ID="$(node -e "const r=require(process.argv[1]); console.log(r.extension.id)" "$RELEASE_JSON")"
INSTALL_DIR="$INSTALL_ROOT/$PRODUCT_VERSION"

printf '%s  %s\n' "$RUNTIME_SHA256" "$RELEASE_DIR/$RUNTIME_FILE" | shasum -a 256 -c -
printf '%s  %s\n' "$EXTENSION_SHA256" "$RELEASE_DIR/$EXTENSION_FILE" | shasum -a 256 -c -

test ! -e "$INSTALL_DIR" || { echo "Refusing to overlay existing install: $INSTALL_DIR" >&2; exit 1; }
mkdir -p "$INSTALL_ROOT"
mkdir "$INSTALL_DIR"
tar -xzf "$RELEASE_DIR/$RUNTIME_FILE" -C "$INSTALL_DIR"
unzip -q "$RELEASE_DIR/$EXTENSION_FILE" -d "$INSTALL_DIR/fast-browser-extension"
printf 'Verified Fast Browser extension ID: %s\n' "$EXTENSION_ID"
```

Only continue after both checksum commands report `OK`.

## Load the extension in Google Chrome

1. Keep the extracted `fast-browser-extension` directory in a stable location.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `fast-browser-extension` directory.
6. Confirm the ID on Chrome's loaded extension card exactly matches the
   `Verified Fast Browser extension ID` printed above.

## Configure the verified Fast Browser runtime

Point the MCP configuration at the extracted launcher and use the value read
from `release.extension.id` above:

```json
{
  "mcpServers": {
    "fast-browser-extension": {
      "command": "node",
      "args": [
        "/absolute/path/to/fast-browser-install/<productVersion>/fast-browser-mcp/cli.cjs",
        "--extension",
        "--extension-id=<value from release.extension.id>"
      ]
    }
  }
}
```

The downstream `mattstack/runtime-lock.json` must consume the verified release
JSON rather than independently selecting runtime or extension versions.

## Use an authentication token

By default, Google Chrome asks you to approve each MCP connection. To enable
automatic reconnection:

1. Click the Fast Browser extension icon, or open its status page.
2. Copy the raw token displayed by the extension.
3. Add it as `PLAYWRIGHT_MCP_EXTENSION_TOKEN` in the same MCP server entry:

```json
{
  "env": {
    "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "your-raw-token-here"
  }
}
```

The token is unique to the Chrome profile. Store it as a secret and do not put
it in source control.

## Build release artifacts locally

From a clean checkout:

```bash
npm ci
node utils/fast_browser/build_artifacts.mjs --version 0.1.0-alpha.1 --out-dir fast-browser-dist
```

The builder performs a controlled fresh build and rejects dirty relevant source.
