# Fast Browser MCP runtime

This package is the launcher for the self-contained Fast Browser MCP runtime.
The release artifact bundles the forked `playwright-core` npm payload and does
not install dependencies when it starts.

Until a Fast Browser store listing exists, extract its release ZIP and use
Google Chrome's **Load unpacked** action on the extracted directory.

## Build release artifacts

Build the runtime tarball, extension ZIP, and release manifest locally from a
clean checkout:

```bash
npm ci
node utils/fast_browser/build_artifacts.mjs --version 0.1.0-alpha.1 --out-dir fast-browser-dist
```

The artifact builder rejects dirty relevant source, removes stale runtime and
extension outputs, and performs a controlled fresh build before packaging.

The release JSON is the only file that `mattstack/runtime-lock.json` should
consume. It names the runtime and extension artifacts and pins their checksums.

The bundled Playwright code is licensed under Apache-2.0. See `LICENSE` and
`NOTICE` in this package, and `playwright-core/ThirdPartyNotices.txt` in the
release artifact for applicable notices. The standalone extension ZIP also
contains `LICENSE`, `NOTICE`, and `ThirdPartyNotices.txt`.
