# TRACE.md — Fast Browser trace schema (schema version 1)

This document is the canonical contract for the trace format Fast Browser's
MCP runtime writes when tracing is enabled. It describes what is on disk,
field by field, and the semantics behind fields whose meaning is not obvious
from their type alone (empty arrays, truncation markers, take-once
telemetry). A downstream compiler (WS2) is written against this document,
not against the implementation plan that produced it — where the two
disagree, this document and the landed code it is copied from win.

The authoritative TypeScript source for every type below is
`packages/playwright-core/src/tools/backend/traceLog.ts`. If this document
and that file ever disagree, the file wins; file an issue against this doc.

## Opt-in

Tracing is off by default (`saveTrace` config default: `false`). It is
enabled per session with the `--save-trace` CLI flag or the
`PLAYWRIGHT_MCP_SAVE_TRACE` environment variable
(`packages/playwright-core/src/tools/mcp/config.ts`,
`packages/playwright-core/src/tools/mcp/config.d.ts`,
`packages/playwright-core/src/tools/mcp/configIni.ts`,
`packages/playwright-core/src/tools/mcp/program.ts`). When disabled, no
`trace-*` directory is created and no trace I/O happens at all — this is a
product contract, covered by
`tests/mcp/fast-browser-contract.spec.ts`.

### `--save-trace` off means no capture work, not just no output

The absence of a `trace-*` directory is the visible half of the contract;
the other half is that nothing upstream of "no directory" runs either.
Three capture paths are gated on `Context.traceLog` being set (i.e. on a
trace actually being active), not merely on a tool having opted into
tracing in principle:

- **Element targeting enrichment** (`Tab.targetLocators`,
  `packages/playwright-core/src/tools/backend/tab.ts`) — the seven
  ref-based action tools pass `{ trace: true }` unconditionally, but
  `_recordTarget`'s `_selectorCandidates()` channel round trip only runs
  when `this.context.traceLog` is also set. With tracing off, `targets`
  enrichment does zero extra channel work, not just zero extra output.
- **Per-request network bookkeeping**
  (`packages/playwright-core/src/tools/backend/utils.ts`'s
  `waitForCompletion`) — the `request.response()` call that populates
  `TraceNetworkEntry.status`/`failed` only runs when `tab.context.traceLog`
  is set. The non-telemetry await logic this function also performs (the
  settle wait, awaiting in-flight requests to finish) is unaffected either
  way — that behavior belongs to `waitForCompletion`'s own contract, not to
  tracing, and must stay byte-identical regardless of `--save-trace`.
- **Script capture** (`browser_run_code_unsafe`,
  `packages/playwright-core/src/tools/backend/runCode.ts`) —
  `beginScriptCapture()`/`instrumentation.addListener(...)` only run when
  `tab.context.traceLog` is set. With tracing off, a `run_code` call never
  registers a process-wide instrumentation listener or consumes a slot in
  `scriptCapture.ts`'s contamination tracking on tracing's account.

In all three cases, the tool's actual browser behavior is identical with
tracing on or off — only the bookkeeping that exists purely to populate a
trace record is skipped. Regression coverage: `no trace dir without
--save-trace` in `tests/mcp/fast-browser-contract.spec.ts` covers the
visible half of the contract end-to-end (still the most useful automated
signal, since it runs the full flag-off path through a real MCP session).
The three gates above are point conditionals on `context.traceLog`
reviewable directly at their call sites; an end-to-end test cannot honestly
assert "no `_selectorCandidates()` channel traffic occurred" or "no
instrumentation listener was registered" without a spy inside the server
process, which is a separate process across the test's stdio transport —
there is no test-only seam to observe that from outside. Treat the gates
themselves, plus this document, as the contract; the flag-off contract test
is the regression guard for the observable half of it.

## Directory layout

Each traced session gets its own directory, created once per client
connection (`BrowserBackend.initialize`):

```
<outputDir>/trace-<epochMs>/
  meta.json
  actions.jsonl
```

`<epochMs>` is `Date.now()` at session start (`TraceLog.create`), so a
session that reconnects gets a new trace directory, never an appended one.

## `meta.json`

Written once at session start, rewritten once at clean close:

```json
{
  "schemaVersion": 1,
  "clientName": "...",
  "cwd": "...",
  "runtimeVersion": "1.62.0-next",
  "productVersion": "0.1.0-alpha.1",
  "protocolVersion": 2,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "endedAt": "2026-01-01T00:05:00.000Z"
}
```

- `schemaVersion` is this document's version, exported as
  `TRACE_SCHEMA_VERSION` from `traceLog.ts` (currently `1`, the same
  constant used for every record's `v`, below). It versions the trace
  format itself, independently of `protocolVersion` (the Fast Browser
  extension protocol, currently `2`) and of the Fast Browser product
  release schema (see `COMPATIBILITY.md`). All three numbers move
  independently.
- `runtimeVersion` is `packageJSON.version` read from the forked
  `playwright-core` package
  (`packages/playwright-core/src/tools/backend/utils.ts`'s `packageJSON`,
  threaded through `BrowserBackend.initialize`) — **not** the shipped
  Fast Browser product version. At the time of writing this reports
  something like `1.62.0-next`.
- `productVersion` is the shipped Fast Browser product version
  (`packages/fast-browser-mcp/package.json`, e.g. `0.1.0-alpha.1` once
  built via `utils/fast_browser/build_artifacts.mjs --version ...`) —
  `mcp/program.ts`'s `serverVersion`, threaded through
  `ContextConfig.productVersion` into `TraceLog.create()` (backend/ cannot
  import from `mcp/`, see DEPS.list, hence the data-threading rather than
  a direct import). Optional: any `BrowserBackend` construction path that
  doesn't thread a product version through (there are a few outside the
  MCP server itself, e.g. the trace-snapshot debug CLI) leaves this field
  absent, not a placeholder value.
- `protocolVersion` is `mcp/protocol.ts`'s `VERSION`, threaded the same way
  as `productVersion` for the same DEPS.list reason — `traceLog.ts` no
  longer hardcodes this number.
- `endedAt` is present only after a clean close (`BrowserBackend.dispose` →
  `TraceLog.close()`). Its absence means the session ended without a clean
  close (crash, kill -9, ...), not that the trace is corrupt — everything
  already flushed to `actions.jsonl` up to that point is still valid.
  `close()` is idempotent: calling it more than once is a no-op after the
  first call sets `endedAt`.

## `actions.jsonl`

One JSON object per line, one line per **dispatched** tool call, in
`Response.serialize()`/dispatch order. Each line is appended synchronously
(`fs.appendFileSync`) at the moment the tool call finishes, so the file is
durable call-by-call — there is no in-process buffering to lose on a hard
kill, and a reader can safely tail the file while the session is live.

### What counts as "dispatched" — only real tool calls are traced

A call only produces a trace record if it actually reached the tool's
`handle()`. Two categories of call return *before* the traced region
(`BrowserBackend.callTool` in
`packages/playwright-core/src/tools/backend/browserBackend.ts`) and
therefore **produce no record at all**, not even an error record:

- **Tool not found** — `name` doesn't match any registered tool.
- **Invalid arguments** — the tool's Zod schema rejects the raw arguments.

Both return an MCP error response to the client as normal; they just never
touch `context.beginAction()`, `tool.handle()`, or `traceLog.appendRecord()`.
If you are reconciling a client's call log against `actions.jsonl` and find
calls missing, check first whether they errored before dispatch — that is
expected, not a gap in the trace.

Every call that *does* reach `tool.handle()` gets exactly one record,
whether the tool call succeeded or threw (see `error`, below).

### `TraceRecord` (verbatim from `traceLog.ts`)

```ts
export type TraceLocator = { kind: 'role' | 'testid' | 'text' | 'css' | 'other', selector: string };
export type TraceTarget = {
  ref?: string;            // aria ref (e.g. 'e12') when the call used one
  resolved?: string;       // human-readable locator from targetLocators/normalize
  alternates: TraceLocator[];
  role?: string;
  name?: string;
  description?: string;    // accessible description, else accessible name
};

export type TraceNetworkEntry = { method: string, url: string, resourceType: string, status?: number, failed?: boolean };
export type TraceScriptAction = { apiName: string, params?: unknown, error?: string };

// Appended as the final element of a truncated array field in place of
// collapsing the whole array to a bare marker object (see
// truncateArrayIfOversized below) -- this is what lets `network`, `targets`,
// `code`, and `script.actions` keep their declared array type even when
// oversized, which is load-bearing for WS2 (the downstream compiler reads
// these fields expecting an array, never a bare object). `omittedElements`
// counts entries dropped from the END of the array (kept elements are always
// a prefix); `sizeBytes` is the post-walk serialized size of the FULL array
// before trimming, not of the marker or the kept prefix.
export type TraceTruncationMarker = { __truncated__: true, omittedElements: number, sizeBytes: number };

// This trace format's schema version. Used for both meta.json's
// `schemaVersion` and every record's `v` -- the two are the same number by
// design (meta.json's own comment on this documents why: a record is
// self-describing even read out of context of its meta.json). Bump this,
// not the two call sites, when the schema changes.
export const TRACE_SCHEMA_VERSION = 1;

export type TraceRecord = {
  v: typeof TRACE_SCHEMA_VERSION,
  seq: number,
  tool: string,
  startedAt: string,       // ISO-8601
  endedAt: string,
  params: unknown,         // parsed tool arguments, raw (trace is local-only)
  urlBefore?: string,
  urlAfter?: string,
  targets: (TraceTarget | TraceTruncationMarker)[],
  network: (TraceNetworkEntry | TraceTruncationMarker)[],
  mutating: boolean,       // any non-GET/HEAD/OPTIONS request in the action window
  waits: { settleMs: number, awaitedNavigation: boolean, awaitedRequests: number },
  code: (string | TraceTruncationMarker)[], // generated Playwright code lines the Response collected; [] minimum, never absent
  script?: { filename?: string, sha256: string, args?: unknown, actions: (TraceScriptAction | TraceTruncationMarker)[] },
  error?: string,
};
```

`v` is always `TRACE_SCHEMA_VERSION` (currently `1`) and is the record-level
twin of `meta.json`'s `schemaVersion` — every record in a schema-1 trace
carries `v: 1` individually, so a record is self-describing even read out of
context of its `meta.json`.

`seq` starts at `1` and increments once per dispatched call
(`TraceLog.nextSeq()`), scoped to one `TraceLog` instance (one client
connection / one trace directory). It is not a global counter across
sessions.

### `params`

The tool's Zod-parsed arguments, recorded raw, exactly as the tool received
them. No redaction, no normalization beyond what Zod parsing already did.
See **Privacy**, below.

### `urlBefore` / `urlAfter`

`context.currentTab()?.page.url()` read immediately before `tool.handle()`
runs and immediately after it returns (success or throw). Either can be
`undefined` if there is no current tab (e.g. before the first
`browser_navigate`/`browser_tabs` call creates one).

### `targets` — element targeting, enriched tools only

`targets` is `[]` for every tool call **except** the seven ref-based action
tools that opt in by passing `{ trace: true }` to
`Tab.targetLocator`/`targetLocators`
(`packages/playwright-core/src/tools/backend/tab.ts`): **click, type,
hover, select_option, drag, fill_form, drop**. Every other tool — including
`browser_snapshot`'s own optional `target` parameter, which resolves a real
locator through the same `targetLocator` code path but without the trace
flag — always records `targets: []`. An empty array here means "this tool
doesn't do element targeting enrichment," not "targeting failed."

Passing `{ trace: true }` is necessary but not sufficient: `targetLocators`
also requires an active trace (`this.context.traceLog`) before it runs
`_recordTarget`'s `_selectorCandidates()` channel round trip at all. With
`--save-trace` off, none of the seven tools do this enrichment work —
`targets` is `[]` for the same reason every other tool's is, and no extra
channel traffic happens on their account. See **`--save-trace` off means no
capture work, not just no output**, below.

For an enriched call, one `TraceTarget` is recorded per element the tool
addressed (one for click/type/hover/select_option, two for drag: start and
end, in that order; `fill_form` records one per field, in field order; `drop`
records one, for the drop target).

- `ref` is populated only when the call used an aria-ref target
  (`e12`-style); `undefined` for selector-string targets.
- `resolved` is the human-readable locator string from
  `Locator.normalize()`/`targetLocators`.
- `role`, `name`, `description`, and `alternates` come from the internal
  `Locator._selectorCandidates()` API
  (`packages/playwright-core/src/client/locator.ts`,
  `packages/injected/src/injectedScript.ts`). Before computing any of these,
  the injected script retargets to the closest interactive ancestor
  (`retargetForSelectorGeneration`) — e.g. a `<span>` inside a `<button>`
  yields candidates, role, name, and description that all describe the
  **button**, not the span. Role/name/description and the selector
  candidates therefore always describe the same element.
- `description` falls back to the accessible **name** when the element has
  no distinct accessible description
  (`getElementAccessibleDescription(element, false) || name` in
  `injectedScript.ts`). `target.description === target.name` is an expected,
  common case, not a bug — do not treat equality as a signal that
  enrichment failed.
- `alternates` is the ranked list of selector candidates
  `generateSelector` produced (best-first), each classified into a
  `TraceLocator.kind` by `traceLocatorKind()`:

  ```ts
  export function traceLocatorKind(candidate: string): TraceLocator['kind'] {
    const engine = /^(?:internal:)?([a-zA-Z-]+)=/.exec(candidate)?.[1];
    switch (engine) {
      case 'role': return 'role';
      case 'testid': return 'testid';
      case 'text': return 'text';
      case 'css': return 'css';
      default: return engine ? 'other' : 'css';
    }
  }
  ```

  A candidate with **no recognized engine prefix at all** (`generateSelector`
  never prefixes its plain-CSS fallback with `css=`) maps to `css`, not
  `other`. `other` is reserved for engines this trace format doesn't track
  (e.g. `internal:label`, `internal:attr`). `alternates` can collapse to a
  single entry when a decisive test-id attribute exists — `generateSelector`
  scores a configured, unique test-id above every other candidate, so there
  may be nothing else worth listing.
- On enrichment failure (an unexpected error from the
  `_selectorCandidates()` channel round trip), the target degrades to just
  `{ ref, resolved, alternates: [] }` — `role`/`name`/`description` are left
  `undefined` rather than losing the whole action's trace record. Enrichment
  failure never fails the underlying browser action.

### `network` and `waits` — take-once, epoch-guarded action telemetry

`network` and `waits` come from `Context.takeActionTelemetry()`, drained
exactly once per dispatched call by the seam in `BrowserBackend.callTool`.
Not every tool populates this data — only calls that actually go through
`Tab.waitForCompletion` do; every other call falls back to `network: []`
and zeroed `waits` (`settleMs: 0, awaitedNavigation: false,
awaitedRequests: 0`) from `takeActionTelemetry()`'s default. Among the
seven target-enriched tools specifically: **click**, **drag**, and **drop**
always call `waitForCompletion`; **hover** and **select_option** never do
(they resolve their target and act directly); **type** only does when its
`submit` or `slowly` parameter is set; **fill_form** never does, regardless
of field count or type — a plain `browser_type` fill call (no `submit`, no
`slowly`) and every `browser_fill_form` call record empty `network`/zeroed
`waits` even though they mutated the page, exactly like
`hover`/`select_option` (`packages/playwright-core/src/tools/backend/
keyboard.ts`, `snapshot.ts`, `form.ts`). This is a deliberate, already-ruled
decision, not a gap to close: wrapping `fill_form` in `waitForCompletion`
would add settle latency to every field fill. `targets` enrichment is
independent of this and is unaffected — it happens earlier, while resolving
the locator, regardless of whether the tool goes on to call
`waitForCompletion`.

**An empty `network` array means "no network activity was observed during
this action's window," not "network activity is unknown."** The absence of
entries is itself informative — treat `network: []` as ground truth for "no
requests fired," never as "we don't know."

**Epoch guard — a modal-dialog-interrupted action's stale telemetry is
never attributed to a later call.** `Tab._raceAgainstModalStates` can let a
tool's own `waitForCompletion()` call keep running in the background after
the tool call has already returned (e.g. a `click` that triggers a page
`alert()`: the click's response comes back with a modal-state result, but
the underlying network/settle wait is still in flight, blocked until a
*separate*, later `browser_handle_dialog` call dismisses the dialog).
Each dispatched call captures the context's action epoch
(`context.currentActionEpoch()`) at the start of its action; when the
backgrounded work eventually calls `setActionTelemetry(epoch, ...)`, the
write is silently dropped if the epoch no longer matches the context's
current epoch (i.e. a newer call has since started). Concretely: every
tool call issued between the interrupted click and the dialog being
handled — and the dialog-handling call itself — records its own,
correctly-empty telemetry; the interrupted click's telemetry is simply
lost, never merged onto a call it didn't belong to.

`network` entries:

```ts
export type TraceNetworkEntry = { method: string, url: string, resourceType: string, status?: number, failed?: boolean };
```

`status` and `failed` are populated asynchronously as each request's
response settles; a request that never gets a response (aborted, page
navigated away) may have neither `status` nor `failed`.

`waits.settleMs` is **cumulative wall-clock time across every post-callback
wait the action performed**, not just the time spent in the first settle
wait. Concretely (`packages/playwright-core/src/tools/backend/utils.ts`,
`waitForCompletion`): the clock starts (`settleStart = Date.now()`)
immediately after the tool's own callback resolves, then the action waits
for the configured settle timeout, then — depending on whether a
navigation was requested — either waits for the frame's `load` state or
awaits every in-flight `document|stylesheet|script|xhr|fetch` request's
response to finish (plus, in the non-navigation branch, one more settle
wait if any requests were seen at all). `settleMs` is
`Date.now() - settleStart` measured only once, after all of that has
finished — so it is the sum of every wait phase the action went through,
not any single phase in isolation. `awaitedNavigation` is `true` iff any
observed request was a navigation request; `awaitedRequests` counts how
many `document|stylesheet|script|xhr|fetch` requests were explicitly
awaited (the navigation branch does not increment it, since it waits on
frame load state instead of individual requests).

### `mutating`

(`packages/playwright-core/src/tools/backend/browserBackend.ts`, the
`mutating:` line in the `traceLog?.appendRecord({...})` call inside
`callTool`.)

```ts
mutating: telemetry.network.some(n => !SAFE_METHODS.has(n.method.toUpperCase()))
// SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
```

`true` iff at least one request recorded in this action's `network` array
used an HTTP method other than `GET`, `HEAD`, or `OPTIONS` (case-insensitive
comparison; the method as received on the wire is stored unmodified in the
`network` entry, only the comparison is case-normalized). A call with empty
`network` is never `mutating`.

**`mutating: false` means "no non-safe request was observed in this
action's window," not "this action had no side effects."** `mutating` is
derived entirely from the `network` array, and `network` is itself only
populated for calls that go through `Tab.waitForCompletion` (see `network`
and `waits`, above) — a tool that mutates the page without ever making an
HTTP request that this backend observes will report `mutating: false`
regardless of what it actually did to the page. Two ways this shows up in
practice:

- **Structurally blind tools.** `browser_fill_form`, `browser_hover`, and
  `browser_select_option` never call `Tab.waitForCompletion` at all (see
  above); a plain `browser_type` call with no `submit`/`slowly` doesn't
  either. `browser_navigate` (`packages/playwright-core/src/tools/backend/
  navigate.ts`) is the same story by a different path: it drives the
  navigation directly (`tab.checkUrlAndNavigate` → `page.goto`) and never
  goes through `waitForCompletion` either, at all, regardless of what the
  navigation loads. Every call to any of these five records `mutating:
  false` unconditionally, even when the underlying action changed page
  state or issued a POST (a filled form field, a toggled checkbox, a
  changed select value, a navigation to a URL that itself triggers
  server-side writes) — there is no network signal to derive `mutating`
  from in the first place, because `network` itself is empty for these
  tools by construction, not by observation.
- **Popup / second-tab blind spot.** `network` is scoped to telemetry
  captured for the dispatched call's own action window on the tab it
  operated on. A click that opens a new tab (`target="_blank"`, `window.
  open`) and the *new* tab's own subsequent navigation/requests are not
  attributed back to the click's trace record — the click's `network`
  reflects only what happened on the original tab before/during its own
  settle window.

**A consent gate (or any policy decision about whether an action is safe
to allow) must not trust `mutating: false` alone for the tools listed
above.** Treat `browser_fill_form`, `browser_type` (unconditionally, not
just when `submit`/`slowly` is unset — the trace record alone doesn't tell
a reader which branch a given call took without also checking `params`),
`browser_hover`, `browser_select_option`, and `browser_navigate` as
mutating-by-tool-identity, independent of what their trace record's
`mutating` field says. This is a deliberate, already-ruled scope
boundary, not an oversight to fix here: wrapping `fill_form` in
`waitForCompletion` to give it real network telemetry would add settle
latency to every field fill, and is out of scope for WS1.

### `code`

The generated Playwright API code lines the tool's `Response` object
collected while handling the call (`response.code()`). Always an array,
`[]` minimum — `Response._code` initializes to `[]`
(`packages/playwright-core/src/tools/backend/response.ts`) and `code()`
returns it directly, so this field is never `undefined`; `[]` means the
tool never called `response.addCode(...)`, not that the field is absent.

### `script` — `browser_run_code_unsafe` only

`undefined` for every tool except `browser_run_code_unsafe`.

```ts
script?: { filename?: string, sha256: string, args?: unknown, actions: (TraceScriptAction | TraceTruncationMarker)[] }
```

- `sha256` is a SHA-256 hash of the **final code string that actually ran**
  — i.e. computed *after* `filename`-based loading resolves to source text,
  not a hash of the `filename` parameter or of the raw request. Two calls
  that pass different `filename`s but load byte-identical source hash the
  same; a `code`-parameter call and a `filename` call that load the same
  source also hash the same.
- `args` is the tool's `args` parameter recorded raw (same "no redaction"
  posture as `params`; see **Privacy**).
- `actions` is captured via a **process-wide instrumentation singleton**
  (`packages/playwright-core/src/tools/backend/scriptCapture.ts`): the
  underlying `ClientInstrumentation` object that reports Playwright API
  calls is shared by every `BrowserBackend` in the process (one MCP server
  process can serve multiple client connections over its lifetime), and its
  `onApiCallBegin` event carries no way to attribute a call back to the
  script/connection that made it. Because of this, **if two
  `browser_run_code_unsafe` calls capture concurrently (their execution
  windows overlap in wall-clock time, regardless of which connection or
  session they belong to), both are marked contaminated and both report
  `actions: []`** rather than risking silently merged, misattributed data.

  **`actions: []` is therefore ambiguous by construction** and can mean any
  of: instrumentation was unavailable, this capture overlapped with another
  concurrent `run_code` call (contaminated), or the script genuinely made
  no Playwright API calls. **Do not infer "the script did nothing" from an
  empty `actions` array — treat the script as opaque** (verifiable only via
  `sha256`/`args`/`network`/`code`/the tool's own response) whenever
  `actions` is empty.
  - Independently of contamination, `actions` is capped at 10,000 captured
    entries in memory as they're observed
    (`scriptCapture.ts`'s `MAX_CAPTURED_ACTIONS`), to bound a single
    long-running script's memory footprint. Once the cap is hit, further
    API calls are counted but not retained; a capped, non-contaminated
    capture ends with a trailing `TraceTruncationMarker` (`{ __truncated__:
    true, omittedElements, sizeBytes }`) summarizing what was dropped,
    exactly like an oversized `network`/`targets`/`code` array (see
    **Truncation**, below) — `omittedElements` is the count of API calls
    past the cap; `sizeBytes` is the serialized size of the 10,000 kept
    entries, not of the omitted tail (which was never retained, so has no
    honest size to report).

### `error`

A string when the tool call threw or its response was itself an error
(`responseObject.isError`); `undefined` on success. Sourced from the
caught exception (plus any drained unhandled-rejection messages) when the
call threw, or extracted from the response's error text otherwise.

## Truncation

Any individual `TraceRecord` **value** — not the record as a whole — whose
JSON-serialized size (`Buffer.byteLength` of `JSON.stringify(value)`)
exceeds 64 KiB (`MAX_VALUE_BYTES = 64 * 1024`) is truncated before the
record is written. What "truncated" means depends on whether the
oversized value is an **array** or not — this split exists specifically so
oversized array fields (`network`, `targets`, `code`, `script.actions`)
never stop being arrays:

- **Arrays keep their type.** An oversized array is walked element-wise
  and truncated to a prefix that fits the budget, then gets exactly one
  `TraceTruncationMarker` appended as its final element:

  ```json
  { "__truncated__": true, "omittedElements": 12, "sizeBytes": 123456 }
  ```

  `omittedElements` is how many elements past the kept prefix were
  dropped; `sizeBytes` is the full array's serialized size *before*
  trimming (not the trimmed/kept portion's size, and not the marker's own
  size). Elements are always dropped from the **end** — the kept portion
  is always a prefix of the original array, so ordering-sensitive readers
  (e.g. `network`/`code` entries in call order, `script.actions` in
  execution order) can rely on "everything before the marker is in its
  original relative order, and there is nothing meaningful after it."
  Emitted by `truncateArrayIfOversized()` in `traceLog.ts`. A reader
  should treat the **last** element of any of these four fields as a
  possible marker and check it structurally (`__truncated__ === true` and
  `typeof omittedElements === 'number'`) rather than assuming array length
  alone means nothing was dropped.
- **Non-array containers still collapse to a bare marker.** An oversized
  *object* value (not an array) — e.g. `script` as a whole, or a subtree
  inside `script.args` — is replaced wholesale by:

  ```json
  { "__truncated__": true, "sizeBytes": 123456 }
  ```

  This marker has no `omittedElements` key — that is precisely how a
  reader tells the two marker shapes apart (see below). Unlike the array
  case, there is no "keep a prefix" concept for an arbitrary object: the
  whole value is gone, replaced by this one marker.
- **A long string value also collapses to the object-shaped marker**
  (`{ "__truncated__": true, "sizeBytes": ... }`) when it alone exceeds 64
  KiB — e.g. `error`, `urlBefore`/`urlAfter`, or a string leaf somewhere
  inside `params`/`script.args`.

Key semantics, all load-bearing for anything reading `actions.jsonl`:

- **The rule is per-value within a record, never per-record.** Truncation
  is decided independently for each of the record's top-level fields (`v`,
  `seq`, `tool`, `startedAt`, ..., `error`), each walked and truncated on
  its own. A record with several individually-small fields whose
  *aggregate* size exceeds 64 KiB is written intact — nothing about the
  record as a whole is ever collapsed, checked, or acted on as a unit.
- **The top-level record never collapses to a bare marker.** There is no
  code path that treats the whole `TraceRecord` as a truncatable leaf —
  `appendRecord()` (`traceLog.ts`) always writes an object with every
  `TraceRecord` key present, walking each field independently rather than
  handing the whole record to the truncation walk in one call.
- **`v`, `seq`, and `mutating` are structurally exempt from truncation, not
  just practically small.** They are a number/number/boolean, and
  `truncateOversizedValues()`'s size check only ever runs on strings and
  objects/arrays (`typeof value !== 'object' && typeof value !== 'string'`
  returns the value untouched) — there is no code path under which a
  number or boolean gets replaced by a marker, regardless of value.
- **`tool`, `startedAt`, and `endedAt` are practically always small, but
  are not structurally exempt the way `v`/`seq`/`mutating` are.** They are
  ordinary strings, and every string value — these three included — goes
  through the same per-field size check as `error`/`urlBefore`/`urlAfter`.
  In practice a tool name and an `Date.toISOString()` timestamp are always
  many orders of magnitude under 64 KiB, so this never fires for them, but
  that is a fact about their real-world content, not a special-case in the
  code that protects them by name. Do not build a reader that assumes
  these three keys can never be `{ __truncated__: true, sizeBytes }` —
  build one that (like every other string field) checks the value's type
  before treating it as a plain string.
- **The walk is bottom-up and per-field**, so truncation can apply to a
  *subtree* inside a field (e.g. `script.args.someHugeKey`) without
  discarding the rest of that field's sibling keys, and an array nested
  inside an object field (e.g. `script.args.items`, if the caller's own
  `args` happens to contain an array) gets the same array-keeps-its-type
  treatment as a top-level array field — this rule is about the *value*
  being truncated, not about field position. When a subtree collapses,
  `sizeBytes` is the size of that subtree's JSON **after its own children
  have already been truncated** (post-child-truncation size), not its
  original pre-truncation size — a container that only became small enough
  to report accurately because a child inside it was already replaced by a
  marker still reports the size it actually serializes to now, not a
  number for data that's no longer there. The same applies to an
  oversized array's `sizeBytes`: it is the post-walk (children already
  truncated) size of the full array before trimming.
- **The cycle marker omits both `sizeBytes` and `omittedElements`**:
  `{ "__truncated__": true }` alone. This only fires for an object the walk
  has already visited as one of its own ancestors — expected to be
  unreachable in practice, since every traced value is JSON-derived (parsed
  tool arguments, telemetry the backend built itself) and none of the code
  paths that produce trace data intentionally construct cycles. Treat its
  appearance as a signal something upstream is producing non-JSON-shaped
  data, not as a normal truncation case.

A reader can distinguish "this value was truncated" from "this value is
legitimately `{ __truncated__: true, ... }`-shaped application data" only
by the field's expected type in the schema above — the marker shapes are
not namespaced or otherwise unambiguous on their own. In practice no field
in `TraceRecord` legitimately contains user data shaped exactly like either
marker, but a defensive reader should check the field's expected type
before treating a truncation-shaped object as a truncation marker, and
(for the array-element marker specifically) check for `omittedElements` to
tell it apart from the object-collapse marker rather than assuming
`__truncated__: true` alone identifies which shape it's looking at.

## Privacy — traces are local-only and raw by design

Nothing in `actions.jsonl` is redacted at capture time. `params`,
`script.args`, `urlBefore`/`urlAfter`, and every other field are recorded
exactly as observed, including anything a page or a script author put
there — credentials typed into a form field, tokens embedded in a URL,
full request/response metadata, arbitrary `run_code` arguments. This is
deliberate: traces are a local, on-disk debugging/replay artifact, not a
transmitted or shared format, and capture-time redaction would make the
trace useless for its purpose (reconstructing exactly what happened).

**Literal stripping/redaction is out of scope for this runtime and is the
downstream compiler's responsibility.** Anything that consumes
`actions.jsonl` to produce a shareable artifact (a generated test, a
report, ...) must apply its own redaction before that artifact leaves the
machine. Do not assume any field here has been sanitized.

## Versioning

This is trace schema **1**, exported as `TRACE_SCHEMA_VERSION` from
`traceLog.ts` and used for both `meta.json`'s `schemaVersion` and every
`TraceRecord.v` — the two are read from the same constant, not
independently maintained literals. It is independent of the Fast Browser
extension protocol version (currently 2, unrelated to trace capture,
reported in `meta.json` as `protocolVersion`), the Fast Browser product
version (`meta.json`'s `productVersion`), and the Fast Browser product
release schema (see `COMPATIBILITY.md`). A future incompatible change to
this format must bump `TRACE_SCHEMA_VERSION` (which moves `schemaVersion`
and every record's `v` together), and should be documented as a new
section here rather than by editing the semantics of schema 1 in place.
