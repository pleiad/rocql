import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { open, importJson, Connection } from 'frogql';
import { buildGraph, BuiltGraph, IDENT } from './buildGraph';
import { discoverCoqProject } from './coqProject';
import { harvestDpdgraph } from './dpdgraph';

/**
 * coq-dpdgraph no está instalado: muestra un mensaje accionable y, si el
 * usuario acepta, lanza `opam install` en una terminal del entorno activo
 * (dentro del dev container cuando aplica). El grafo textual no se ve afectado.
 */
async function showDpdgraphMissingMessage(): Promise<void> {
  const install = 'Instalar coq-dpdgraph';
  const choice = await vscode.window.showWarningMessage(
    'Rocql: coq-dpdgraph no está instalado. El enrichment del kernel lo ' +
      'requiere; el grafo textual sigue funcionando. Instálalo con ' +
      '`opam install coq-dpdgraph`.',
    install,
  );
  if (choice === install) {
    const term = vscode.window.createTerminal('coq-dpdgraph install');
    term.show();
    term.sendText('opam install --yes coq-dpdgraph');
  }
}
import { mergeGraphs } from './mergeGraph';
import {
  builtGraphFingerprint,
  hydrateBuiltFromGdb,
  preserveEnrichmentBuilt,
} from './autoGraph';
import {
  VerificationEvent,
  VerificationTracker,
  isVsRocqInstalled,
} from './verification';
import { findAnchorLine, ROCQ_ANCHOR_MACRO } from './paperLink';

interface NodeRef {
  id: number;
  kind: 'node';
  labels: string[];
  props: Record<string, unknown>;
}

interface EdgeRef {
  id: number;
  kind: 'edge';
  labels: string[];
  props?: Record<string, unknown>;
}

interface VizEdge {
  id: number;
  labels: string[];
  from: number;
  to: number;
  props?: Record<string, unknown>;
}

let connection: Connection | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let cursorStatusBar: vscode.StatusBarItem | undefined;
let autoGraphStatusBar: vscode.StatusBarItem | undefined;
let panel: vscode.WebviewPanel | undefined;
let gdbPath: string | undefined;
let cursorScopeEnabled = false;
const cursorScopeSubs: vscode.Disposable[] = [];
let cursorScopeDebounce: NodeJS.Timeout | undefined;

// Auto-graph state.
let autoGraphEnabled = false;
const autoGraphSubs: vscode.Disposable[] = [];
let lastBuiltGraph: BuiltGraph | null = null;
let lastFingerprint: string | null = null;
let verificationTracker: VerificationTracker | undefined;
let dpdDebounceTimer: NodeJS.Timeout | undefined;
let autoGraphInFlight = false;
let dpdInFlight = false;
let vsRocqInstalled = false;
// Evita repetir la notificación de "coq-dpdgraph ausente" en cada ciclo de
// auto-graph. Se muestra una vez por sesión.
let dpdgraphMissingNotified = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage(
      'Rocql: abre una carpeta de workspace para activar la extensión.',
    );
    return;
  }

  // No tiene sentido crear .rocql/graph.gdb en proyectos sin Rocq.
  // El activationEvent `workspaceContains:**/*.v` ya evita activar la
  // extensión en esos casos; esto cubre activaciones por otras vías
  // (p. ej. invocar un comando) y workspaces donde los únicos .v están
  // bajo node_modules / _build / .rocql.
  const vFiles = await vscode.workspace.findFiles(
    '**/*.v',
    '**/{node_modules,_build,.rocql}/**',
    1,
  );
  if (vFiles.length === 0) {
    return;
  }

  const dir = path.join(folder.uri.fsPath, '.rocql');
  fs.mkdirSync(dir, { recursive: true });
  gdbPath = path.join(dir, 'graph.gdb');

  // En esta versión de frogql, `open()` no crea el archivo si no existe.
  // Bootstrap: si no hay .gdb, importamos un grafo vacío para tener uno.
  if (!fs.existsSync(gdbPath)) {
    const emptyJson = path.join(dir, '_empty.json');
    fs.writeFileSync(
      emptyJson,
      JSON.stringify({
        nodes: [],
        edges: [],
        _meta: { files: [], node_count: 0, edge_count: 0, duplicate_names: [] },
      }),
    );
    try {
      importJson(gdbPath, emptyJson);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Rocql: no pude crear ${gdbPath}: ${String(err)}`,
      );
      return;
    } finally {
      try {
        fs.unlinkSync(emptyJson);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    connection = open(gdbPath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Rocql: no pude abrir ${gdbPath}: ${String(err)}`,
    );
    return;
  }

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBar.command = 'rocqGraph.openGraphPanel';
  statusBar.tooltip = `Rocql database: ${gdbPath}`;
  refreshStatusBar();
  context.subscriptions.push(statusBar);

  cursorStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99,
  );
  cursorStatusBar.command = 'rocqGraph.toggleCursorScope';
  refreshCursorStatusBar();
  context.subscriptions.push(cursorStatusBar);

  autoGraphStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    98,
  );
  autoGraphStatusBar.command = 'rocqGraph.toggleAutoGraph';
  vsRocqInstalled = isVsRocqInstalled();
  refreshAutoGraphStatusBar();
  context.subscriptions.push(autoGraphStatusBar);

  // Los tres items de la barra solo tienen sentido sobre archivos Rocq.
  // Mostrarlos/ocultarlos según el editor activo en vez de dejarlos fijos.
  updateStatusBarVisibility();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatusBarVisibility),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rocqGraph.openGraphPanel', () =>
      openGraphPanel(context),
    ),
    vscode.commands.registerCommand('rocqGraph.showInGraph', () =>
      showInGraph(context, false),
    ),
    vscode.commands.registerCommand('rocqGraph.showInGraphIsolated', () =>
      showInGraph(context, true),
    ),
    vscode.commands.registerCommand('rocqGraph.findReferences', () =>
      findReferences(),
    ),
    vscode.commands.registerCommand('rocqGraph.goToDefinition', () =>
      goToDefinition(),
    ),
    vscode.commands.registerCommand('rocqGraph.toggleCursorScope', () =>
      toggleCursorScope(),
    ),
    vscode.commands.registerCommand('rocqGraph.toggleAutoGraph', () =>
      toggleAutoGraph(),
    ),
    vscode.commands.registerCommand('rocqGraph.buildGraph', () =>
      runBuild(),
    ),
    vscode.commands.registerCommand('rocqGraph.buildGraphFull', () =>
      runBuildFull(),
    ),
    vscode.commands.registerCommand('rocqGraph.jumpToPaper', () =>
      jumpToPaper(),
    ),
    vscode.languages.registerDefinitionProvider(
      { pattern: '**/*.v', scheme: 'file' },
      { provideDefinition: provideRocqDefinition },
    ),
  );

  vscode.window.registerWebviewPanelSerializer('rocqGraph.panel', {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
      panel = webviewPanel;
      wirePanel(context, panel);
      runDefault(panel);
      emitCursorScope();
    },
  });

  // Cursor scope ON por defecto.
  toggleCursorScope();

  // Auto-graph: respetar el estado persistido en config (default false).
  const persistedAuto = vscode.workspace
    .getConfiguration('rocqGraph')
    .get<boolean>('autoGraph.enabled', false);
  if (persistedAuto) setAutoGraph(true);

  context.subscriptions.push({
    dispose: () => {
      connection = undefined;
      if (dpdDebounceTimer) clearTimeout(dpdDebounceTimer);
      while (autoGraphSubs.length) autoGraphSubs.pop()?.dispose();
    },
  });
}

/**
 * Muestra los items de la barra solo cuando el editor activo es un archivo
 * Rocq. Cuando el foco está fuera de un editor de texto (webview del grafo,
 * terminal, settings) `activeTextEditor` es undefined: ahí mantenemos el
 * estado actual en vez de ocultar, para no parpadear al usar el panel del
 * grafo (mismo criterio que `emitCursorScope`).
 */
function updateStatusBarVisibility(): void {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const isRocq =
    ed.document.languageId === 'coq' || ed.document.fileName.endsWith('.v');
  for (const item of [statusBar, cursorStatusBar, autoGraphStatusBar]) {
    if (!item) continue;
    if (isRocq) item.show();
    else item.hide();
  }
}

function refreshCursorStatusBar(): void {
  if (!cursorStatusBar) return;
  if (cursorScopeEnabled) {
    cursorStatusBar.text = '$(eye) Cursor scope: on';
    cursorStatusBar.tooltip =
      'Click para apagar. El grafo oculta lo definido después del cursor en el archivo activo.';
  } else {
    cursorStatusBar.text = '$(eye-closed) Cursor scope: off';
    cursorStatusBar.tooltip =
      'Click para encender. El grafo va a ocultar lo definido después del cursor en el archivo activo.';
  }
}

function emitCursorScope(): void {
  if (!panel || !cursorScopeEnabled) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.v')) {
    // El foco no está en un .v (puede estar en el webview, terminal, etc.).
    // Mantener el último estado en lugar de limpiar.
    return;
  }
  const file = activeRelpath(editor.document);
  const line = editor.selection.active.line + 1;
  panel.webview.postMessage({
    type: 'cursorScope',
    enabled: true,
    file,
    line,
  });
}

function scheduleCursorEmit(): void {
  if (cursorScopeDebounce) clearTimeout(cursorScopeDebounce);
  cursorScopeDebounce = setTimeout(emitCursorScope, 200);
}

function toggleCursorScope(): void {
  cursorScopeEnabled = !cursorScopeEnabled;
  refreshCursorStatusBar();
  if (cursorScopeEnabled) {
    cursorScopeSubs.push(
      vscode.window.onDidChangeTextEditorSelection(scheduleCursorEmit),
      vscode.window.onDidChangeActiveTextEditor(scheduleCursorEmit),
    );
    emitCursorScope();
  } else {
    while (cursorScopeSubs.length) cursorScopeSubs.pop()?.dispose();
    if (cursorScopeDebounce) clearTimeout(cursorScopeDebounce);
    panel?.webview.postMessage({ type: 'cursorScope', enabled: false });
  }
}

async function runBuild(): Promise<void> {
  if (!gdbPath) {
    vscode.window.showWarningMessage('Rocql: el workspace no está inicializado.');
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Rocql: building (textual)',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Searching .v files…' });
      const uris = await vscode.workspace.findFiles(
        '**/*.v',
        '**/{node_modules,_build,.rocql}/**',
      );
      if (uris.length === 0) {
        vscode.window.showWarningMessage(
          'Rocql: no encontré archivos .v en el workspace.',
        );
        return;
      }
      progress.report({ message: `Parsing ${uris.length} .v files…` });
      // Discover CoqProject for accurate module-to-file mapping. Es barato
      // (solo lee _CoqProject si existe) y mejora la resolución de imports
      // qualificados como `Require Import Sub.Foo.`.
      const project = discoverCoqProject(
        folder.uri.fsPath,
        uris.map((u) => u.fsPath),
      );
      const moduleToFile = coqProjectModuleToFile(project, folder.uri.fsPath);
      const graph = buildTextualGraph(uris, folder.uri.fsPath, moduleToFile);
      progress.report({ message: `Importing…` });
      const ok = await importGraphIntoGdb(graph, folder.uri.fsPath);
      if (!ok) return;
      vscode.window.showInformationMessage(
        `Rocql: ${graph.nodes.length} nodes, ${graph.edges.length} edges from ${uris.length} files.`,
      );
    },
  );
}

async function runBuildFull(): Promise<void> {
  if (!gdbPath) {
    vscode.window.showWarningMessage('Rocql: el workspace no está inicializado.');
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Rocql: building (full, with dpdgraph)',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Searching .v files…' });
      const uris = await vscode.workspace.findFiles(
        '**/*.v',
        '**/{node_modules,_build,.rocql}/**',
      );
      if (uris.length === 0) {
        vscode.window.showWarningMessage(
          'Rocql: no encontré archivos .v en el workspace.',
        );
        return;
      }
      progress.report({ message: 'Discovering Coq project…' });
      const rootDir = folder.uri.fsPath;
      const absFiles = uris.map((u) => u.fsPath);
      const project = discoverCoqProject(rootDir, absFiles);
      const moduleToFile = coqProjectModuleToFile(project, rootDir);

      progress.report({ message: `Parsing ${uris.length} .v files…` });
      const textual = buildTextualGraph(uris, rootDir, moduleToFile);

      if (project.modules.size === 0) {
        vscode.window.showWarningMessage(
          'Rocql: no pude mapear archivos .v a módulos Coq. Falling back al build textual.',
        );
        const ok = await importGraphIntoGdb(textual, rootDir);
        if (!ok) return;
        return;
      }

      progress.report({
        message: `Harvesting dpdgraph (${project.modules.size} modules)…`,
      });
      const cacheDir = path.join(rootDir, '.rocql', 'dpd');
      const harvest = await harvestDpdgraph({
        project,
        cacheDir,
        onProgress: (msg) => progress.report({ message: msg }),
      });

      let graph: BuiltGraph;
      let mergeNote = '';
      // `error` solo se setea cuando NO compiló ningún módulo. Si hubo algunos
      // exitosos, harvest.graph contiene su subconjunto y entramos al merge.
      if (harvest.dpdgraphMissing) {
        await showDpdgraphMissingMessage();
        graph = textual;
      } else if (harvest.error) {
        vscode.window.showWarningMessage(
          `Rocql: dpdgraph falló entero (${harvest.error.slice(0, 120)}…). Sigo con el textual puro.`,
        );
        graph = textual;
      } else {
        progress.report({ message: 'Merging textual + dpdgraph…' });
        const merged = mergeGraphs(textual, harvest.graph, moduleToFile);
        graph = merged.graph;
        const s = merged.stats;
        mergeNote =
          ` (merged: ${s.matchedNodes} matched, ${s.unmatchedDpdNodes} unmatched, ${s.enrichedEdges} enriched, ${s.addedElaboratedEdges} elaborated)`;
        if (harvest.skipped && harvest.skipped.length > 0) {
          const list = harvest.skipped.map((s) => s.module).join(', ');
          vscode.window.showWarningMessage(
            `Rocql: ${harvest.skipped.length} módulo(s) sin enrichment por errores de compilación: ${list}. Detalle en Output → Extension Host.`,
          );
        }
      }

      progress.report({ message: 'Importing…' });
      const ok = await importGraphIntoGdb(graph, rootDir);
      if (!ok) return;
      vscode.window.showInformationMessage(
        `Rocql: ${graph.nodes.length} nodes, ${graph.edges.length} edges from ${uris.length} files.${mergeNote}`,
      );
    },
  );
}

function buildTextualGraph(
  uris: vscode.Uri[],
  rootDir: string,
  moduleToFile?: Map<string, string>,
): BuiltGraph {
  const inputs = uris.map((u) => ({
    path: u.fsPath,
    relpath: path.relative(rootDir, u.fsPath),
    text: fs.readFileSync(u.fsPath, 'utf8'),
  }));
  return buildGraph(inputs, moduleToFile ? { moduleToFile } : undefined);
}

/** Construye `dotted module name -> relpath` desde un CoqProject. */
function coqProjectModuleToFile(
  project: {
    moduleToPath: Map<string, string>;
  },
  // Relativo al workspace, no a project.rootDir: los node ids del grafo
  // textual usan relpaths contra el workspace, y project.rootDir puede ser
  // un subdirectorio (donde vive el _CoqProject / _RocqProject).
  workspaceRoot: string,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [modName, absPath] of project.moduleToPath) {
    m.set(modName, path.relative(workspaceRoot, absPath));
  }
  return m;
}

/** Persiste el grafo al .gdb. Devuelve false si algo falla (ya mostró mensaje). */
async function importGraphIntoGdb(
  graph: BuiltGraph,
  workspaceFsPath: string,
): Promise<boolean> {
  if (!gdbPath) return false;
  const dir = path.join(workspaceFsPath, '.rocql');
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'graph.json');
  fs.writeFileSync(jsonPath, JSON.stringify(graph));

  // Soltar la conexión activa antes de sobrescribir el archivo. napi-rs
  // libera el handle cuando JS GC la recolecta — no es determinístico, así
  // que también borramos el archivo viejo para forzar a importJson a
  // empezar de cero.
  connection = undefined;
  try {
    if (fs.existsSync(gdbPath)) fs.rmSync(gdbPath);
  } catch (err) {
    console.warn('rm gdb failed:', err);
  }
  try {
    importJson(gdbPath, jsonPath);
  } catch (err) {
    vscode.window.showErrorMessage(`Rocql: import falló: ${String(err)}`);
    return false;
  }
  try {
    connection = open(gdbPath);
  } catch (err) {
    vscode.window.showErrorMessage(`Rocql: reopen falló: ${String(err)}`);
    return false;
  }
  try {
    fs.unlinkSync(jsonPath);
  } catch (err) {
    console.warn('rm graph.json failed:', err);
  }
  refreshStatusBar();
  if (panel) {
    runDefault(panel);
    emitCursorScope();
  }
  return true;
}

// Mismo léxico Unicode que el builder, para que Cmd+Click seleccione la
// palabra completa sobre identificadores como `αi64`. El flag `u` es necesario
// para que las propiedades Unicode (\p{L} etc.) tengan efecto.
const ROCQ_IDENT_RE = new RegExp(IDENT, 'u');

function symbolUnderCursor(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const range = editor.document.getWordRangeAtPosition(
    editor.selection.active,
    ROCQ_IDENT_RE,
  );
  if (!range) return undefined;
  const text = editor.document.getText(range);
  return text.includes('.') ? text.split('.').pop() : text;
}

function escapeGqlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function showInGraph(
  context: vscode.ExtensionContext,
  isolate: boolean,
): void {
  if (!connection) return;
  const sym = symbolUnderCursor();
  if (!sym) {
    vscode.window.showWarningMessage(
      'Rocql: poné el cursor sobre un identificador.',
    );
    return;
  }
  let rows: unknown[];
  try {
    rows = connection.execute(
      `(n) WHERE n.name = '${escapeGqlString(sym)}'`,
      10,
    ) as unknown[];
  } catch (err) {
    vscode.window.showErrorMessage(`Rocql: ${String(err)}`);
    return;
  }
  const first = (rows[0] as Record<string, unknown> | undefined) ?? undefined;
  const paths = first?._paths as Array<Array<NodeRef>> | undefined;
  const node =
    paths?.[0]?.[0] ??
    (first && Object.values(first).find(
      (v) => (v as { kind?: string } | undefined)?.kind === 'node',
    )) as NodeRef | undefined;
  if (!node || node.kind !== 'node') {
    vscode.window.showWarningMessage(
      `Rocql: ${sym} no está en el grafo.`,
    );
    return;
  }
  if (!panel) {
    openGraphPanel(context);
  } else {
    panel.reveal(undefined, true);
  }
  panel?.webview.postMessage({
    type: 'focusNode',
    id: node.id,
    name: sym,
    isolate,
  });
}

type DefCandidate = { file: string; line: number; name?: string; kind?: string };

/** Devuelve el path relativo al workspace del documento (con fallback al basename). */
function activeRelpath(document: vscode.TextDocument): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const rel = path.relative(folder.uri.fsPath, document.fileName);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return path.basename(document.fileName);
}

/**
 * Encuentra el entry textual top-level que rodea la posición del cursor.
 * Usa los byte ranges (head_start / proof_end) guardados por buildGraph.
 */
async function findEnclosingEntry(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<{ name: string; file: string } | undefined> {
  if (!connection) return undefined;
  const file = activeRelpath(document);
  const head = document.getText(
    new vscode.Range(new vscode.Position(0, 0), position),
  );
  const byteOffset = Buffer.byteLength(head, 'utf8');

  let rows: unknown[];
  try {
    rows = connection.execute(
      `(c) WHERE c.file = '${escapeGqlString(file)}'`,
      20000,
    ) as unknown[];
  } catch {
    return undefined;
  }
  let best: { name: string; file: string; headStart: number } | undefined;
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const paths = row?._paths as Array<Array<NodeRef>> | undefined;
    const node =
      paths?.[0]?.[0] ??
      (Object.values(row).find(
        (v) => (v as { kind?: string } | undefined)?.kind === 'node',
      ) as NodeRef | undefined);
    if (!node || node.kind !== 'node') continue;
    const props = node.props ?? {};
    const headStart = props.head_start as number | undefined;
    const proofEnd =
      (props.proof_end as number | undefined) ??
      (props.head_end as number | undefined);
    if (typeof headStart !== 'number' || typeof proofEnd !== 'number') continue;
    if (headStart <= byteOffset && proofEnd > byteOffset) {
      // Si hay anidamiento (raro en top-level), preferimos el más interno.
      if (!best || headStart > best.headStart) {
        best = {
          name: String(props.name ?? ''),
          file: String(props.file ?? file),
          headStart,
        };
      }
    }
  }
  return best ? { name: best.name, file: best.file } : undefined;
}

/**
 * Busca destinos de aristas que salen del entry `enclosing` hacia un nodo
 * con `name = sym`. Usa el textual local-first resolution implícito.
 */
async function resolveByEnclosingEdge(
  enclosing: { name: string; file: string },
  sym: string,
): Promise<DefCandidate[]> {
  if (!connection) return [];
  let rows: unknown[];
  try {
    rows = connection.execute(
      `(c)-[]->(x) WHERE c.name = '${escapeGqlString(enclosing.name)}'` +
        ` AND c.file = '${escapeGqlString(enclosing.file)}'` +
        ` AND x.name = '${escapeGqlString(sym)}'`,
      20,
    ) as unknown[];
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: DefCandidate[] = [];
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const paths = row?._paths as Array<Array<NodeRef | EdgeRef>> | undefined;
    const path0 = paths?.[0];
    if (!path0 || path0.length < 3) continue;
    const tgt = path0[2] as NodeRef;
    if (tgt?.kind !== 'node') continue;
    const props = tgt.props ?? {};
    const file = props.file as string | undefined;
    const line = props.line as number | undefined;
    if (!file || !line) continue;
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      file,
      line,
      name: String(props.name ?? sym),
      kind: props.kind as string | undefined,
    });
  }
  return out;
}

/** Busca todos los nodos con `name = sym`. */
async function resolveByName(sym: string): Promise<DefCandidate[]> {
  if (!connection) return [];
  let rows: unknown[];
  try {
    rows = connection.execute(
      `(n) WHERE n.name = '${escapeGqlString(sym)}'`,
      20,
    ) as unknown[];
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: DefCandidate[] = [];
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const paths = row?._paths as Array<Array<NodeRef>> | undefined;
    const node =
      paths?.[0]?.[0] ??
      (Object.values(row).find(
        (v) => (v as { kind?: string } | undefined)?.kind === 'node',
      ) as NodeRef | undefined);
    if (!node || node.kind !== 'node') continue;
    const props = node.props ?? {};
    const file = props.file as string | undefined;
    const line = props.line as number | undefined;
    if (!file || !line) continue;
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      file,
      line,
      name: String(props.name ?? sym),
      kind: props.kind as string | undefined,
    });
  }
  return out;
}

/**
 * Estrategia en cascada:
 *   1. Si el cursor está dentro de un entry, seguir la arista saliente
 *      de ese entry hacia un nodo `sym`. Usa el local-first resolution
 *      del buildGraph textual.
 *   2. Filtrar por archivo activo (fallback si el cursor no cae en un
 *      entry conocido o no hay arista directa).
 *   3. Todos los matches.
 */
async function findDefinitionsFor(
  document: vscode.TextDocument,
  position: vscode.Position,
  sym: string,
): Promise<DefCandidate[]> {
  const enclosing = await findEnclosingEntry(document, position);
  if (enclosing && enclosing.name) {
    const byEdge = await resolveByEnclosingEdge(enclosing, sym);
    if (byEdge.length > 0) return byEdge;
  }
  const byName = await resolveByName(sym);
  if (byName.length === 0) return [];
  const activeFile = activeRelpath(document);
  const sameFile = byName.filter((c) => c.file === activeFile);
  return sameFile.length > 0 ? sameFile : byName;
}

async function candidatesToLocations(
  candidates: DefCandidate[],
): Promise<vscode.Location[]> {
  const fileToUri = new Map<string, vscode.Uri>();
  const locations: vscode.Location[] = [];
  for (const c of candidates) {
    let uri = fileToUri.get(c.file);
    if (!uri) {
      const matches = await vscode.workspace.findFiles(
        `**/${c.file}`,
        '**/{node_modules,_build,.rocql}/**',
        1,
      );
      if (matches.length === 0) continue;
      uri = matches[0];
      fileToUri.set(c.file, uri);
    }
    const zeroBased = Math.max(0, c.line - 1);
    const pos = new vscode.Position(zeroBased, 0);
    locations.push(new vscode.Location(uri, pos));
  }
  return locations;
}

async function provideRocqDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Location[] | undefined> {
  if (!connection) return undefined;
  const range = document.getWordRangeAtPosition(position, ROCQ_IDENT_RE);
  if (!range) return undefined;
  const word = document.getText(range);
  const sym = word.includes('.') ? word.split('.').pop()! : word;
  if (!sym) return undefined;
  const candidates = await findDefinitionsFor(document, position, sym);
  if (candidates.length === 0) return undefined;
  const locations = await candidatesToLocations(candidates);
  return locations.length > 0 ? locations : undefined;
}

async function goToDefinition(): Promise<void> {
  if (!connection) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage(
      'Rocql: necesito un editor activo.',
    );
    return;
  }
  const sym = symbolUnderCursor();
  if (!sym) {
    vscode.window.showWarningMessage(
      'Rocql: pon el cursor sobre un identificador.',
    );
    return;
  }
  const candidates = await findDefinitionsFor(
    editor.document,
    editor.selection.active,
    sym,
  );
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      `Rocql: ${sym} no está en el grafo. ¿Falta un rebuild?`,
    );
    return;
  }
  if (candidates.length === 1) {
    await openFile(candidates[0].file, candidates[0].line);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    candidates.map((d) => ({
      label: d.name ?? sym,
      description: d.kind ?? '',
      detail: `${d.file}:${d.line}`,
      def: d,
    })),
    {
      title: `Definiciones de ${sym} (${candidates.length})`,
      placeHolder: 'Seleccionar para abrir',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (pick) await openFile(pick.def.file, pick.def.line);
}

async function findReferences(): Promise<void> {
  if (!connection) return;
  const sym = symbolUnderCursor();
  if (!sym) {
    vscode.window.showWarningMessage(
      'Rocql: poné el cursor sobre un identificador.',
    );
    return;
  }
  let rows: unknown[];
  try {
    rows = connection.execute(
      `(s)-[e]->(t) WHERE t.name = '${escapeGqlString(sym)}'`,
      1_000,
    ) as unknown[];
  } catch (err) {
    vscode.window.showErrorMessage(`Rocql: ${String(err)}`);
    return;
  }
  type Ref = {
    name: string;
    file?: string;
    line?: number;
    edgeLabel: string;
    where?: string;
  };
  const refs: Ref[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const path = (row?._paths as Array<Array<NodeRef | EdgeRef>> | undefined)?.[0];
    if (!path || path.length < 3) continue;
    const src = path[0] as NodeRef;
    const edge = path[1] as EdgeRef;
    if (src?.kind !== 'node' || edge?.kind !== 'edge') continue;
    const props = src.props ?? {};
    const name = String(props.name ?? src.id);
    const file = props.file as string | undefined;
    const line = props.line as number | undefined;
    const edgeLabel = edge.labels[0] ?? '?';
    const eprops = edge.props as
      | { ref_kind?: string; where?: string }
      | undefined;
    const where = eprops?.ref_kind ?? eprops?.where;
    const key = `${src.id}:${edgeLabel}:${where ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ name, file, line, edgeLabel, where });
  }
  if (refs.length === 0) {
    vscode.window.showInformationMessage(
      `Rocql: nadie referencia a ${sym}.`,
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    refs.map((r) => ({
      label: r.name,
      description: r.where ? `${r.edgeLabel} · ${r.where}` : r.edgeLabel,
      detail: r.file ? `${r.file}:${r.line ?? '?'}` : undefined,
      ref: r,
    })),
    {
      title: `Referencias a ${sym} (${refs.length})`,
      placeHolder: 'Seleccionar para abrir',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (pick?.ref.file && pick.ref.line) {
    await openFile(pick.ref.file, pick.ref.line);
  }
}

/**
 * Salta desde la entrada Rocq bajo el cursor al punto correspondiente del PDF.
 *
 * Resuelve la entrada que encierra el cursor, busca su ancla `\rocqanchor{nombre}`
 * (o `\label{rocq:nombre}`) en los .tex del workspace, y delega el forward-sync a
 * LaTeX Workshop. Si no hay ancla, no hay a dónde saltar: se informa cómo crearla
 * y termina sin error.
 */
async function jumpToPaper(): Promise<void> {
  if (!connection) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'coq') {
    vscode.window.showWarningMessage(
      'Rocql: pon el cursor dentro de una entrada en un archivo .v.',
    );
    return;
  }
  const enclosing = await findEnclosingEntry(
    editor.document,
    editor.selection.active,
  );
  if (!enclosing || !enclosing.name) {
    vscode.window.showInformationMessage(
      'Rocql: el cursor no está dentro de una entrada Rocq.',
    );
    return;
  }
  const name = enclosing.name;

  const texUris = await vscode.workspace.findFiles(
    '**/*.tex',
    '**/{node_modules,.rocql,_build}/**',
  );
  const matches: { uri: vscode.Uri; line: number }[] = [];
  for (const uri of texUris) {
    let text: string;
    try {
      text = fs.readFileSync(uri.fsPath, 'utf8');
    } catch {
      continue;
    }
    const line = findAnchorLine(text, name);
    if (line !== undefined) matches.push({ uri, line });
  }

  if (matches.length === 0) {
    const copyMacro = 'Copiar macro';
    const choice = await vscode.window.showInformationMessage(
      `Rocql: no hay ancla para ${name} en el .tex. Agrega ` +
        `\\rocqanchor{${name}} junto al enunciado (y una vez el macro ` +
        `${ROCQ_ANCHOR_MACRO} en el preámbulo).`,
      copyMacro,
    );
    if (choice === copyMacro) {
      await vscode.env.clipboard.writeText(`\\rocqanchor{${name}}`);
    }
    return;
  }

  // Ante duplicados (p. ej. main vs supplementary), dejar elegir; si es único, ir directo.
  let target = matches[0];
  if (matches.length > 1) {
    const pick = await vscode.window.showQuickPick(
      matches.map((m) => ({
        label: vscode.workspace.asRelativePath(m.uri),
        description: `línea ${m.line}`,
        m,
      })),
      { title: `Ancla de ${name} en ${matches.length} archivos`, placeHolder: 'Elegir destino' },
    );
    if (!pick) return;
    target = pick.m;
  }

  const lw = vscode.extensions.getExtension('James-Yu.latex-workshop');
  const doc = await vscode.workspace.openTextDocument(target.uri);
  const texEditor = await vscode.window.showTextDocument(doc, { preview: false });
  const pos = new vscode.Position(target.line - 1, 0);
  texEditor.selection = new vscode.Selection(pos, pos);
  texEditor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter,
  );

  if (!lw) {
    vscode.window.showWarningMessage(
      'Rocql: instala LaTeX Workshop para sincronizar con el PDF. ' +
        'Abrí el .tex en el ancla igual.',
    );
    return;
  }
  try {
    await vscode.commands.executeCommand(
      'latex-workshop.synctexto',
      target.line,
      target.uri.fsPath,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Rocql: forward-sync falló: ${String(err)}. ¿Compilaste el PDF con SyncTeX?`,
    );
  }
}

export function deactivate(): void {
  connection = undefined;
}

function refreshStatusBar(): void {
  if (!statusBar || !connection) {
    return;
  }
  statusBar.text = `📊 ${connection.nodeCount} nodes`;
}

function openGraphPanel(context: vscode.ExtensionContext): void {
  if (!connection) {
    vscode.window.showWarningMessage(
      'Rocql: la conexión no está disponible. Recarga la ventana.',
    );
    return;
  }

  if (panel) {
    panel.reveal(undefined, true);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'rocqGraph.panel',
    'Rocql',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    },
  );
  wirePanel(context, panel);
  runDefault(panel);
  emitCursorScope();
}

function wirePanel(
  context: vscode.ExtensionContext,
  p: vscode.WebviewPanel,
): void {
  p.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  };
  p.onDidDispose(() => {
    panel = undefined;
  });
  p.webview.onDidReceiveMessage((msg) => {
    if (!msg) return;
    if (msg.type === 'openFile' && typeof msg.file === 'string') {
      const line =
        typeof msg.line === 'number' && msg.line > 0 ? msg.line : 1;
      void openFile(msg.file, line);
    } else if (msg.type === 'runQuery' && typeof msg.query === 'string') {
      runQuery(p, msg.query);
    } else if (msg.type === 'runDefault') {
      runDefault(p);
    } else if (msg.type === 'ready') {
      emitCursorScope();
    }
  });
  p.webview.html = renderHtml(p.webview, context.extensionUri);
}

async function openFile(file: string, line: number): Promise<void> {
  // `file` ahora es un relpath relativo al workspace (e.g. "src/Foo.v") o, por
  // compat con grafos viejos, podría ser solo el basename. Probamos primero el
  // path directo; si no existe, caemos al glob por basename.
  const folder = vscode.workspace.workspaceFolders?.[0];
  const candidate =
    folder && !path.isAbsolute(file)
      ? vscode.Uri.file(path.join(folder.uri.fsPath, file))
      : vscode.Uri.file(file);
  let target: vscode.Uri | undefined;
  try {
    await vscode.workspace.fs.stat(candidate);
    target = candidate;
  } catch {
    const matches = await vscode.workspace.findFiles(
      `**/${path.basename(file)}`,
      '**/{node_modules,_build,.rocql}/**',
      5,
    );
    if (matches.length === 0) {
      vscode.window.showWarningMessage(
        `Rocql: no encontré ${file} en el workspace.`,
      );
      return;
    }
    target = matches[0];
    if (matches.length > 1) {
      vscode.window.showInformationMessage(
        `Rocql: ${path.basename(file)} aparece ${matches.length} veces. Abrí ${vscode.workspace.asRelativePath(target)}.`,
      );
    }
  }
  // Buscar la tab abierta entre TODAS las tabs (incluye inactivas en la misma
  // columna). `visibleTextEditors` solo lista las activas; usaba ViewColumn.Beside
  // de fallback y abría una nueva columna cuando el archivo ya estaba abierto
  // pero inactivo.
  const allTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  const matchingTab = allTabs.find((t) => {
    const input = t.input;
    return (
      input instanceof vscode.TabInputText &&
      input.uri.fsPath === target!.fsPath
    );
  });
  const doc = await vscode.workspace.openTextDocument(target);
  const viewColumn =
    matchingTab?.group.viewColumn ?? vscode.ViewColumn.Active;
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn,
    preserveFocus: false,
  });
  const zeroBased = Math.max(0, line - 1);
  const pos = new vscode.Position(zeroBased, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter,
  );
}

function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'webview.html');
  let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
  const nonce = createNonce();
  html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
  html = html.replace(/\{\{nonce\}\}/g, nonce);
  return html;
}

function createNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function harvestRows(
  rows: unknown[],
  nodesMap: Map<number, NodeRef>,
  edges: VizEdge[],
  seenEdgeIds: Set<number>,
): void {
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const paths = row?._paths as Array<Array<NodeRef | EdgeRef>> | undefined;
    if (Array.isArray(paths)) {
      for (const path of paths) {
        for (let i = 0; i < path.length; i += 1) {
          const item = path[i];
          if (item?.kind === 'node') {
            nodesMap.set(item.id, item as NodeRef);
          } else if (item?.kind === 'edge') {
            if (seenEdgeIds.has(item.id)) continue;
            const prev = path[i - 1];
            const next = path[i + 1];
            if (prev?.kind === 'node' && next?.kind === 'node') {
              seenEdgeIds.add(item.id);
              edges.push({
                id: item.id,
                labels: (item as EdgeRef).labels,
                from: prev.id,
                to: next.id,
                props: (item as EdgeRef).props,
              });
            }
          }
        }
      }
    } else if (row) {
      for (const v of Object.values(row)) {
        const obj = v as { kind?: string; id?: number } | undefined;
        if (obj?.kind === 'node' && typeof obj.id === 'number') {
          nodesMap.set(obj.id, obj as NodeRef);
        }
      }
    }
  }
}

function sendGraph(
  target: vscode.WebviewPanel,
  nodesMap: Map<number, NodeRef>,
  edges: VizEdge[],
  query: string,
): void {
  if (!connection) return;
  target.webview.postMessage({
    type: 'graph',
    nodes: [...nodesMap.values()],
    edges,
    nodeCount: connection.nodeCount,
    edgeCount: connection.edgeCount,
    query,
  });
  refreshStatusBar();
}

function runDefault(target: vscode.WebviewPanel): void {
  if (!connection) return;
  const configured = vscode.workspace
    .getConfiguration('rocqGraph')
    .get<string>('defaultQuery', '')
    .trim();
  if (configured) {
    runQuery(target, configured);
    return;
  }
  try {
    const nodeRows = connection.execute('(n)', 1_000_000) as unknown[];
    const edgeRows = connection.execute(
      '()-[e]->()',
      1_000_000,
    ) as unknown[];
    const nodesMap = new Map<number, NodeRef>();
    const edges: VizEdge[] = [];
    const seenEdgeIds = new Set<number>();
    harvestRows(nodeRows, nodesMap, edges, seenEdgeIds);
    harvestRows(edgeRows, nodesMap, edges, seenEdgeIds);
    sendGraph(target, nodesMap, edges, '');
  } catch (err) {
    target.webview.postMessage({ type: 'error', message: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Auto-graph: rebuild incremental al guardar + dpdgraph al volverse verde.
// ---------------------------------------------------------------------------

function refreshAutoGraphStatusBar(): void {
  if (!autoGraphStatusBar) return;
  if (!autoGraphEnabled) {
    autoGraphStatusBar.text = '$(sync-ignored) Auto-graph: off';
    autoGraphStatusBar.tooltip =
      'Click para activar. El grafo se va a regenerar (diff incremental) al guardar un .v.';
    return;
  }
  if (dpdInFlight) {
    autoGraphStatusBar.text = '$(sync~spin) Auto-graph: enriching';
    autoGraphStatusBar.tooltip = 'Corriendo dpdgraph en background.';
    return;
  }
  if (autoGraphInFlight) {
    autoGraphStatusBar.text = '$(sync~spin) Auto-graph: updating';
    autoGraphStatusBar.tooltip = 'Aplicando delta textual.';
    return;
  }
  const enrichSuffix = vsRocqInstalled ? '' : ' (VsRocq missing — solo textual)';
  autoGraphStatusBar.text = `$(sync) Auto-graph: on${enrichSuffix}`;
  autoGraphStatusBar.tooltip =
    'Click para apagar. Diff incremental al guardar; dpdgraph cuando VsRocq deja de reportar errores.';
}

function toggleAutoGraph(): void {
  const next = !autoGraphEnabled;
  // Persistir en el workspace para que vuelva al mismo estado tras reload.
  void vscode.workspace
    .getConfiguration('rocqGraph')
    .update(
      'autoGraph.enabled',
      next,
      vscode.ConfigurationTarget.Workspace,
    );
  setAutoGraph(next);
}

function setAutoGraph(enabled: boolean): void {
  if (autoGraphEnabled === enabled) return;
  autoGraphEnabled = enabled;
  if (enabled) {
    if (connection && connection.nodeCount > 0) {
      try {
        lastBuiltGraph = hydrateBuiltFromGdb(connection);
        lastFingerprint = builtGraphFingerprint(lastBuiltGraph);
      } catch (err) {
        console.warn('autoGraph: hydrate failed', err);
        lastBuiltGraph = null;
        lastFingerprint = null;
      }
    } else {
      lastBuiltGraph = null;
      lastFingerprint = null;
    }
    autoGraphSubs.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void onVfileSaved(doc);
      }),
    );
    if (vsRocqInstalled) {
      verificationTracker = new VerificationTracker();
      autoGraphSubs.push(verificationTracker);
      autoGraphSubs.push(
        verificationTracker.onDidChange((evt) => {
          void handleVerification(evt);
        }),
      );
      verificationTracker.start();
    }
  } else {
    while (autoGraphSubs.length) autoGraphSubs.pop()?.dispose();
    if (dpdDebounceTimer) {
      clearTimeout(dpdDebounceTimer);
      dpdDebounceTimer = undefined;
    }
    verificationTracker = undefined;
    lastBuiltGraph = null;
    lastFingerprint = null;
  }
  refreshAutoGraphStatusBar();
}

async function onVfileSaved(doc: vscode.TextDocument): Promise<void> {
  if (!autoGraphEnabled) return;
  if (!doc.fileName.endsWith('.v')) return;
  if (!connection) return;
  if (autoGraphInFlight || dpdInFlight) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  autoGraphInFlight = true;
  refreshAutoGraphStatusBar();
  try {
    const uris = await vscode.workspace.findFiles(
      '**/*.v',
      '**/{node_modules,_build,.rocql}/**',
    );
    const project = discoverCoqProject(
      folder.uri.fsPath,
      uris.map((u) => u.fsPath),
    );
    const moduleToFile = coqProjectModuleToFile(project, folder.uri.fsPath);
    const newTextual = buildTextualGraph(
      uris,
      folder.uri.fsPath,
      moduleToFile,
    );
    // Arrastrar dpd_* y aristas elaboradas del estado previo; sin esto cada
    // save sin dpd-corrido borraría el enrichment hasta el próximo ciclo.
    const merged = lastBuiltGraph
      ? preserveEnrichmentBuilt(newTextual, lastBuiltGraph)
      : newTextual;
    await applyBuiltGraph(merged, folder.uri.fsPath, 'textual delta');
  } catch (err) {
    vscode.window.showErrorMessage(
      `Rocql: auto-graph error: ${String(err)}`,
    );
  } finally {
    autoGraphInFlight = false;
    refreshAutoGraphStatusBar();
  }
}

/**
 * Persiste un BuiltGraph al .gdb si tiene cambios respecto al último estado
 * conocido. Reusa importGraphIntoGdb (drop + importJson + reopen), que mide
 * ~25-35 ms para grafos del orden de 5k nodos/aristas. La alternativa de DML
 * incremental paga ~700 ms por MATCH (cache invalidation del LTJ), inviable
 * a esa frecuencia.
 */
async function applyBuiltGraph(
  next: BuiltGraph,
  workspaceFsPath: string,
  label: string,
): Promise<void> {
  const fp = builtGraphFingerprint(next);
  if (fp === lastFingerprint) return;
  const ok = await importGraphIntoGdb(next, workspaceFsPath);
  if (ok) {
    lastBuiltGraph = next;
    lastFingerprint = fp;
  } else {
    // Fall back: si falló el import, rehidratamos para no quedar con un
    // fingerprint que no refleja el estado real del .gdb.
    if (connection) {
      try {
        lastBuiltGraph = hydrateBuiltFromGdb(connection);
        lastFingerprint = builtGraphFingerprint(lastBuiltGraph);
      } catch {
        lastBuiltGraph = null;
        lastFingerprint = null;
      }
    }
    console.warn(`autoGraph: ${label} import failed`);
  }
}

async function handleVerification(evt: VerificationEvent): Promise<void> {
  if (!autoGraphEnabled) return;
  if (evt.state !== 'likely-green') return;
  const dpdOnGreen = vscode.workspace
    .getConfiguration('rocqGraph')
    .get<boolean>('autoGraph.dpdOnGreen', true);
  if (!dpdOnGreen) return;
  if (dpdDebounceTimer) clearTimeout(dpdDebounceTimer);
  // Debounce: si varios archivos transicionan a verde a la vez, hacer un solo
  // harvest para todos.
  dpdDebounceTimer = setTimeout(() => {
    dpdDebounceTimer = undefined;
    void runDpdEnrich();
  }, 1500);
}

async function runDpdEnrich(): Promise<void> {
  if (!autoGraphEnabled) return;
  if (!connection || !gdbPath) return;
  if (autoGraphInFlight || dpdInFlight) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  dpdInFlight = true;
  refreshAutoGraphStatusBar();
  try {
    const uris = await vscode.workspace.findFiles(
      '**/*.v',
      '**/{node_modules,_build,.rocql}/**',
    );
    if (uris.length === 0) return;
    const rootDir = folder.uri.fsPath;
    const project = discoverCoqProject(
      rootDir,
      uris.map((u) => u.fsPath),
    );
    if (project.modules.size === 0) return;
    const moduleToFile = coqProjectModuleToFile(project, rootDir);
    const textual = buildTextualGraph(uris, rootDir, moduleToFile);
    const cacheDir = path.join(rootDir, '.rocql', 'dpd');
    const harvest = await harvestDpdgraph({ project, cacheDir });
    if (harvest.dpdgraphMissing) {
      // Plugin ausente: avisar una vez y seguir con el textual sin enrichment.
      console.warn('autoGraph: coq-dpdgraph no instalado; sin enrichment.');
      if (!dpdgraphMissingNotified) {
        dpdgraphMissingNotified = true;
        await showDpdgraphMissingMessage();
      }
      return;
    }
    if (harvest.error) {
      // Cero módulos compilaron. Mantener el textual sin enrichment.
      console.warn(`autoGraph: dpd harvest skipped: ${harvest.error}`);
      return;
    }
    if (harvest.skipped && harvest.skipped.length > 0) {
      const list = harvest.skipped.map((s) => s.module).join(', ');
      console.warn(
        `autoGraph: dpd partial — sin enrichment para ${list}`,
      );
    }
    const merged = mergeGraphs(textual, harvest.graph, moduleToFile);
    await applyBuiltGraph(merged.graph, rootDir, 'dpd enrichment');
  } catch (err) {
    console.warn('autoGraph: dpd enrich error', err);
  } finally {
    dpdInFlight = false;
    refreshAutoGraphStatusBar();
  }
}

function runQuery(target: vscode.WebviewPanel, query: string): void {
  if (!connection) return;
  const trimmed = query.trim();
  if (!trimmed) {
    runDefault(target);
    return;
  }
  try {
    const rows = connection.execute(trimmed, 1_000_000) as unknown[];
    if (!Array.isArray(rows)) {
      target.webview.postMessage({
        type: 'error',
        message: 'La query no devolvió filas (¿es DDL o DML? Usa solo MATCH/path patterns).',
      });
      return;
    }
    const nodesMap = new Map<number, NodeRef>();
    const edges: VizEdge[] = [];
    const seenEdgeIds = new Set<number>();
    harvestRows(rows, nodesMap, edges, seenEdgeIds);
    sendGraph(target, nodesMap, edges, trimmed);
  } catch (err) {
    target.webview.postMessage({ type: 'error', message: String(err) });
  }
}
