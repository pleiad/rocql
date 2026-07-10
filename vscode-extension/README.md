# Rocql

Explore Rocq/Coq proof developments as an interactive dependency graph, directly inside VS Code. Rocql parses your `.v` files, builds a graph of definitions, lemmas, theorems and their references, and renders it in a live, physics-driven canvas next to the editor.

No Python, no server, no external database to run. The graph engine (`frogql`) ships with the extension as a native module.

## Features

- **Dependency graph of your project.** Every top-level entry (`Definition`, `Lemma`, `Theorem`, `Fixpoint`, `Inductive`, `Record`, `Instance`, ...) becomes a node; every reference in a statement or proof becomes an edge. Inductive constructors and record fields are nested under their parent.
- **Go to definition (Cmd/Ctrl+Click).** Jump from any identifier to where it is defined, resolved through module scopes, aliases and cross-file `Require Import`.
- **Find references.** List every entry that depends on the symbol under the cursor.
- **Show in graph (Cmd+K G) / isolate (Cmd+K I).** Focus the node for the symbol at the cursor, optionally filtering the canvas to just its neighborhood.
- **Cursor scope.** Narrow the canvas to only what is defined up to the cursor line, so the graph tracks where you are reading.
- **Admit tracking.** Entries closed with `Admitted.` or containing an `admit.` tactic are outlined in red, and presets surface them and their dependents.
- **Auto-graph on save.** Toggle it on and the graph rebuilds automatically every time you save a `.v` file.
- **GQL queries.** The visible graph is driven by a GQL path-pattern query. Presets are built in, and you can type your own to slice the graph.

## Getting started

1. Open a folder containing Rocq/Coq `.v` files.
2. Run **Rocql: Build graph (textual, fast)** from the Command Palette (`Cmd/Ctrl+Shift+P`).
3. Run **Rocql: Open graph panel** to see the graph, or Cmd+K G on any identifier to jump straight to its node.

The textual build needs nothing beyond the `.v` sources. It works even when the project does not compile.

## Commands

| Command | Shortcut | What it does |
|---|---|---|
| Rocql: Open graph panel | | Opens / reveals the graph webview |
| Rocql: Build graph (textual, fast) | | Parses `.v` files (no compiler needed) |
| Rocql: Build graph (full, with dpdgraph) | | Textual + kernel-resolved references |
| Rocql: Show in graph | Cmd+K G | Focus the node for the symbol under the cursor |
| Rocql: Show in graph and isolate | Cmd+K I | Focus + filter to its neighborhood |
| Rocql: Find references | | List incoming references |
| Rocql: Go to definition | | Jump to the definition of the symbol |
| Rocql: Toggle cursor scope | | Show only what is defined up to the cursor |
| Rocql: Toggle auto-graph | | Rebuild the graph on every save |

All commands are also available from the **Rocql** submenu in the editor right-click menu.

## Full graph (optional)

The **full** build enriches the graph with references the Rocq kernel resolves (typeclass instances, notations) via `coq-dpdgraph`. This layer is optional and requires:

- The `rocq` (or `coqc`) binary on `PATH`.
- `coq-dpdgraph` installed in your switch: `opam install coq-dpdgraph`.

Without them, every editor feature and the textual graph still work.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `rocqGraph.defaultQuery` | _(empty)_ | GQL query run when the panel opens. Empty = full graph. |
| `rocqGraph.autoGraph.enabled` | `false` | Persisted state of the auto-graph toggle. |
| `rocqGraph.autoGraph.dpdOnGreen` | `true` | With auto-graph on, run the dpdgraph enrichment once VsRocq stops reporting errors. |

## Requirements

- VS Code 1.85 or newer.
- Rocq/Coq `.v` source files in the workspace.
- The compiler and `coq-dpdgraph` are only needed for the optional full build.

## License

MIT
