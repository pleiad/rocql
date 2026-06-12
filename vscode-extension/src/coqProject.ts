// Descubre el _CoqProject (o _RocqProject, convención Rocq 9) del workspace y
// mapea cada .v a su Module Dotted Name. Soporta directivas -Q <physical>
// <logical> y -R <physical> <logical>. El archivo de proyecto se busca en la
// raíz del workspace y también en los directorios que contienen .v (caso
// típico: workspace abierto un nivel arriba del proyecto Rocq); su directorio
// pasa a ser el rootDir efectivo de compilación.
// Si no existe archivo de proyecto, emite un -Q <dir> "" por cada directorio
// que contiene .v, de modo que `Require Import Foo.` entre hermanos resuelva
// igual que al compilar a mano desde dentro del directorio.

import * as fs from 'fs';
import * as path from 'path';

export interface LoadPath {
  /** Path físico relativo al rootDir, normalizado sin trailing slash. */
  physical: string;
  /** Nombre lógico (vacío para -Q . ""). */
  logical: string;
  /** -R (recursivo) o -Q. Sin distinción semántica aquí: ambos resuelven igual. */
  flag: '-Q' | '-R';
}

export interface CoqProject {
  rootDir: string;
  loadPaths: LoadPath[];
  /** Path absoluto -> Module Dotted Name. */
  modules: Map<string, string>;
  /** Module Dotted Name -> path absoluto. */
  moduleToPath: Map<string, string>;
  /** Args listos para pasar a `rocq compile`. */
  compileArgs: string[];
}

function parseCoqProjectFile(text: string): LoadPath[] {
  const lps: LoadPath[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = tokenize(line);
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok === '-Q' || tok === '-R') {
        const phys = tokens[i + 1];
        const logical = tokens[i + 2];
        if (phys === undefined || logical === undefined) continue;
        lps.push({
          physical: normalizePhysical(phys),
          logical: logical === '""' || logical === "''" ? '' : logical,
          flag: tok,
        });
        i += 2;
      }
    }
  }
  return lps;
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i += 1;
    if (i >= line.length) break;
    let token = '';
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i];
      i += 1;
      while (i < line.length && line[i] !== quote) {
        token += line[i];
        i += 1;
      }
      if (i < line.length) i += 1;
    } else {
      while (i < line.length && !/\s/.test(line[i])) {
        token += line[i];
        i += 1;
      }
    }
    out.push(token);
  }
  return out;
}

function normalizePhysical(p: string): string {
  let r = p;
  while (r.endsWith('/')) r = r.slice(0, -1);
  if (r === '') r = '.';
  return r;
}

/** Devuelve la dotted name si el archivo cae bajo el load path; sino, undefined. */
function moduleNameFor(
  absFile: string,
  rootDir: string,
  lp: LoadPath,
): string | undefined {
  const physAbs = path.resolve(rootDir, lp.physical);
  const rel = path.relative(physAbs, absFile);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  if (!rel.endsWith('.v')) return undefined;
  const withoutExt = rel.slice(0, -2);
  const parts = withoutExt.split(path.sep).filter(Boolean);
  const dotted = parts.join('.');
  return lp.logical ? `${lp.logical}.${dotted}` : dotted;
}

const PROJECT_FILENAMES = ['_CoqProject', '_RocqProject'];

/**
 * Busca _CoqProject / _RocqProject en rootDir y en los ancestros (dentro del
 * workspace) de cada .v, del más superficial al más profundo. Devuelve el
 * path absoluto del archivo de proyecto, o undefined.
 */
function findProjectFile(
  rootDir: string,
  vFiles: string[],
): string | undefined {
  const dirs = new Set<string>([rootDir]);
  for (const f of vFiles) {
    let d = path.dirname(f);
    for (;;) {
      const rel = path.relative(rootDir, d);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) break;
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  const sorted = [...dirs].sort(
    (a, b) => a.split(path.sep).length - b.split(path.sep).length,
  );
  for (const d of sorted) {
    for (const name of PROJECT_FILENAMES) {
      const candidate = path.join(d, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function discoverCoqProject(
  workspaceRoot: string,
  vFiles: string[],
): CoqProject {
  const projectFile = findProjectFile(workspaceRoot, vFiles);
  // El rootDir efectivo es el directorio del archivo de proyecto: sus -Q/-R
  // son relativos a él, y la compilación debe correr desde ahí (igual que el
  // Makefile del usuario). Sin archivo de proyecto, queda el workspace.
  const rootDir = projectFile ? path.dirname(projectFile) : workspaceRoot;
  let loadPaths: LoadPath[] = [];
  if (projectFile) {
    loadPaths = parseCoqProjectFile(fs.readFileSync(projectFile, 'utf8'));
  }
  if (loadPaths.length === 0) {
    // Sin _CoqProject: un binding por directorio con .v, no un único -Q . ""
    // en la raíz. Con el binding raíz, un .v en subdirectorio `rocq/` queda
    // nombrado `rocq.Foo`, pero sus hermanos lo requieren como `Foo` — rocq
    // falla con "Cannot find a physical path bound to logical path Foo".
    const dirs = new Set<string>();
    for (const abs of vFiles) {
      const rel = path.relative(rootDir, path.dirname(abs));
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      dirs.add(normalizePhysical(rel === '' ? '.' : rel));
    }
    if (dirs.size === 0) dirs.add('.');
    loadPaths = [...dirs]
      .sort()
      .map((physical) => ({ physical, logical: '', flag: '-Q' as const }));
  }
  // Ordenar load paths por especificidad descendente (más específico primero).
  // El más específico es el que tiene physical más profundo; '.' cuenta como
  // profundidad 0 para no empatar con subdirectorios de un segmento.
  const depth = (p: string): number =>
    p === '.' ? 0 : p.split(path.sep).length;
  const sortedLps = [...loadPaths].sort(
    (a, b) => depth(b.physical) - depth(a.physical),
  );

  const modules = new Map<string, string>();
  const moduleToPath = new Map<string, string>();
  for (const abs of vFiles) {
    for (const lp of sortedLps) {
      const name = moduleNameFor(abs, rootDir, lp);
      if (name) {
        modules.set(abs, name);
        moduleToPath.set(name, abs);
        break;
      }
    }
  }

  const compileArgs: string[] = [];
  for (const lp of loadPaths) {
    // Para load paths con nombre lógico vacío pasamos '' (cadena vacía real)
    // en lugar de '""'. `child_process.spawn` no interpreta comillas: cualquier
    // string se pasa literal a argv. El '""' literal hace que rocq vea cuatro
    // caracteres y los rechace como identificador inválido.
    compileArgs.push(lp.flag, lp.physical, lp.logical);
  }

  return { rootDir, loadPaths, modules, moduleToPath, compileArgs };
}
