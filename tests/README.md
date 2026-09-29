Run `pnpm test` from the frontend root to run all Node tests in this directory.
Use `pnpm test:watch` during development, or `node --test tests/indexing-flow.test.mts`
for one file. Tests use Node’s built-in runner and the existing Vite/Svelte compiler;
no separate test package is required. IPC and lifecycle tests mock Electron and do not
connect to the running app or its catalog.

For live gallery gesture checks, run `pnpm dev`, connect with `agent-browser connect 9222`,
and execute `tests/helpers/gallery-input.browser.js` with `agent-browser eval -b` using
the file's UTF-8 base64 text. This checks the actual ViSelect integration in the renderer,
including item-drag exclusion, cancellation, lost mouseup, and subsequent clicks. It creates
and removes an isolated DOM fixture without changing catalog data. Native OS drops also need
a manual Explorer/file-manager check; the Node tests validate IPC payloads and late preparation.

Rust tests remain with the backend crate. From `nicegal-server`, use
`./dev.cmd test -p nicegal-server -- --test-threads=1` on Windows or
`./dev.sh test -p nicegal-server -- --test-threads=1` on Linux. The existing API fixture
loads BGE and the active CLIP model's image/text towers, not every CLIP option.
Serial execution avoids loading duplicate sessions concurrently. Run it separately
from model benchmarks so test inference does not distort benchmark timings.

`svelte-client.test.mjs` runs library reactivity and gallery selection checks with Svelte's
client runtime in isolated Node processes. Its local loader compiles `.svelte.ts` runes
without a DOM shim. The library check verifies that scroll persistence and
unchanged/loading/failed status snapshots do not restart searches, while query changes
and new OCR data do. `all-search.test.mts` also
covers malformed and deferred section responses and collapsed layouts in all three modes.
