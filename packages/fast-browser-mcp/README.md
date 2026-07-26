# Fast Browser MCP runtime

This package is the launcher for the self-contained Fast Browser MCP runtime.
The release artifact bundles the forked `playwright-core` npm payload and does
not install dependencies when it starts.

Until a Fast Browser store listing exists, install the extension unpacked from
its release zip.

## Build release artifacts

Build the runtime tarball, unpacked extension zip, and release manifest locally:

```bash
npm ci
npm run build
node utils/fast_browser/build_artifacts.mjs --version 0.1.0-alpha.1 --out-dir fast-browser-dist
```

The release JSON is the only file that `mattstack/runtime-lock.json` should
consume. It names the runtime and extension artifacts and pins their checksums.

The bundled Playwright code is licensed under Apache-2.0. See `LICENSE` and
`NOTICE` in this package, and `playwright-core/ThirdPartyNotices.txt` in the
release artifact for applicable notices.
