# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

VS Code extension that visualizes Rocq/Coq dependency graphs. Two responsibilities:

1. **Build the graph** from `.v` source files. The textual builder (`src/buildGraph.ts`) parses `.v` directly. The full pipeline (`src/dpdgraph.ts` + `src/mergeGraph.ts`) optionally enriches it with kernel-resolved references via `coq-dpdgraph`.
2. **Visualize it** in a `WebviewPanel` using `vis-network`, with editor integration (Cmd+Click go-to-definition, find-references, cursor scope, isolation, Module nesting).

Single Node.js process: the extension. `frogql` is loaded as a native module via napi-rs (no Python sidecar, no HTTP). No Vite or build step for the webview — `media/webview.html` is read with `fs.readFileSync` on every `wirePanel` and injected with a fresh CSP nonce.

## Commands

```bash
cd vscode-extension

# Compile TypeScript → out/
npx tsc -p .

# Watch mode (for iterative development)
npm run watch

# Run the test suite (35 tests across buildGraph, coqProject, dpdgraph, mergeGraph)
# Skips the 2 rocq-integration tests if `rocq --version` is not in PATH.
npm test

# Launch Extension Development Host
# F5 in VS Code; preLaunchTask runs `npm: compile`.

# After editing media/webview.html: close + reopen the panel (the HTML is read fresh).
# After editing src/*.ts: tsc rebuilds (watch) and Cmd+R in the Extension Host reloads.
# After editing package.json (commands, menus, keybindings): Cmd+R required.

# Quick smoke test of buildGraph against real .v files
node -e "
const { buildGraph } = require('./out/buildGraph.js');
const fs = require('fs'); const path = require('path');
const dir = '/path/to/rocq/project';
const files = ['Foo.v', 'Bar.v'].map(b => ({
  path: path.join(dir, b),
  relpath: b,            // path relative to dir, drives node ids
  text: fs.readFileSync(path.join(dir, b), 'utf8'),
}));
const g = buildGraph(files);
console.log('nodes:', g.nodes.length, 'edges:', g.edges.length);
"
```

`frogql` is installed from npm (`package.json` pins `latest`).

## Commands exposed by the extension

| Command | What it does |
|---|---|
| `Rocq Graph: Open graph panel` | Opens / reveals the webview |
| `Rocq Graph: Build graph (textual, fast)` | Parses `.v` files with `buildGraph` only |
| `Rocq Graph: Build graph (full, with dpdgraph)` | Textual + `coq-dpdgraph` harvest + merge |
| `Rocq Graph: Show in graph` (Cmd+K G) | Focuses the node for the symbol under cursor |
| `Rocq Graph: Show in graph and isolate` (Cmd+K I) | Focus + filter to neighborhood |
| `Rocq Graph: Find references` | QuickPick of incoming edges |
| `Rocq Graph: Go to definition` | Same as Cmd+Click but invocable from palette / submenu |
| `Rocq Graph: Toggle cursor scope` | Filter the canvas by file/line at cursor |
| `Rocq Graph: Toggle auto-graph` | Off/on. When on, the .gdb rebuilds on every `.v` save and re-runs dpdgraph when VsRocq's diagnostics for a file go quiet. State persisted in `rocqGraph.autoGraph.enabled` workspace setting. |

A submenu `Rocq Graph` groups these in the editor right-click context.

## Architecture

### Process model

- One process: the VS Code extension host.
- `frogql.Connection` (native via `frogql` napi-rs binding) is opened against `<workspace>/.rocqgraph/graph.gdb`.
- Webview communication is `panel.webview.postMessage` / `onDidReceiveMessage`. No HTTP, no sockets.

### Workspace convention

`<workspace>/.rocqgraph/`:

- `graph.gdb` — frogql database, source of truth.
- `graph.json` — transient before `importJson`; deleted on success.
- `dpd/` — caches the per-module `.dpd` dumps from `coq-dpdgraph` (created on full build).

`open(gdbPath)` creates an empty `.gdb` on first activate. No automatic build — user must run one of the build commands. Add `.rocqgraph/` to `.gitignore`.

### `src/extension.ts` responsibilities

- **Module-level state**: `connection`, `panel`, status bar items, `cursorScopeEnabled` + subscriptions. `panel` is reassigned by `WebviewPanelSerializer.deserializeWebviewPanel` after a host reload.
- **`activate()`**: opens the gdb, registers commands + `DefinitionProvider`, wires the panel serializer, turns cursor scope ON by default.
- **`wirePanel`**: shared by `openGraphPanel` and the serializer. Regenerates the CSP nonce on every call so the inline script + unpkg load work after a restore.
- **`runBuild` / `runBuildFull`**: both discover the `_CoqProject` (`coqProject.ts`), parse `.v` files with the textual builder, and import into the gdb via `importGraphIntoGdb` (helper that drops `connection`, `rmSync` the gdb, `importJson`, reopens). The full variant adds a `dpdgraph` harvest and `mergeGraphs` between textual and kernel outputs.
- **`provideRocqDefinition`** (registered as `DefinitionProvider` for `*.v`): cascade resolver — (1) find the enclosing entry by byte offset and follow its outgoing edge to the symbol; (2) filter candidates by active file; (3) fall through to all matches.
- **Cursor scope**: `onDidChangeTextEditorSelection` + `onDidChangeActiveTextEditor` with 200ms debounce. `emitCursorScope` returns early when the active editor isn't a `.v` (the webview itself triggers focus changes).
- **Status bar visibility**: the three left items (nodes count, cursor scope, auto-graph) `show()`/`hide()` via `updateStatusBarVisibility`, wired to `onDidChangeActiveTextEditor`. They appear only when the active editor is Rocq (`languageId === 'coq'` or `.v`), so they don't clutter the bar in Python/other files. When `activeTextEditor` is undefined (graph webview, terminal, settings focused) the function returns early and keeps the current state, mirroring `emitCursorScope` — prevents flicker while using the graph panel.
- **`openFile(file, line)`**: tries the relpath directly first (with the workspace folder as base), falls back to a basename glob. Uses `vscode.window.tabGroups.all` to find an already-open tab (visible **or** inactive in the same column) before defaulting to `ViewColumn.Active`. Defaulting to `Beside` was a bug that opened duplicate columns for inactive tabs.

### `src/buildGraph.ts` — the textual builder

Three responsibilities:

1. **Parse each `.v`** as a sequence of top-level commands (no longer just `ENTRY_RE` matches). `classifyCommand(head)` distinguishes `Module` / `Module Type` / `Section` / `End` / `Module := alias` / `Require` / `Import` / entry definitions. Scope stack is maintained per file.
2. **Build a `ModuleScope` tree per file** with `defs` (simple-name → node id) and `submodules` (name → child scope). Indexed by **relpath** of the file (e.g. `"src/Foo.v"`), not by stem — two files with the same basename in different subdirectories are distinct.
3. **Resolve edges with incremental scope**. For each file, a `seed` scope is populated with the post-order DFS closure of `Require Import`. Entries are processed in source order; their `defs` are added to scope **after** their refs are resolved — this is what makes a reference like `Definition usesGlobal := foo.` (with a later `Definition foo := 99.` in the same file) resolve to the global `foo`, not the forward-redef. Qualified refs (`Foo.bar`) walk into the matching submodule; aliases (`Module Bar := Foo.`) are expanded via the `aliases` map.

Node id format: `<relpath>::<qualified_name>` where `qualified_name` is `module_path + '.' + name` if inside a Module, else just `name`. Props include `name`, `qualified_name`, `module_path`, `file` (= relpath), `line`, `head_start`, `head_end`, `proof_start`, `proof_end`, `terminator`, `admitted`, plus the kernel-derived `dpd_*` from merge.

**Unicode identifiers**: Rocq accepts Unicode letters and subscripts in names (`αi64`, `αΞ`, `xᵢ`). The shared lexeme fragments `IDENT_START` / `IDENT_CONT` / `IDENT` (`[_\p{L}]`, `[_\p{L}\p{N}\p{M}']`) drive every identifier regex — `ENTRY_RE`, `QUALIFIED_IDENT_RE`, `MODULE_DECL_RE`, the require/import directives — all with the `u` flag. They are **exported** and reused as `ROCQ_IDENT_RE` in `extension.ts` so `getWordRangeAtPosition` selects the full token under the cursor; otherwise Cmd+Click silently fails on a Greek-named definition (the ASCII-only `[A-Za-z_]` regex never created the node, and never matched the word range). The cursor→byte-offset conversion in `findEnclosingEntry` is already Unicode-safe: `Buffer.byteLength(getText(0..pos), 'utf8')` maps the UTF-16 prefix to the UTF-8 byte offset that matches `head_start`.

**Admit detection**: a node is labeled `Admitted` when the terminator is literal `Admitted.` **or** the proof body contains the `admit.` tactic (matched as `\badmit\b` against the comment-stripped proof). The latter covers code in progress with `admit. Qed.` (which Coq itself rejects but is common during proof development). `admit` is a reserved tactic name, so false positives are improbable.

### `src/coqProject.ts` — `_CoqProject` discovery

Parses `_CoqProject` **or `_RocqProject`** (Rocq 9 convention) for `-Q phys logical` and `-R phys logical` directives. The project file is searched at the workspace root and in every directory containing `.v` files (shallowest first) — covering workspaces opened one level above the Rocq project. Its directory becomes the effective `rootDir`: compilation runs from there with paths relative to it, matching how the user's own Makefile compiles. This keeps extension-built `.vo` files library-name-compatible with `make`'s — a mismatch (e.g. old root-level `-Q . ""` naming `rocq.Foo` vs make's plain `Foo`) silently poisons the user's build until `make clean`. Because `rootDir` may differ from the workspace root, `coqProjectModuleToFile` in `extension.ts` takes the workspace root explicitly for relpath computation. Returns a `CoqProject` with:

- `rootDir`: project root.
- `loadPaths`: parsed list.
- `modules`: `Map<absPath, dotted-name>` — e.g. `/.../src/Foo.v → MyLib.Foo` when `_CoqProject` has `-Q src MyLib`.
- `moduleToPath`: inverse.
- `compileArgs`: ready to pass to `rocq compile`.

Fallback when no `_CoqProject`: one `-Q <dir> ""` per directory containing `.v` files, NOT a single `-Q . ""` at the workspace root. With the root binding, a file in `rocq/Foo.v` gets named `rocq.Foo` while its siblings say `Require Import Foo.` — rocq fails with "Cannot find a physical path bound to logical path Foo". Per-directory bindings make sibling requires resolve the same way as compiling by hand from inside the directory. (Note: pass `""` as the **empty string** in `argv`, not the literal `'""'`; `spawn` doesn't interpret shell quoting, and rocq rejects `"""` as an identifier.)

### `src/dpdgraph.ts` — kernel-derived references

Pre-compilation runs in **topological order** (`topoSortModules`, driven by each file's `Require` lines, with suffix matching for logical prefixes), plus a retry-to-fixpoint loop for deps the regex misses. Compiling in file-discovery order broke any module whose dependency's `.vo` didn't exist yet.

For each module in the project, generates a tiny `_dpd_<modulestem>.v` with:

```coq
Require dpdgraph.dpdgraph.
Require Import <all modules>.
Set DependGraph File "dpd_<n>.dpd".
Print FileDependGraph <one module>.
```

**Per-module dumps, not a single combined one.** A combined `Print FileDependGraph A B C.` omits `path=` for names of the "current" module (the last in scope), so two files defining the same name (`Foo.x`) become indistinguishable. Per-module dumps keep each node attributable to a single file. Tradeoff: cross-file refs that the kernel resolves only via implicit mechanisms (typeclass resolution that spans files, notation expansion) are lost; the textual builder still covers cross-file refs via its regex.

Each `DpdNode` carries `sourceFile` (module dotted name of the dump that emitted it), `modulePath` (the kernel-reported `path=` — empty for top-level, `Foo` for `Module Foo`, `Foo.Sub` for nesting), and `qualifiedName` (`modulePath.name` or just `name`).

**`coq-dpdgraph` is a user-installed dependency, not bundled.** It's a Coq/Rocq OCaml plugin (`.cmxs`) compiled against the exact Coq + OCaml version, so it can only come from `opam install coq-dpdgraph` — the `.vsix` cannot ship it. Only the **full / auto-dpd** path needs it; the textual builder and all editor features work without it (and without `rocq` at all). When the generated `_dpd_<M>.v` fails its `Require dpdgraph.dpdgraph` with `Cannot find a physical path bound to logical path dpdgraph`, `isDpdgraphMissingError` detects that exact signature (anchored to `dpdgraph` so a project module's load-path error doesn't match), `harvestDpdgraph` returns early with `dpdgraphMissing: true` instead of marking every module skipped, and `extension.ts` shows an actionable message (`showDpdgraphMissingMessage`) offering to run `opam install --yes coq-dpdgraph` in a terminal of the active environment (inside the dev container when applicable). The auto-graph path shows it at most once per session via `dpdgraphMissingNotified`. Either way the textual graph is kept.

### `src/mergeGraph.ts` — combining textual + kernel

Indexes textual nodes by `(file, qualified_name)`. For each dpd node:

- Map `sourceFile → relpath` via `moduleToFile` (built from the `CoqProject`), then look up `(file, qualifiedName)` in the textual index. Match found → enrich with `dpd_kind`, `dpd_body`, `dpd_prop`, `dpd_module`.
- No match → counted as `unmatchedDpdNodes` (does not invent edges).

For each dpd edge between two matched nodes:

- If the textual already has an edge with the same endpoints, add `dpd_weight` to it.
- If not, add a new `REFERENCES_ELABORATED` edge with `where='elaborated'` and `weight`.

Textual edges with no dpd counterpart are kept (covers `BELONGS_TO`, plus refs the kernel can't see when the file doesn't compile).

### `media/webview.html` responsibilities

Self-contained HTML with CSP nonce; loads `vis-network@9.1.9` from unpkg. Single IIFE in `<script nonce>`. Key state:

- `rawNodes` / `rawEdges`: full payload of the last `graph` message.
- `positionCache`: id → `{x, y}`. Survives across filter passes and even for hidden nodes — load-bearing for cluster / global layouts.
- `groupMode`: `'off' | 'color' | 'cluster' | 'global'`. The first three operate per-file; `global` runs a Sugiyama layered layout over the whole graph with a sub-toggle:
  - `deps`: Y = longest-path rank from sources (nodes with no in-edges go on top). Barycentric ordering within each layer, initialized by `(file, line)`, 16 passes alternating top-down / bottom-up.
  - `source`: Y proportional to line within a per-file band (`bandHeight = 1600`). X by the same barycentric routine treating files as layers. Width is capped per layer to avoid the aspect-ratio collapse seen with naive linear spacing on large layers.
- `cursorScope`: `{file, line} | null`. Combined with `transitiveFileDeps()` to derive `allowedFiles`. Note: `file` is now the **relpath** (e.g. `"src/Foo.v"`) to match `props.file` of the graph.
- `isolation`: `{id, mode, depth}`. BFS over `outAdj`/`inAdj`.
- `ready`: `false` until the first stabilization completes. `applyFilters` is a no-op while `false` — this prevents incoming `cursorScope` messages from disrupting the initial physics run.
- `isAdmitted(n)`: nodes with the `Admitted` label or `props.admitted === true` get a thick red border (`ADMIT_COLOR = '#ff3b30'`, `borderWidth = 4`).

Presets in the header dropdown include `(:Admitted)` and `()-[]->(:Admitted)` for surfacing admits and their direct dependents.

### `src/autoGraph.ts` + `src/verification.ts` — auto-graph mode

When the toggle is on (status bar at left, third item), the .gdb is kept in sync with the workspace automatically:

- **On `.v` save (`onDidSaveTextDocument`)**: parse the entire workspace with `buildGraph` (textual), call `preserveEnrichmentBuilt(newTextual, lastBuiltGraph)` to carry over `dpd_*` props and `REFERENCES_ELABORATED` edges from the previous state, compute a `builtGraphFingerprint`, skip if unchanged, otherwise `importGraphIntoGdb` (drop + importJson + reopen). End-to-end ~150ms for projects under 5k nodes.
- **On VsRocq quiet-green (`onDidChangeDiagnostics` + delay)**: `VerificationTracker` watches standard `vscode.languages.getDiagnostics` for `.v` files. A file with zero error-severity diagnostics for N seconds transitions to `likely-green` (N = 2000ms in `vsrocq.proof.mode = continuous`, 8000ms in `manual`). On any green transition, the extension debounces 1.5s then runs `harvestDpdgraph` + `mergeGraphs` over the whole project and re-imports.
- **State**: `lastBuiltGraph: BuiltGraph | null` and `lastFingerprint: string | null` live as module-level state in `extension.ts`. On enable, hydrated from the .gdb via `hydrateBuiltFromGdb` (~80ms for 5k nodes/edges).

**Why full rebuild instead of DML deltas**: each `MATCH` inside a DML statement invalidates the LTJ TripleIndex and the next read pays ~700ms to rebuild. A typical save's worth of edge edits would take 30+ seconds. `drop + importJson + reopen` for the entire graph runs in ~25-35ms because there's no incremental index work to do. Measured against the real `graph.gdb` (421 nodes / 3434 edges).

**Why `ref_kind` instead of `where` on edges**: `where` is a reserved GQL keyword. The DML parser rejects it as a property name in any position (INSERT body, MATCH selector, SET clause). `buildGraph` and `mergeGraph` now emit `ref_kind`. `refKindOf(props)` reads `ref_kind` with fallback to `where` for `.gdb` files generated before the rename. The webview reads both via `(e.props.ref_kind || e.props.where)`.

**VsRocq integration is observational, not coupled**: VsRocq publishes verified ranges via a private LSP notification (`prover/updateHighlights`), inaccessible to other extensions. We can only see standard `textDocument/publishDiagnostics`. So "verified" is inferred from "no error diagnostics for N seconds" — strong in continuous mode, heuristic in manual. When VsRocq isn't installed the status bar shows "(VsRocq missing — solo textual)" and dpd never auto-triggers.

## Critical gotchas

- **CSP nonce regeneration**: every `wirePanel` regenerates a fresh nonce. Don't cache `webview.html`.
- **vis-network `groups` config**: do NOT set `group: kind` on nodes. vis-network's default palette overrides per-node `color`. Borders for "color by file" are set via `color: {background, border}` + `borderWidth`.
- **`setData` resets the viewport**: `applyFilters` captures `getViewPosition()` and `getScale()` before `setData` and restores them after.
- **`network.moveNode` only works on visible nodes**. For hidden nodes (e.g. while computing cluster / global layouts), write to `positionCache` and let `applyFilters` pick them up via `x, y` on the next `setData`.
- **`-Q phys logical` argv**: pass `""` as the **empty string** in `argv`, not the literal `'""'`. `child_process.spawn` doesn't interpret shell quoting and rocq rejects `"""` as an identifier.
- **dpdgraph dumps must be per-module** (`Print FileDependGraph M.` with M alone). A combined `Print FileDependGraph A B C.` drops `path=` for the "current" module and makes nodes with the same name across files indistinguishable. Documented in `~/.claude/projects/.../memory/project_dpdgraph_quirks.md`.
- **Forward references in the textual builder**: don't add a def to its scope until after resolving its refs. Otherwise `Definition usesGlobal := foo.` followed by `Definition foo := 99.` mis-resolves `foo` to the local one.
- **Edge prop is `ref_kind`, not `where`**: GQL reserves `where` as a keyword. Any property literally named `where` survives `importJson` (no GQL parse) but explodes the moment you touch it via DML or `MATCH ... WHERE e.where = ...`. The whole codebase emits `ref_kind`; readers fall back to `where` for legacy data via `refKindOf(props)`.
- **`tabGroups.all` vs `visibleTextEditors`**: when reusing an editor for `openFile`, only `tabGroups.all` enumerates inactive tabs in the same column. `visibleTextEditors` misses them and causes `ViewColumn.Beside` to open a duplicate column.

## Test suite

`tests/` runs with `node --test` against `out-tests/` (built by `tsconfig.test.json`). Coverage:

- `buildGraph.test.ts` — definitions, forward references, cross-file imports, Module nesting / alias / mid-file Import, Section flat, Inductive/Record children, admit detection (terminator + `admit.` tactic + clean Qed), CoqProject module mapping.
- `coqProject.test.ts` — `_CoqProject` parsing (default, `-Q`, subdirectories, multiple load paths by specificity).
- `dpdgraph.test.ts` — `parseDpd` unit tests + 2 integration tests that actually invoke `rocq compile`. The integration tests skip if `rocq --version` is not in PATH.
- `mergeGraph.test.ts` — `(file, qualified_name)` matching, edge enrichment, unmatched nodes don't invent spurious edges.

Each test uses inline `.v` content or creates a temp dir under `os.tmpdir()`; nothing persists between runs.

## Things deliberately left out

- No esbuild bundling, no `.vsix` packaging. Development happens via F5.
- No automatic graph rebuild on file change. The user runs `Build` manually.
- `_CoqProject` parser ignores everything that isn't `-Q` / `-R` (e.g. `-arg`, individual `.v` file lists). Extend when a corpus needs it.
- Inline imports `Import A.Foo.` open the namespace from that point forward in the file. They don't unimport on `End`. Real Coq doesn't either, but if we add `Module Type` scoping subtleties this assumption may need revisiting.

## See also

- `../CLAUDE.md` — parent project (Python interpreter, gqlrust core, FastAPI playground).
- `../../CLAUDE.md` — repo-level overview.
- `../mayhelp_plan.md` — the original three-phase plan (A: VS Code extension; B: LSP; C: community split). This extension is Phase A, simplified by the napi-rs binding to skip the sidecar.
