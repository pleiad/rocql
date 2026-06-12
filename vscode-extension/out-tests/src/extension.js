"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const frogql_1 = require("frogql");
const buildGraph_1 = require("./buildGraph");
const coqProject_1 = require("./coqProject");
const dpdgraph_1 = require("./dpdgraph");
const mergeGraph_1 = require("./mergeGraph");
const autoGraph_1 = require("./autoGraph");
const verification_1 = require("./verification");
let connection;
let statusBar;
let cursorStatusBar;
let autoGraphStatusBar;
let panel;
let gdbPath;
let cursorScopeEnabled = false;
const cursorScopeSubs = [];
let cursorScopeDebounce;
// Auto-graph state.
let autoGraphEnabled = false;
const autoGraphSubs = [];
let lastBuiltGraph = null;
let lastFingerprint = null;
let verificationTracker;
let dpdDebounceTimer;
let autoGraphInFlight = false;
let dpdInFlight = false;
let vsRocqInstalled = false;
async function activate(context) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showWarningMessage('Rocq Graph: abre una carpeta de workspace para activar la extensión.');
        return;
    }
    // No tiene sentido crear .rocqgraph/graph.gdb en proyectos sin Rocq.
    // El activationEvent `workspaceContains:**/*.v` ya evita activar la
    // extensión en esos casos; esto cubre activaciones por otras vías
    // (p. ej. invocar un comando) y workspaces donde los únicos .v están
    // bajo node_modules / _build / .rocqgraph.
    const vFiles = await vscode.workspace.findFiles('**/*.v', '**/{node_modules,_build,.rocqgraph}/**', 1);
    if (vFiles.length === 0) {
        return;
    }
    const dir = path.join(folder.uri.fsPath, '.rocqgraph');
    fs.mkdirSync(dir, { recursive: true });
    gdbPath = path.join(dir, 'graph.gdb');
    // En esta versión de frogql, `open()` no crea el archivo si no existe.
    // Bootstrap: si no hay .gdb, importamos un grafo vacío para tener uno.
    if (!fs.existsSync(gdbPath)) {
        const emptyJson = path.join(dir, '_empty.json');
        fs.writeFileSync(emptyJson, JSON.stringify({
            nodes: [],
            edges: [],
            _meta: { files: [], node_count: 0, edge_count: 0, duplicate_names: [] },
        }));
        try {
            (0, frogql_1.importJson)(gdbPath, emptyJson);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Rocq Graph: no pude crear ${gdbPath}: ${String(err)}`);
            return;
        }
        finally {
            try {
                fs.unlinkSync(emptyJson);
            }
            catch {
                /* ignore */
            }
        }
    }
    try {
        connection = (0, frogql_1.open)(gdbPath);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Rocq Graph: no pude abrir ${gdbPath}: ${String(err)}`);
        return;
    }
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'rocqGraph.openGraphPanel';
    statusBar.tooltip = `Rocq Graph database: ${gdbPath}`;
    refreshStatusBar();
    statusBar.show();
    context.subscriptions.push(statusBar);
    cursorStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    cursorStatusBar.command = 'rocqGraph.toggleCursorScope';
    refreshCursorStatusBar();
    cursorStatusBar.show();
    context.subscriptions.push(cursorStatusBar);
    autoGraphStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    autoGraphStatusBar.command = 'rocqGraph.toggleAutoGraph';
    vsRocqInstalled = (0, verification_1.isVsRocqInstalled)();
    refreshAutoGraphStatusBar();
    autoGraphStatusBar.show();
    context.subscriptions.push(autoGraphStatusBar);
    context.subscriptions.push(vscode.commands.registerCommand('rocqGraph.openGraphPanel', () => openGraphPanel(context)), vscode.commands.registerCommand('rocqGraph.showInGraph', () => showInGraph(context, false)), vscode.commands.registerCommand('rocqGraph.showInGraphIsolated', () => showInGraph(context, true)), vscode.commands.registerCommand('rocqGraph.findReferences', () => findReferences()), vscode.commands.registerCommand('rocqGraph.goToDefinition', () => goToDefinition()), vscode.commands.registerCommand('rocqGraph.toggleCursorScope', () => toggleCursorScope()), vscode.commands.registerCommand('rocqGraph.toggleAutoGraph', () => toggleAutoGraph()), vscode.commands.registerCommand('rocqGraph.buildGraph', () => runBuild()), vscode.commands.registerCommand('rocqGraph.buildGraphFull', () => runBuildFull()), vscode.languages.registerDefinitionProvider({ pattern: '**/*.v', scheme: 'file' }, { provideDefinition: provideRocqDefinition }));
    vscode.window.registerWebviewPanelSerializer('rocqGraph.panel', {
        async deserializeWebviewPanel(webviewPanel) {
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
        .get('autoGraph.enabled', false);
    if (persistedAuto)
        setAutoGraph(true);
    context.subscriptions.push({
        dispose: () => {
            connection = undefined;
            if (dpdDebounceTimer)
                clearTimeout(dpdDebounceTimer);
            while (autoGraphSubs.length)
                autoGraphSubs.pop()?.dispose();
        },
    });
}
function refreshCursorStatusBar() {
    if (!cursorStatusBar)
        return;
    if (cursorScopeEnabled) {
        cursorStatusBar.text = '$(eye) Cursor scope: on';
        cursorStatusBar.tooltip =
            'Click para apagar. El grafo oculta lo definido después del cursor en el archivo activo.';
    }
    else {
        cursorStatusBar.text = '$(eye-closed) Cursor scope: off';
        cursorStatusBar.tooltip =
            'Click para encender. El grafo va a ocultar lo definido después del cursor en el archivo activo.';
    }
}
function emitCursorScope() {
    if (!panel || !cursorScopeEnabled)
        return;
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
function scheduleCursorEmit() {
    if (cursorScopeDebounce)
        clearTimeout(cursorScopeDebounce);
    cursorScopeDebounce = setTimeout(emitCursorScope, 200);
}
function toggleCursorScope() {
    cursorScopeEnabled = !cursorScopeEnabled;
    refreshCursorStatusBar();
    if (cursorScopeEnabled) {
        cursorScopeSubs.push(vscode.window.onDidChangeTextEditorSelection(scheduleCursorEmit), vscode.window.onDidChangeActiveTextEditor(scheduleCursorEmit));
        emitCursorScope();
    }
    else {
        while (cursorScopeSubs.length)
            cursorScopeSubs.pop()?.dispose();
        if (cursorScopeDebounce)
            clearTimeout(cursorScopeDebounce);
        panel?.webview.postMessage({ type: 'cursorScope', enabled: false });
    }
}
async function runBuild() {
    if (!gdbPath) {
        vscode.window.showWarningMessage('Rocq Graph: el workspace no está inicializado.');
        return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder)
        return;
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Rocq Graph: building (textual)',
        cancellable: false,
    }, async (progress) => {
        progress.report({ message: 'Searching .v files…' });
        const uris = await vscode.workspace.findFiles('**/*.v', '**/{node_modules,_build,.rocqgraph}/**');
        if (uris.length === 0) {
            vscode.window.showWarningMessage('Rocq Graph: no encontré archivos .v en el workspace.');
            return;
        }
        progress.report({ message: `Parsing ${uris.length} .v files…` });
        // Discover CoqProject for accurate module-to-file mapping. Es barato
        // (solo lee _CoqProject si existe) y mejora la resolución de imports
        // qualificados como `Require Import Sub.Foo.`.
        const project = (0, coqProject_1.discoverCoqProject)(folder.uri.fsPath, uris.map((u) => u.fsPath));
        const moduleToFile = coqProjectModuleToFile(project, folder.uri.fsPath);
        const graph = buildTextualGraph(uris, folder.uri.fsPath, moduleToFile);
        progress.report({ message: `Importing…` });
        const ok = await importGraphIntoGdb(graph, folder.uri.fsPath);
        if (!ok)
            return;
        vscode.window.showInformationMessage(`Rocq Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges from ${uris.length} files.`);
    });
}
async function runBuildFull() {
    if (!gdbPath) {
        vscode.window.showWarningMessage('Rocq Graph: el workspace no está inicializado.');
        return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder)
        return;
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Rocq Graph: building (full, with dpdgraph)',
        cancellable: false,
    }, async (progress) => {
        progress.report({ message: 'Searching .v files…' });
        const uris = await vscode.workspace.findFiles('**/*.v', '**/{node_modules,_build,.rocqgraph}/**');
        if (uris.length === 0) {
            vscode.window.showWarningMessage('Rocq Graph: no encontré archivos .v en el workspace.');
            return;
        }
        progress.report({ message: 'Discovering Coq project…' });
        const rootDir = folder.uri.fsPath;
        const absFiles = uris.map((u) => u.fsPath);
        const project = (0, coqProject_1.discoverCoqProject)(rootDir, absFiles);
        const moduleToFile = coqProjectModuleToFile(project, rootDir);
        progress.report({ message: `Parsing ${uris.length} .v files…` });
        const textual = buildTextualGraph(uris, rootDir, moduleToFile);
        if (project.modules.size === 0) {
            vscode.window.showWarningMessage('Rocq Graph: no pude mapear archivos .v a módulos Coq. Falling back al build textual.');
            const ok = await importGraphIntoGdb(textual, rootDir);
            if (!ok)
                return;
            return;
        }
        progress.report({
            message: `Harvesting dpdgraph (${project.modules.size} modules)…`,
        });
        const cacheDir = path.join(rootDir, '.rocqgraph', 'dpd');
        const harvest = await (0, dpdgraph_1.harvestDpdgraph)({
            project,
            cacheDir,
            onProgress: (msg) => progress.report({ message: msg }),
        });
        let graph;
        let mergeNote = '';
        // `error` solo se setea cuando NO compiló ningún módulo. Si hubo algunos
        // exitosos, harvest.graph contiene su subconjunto y entramos al merge.
        if (harvest.error) {
            vscode.window.showWarningMessage(`Rocq Graph: dpdgraph falló entero (${harvest.error.slice(0, 120)}…). Sigo con el textual puro.`);
            graph = textual;
        }
        else {
            progress.report({ message: 'Merging textual + dpdgraph…' });
            const merged = (0, mergeGraph_1.mergeGraphs)(textual, harvest.graph, moduleToFile);
            graph = merged.graph;
            const s = merged.stats;
            mergeNote =
                ` (merged: ${s.matchedNodes} matched, ${s.unmatchedDpdNodes} unmatched, ${s.enrichedEdges} enriched, ${s.addedElaboratedEdges} elaborated)`;
            if (harvest.skipped && harvest.skipped.length > 0) {
                const list = harvest.skipped.map((s) => s.module).join(', ');
                vscode.window.showWarningMessage(`Rocq Graph: ${harvest.skipped.length} módulo(s) sin enrichment por errores de compilación: ${list}. Detalle en Output → Extension Host.`);
            }
        }
        progress.report({ message: 'Importing…' });
        const ok = await importGraphIntoGdb(graph, rootDir);
        if (!ok)
            return;
        vscode.window.showInformationMessage(`Rocq Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges from ${uris.length} files.${mergeNote}`);
    });
}
function buildTextualGraph(uris, rootDir, moduleToFile) {
    const inputs = uris.map((u) => ({
        path: u.fsPath,
        relpath: path.relative(rootDir, u.fsPath),
        text: fs.readFileSync(u.fsPath, 'utf8'),
    }));
    return (0, buildGraph_1.buildGraph)(inputs, moduleToFile ? { moduleToFile } : undefined);
}
/** Construye `dotted module name -> relpath` desde un CoqProject. */
function coqProjectModuleToFile(project, 
// Relativo al workspace, no a project.rootDir: los node ids del grafo
// textual usan relpaths contra el workspace, y project.rootDir puede ser
// un subdirectorio (donde vive el _CoqProject / _RocqProject).
workspaceRoot) {
    const m = new Map();
    for (const [modName, absPath] of project.moduleToPath) {
        m.set(modName, path.relative(workspaceRoot, absPath));
    }
    return m;
}
/** Persiste el grafo al .gdb. Devuelve false si algo falla (ya mostró mensaje). */
async function importGraphIntoGdb(graph, workspaceFsPath) {
    if (!gdbPath)
        return false;
    const dir = path.join(workspaceFsPath, '.rocqgraph');
    fs.mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, 'graph.json');
    fs.writeFileSync(jsonPath, JSON.stringify(graph));
    // Soltar la conexión activa antes de sobrescribir el archivo. napi-rs
    // libera el handle cuando JS GC la recolecta — no es determinístico, así
    // que también borramos el archivo viejo para forzar a importJson a
    // empezar de cero.
    connection = undefined;
    try {
        if (fs.existsSync(gdbPath))
            fs.rmSync(gdbPath);
    }
    catch (err) {
        console.warn('rm gdb failed:', err);
    }
    try {
        (0, frogql_1.importJson)(gdbPath, jsonPath);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Rocq Graph: import falló: ${String(err)}`);
        return false;
    }
    try {
        connection = (0, frogql_1.open)(gdbPath);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Rocq Graph: reopen falló: ${String(err)}`);
        return false;
    }
    try {
        fs.unlinkSync(jsonPath);
    }
    catch (err) {
        console.warn('rm graph.json failed:', err);
    }
    refreshStatusBar();
    if (panel) {
        runDefault(panel);
        emitCursorScope();
    }
    return true;
}
const ROCQ_IDENT_RE = /[A-Za-z_][A-Za-z0-9_']*/;
function symbolUnderCursor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return undefined;
    const range = editor.document.getWordRangeAtPosition(editor.selection.active, ROCQ_IDENT_RE);
    if (!range)
        return undefined;
    const text = editor.document.getText(range);
    return text.includes('.') ? text.split('.').pop() : text;
}
function escapeGqlString(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function showInGraph(context, isolate) {
    if (!connection)
        return;
    const sym = symbolUnderCursor();
    if (!sym) {
        vscode.window.showWarningMessage('Rocq Graph: poné el cursor sobre un identificador.');
        return;
    }
    let rows;
    try {
        rows = connection.execute(`(n) WHERE n.name = '${escapeGqlString(sym)}'`, 10);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Rocq Graph: ${String(err)}`);
        return;
    }
    const first = rows[0] ?? undefined;
    const paths = first?._paths;
    const node = paths?.[0]?.[0] ??
        (first && Object.values(first).find((v) => v?.kind === 'node'));
    if (!node || node.kind !== 'node') {
        vscode.window.showWarningMessage(`Rocq Graph: ${sym} no está en el grafo.`);
        return;
    }
    if (!panel) {
        openGraphPanel(context);
    }
    else {
        panel.reveal(undefined, true);
    }
    panel?.webview.postMessage({
        type: 'focusNode',
        id: node.id,
        name: sym,
        isolate,
    });
}
/** Devuelve el path relativo al workspace del documento (con fallback al basename). */
function activeRelpath(document) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
        const rel = path.relative(folder.uri.fsPath, document.fileName);
        if (!rel.startsWith('..') && !path.isAbsolute(rel))
            return rel;
    }
    return path.basename(document.fileName);
}
/**
 * Encuentra el entry textual top-level que rodea la posición del cursor.
 * Usa los byte ranges (head_start / proof_end) guardados por buildGraph.
 */
async function findEnclosingEntry(document, position) {
    if (!connection)
        return undefined;
    const file = activeRelpath(document);
    const head = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const byteOffset = Buffer.byteLength(head, 'utf8');
    let rows;
    try {
        rows = connection.execute(`(c) WHERE c.file = '${escapeGqlString(file)}'`, 20000);
    }
    catch {
        return undefined;
    }
    let best;
    for (const raw of rows) {
        const row = raw;
        const paths = row?._paths;
        const node = paths?.[0]?.[0] ??
            Object.values(row).find((v) => v?.kind === 'node');
        if (!node || node.kind !== 'node')
            continue;
        const props = node.props ?? {};
        const headStart = props.head_start;
        const proofEnd = props.proof_end ??
            props.head_end;
        if (typeof headStart !== 'number' || typeof proofEnd !== 'number')
            continue;
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
async function resolveByEnclosingEdge(enclosing, sym) {
    if (!connection)
        return [];
    let rows;
    try {
        rows = connection.execute(`(c)-[]->(x) WHERE c.name = '${escapeGqlString(enclosing.name)}'` +
            ` AND c.file = '${escapeGqlString(enclosing.file)}'` +
            ` AND x.name = '${escapeGqlString(sym)}'`, 20);
    }
    catch {
        return [];
    }
    const seen = new Set();
    const out = [];
    for (const raw of rows) {
        const row = raw;
        const paths = row?._paths;
        const path0 = paths?.[0];
        if (!path0 || path0.length < 3)
            continue;
        const tgt = path0[2];
        if (tgt?.kind !== 'node')
            continue;
        const props = tgt.props ?? {};
        const file = props.file;
        const line = props.line;
        if (!file || !line)
            continue;
        const key = `${file}:${line}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({
            file,
            line,
            name: String(props.name ?? sym),
            kind: props.kind,
        });
    }
    return out;
}
/** Busca todos los nodos con `name = sym`. */
async function resolveByName(sym) {
    if (!connection)
        return [];
    let rows;
    try {
        rows = connection.execute(`(n) WHERE n.name = '${escapeGqlString(sym)}'`, 20);
    }
    catch {
        return [];
    }
    const seen = new Set();
    const out = [];
    for (const raw of rows) {
        const row = raw;
        const paths = row?._paths;
        const node = paths?.[0]?.[0] ??
            Object.values(row).find((v) => v?.kind === 'node');
        if (!node || node.kind !== 'node')
            continue;
        const props = node.props ?? {};
        const file = props.file;
        const line = props.line;
        if (!file || !line)
            continue;
        const key = `${file}:${line}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({
            file,
            line,
            name: String(props.name ?? sym),
            kind: props.kind,
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
async function findDefinitionsFor(document, position, sym) {
    const enclosing = await findEnclosingEntry(document, position);
    if (enclosing && enclosing.name) {
        const byEdge = await resolveByEnclosingEdge(enclosing, sym);
        if (byEdge.length > 0)
            return byEdge;
    }
    const byName = await resolveByName(sym);
    if (byName.length === 0)
        return [];
    const activeFile = activeRelpath(document);
    const sameFile = byName.filter((c) => c.file === activeFile);
    return sameFile.length > 0 ? sameFile : byName;
}
async function candidatesToLocations(candidates) {
    const fileToUri = new Map();
    const locations = [];
    for (const c of candidates) {
        let uri = fileToUri.get(c.file);
        if (!uri) {
            const matches = await vscode.workspace.findFiles(`**/${c.file}`, '**/{node_modules,_build,.rocqgraph}/**', 1);
            if (matches.length === 0)
                continue;
            uri = matches[0];
            fileToUri.set(c.file, uri);
        }
        const zeroBased = Math.max(0, c.line - 1);
        const pos = new vscode.Position(zeroBased, 0);
        locations.push(new vscode.Location(uri, pos));
    }
    return locations;
}
async function provideRocqDefinition(document, position) {
    if (!connection)
        return undefined;
    const range = document.getWordRangeAtPosition(position, ROCQ_IDENT_RE);
    if (!range)
        return undefined;
    const word = document.getText(range);
    const sym = word.includes('.') ? word.split('.').pop() : word;
    if (!sym)
        return undefined;
    const candidates = await findDefinitionsFor(document, position, sym);
    if (candidates.length === 0)
        return undefined;
    const locations = await candidatesToLocations(candidates);
    return locations.length > 0 ? locations : undefined;
}
async function goToDefinition() {
    if (!connection)
        return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Rocq Graph: necesito un editor activo.');
        return;
    }
    const sym = symbolUnderCursor();
    if (!sym) {
        vscode.window.showWarningMessage('Rocq Graph: pon el cursor sobre un identificador.');
        return;
    }
    const candidates = await findDefinitionsFor(editor.document, editor.selection.active, sym);
    if (candidates.length === 0) {
        vscode.window.showInformationMessage(`Rocq Graph: ${sym} no está en el grafo. ¿Falta un rebuild?`);
        return;
    }
    if (candidates.length === 1) {
        await openFile(candidates[0].file, candidates[0].line);
        return;
    }
    const pick = await vscode.window.showQuickPick(candidates.map((d) => ({
        label: d.name ?? sym,
        description: d.kind ?? '',
        detail: `${d.file}:${d.line}`,
        def: d,
    })), {
        title: `Definiciones de ${sym} (${candidates.length})`,
        placeHolder: 'Seleccionar para abrir',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (pick)
        await openFile(pick.def.file, pick.def.line);
}
async function findReferences() {
    if (!connection)
        return;
    const sym = symbolUnderCursor();
    if (!sym) {
        vscode.window.showWarningMessage('Rocq Graph: poné el cursor sobre un identificador.');
        return;
    }
    let rows;
    try {
        rows = connection.execute(`(s)-[e]->(t) WHERE t.name = '${escapeGqlString(sym)}'`, 1_000);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Rocq Graph: ${String(err)}`);
        return;
    }
    const refs = [];
    const seen = new Set();
    for (const raw of rows) {
        const row = raw;
        const path = row?._paths?.[0];
        if (!path || path.length < 3)
            continue;
        const src = path[0];
        const edge = path[1];
        if (src?.kind !== 'node' || edge?.kind !== 'edge')
            continue;
        const props = src.props ?? {};
        const name = String(props.name ?? src.id);
        const file = props.file;
        const line = props.line;
        const edgeLabel = edge.labels[0] ?? '?';
        const eprops = edge.props;
        const where = eprops?.ref_kind ?? eprops?.where;
        const key = `${src.id}:${edgeLabel}:${where ?? ''}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        refs.push({ name, file, line, edgeLabel, where });
    }
    if (refs.length === 0) {
        vscode.window.showInformationMessage(`Rocq Graph: nadie referencia a ${sym}.`);
        return;
    }
    const pick = await vscode.window.showQuickPick(refs.map((r) => ({
        label: r.name,
        description: r.where ? `${r.edgeLabel} · ${r.where}` : r.edgeLabel,
        detail: r.file ? `${r.file}:${r.line ?? '?'}` : undefined,
        ref: r,
    })), {
        title: `Referencias a ${sym} (${refs.length})`,
        placeHolder: 'Seleccionar para abrir',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (pick?.ref.file && pick.ref.line) {
        await openFile(pick.ref.file, pick.ref.line);
    }
}
function deactivate() {
    connection = undefined;
}
function refreshStatusBar() {
    if (!statusBar || !connection) {
        return;
    }
    statusBar.text = `📊 ${connection.nodeCount} nodes`;
}
function openGraphPanel(context) {
    if (!connection) {
        vscode.window.showWarningMessage('Rocq Graph: la conexión no está disponible. Recarga la ventana.');
        return;
    }
    if (panel) {
        panel.reveal(undefined, true);
        return;
    }
    panel = vscode.window.createWebviewPanel('rocqGraph.panel', 'Rocq Graph', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    wirePanel(context, panel);
    runDefault(panel);
    emitCursorScope();
}
function wirePanel(context, p) {
    p.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
    p.onDidDispose(() => {
        panel = undefined;
    });
    p.webview.onDidReceiveMessage((msg) => {
        if (!msg)
            return;
        if (msg.type === 'openFile' && typeof msg.file === 'string') {
            const line = typeof msg.line === 'number' && msg.line > 0 ? msg.line : 1;
            void openFile(msg.file, line);
        }
        else if (msg.type === 'runQuery' && typeof msg.query === 'string') {
            runQuery(p, msg.query);
        }
        else if (msg.type === 'runDefault') {
            runDefault(p);
        }
        else if (msg.type === 'ready') {
            emitCursorScope();
        }
    });
    p.webview.html = renderHtml(p.webview, context.extensionUri);
}
async function openFile(file, line) {
    // `file` ahora es un relpath relativo al workspace (e.g. "src/Foo.v") o, por
    // compat con grafos viejos, podría ser solo el basename. Probamos primero el
    // path directo; si no existe, caemos al glob por basename.
    const folder = vscode.workspace.workspaceFolders?.[0];
    const candidate = folder && !path.isAbsolute(file)
        ? vscode.Uri.file(path.join(folder.uri.fsPath, file))
        : vscode.Uri.file(file);
    let target;
    try {
        await vscode.workspace.fs.stat(candidate);
        target = candidate;
    }
    catch {
        const matches = await vscode.workspace.findFiles(`**/${path.basename(file)}`, '**/{node_modules,_build,.rocqgraph}/**', 5);
        if (matches.length === 0) {
            vscode.window.showWarningMessage(`Rocq Graph: no encontré ${file} en el workspace.`);
            return;
        }
        target = matches[0];
        if (matches.length > 1) {
            vscode.window.showInformationMessage(`Rocq Graph: ${path.basename(file)} aparece ${matches.length} veces. Abrí ${vscode.workspace.asRelativePath(target)}.`);
        }
    }
    // Buscar la tab abierta entre TODAS las tabs (incluye inactivas en la misma
    // columna). `visibleTextEditors` solo lista las activas; usaba ViewColumn.Beside
    // de fallback y abría una nueva columna cuando el archivo ya estaba abierto
    // pero inactivo.
    const allTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const matchingTab = allTabs.find((t) => {
        const input = t.input;
        return (input instanceof vscode.TabInputText &&
            input.uri.fsPath === target.fsPath);
    });
    const doc = await vscode.workspace.openTextDocument(target);
    const viewColumn = matchingTab?.group.viewColumn ?? vscode.ViewColumn.Active;
    const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn,
        preserveFocus: false,
    });
    const zeroBased = Math.max(0, line - 1);
    const pos = new vscode.Position(zeroBased, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}
function renderHtml(webview, extensionUri) {
    const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'webview.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    const nonce = createNonce();
    html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
    html = html.replace(/\{\{nonce\}\}/g, nonce);
    return html;
}
function createNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i += 1) {
        out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
}
function harvestRows(rows, nodesMap, edges, seenEdgeIds) {
    for (const raw of rows) {
        const row = raw;
        const paths = row?._paths;
        if (Array.isArray(paths)) {
            for (const path of paths) {
                for (let i = 0; i < path.length; i += 1) {
                    const item = path[i];
                    if (item?.kind === 'node') {
                        nodesMap.set(item.id, item);
                    }
                    else if (item?.kind === 'edge') {
                        if (seenEdgeIds.has(item.id))
                            continue;
                        const prev = path[i - 1];
                        const next = path[i + 1];
                        if (prev?.kind === 'node' && next?.kind === 'node') {
                            seenEdgeIds.add(item.id);
                            edges.push({
                                id: item.id,
                                labels: item.labels,
                                from: prev.id,
                                to: next.id,
                                props: item.props,
                            });
                        }
                    }
                }
            }
        }
        else if (row) {
            for (const v of Object.values(row)) {
                const obj = v;
                if (obj?.kind === 'node' && typeof obj.id === 'number') {
                    nodesMap.set(obj.id, obj);
                }
            }
        }
    }
}
function sendGraph(target, nodesMap, edges, query) {
    if (!connection)
        return;
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
function runDefault(target) {
    if (!connection)
        return;
    const configured = vscode.workspace
        .getConfiguration('rocqGraph')
        .get('defaultQuery', '')
        .trim();
    if (configured) {
        runQuery(target, configured);
        return;
    }
    try {
        const nodeRows = connection.execute('(n)', 1_000_000);
        const edgeRows = connection.execute('()-[e]->()', 1_000_000);
        const nodesMap = new Map();
        const edges = [];
        const seenEdgeIds = new Set();
        harvestRows(nodeRows, nodesMap, edges, seenEdgeIds);
        harvestRows(edgeRows, nodesMap, edges, seenEdgeIds);
        sendGraph(target, nodesMap, edges, '');
    }
    catch (err) {
        target.webview.postMessage({ type: 'error', message: String(err) });
    }
}
// ---------------------------------------------------------------------------
// Auto-graph: rebuild incremental al guardar + dpdgraph al volverse verde.
// ---------------------------------------------------------------------------
function refreshAutoGraphStatusBar() {
    if (!autoGraphStatusBar)
        return;
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
function toggleAutoGraph() {
    const next = !autoGraphEnabled;
    // Persistir en el workspace para que vuelva al mismo estado tras reload.
    void vscode.workspace
        .getConfiguration('rocqGraph')
        .update('autoGraph.enabled', next, vscode.ConfigurationTarget.Workspace);
    setAutoGraph(next);
}
function setAutoGraph(enabled) {
    if (autoGraphEnabled === enabled)
        return;
    autoGraphEnabled = enabled;
    if (enabled) {
        if (connection && connection.nodeCount > 0) {
            try {
                lastBuiltGraph = (0, autoGraph_1.hydrateBuiltFromGdb)(connection);
                lastFingerprint = (0, autoGraph_1.builtGraphFingerprint)(lastBuiltGraph);
            }
            catch (err) {
                console.warn('autoGraph: hydrate failed', err);
                lastBuiltGraph = null;
                lastFingerprint = null;
            }
        }
        else {
            lastBuiltGraph = null;
            lastFingerprint = null;
        }
        autoGraphSubs.push(vscode.workspace.onDidSaveTextDocument((doc) => {
            void onVfileSaved(doc);
        }));
        if (vsRocqInstalled) {
            verificationTracker = new verification_1.VerificationTracker();
            autoGraphSubs.push(verificationTracker);
            autoGraphSubs.push(verificationTracker.onDidChange((evt) => {
                void handleVerification(evt);
            }));
            verificationTracker.start();
        }
    }
    else {
        while (autoGraphSubs.length)
            autoGraphSubs.pop()?.dispose();
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
async function onVfileSaved(doc) {
    if (!autoGraphEnabled)
        return;
    if (!doc.fileName.endsWith('.v'))
        return;
    if (!connection)
        return;
    if (autoGraphInFlight || dpdInFlight)
        return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder)
        return;
    autoGraphInFlight = true;
    refreshAutoGraphStatusBar();
    try {
        const uris = await vscode.workspace.findFiles('**/*.v', '**/{node_modules,_build,.rocqgraph}/**');
        const project = (0, coqProject_1.discoverCoqProject)(folder.uri.fsPath, uris.map((u) => u.fsPath));
        const moduleToFile = coqProjectModuleToFile(project, folder.uri.fsPath);
        const newTextual = buildTextualGraph(uris, folder.uri.fsPath, moduleToFile);
        // Arrastrar dpd_* y aristas elaboradas del estado previo; sin esto cada
        // save sin dpd-corrido borraría el enrichment hasta el próximo ciclo.
        const merged = lastBuiltGraph
            ? (0, autoGraph_1.preserveEnrichmentBuilt)(newTextual, lastBuiltGraph)
            : newTextual;
        await applyBuiltGraph(merged, folder.uri.fsPath, 'textual delta');
    }
    catch (err) {
        vscode.window.showErrorMessage(`Rocq Graph: auto-graph error: ${String(err)}`);
    }
    finally {
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
async function applyBuiltGraph(next, workspaceFsPath, label) {
    const fp = (0, autoGraph_1.builtGraphFingerprint)(next);
    if (fp === lastFingerprint)
        return;
    const ok = await importGraphIntoGdb(next, workspaceFsPath);
    if (ok) {
        lastBuiltGraph = next;
        lastFingerprint = fp;
    }
    else {
        // Fall back: si falló el import, rehidratamos para no quedar con un
        // fingerprint que no refleja el estado real del .gdb.
        if (connection) {
            try {
                lastBuiltGraph = (0, autoGraph_1.hydrateBuiltFromGdb)(connection);
                lastFingerprint = (0, autoGraph_1.builtGraphFingerprint)(lastBuiltGraph);
            }
            catch {
                lastBuiltGraph = null;
                lastFingerprint = null;
            }
        }
        console.warn(`autoGraph: ${label} import failed`);
    }
}
async function handleVerification(evt) {
    if (!autoGraphEnabled)
        return;
    if (evt.state !== 'likely-green')
        return;
    const dpdOnGreen = vscode.workspace
        .getConfiguration('rocqGraph')
        .get('autoGraph.dpdOnGreen', true);
    if (!dpdOnGreen)
        return;
    if (dpdDebounceTimer)
        clearTimeout(dpdDebounceTimer);
    // Debounce: si varios archivos transicionan a verde a la vez, hacer un solo
    // harvest para todos.
    dpdDebounceTimer = setTimeout(() => {
        dpdDebounceTimer = undefined;
        void runDpdEnrich();
    }, 1500);
}
async function runDpdEnrich() {
    if (!autoGraphEnabled)
        return;
    if (!connection || !gdbPath)
        return;
    if (autoGraphInFlight || dpdInFlight)
        return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder)
        return;
    dpdInFlight = true;
    refreshAutoGraphStatusBar();
    try {
        const uris = await vscode.workspace.findFiles('**/*.v', '**/{node_modules,_build,.rocqgraph}/**');
        if (uris.length === 0)
            return;
        const rootDir = folder.uri.fsPath;
        const project = (0, coqProject_1.discoverCoqProject)(rootDir, uris.map((u) => u.fsPath));
        if (project.modules.size === 0)
            return;
        const moduleToFile = coqProjectModuleToFile(project, rootDir);
        const textual = buildTextualGraph(uris, rootDir, moduleToFile);
        const cacheDir = path.join(rootDir, '.rocqgraph', 'dpd');
        const harvest = await (0, dpdgraph_1.harvestDpdgraph)({ project, cacheDir });
        if (harvest.error) {
            // Cero módulos compilaron. Mantener el textual sin enrichment.
            console.warn(`autoGraph: dpd harvest skipped: ${harvest.error}`);
            return;
        }
        if (harvest.skipped && harvest.skipped.length > 0) {
            const list = harvest.skipped.map((s) => s.module).join(', ');
            console.warn(`autoGraph: dpd partial — sin enrichment para ${list}`);
        }
        const merged = (0, mergeGraph_1.mergeGraphs)(textual, harvest.graph, moduleToFile);
        await applyBuiltGraph(merged.graph, rootDir, 'dpd enrichment');
    }
    catch (err) {
        console.warn('autoGraph: dpd enrich error', err);
    }
    finally {
        dpdInFlight = false;
        refreshAutoGraphStatusBar();
    }
}
function runQuery(target, query) {
    if (!connection)
        return;
    const trimmed = query.trim();
    if (!trimmed) {
        runDefault(target);
        return;
    }
    try {
        const rows = connection.execute(trimmed, 1_000_000);
        if (!Array.isArray(rows)) {
            target.webview.postMessage({
                type: 'error',
                message: 'La query no devolvió filas (¿es DDL o DML? Usa solo MATCH/path patterns).',
            });
            return;
        }
        const nodesMap = new Map();
        const edges = [];
        const seenEdgeIds = new Set();
        harvestRows(rows, nodesMap, edges, seenEdgeIds);
        sendGraph(target, nodesMap, edges, trimmed);
    }
    catch (err) {
        target.webview.postMessage({ type: 'error', message: String(err) });
    }
}
//# sourceMappingURL=extension.js.map