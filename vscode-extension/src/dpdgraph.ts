// Cosecha refs entre constantes vía coq-dpdgraph. Un dump por módulo.
//
// Por qué un dump por módulo y no `Print FileDependGraph M1 M2 ...` en una
// sola pasada: el comando combinado emite N: sin `path=` para nombres que no
// están "shadowed" en el contexto del último Require, lo cual borra la
// identidad de archivo cuando dos módulos definen un nombre igual (típico:
// fields como `edges` o `nodes` repetidos en records distintos). Aristas
// resultantes del merge terminan atadas al archivo equivocado.
//
// El comando `Print FileDependGraph M.` (un solo módulo) sí emite solo las
// constantes de M; cada nodo se atribuye a M sin ambigüedad. Cost: N
// invocaciones de `rocq compile`, todas baratas porque los .vo ya están en
// disco tras la pre-compilación.
//
// Tradeoff: aristas cross-file aportadas por el kernel se pierden (el comando
// per-module no las emite). Las aristas cross-file siguen llegando del textual,
// que ya las detecta por regex de identificadores. El kernel queda agregando
// aristas implícitas dentro-de-archivo (typeclasses, notations, tactics).

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CoqProject } from './coqProject';

export interface DpdNode {
  /** ID global tras renormalización entre dumps. */
  id: number;
  name: string;
  kind: string;
  body: boolean;
  prop: boolean;
  /** Módulo Coq del archivo del query (target). Identifica el .v. */
  sourceFile: string;
  /** Path relativo al archivo. Vacío si top-level; sino "Foo" o "Foo.Sub". */
  modulePath: string;
  /** Nombre qualificado relativo al archivo: `${modulePath}.${name}` o solo name. */
  qualifiedName: string;
}

export interface DpdEdge {
  src: number;
  tgt: number;
  weight: number;
}

export interface DpdGraph {
  nodes: DpdNode[];
  edges: DpdEdge[];
}

export interface HarvestResult {
  graph: DpdGraph;
  /** Solo presente si la cosecha falló entera (cero módulos cosechados). */
  error?: string;
  /** Módulos que no se compilaron y se saltearon (vacío si todo limpio). */
  skipped?: Array<{ module: string; reason: string }>;
  /**
   * true cuando `Require dpdgraph.dpdgraph` falló: el plugin coq-dpdgraph no
   * está instalado en el entorno Rocq activo. Es una condición global (ningún
   * query puede correr), distinta de un módulo que no compila. El caller debe
   * mostrar un mensaje accionable y caer al grafo textual.
   */
  dpdgraphMissing?: boolean;
}

/**
 * ¿El stderr de rocq indica que falta el plugin coq-dpdgraph? La firma es el
 * "Cannot find a physical path bound to logical path dpdgraph" que emite al no
 * resolver el `Require dpdgraph.dpdgraph` del query. Anclado a `dpdgraph` para
 * no confundirse con el mismo error sobre un módulo del proyecto.
 */
export function isDpdgraphMissingError(stderr: string): boolean {
  return /Cannot find a physical path bound to logical path\s+dpdgraph\b/.test(
    stderr,
  );
}

function writeQueryFile(cacheDir: string, allModules: string[], target: string, dpdName: string): string {
  const safeStem = target.replace(/[^A-Za-z0-9_]/g, '_');
  const queryPath = path.join(cacheDir, `_dpd_${safeStem}.v`);
  const imports = allModules.join(' ');
  const content =
    `(* Auto-generado por rocq-graph. No editar. *)\n` +
    `Require dpdgraph.dpdgraph.\n` +
    `Require Import ${imports}.\n` +
    `Set DependGraph File "${dpdName}".\n` +
    `Print FileDependGraph ${target}.\n`;
  fs.writeFileSync(queryPath, content);
  return queryPath;
}

/**
 * Devuelve `{cmd, args}` para invocar el compilador. Coq 8.x ofrece `coqc`
 * (invocación directa, sin subcomando), Rocq 9+ ofrece `rocq compile`.
 * Preferimos `rocq` si está disponible, caemos a `coqc` si no.
 *
 * Solo testeamos una vez por proceso; el resultado se cachea.
 */
let cachedRocqCmd: { cmd: string; useSubcommand: boolean } | undefined;
function resolveRocqCommand(): { cmd: string; useSubcommand: boolean } {
  if (cachedRocqCmd) return cachedRocqCmd;
  const PATH = process.env.PATH ?? '';
  const dirs = PATH.split(':').filter(Boolean);
  const exists = (name: string): boolean => {
    for (const d of dirs) {
      const p = `${d}/${name}`;
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        // no exec or missing
      }
    }
    return false;
  };
  if (exists('rocq')) {
    cachedRocqCmd = { cmd: 'rocq', useSubcommand: true };
  } else if (exists('coqc')) {
    cachedRocqCmd = { cmd: 'coqc', useSubcommand: false };
  } else {
    // Sin binario; igual devolvemos rocq para preservar el error legible
    // (spawn ENOENT con el nombre original).
    cachedRocqCmd = { cmd: 'rocq', useSubcommand: true };
  }
  return cachedRocqCmd;
}

function runRocq(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { cmd, useSubcommand } = resolveRocqCommand();
    const fullArgs = useSubcommand ? ['compile', ...args] : args;
    const child = spawn(cmd, fullArgs, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Quita comentarios (* ... *) anidados. Solo para detectar Require; no
 * preserva offsets. */
function stripCoqComments(text: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(' && text[i + 1] === '*') {
      depth += 1;
      i += 1;
      continue;
    }
    if (depth > 0 && text[i] === '*' && text[i + 1] === ')') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0) out += text[i];
  }
  return out;
}

const REQUIRE_RE =
  /(?:^|\s)(?:From\s+[A-Za-z_][A-Za-z0-9_'.]*\s+)?Require(?:\s+(?:Import|Export))?\s+((?:[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*\s+)*[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*)\s*\./g;

/**
 * Ordena los módulos del proyecto topológicamente según sus `Require`.
 * Sin esto la pre-compilación corre en orden de descubrimiento de archivos
 * y un módulo puede compilarse antes que sus dependencias (.vo ausente).
 *
 * Requires que no resuelven a módulos del proyecto (stdlib, dpdgraph) se
 * ignoran. Un dotted-name corto (`Require Import Foo`) matchea un módulo
 * largo (`lib.Foo`) por sufijo, solo si el match es único. Ante ciclos,
 * los módulos restantes conservan el orden original.
 */
export function topoSortModules(project: CoqProject): string[] {
  const names = [...project.modules.values()];
  const resolveRequire = (dotted: string): string | undefined => {
    if (project.moduleToPath.has(dotted)) return dotted;
    const matches = names.filter((n) => n.endsWith(`.${dotted}`));
    return matches.length === 1 ? matches[0] : undefined;
  };

  // deps.get(m) = módulos del proyecto que m requiere.
  const deps = new Map<string, Set<string>>();
  for (const name of names) deps.set(name, new Set());
  for (const [absFile, name] of project.modules) {
    let text: string;
    try {
      text = stripCoqComments(fs.readFileSync(absFile, 'utf8'));
    } catch {
      continue;
    }
    for (const m of text.matchAll(REQUIRE_RE)) {
      for (const dotted of m[1].split(/\s+/).filter(Boolean)) {
        const dep = resolveRequire(dotted);
        if (dep && dep !== name) deps.get(name)!.add(dep);
      }
    }
  }

  // Kahn estable: en cada ronda salen los módulos sin deps pendientes,
  // preservando el orden original dentro de la ronda.
  const sorted: string[] = [];
  const emitted = new Set<string>();
  let pending = names;
  while (pending.length > 0) {
    const ready = pending.filter((n) =>
      [...deps.get(n)!].every((d) => emitted.has(d)),
    );
    if (ready.length === 0) break; // ciclo: el resto va en orden original
    for (const n of ready) {
      sorted.push(n);
      emitted.add(n);
    }
    pending = pending.filter((n) => !emitted.has(n));
  }
  sorted.push(...pending);
  return sorted;
}

const NODE_RE = /^N:\s*(\d+)\s+"([^"]+)"\s*\[([^\]]*)\]\s*;?\s*$/;
const EDGE_RE = /^E:\s*(\d+)\s+(\d+)\s*\[([^\]]*)\]\s*;?\s*$/;

function parseAttrs(attrStr: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const raw of attrStr.split(',')) {
    const piece = raw.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const key = piece.slice(0, eq).trim();
    let value = piece.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs.set(key, value);
  }
  return attrs;
}

interface RawDump {
  nodes: Array<{
    localId: number;
    name: string;
    kind: string;
    body: boolean;
    prop: boolean;
    declaredPath: string;
  }>;
  edges: Array<{ src: number; tgt: number; weight: number }>;
}

export function parseDpd(text: string): RawDump {
  const nodes: RawDump['nodes'] = [];
  const edges: RawDump['edges'] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const nm = line.match(NODE_RE);
    if (nm) {
      const localId = parseInt(nm[1], 10);
      const name = nm[2];
      const attrs = parseAttrs(nm[3]);
      nodes.push({
        localId,
        name,
        kind: attrs.get('kind') ?? 'cnst',
        body: attrs.get('body') === 'yes',
        prop: attrs.get('prop') === 'yes',
        declaredPath: attrs.get('path') ?? '',
      });
      continue;
    }
    const em = line.match(EDGE_RE);
    if (em) {
      const src = parseInt(em[1], 10);
      const tgt = parseInt(em[2], 10);
      const attrs = parseAttrs(em[3]);
      const weight = parseInt(attrs.get('weight') ?? '1', 10);
      edges.push({ src, tgt, weight });
    }
  }
  return { nodes, edges };
}

/** Ejecuta el harvest. Un dump por módulo. */
export async function harvestDpdgraph(opts: {
  project: CoqProject;
  cacheDir: string;
  onProgress?: (msg: string) => void;
}): Promise<HarvestResult> {
  const { project, cacheDir, onProgress } = opts;
  fs.mkdirSync(cacheDir, { recursive: true });

  const modules = [...project.modules.values()];
  if (modules.length === 0) {
    return {
      graph: { nodes: [], edges: [] },
      error: 'no Coq modules discovered in workspace',
    };
  }

  // Pre-compilar los .v del proyecto. Sin esto, Require Import del query falla.
  // En orden topológico según los Require de cada archivo — compilar en orden
  // de descubrimiento rompe cuando A.v requiere B.v y B aún no tiene .vo.
  // Política tolerante: si un archivo no compila, lo reintentamos en pasadas
  // sucesivas (cubre deps que el regex de Require no resolvió) hasta que una
  // pasada completa no compile nada nuevo; lo que quede se marca saltado.
  const compiled = new Set<string>();
  const failReason = new Map<string, string>();
  onProgress?.(`Compiling ${modules.length} project modules…`);
  let pendingCompile = topoSortModules(project);
  for (;;) {
    const stillFailing: string[] = [];
    for (const modName of pendingCompile) {
      const absFile = project.moduleToPath.get(modName)!;
      const relFromRoot = path.relative(project.rootDir, absFile);
      const { code, stderr } = await runRocq(project.rootDir, [
        ...project.compileArgs,
        relFromRoot,
      ]);
      if (code === 0) {
        compiled.add(modName);
        failReason.delete(modName);
      } else {
        stillFailing.push(modName);
        failReason.set(modName, stderr.slice(0, 400));
      }
    }
    if (stillFailing.length === 0 || stillFailing.length === pendingCompile.length) {
      break; // todo limpio, o pasada sin progreso
    }
    pendingCompile = stillFailing;
  }
  const skipped: Array<{ module: string; reason: string }> = [];
  for (const [modName, reason] of failReason) {
    console.error(`[rocq-graph] compile failed on ${modName}:\n${reason}`);
    skipped.push({ module: modName, reason });
  }

  if (compiled.size === 0) {
    return {
      graph: { nodes: [], edges: [] },
      error: `no module compiled cleanly (${skipped.length} skipped)`,
      skipped,
    };
  }

  // Reescribir load paths a absolutos para que el query funcione desde cacheDir.
  const relCompileArgs = rebaseLoadPaths(project.compileArgs, project.rootDir);

  // Un dump por módulo. Merge progresivo a IDs globales.
  const allNodes: DpdNode[] = [];
  const allEdges: DpdEdge[] = [];
  // Key canónico para deduplicar nodos entre dumps: `${sourceModule}::${name}`
  // o `${declaredPath || sourceModule}::${name}` cuando declaredPath está.
  const nodeKeyToId = new Map<string, number>();
  let nextId = 1;

  // El query module requiere a todos los compilados; los saltados quedan
  // afuera del Require para evitar arrastrar el error a TODO el harvest.
  const compiledList = modules.filter((m) => compiled.has(m));
  for (let idx = 0; idx < compiledList.length; idx += 1) {
    const target = compiledList[idx];
    onProgress?.(`Harvesting ${target} (${idx + 1}/${compiledList.length})…`);
    const dpdName = `dpd_${idx}.dpd`;
    const queryPath = writeQueryFile(cacheDir, compiledList, target, dpdName);
    const queryBase = path.basename(queryPath);
    const { code, stderr } = await runRocq(cacheDir, [
      ...relCompileArgs,
      queryBase,
    ]);
    if (code !== 0) {
      // Plugin ausente: el `Require dpdgraph.dpdgraph` del query falla igual
      // para todos los módulos. Abortamos el harvest del kernel sin reintentar
      // y señalamos la condición global; el textual queda intacto.
      if (isDpdgraphMissingError(stderr)) {
        return {
          graph: { nodes: allNodes, edges: allEdges },
          dpdgraphMissing: true,
          skipped: skipped.length > 0 ? skipped : undefined,
        };
      }
      console.error(
        `[rocq-graph] compile failed on query for ${target} (exit ${code}):\n${stderr}`,
      );
      skipped.push({
        module: target,
        reason: `query compile failed: ${stderr.slice(0, 400)}`,
      });
      continue;
    }
    const dpdPath = path.join(cacheDir, dpdName);
    if (!fs.existsSync(dpdPath)) {
      skipped.push({
        module: target,
        reason: `dpdgraph did not produce ${dpdName}`,
      });
      continue;
    }
    const raw = parseDpd(fs.readFileSync(dpdPath, 'utf8'));

    // Asignar IDs globales a los nodos del dump.
    // Con `Print FileDependGraph M.` (M un solo módulo), todos los nodos
    // pertenecen a M. El campo `path=` indica si están dentro de un sub-Module
    // del archivo: vacío para top-level, "Foo" para `Module Foo`, "Foo.Sub"
    // para anidamiento.
    const localToGlobal = new Map<number, number>();
    for (const n of raw.nodes) {
      const qualifiedName = n.declaredPath
        ? `${n.declaredPath}.${n.name}`
        : n.name;
      // Key global: archivo + qualified name (distingue x en Module Foo de x
      // top-level en el mismo archivo).
      const key = `${target}::${qualifiedName}`;
      let globalId = nodeKeyToId.get(key);
      if (globalId === undefined) {
        globalId = nextId++;
        nodeKeyToId.set(key, globalId);
        allNodes.push({
          id: globalId,
          name: n.name,
          kind: n.kind,
          body: n.body,
          prop: n.prop,
          sourceFile: target,
          modulePath: n.declaredPath,
          qualifiedName,
        });
      }
      localToGlobal.set(n.localId, globalId);
    }
    for (const e of raw.edges) {
      const src = localToGlobal.get(e.src);
      const tgt = localToGlobal.get(e.tgt);
      if (src === undefined || tgt === undefined) continue;
      allEdges.push({ src, tgt, weight: e.weight });
    }
  }

  // Cleanup de aux files (mantenemos los .dpd como caché auditable).
  for (const target of compiledList) {
    const safeStem = target.replace(/[^A-Za-z0-9_]/g, '_');
    const stem = `_dpd_${safeStem}`;
    for (const aux of [`${stem}.vo`, `${stem}.vok`, `${stem}.vos`, `${stem}.glob`, `.${stem}.aux`]) {
      try {
        fs.unlinkSync(path.join(cacheDir, aux));
      } catch {
        // ignore
      }
    }
  }

  return {
    graph: { nodes: allNodes, edges: allEdges },
    skipped: skipped.length > 0 ? skipped : undefined,
  };
}

/** Reescribe los `-Q phys logical` para que `phys` sea absoluto contra rootDir. */
function rebaseLoadPaths(args: string[], rootDir: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if ((t === '-Q' || t === '-R') && i + 2 < args.length) {
      const phys = args[i + 1];
      const logical = args[i + 2];
      const abs = path.isAbsolute(phys) ? phys : path.resolve(rootDir, phys);
      out.push(t, abs, logical);
      i += 2;
    } else {
      out.push(t);
    }
  }
  return out;
}
