// Port en TS de build_graph.py + mejoras de resolución de scopes.
//
// Características frente al original:
// - Maneja Module / Module Type con anidamiento (sub-scopes y qualified names).
// - Maneja Section como flat (las defs salen al archivo, sin namespace).
// - Soporta `Module Foo := Bar.` (aliasing).
// - Soporta `Require Import` y `Import` mid-file (este último abre el namespace
//   al scope del archivo desde ese punto).
// - Resuelve refs qualificadas `Foo.bar` siguiendo la jerarquía de scopes y
//   los aliases registrados.
// - Resolución incremental por byte offset: una ref antes de redefinir un
//   nombre apunta al global previo, no a la forward-ref local.

const ENTRY_KEYWORDS = [
  'Theorem', 'Lemma', 'Corollary', 'Proposition', 'Fact', 'Remark',
  'Definition', 'Fixpoint', 'CoFixpoint', 'Function', 'Equations',
  'Example',
  'Inductive', 'CoInductive', 'Record', 'Class', 'Instance',
  'Variable', 'Hypothesis', 'Axiom', 'Parameter',
];

const PROOF_TERMINATORS = new Set(['Qed', 'Defined', 'Admitted', 'Abort', 'Save']);

const ENTRY_RE = new RegExp(
  "(?<![A-Za-z0-9_'])" +
    '(?:(?:Local|Global|Polymorphic|Monomorphic|Program|Private)\\s+)*' +
    '(?<kw>' + ENTRY_KEYWORDS.join('|') + ')' +
    "\\s+(?<name>[A-Za-z_][A-Za-z0-9_']*)",
);

const QUALIFIED_IDENT_RE =
  /[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*/g;

const COQ_RESERVED = new Set([
  'forall', 'exists', 'fun', 'match', 'with', 'end', 'let', 'in', 'if',
  'then', 'else', 'as', 'return', 'fix', 'cofix', 'struct', 'measure',
  'wf', 'for', 'of', 'where', 'is',
  'Prop', 'Set', 'Type', 'SProp',
  'Proof', 'Qed', 'Defined', 'Admitted', 'Abort', 'Save',
  'Section', 'End', 'Module', 'Import', 'Export', 'From', 'Require',
  'Hint', 'Resolve', 'Rewrite', 'Constructors', 'Notation', 'Reserved',
  'Local', 'Global', 'Polymorphic', 'Monomorphic', 'Program', 'Private',
  'Arguments', 'About', 'Print', 'Check', 'Compute', 'Eval',
  'Context', 'Variables', 'Hypotheses', 'Implicit', 'Open', 'Scope',
  'Bind', 'Coercion', 'Canonical', 'Structure',
  'intro', 'intros', 'apply', 'exact', 'destruct', 'induction', 'rewrite',
  'reflexivity', 'symmetry', 'transitivity', 'split', 'left', 'right',
  'constructor', 'econstructor', 'inversion', 'subst', 'simpl', 'unfold',
  'fold', 'cbn', 'cbv', 'specialize', 'pose', 'assert', 'remember',
  'generalize', 'clear', 'rename', 'now', 'eassumption', 'assumption',
  'contradiction', 'discriminate', 'congruence', 'lia', 'omega', 'ring',
  'field', 'firstorder', 'easy', 'admit', 'idtac', 'fail', 'progress',
  'repeat', 'first', 'last', 'trivial', 'auto', 'eauto', 'tauto',
  'intuition', 'do', 'try', 'case', 'elim', 'f_equal', 'replace',
  'revert', 'set', 'change', 'evar', 'instantiate', 'abstract',
]);

const CONSTRUCTOR_KIND: Record<string, string> = {
  Inductive: 'Constructor',
  CoInductive: 'Constructor',
  Record: 'Constructor',
};

// Clasificación de comandos top-level (un comando = head hasta el primer `.`).
const MODULE_DECL_RE =
  /^\s*(?:Local\s+|Global\s+)?Module(\s+Type)?\s+([A-Za-z_][A-Za-z0-9_']*)(\s*\.|\s+(?::|<:|:=|\())/;
const SECTION_BEGIN_RE = /^\s*Section\s+([A-Za-z_][A-Za-z0-9_']*)\s*\./;
const END_RE = /^\s*End\s+([A-Za-z_][A-Za-z0-9_']*)\s*\./;
// Lista de uno-o-más dotted-idents separados por whitespace. Acepta `A`,
// `A.Foo`, `A B`, `A.Foo B.Bar.Sub`, terminado por `.` final del statement.
const MODULE_LIST = String.raw`((?:[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*\s*)+)`;
const REQUIRE_DIRECTIVE_RE = new RegExp(
  String.raw`^\s*(?:From\s+[A-Za-z_][A-Za-z0-9_'.]*\s+)?Require(?:\s+(?:Import|Export))?\s+` +
    MODULE_LIST +
    String.raw`\.`,
);
const IMPORT_DIRECTIVE_RE = new RegExp(
  String.raw`^\s*(?:Import|Export)\s+` + MODULE_LIST + String.raw`\.`,
);

export interface InputFile {
  /** Path absoluto del archivo. Solo se usa para `_meta.files`. */
  path: string;
  /**
   * Path relativo al rootDir del proyecto (e.g. "src/Foo.v"). Es el identificador
   * canónico del archivo en el grafo — va a `props.file` y forma parte del id
   * de cada nodo. Si dos archivos del proyecto comparten basename (`a/Foo.v`
   * y `b/Foo.v`), distinguirlos requiere este path completo.
   */
  relpath: string;
  text: string;
}

export interface GraphNode {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  labels: string[];
  endpoints: [string, string];
  directionality: '->';
  props: Record<string, unknown>;
}

export interface BuiltGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  _meta: {
    files: string[];
    node_count: number;
    edge_count: number;
    duplicate_names: string[];
  };
}

interface Child {
  role: 'constructor' | 'field';
  name: string;
  type: string;
}

interface Entry {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  head: string;
  proof: string;
  terminator: string;
  children: Child[];
  head_start: number;
  head_end: number;
  proof_start: number;
  proof_end: number;
  /** Path de módulos contenedores, dotted; vacío si top-level. */
  module_path: string;
  /** Offset en src (post-strip-comments) donde empieza el comando. */
  cmd_start_char: number;
}

function stripComments(s: string): string {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  let depth = 0;
  while (i < n) {
    const c = s[i];
    const c2 = s.slice(i, i + 2);
    if (c2 === '(*') {
      depth += 1;
      out.push('  ');
      i += 2;
      continue;
    }
    if (c2 === '*)' && depth > 0) {
      depth -= 1;
      out.push('  ');
      i += 2;
      continue;
    }
    if (depth === 0) {
      out.push(c);
    } else {
      out.push(c === '\n' ? '\n' : ' ');
    }
    i += 1;
  }
  return out.join('');
}

function parseCommand(
  text: string,
  start: number,
): { head: string; proof: string; end: number; terminator: string } {
  const n = text.length;
  let i = start;
  let inString = false;
  let headEnd = -1;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (c === '.' && (i + 1 >= n || /\s/.test(text[i + 1]))) {
      headEnd = i + 1;
      break;
    }
    i += 1;
  }
  if (headEnd < 0) {
    return { head: text.slice(start), proof: '', end: n, terminator: '' };
  }
  let j = headEnd;
  while (j < n && /\s/.test(text[j])) j += 1;
  const proofMatch = /^Proof\b[^.]*\./.exec(text.slice(j, n));
  if (!proofMatch) {
    return { head: text.slice(start, headEnd), proof: '', end: headEnd, terminator: '' };
  }
  const proofBodyStart = j + proofMatch[0].length;
  let k = proofBodyStart;
  inString = false;
  while (k < n) {
    const c = text[k];
    if (inString) {
      if (c === '"') inString = false;
      k += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      k += 1;
      continue;
    }
    if (c === '.' && (k + 1 >= n || /\s/.test(text[k + 1]))) {
      let back = k;
      while (back > 0 && /\s/.test(text[back - 1])) back -= 1;
      const endWord = back;
      while (back > 0 && /[A-Za-z0-9_]/.test(text[back - 1])) back -= 1;
      const lastWord = text.slice(back, endWord);
      if (PROOF_TERMINATORS.has(lastWord)) {
        return {
          head: text.slice(start, headEnd),
          proof: text.slice(proofBodyStart, endWord - lastWord.length),
          end: k + 1,
          terminator: lastWord,
        };
      }
    }
    k += 1;
  }
  return { head: text.slice(start, headEnd), proof: text.slice(proofBodyStart, n), end: n, terminator: '' };
}

function lineOf(text: string, offset: number): number {
  let count = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') count += 1;
  }
  return count;
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of s) {
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

function extractInductiveConstructors(head: string): Child[] {
  const eq = head.indexOf(':=');
  if (eq < 0) return [];
  let body = head.slice(eq + 2).trimEnd();
  if (body.endsWith('.')) body = body.slice(0, -1);
  const out: Child[] = [];
  for (const raw of splitTopLevel(body, '|')) {
    const p = raw.trim();
    if (!p) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_']*)/.exec(p);
    if (!m) continue;
    const cname = m[1];
    const rest = p.slice(m[0].length).trim();
    let ctype = '';
    if (rest.startsWith(':')) ctype = rest.slice(1).trim();
    out.push({ role: 'constructor', name: cname, type: ctype });
  }
  return out;
}

function extractRecordFields(head: string): {
  constructor: string | null;
  fields: Child[];
} {
  const m = /:=\s*([A-Za-z_][A-Za-z0-9_']*)\s*\{/.exec(head);
  let bodyStart: number;
  let constructor: string | null;
  if (m) {
    bodyStart = m.index + m[0].length;
    constructor = m[1];
  } else {
    const m2 = /:=\s*\{/.exec(head);
    if (!m2) return { constructor: null, fields: [] };
    bodyStart = m2.index + m2[0].length;
    constructor = null;
  }
  let depth = 1;
  let i = bodyStart;
  const n = head.length;
  while (i < n && depth > 0) {
    if (head[i] === '{') depth += 1;
    else if (head[i] === '}') depth -= 1;
    i += 1;
  }
  const body = head.slice(bodyStart, i - 1);
  const fields: Child[] = [];
  for (const raw of splitTopLevel(body, ';')) {
    const p = raw.trim();
    if (!p) continue;
    const m2 = /^([A-Za-z_][A-Za-z0-9_']*)\s*([\s\S]*)$/.exec(p);
    if (!m2) continue;
    const fname = m2[1];
    const rest = m2[2].trimStart();
    let depth2 = 0;
    let colon = -1;
    for (let k = 0; k < rest.length; k += 1) {
      const c = rest[k];
      if (c === '(' || c === '[' || c === '{') depth2 += 1;
      else if (c === ')' || c === ']' || c === '}') depth2 -= 1;
      else if (c === ':' && depth2 === 0 && (k + 1 >= rest.length || rest[k + 1] !== '=')) {
        colon = k;
        break;
      }
    }
    const ftype = colon >= 0 ? rest.slice(colon + 1).trim() : '';
    fields.push({ role: 'field', name: fname, type: ftype });
  }
  return { constructor, fields };
}

/**
 * Devuelve identifiers simples y qualified. Simples si están en COQ_RESERVED
 * se filtran. Qualified (con punto) se conservan tal cual.
 */
function collectIdents(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(QUALIFIED_IDENT_RE)) {
    const w = match[0];
    if (!w.includes('.')) {
      if (!COQ_RESERVED.has(w)) out.add(w);
    } else {
      // Qualified: descartamos si el primer segmento es reservado o si el
      // último segmento es reservado (raros pero teóricamente posibles).
      const segs = w.split('.');
      if (COQ_RESERVED.has(segs[0])) continue;
      if (COQ_RESERVED.has(segs[segs.length - 1])) continue;
      out.add(w);
    }
  }
  return out;
}

function charToByteTable(text: string): number[] {
  const tab = new Array<number>(text.length + 1);
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    tab[i] = n;
    const code = text.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      n += 4;
      i += 1;
      tab[i] = n;
      continue;
    } else n += 3;
  }
  tab[text.length] = n;
  return tab;
}

type Command =
  | { kind: 'module_begin'; name: string; isType: boolean }
  | { kind: 'module_alias'; name: string; target: string[] }
  | { kind: 'section_begin'; name: string }
  | { kind: 'end'; name: string }
  | { kind: 'require'; dotted: string[] }
  | { kind: 'import'; paths: string[][] }
  | { kind: 'entry'; kw: string; name: string }
  | { kind: 'other' };

function classifyCommand(head: string): Command {
  // Module Foo := Bar.   (alias) – chequear primero porque MODULE_DECL_RE no
  // tiene := específicamente excluido. El target es un dotted-ident sin
  // consumir el punto final del comando.
  const aliasMatch =
    /^\s*(?:Local\s+|Global\s+)?Module\s+([A-Za-z_][A-Za-z0-9_']*)\s*:=\s*([A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*)/.exec(
      head,
    );
  if (aliasMatch) {
    return {
      kind: 'module_alias',
      name: aliasMatch[1],
      target: aliasMatch[2].split('.'),
    };
  }
  // Module Foo. / Module Type Foo. / Module Foo : Sig. / Module Foo <: Sig.
  const modMatch = MODULE_DECL_RE.exec(head);
  if (modMatch) {
    return {
      kind: 'module_begin',
      name: modMatch[2],
      isType: Boolean(modMatch[1]),
    };
  }
  // Section Foo.
  const secMatch = SECTION_BEGIN_RE.exec(head);
  if (secMatch) return { kind: 'section_begin', name: secMatch[1] };
  // End Foo.
  const endMatch = END_RE.exec(head);
  if (endMatch) return { kind: 'end', name: endMatch[1] };
  // Require / Require Import / From X Require Import. Preserva dotted names
  // completos para que el resolver del workspace pueda mapearlos contra el
  // _CoqProject. El fallback a basename ocurre dentro de buildGraph.
  const reqMatch = REQUIRE_DIRECTIVE_RE.exec(head);
  if (reqMatch) {
    const dotted = reqMatch[1].split(/\s+/).filter(Boolean);
    return { kind: 'require', dotted };
  }
  // Import A.Foo.Sub. / Export Foo.   (mid-file abre namespace)
  const impMatch = IMPORT_DIRECTIVE_RE.exec(head);
  if (impMatch) {
    const paths = impMatch[1]
      .split(/\s+/)
      .filter(Boolean)
      .map((tok) => tok.split('.'));
    return { kind: 'import', paths };
  }
  // Entry definition.
  ENTRY_RE.lastIndex = 0;
  const eMatch = ENTRY_RE.exec(head);
  if (eMatch) {
    return {
      kind: 'entry',
      kw: eMatch.groups?.kw ?? '',
      name: eMatch.groups?.name ?? '',
    };
  }
  return { kind: 'other' };
}

interface ParsedFile {
  entries: Entry[];
  imports: string[];
  /** Directivas `Import X.` inline con su offset en chars. */
  inlineImports: Array<{ at: number; path: string[]; scope: string }>;
  /** Aliases declarados: <qualified alias name> -> <qualified target name>. */
  aliases: Map<string, string[]>;
}

function parseFile(file: InputFile): ParsedFile {
  const raw = file.text;
  const src = stripComments(raw);
  const charToByte = charToByteTable(raw);
  const entries: Entry[] = [];
  const imports: string[] = [];
  const inlineImports: Array<{ at: number; path: string[]; scope: string }> =
    [];
  const aliases = new Map<string, string[]>();

  const scopeStack: Array<{ kind: 'module' | 'section'; name: string }> = [];
  const modulePath = (): string =>
    scopeStack
      .filter((s) => s.kind === 'module')
      .map((s) => s.name)
      .join('.');

  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i += 1;
    if (i >= n) break;
    const start = i;
    const { head, proof, end, terminator } = parseCommand(src, start);
    if (head.length === 0) {
      i = end > start ? end : start + 1;
      continue;
    }
    const cls = classifyCommand(head);
    if (cls.kind === 'module_begin') {
      scopeStack.push({ kind: 'module', name: cls.name });
    } else if (cls.kind === 'section_begin') {
      scopeStack.push({ kind: 'section', name: cls.name });
    } else if (cls.kind === 'end') {
      while (scopeStack.length > 0) {
        const top = scopeStack.pop()!;
        if (top.name === cls.name) break;
      }
    } else if (cls.kind === 'module_alias') {
      const fullAliasName = modulePath()
        ? `${modulePath()}.${cls.name}`
        : cls.name;
      aliases.set(fullAliasName, cls.target);
    } else if (cls.kind === 'require') {
      for (const d of cls.dotted) imports.push(d);
    } else if (cls.kind === 'import') {
      for (const p of cls.paths) {
        inlineImports.push({ at: start, path: p, scope: modulePath() });
      }
    } else if (cls.kind === 'entry') {
      const path = modulePath();
      const headStartChar = start;
      const headEndChar = headStartChar + head.length;
      let proofStartChar = headEndChar;
      let proofEndChar = headEndChar;
      if (proof) {
        const found = src.indexOf(proof, headEndChar);
        if (found >= 0) {
          proofStartChar = found;
          proofEndChar = found + proof.length;
        }
      }
      const entry: Entry = {
        id: '',
        name: cls.name,
        kind: cls.kw,
        file: file.relpath,
        line: lineOf(raw, start),
        head,
        proof,
        terminator,
        children: [],
        head_start: charToByte[headStartChar],
        head_end: charToByte[headEndChar],
        proof_start: charToByte[proofStartChar],
        proof_end: charToByte[proofEndChar],
        module_path: path,
        cmd_start_char: start,
      };
      if (cls.kw === 'Inductive' || cls.kw === 'CoInductive') {
        entry.children = extractInductiveConstructors(head);
      } else if (cls.kw === 'Record') {
        const { constructor, fields } = extractRecordFields(head);
        const kids: Child[] = [];
        if (constructor) kids.push({ role: 'constructor', name: constructor, type: '' });
        kids.push(...fields);
        entry.children = kids;
      }
      entries.push(entry);
    }
    i = end > start ? end : start + 1;
  }
  return { entries, imports, inlineImports, aliases };
}

// Estructura de árbol para resolver nombres en el archivo activo y los
// importados. Cada ModuleScope agrupa defs locales y submodules.
interface ModuleScope {
  /** Nombre simple del módulo (vacío para la raíz del archivo). */
  name: string;
  /** Path dotted desde la raíz del archivo (vacío para la raíz). */
  qualifiedPath: string;
  parent?: ModuleScope;
  defs: Map<string, string>; // name simple -> id
  submodules: Map<string, ModuleScope>;
}

function makeScope(
  name: string,
  qualifiedPath: string,
  parent?: ModuleScope,
): ModuleScope {
  return {
    name,
    qualifiedPath,
    parent,
    defs: new Map(),
    submodules: new Map(),
  };
}

/** Busca un nombre simple en la pila de scopes (top-most primero). */
function lookupSimple(
  stack: ModuleScope[],
  name: string,
): string | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const id = stack[i].defs.get(name);
    if (id) return id;
  }
  return undefined;
}

/** Resuelve un qualified name `Foo.bar` o `Foo.Sub.bar`. */
function lookupQualified(
  stack: ModuleScope[],
  parts: string[],
  fileScopeForModule: (modName: string) => ModuleScope | undefined,
  resolveAlias: (qual: string[]) => string[],
  activeFileScope?: ModuleScope,
): string | undefined {
  if (parts.length < 2) {
    return parts.length === 1 ? lookupSimple(stack, parts[0]) : undefined;
  }
  const head = parts[0];
  // Probar como módulo del proyecto: resuelve via el mapping moduleToFile.
  const fileScope = fileScopeForModule(head);
  if (fileScope) {
    const id = walkInto(fileScope, parts.slice(1));
    if (id) return id;
  }
  // Probar como módulo en algún scope de la pila.
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const sub = stack[i].submodules.get(head);
    if (sub) {
      const id = walkInto(sub, parts.slice(1));
      if (id) return id;
    }
  }
  // Fallback: el fileScope del archivo activo tiene todos los submodules y
  // aliases registrados desde FASE 2. La pila solo tiene los populados
  // incrementalmente durante el recorrido, así que un alias o submodule no
  // visitado aún por una entry anterior estaría ausente. Buscar acá rescata
  // ese caso sin habilitar forward references para defs simples (esas siguen
  // por lookupSimple que mira la pila).
  if (activeFileScope) {
    const sub = activeFileScope.submodules.get(head);
    if (sub) {
      const id = walkInto(sub, parts.slice(1));
      if (id) return id;
    }
  }
  // Resolver alias y reintentar.
  const expanded = resolveAlias(parts);
  if (expanded !== parts) {
    return lookupQualified(
      stack,
      expanded,
      fileScopeForModule,
      resolveAlias,
      activeFileScope,
    );
  }
  return undefined;
}

function walkInto(scope: ModuleScope, rest: string[]): string | undefined {
  if (rest.length === 0) return undefined;
  let cur: ModuleScope | undefined = scope;
  for (let i = 0; i < rest.length - 1; i += 1) {
    cur = cur?.submodules.get(rest[i]);
    if (!cur) return undefined;
  }
  return cur?.defs.get(rest[rest.length - 1]);
}

function findSubmodule(
  scope: ModuleScope,
  path: string[],
): ModuleScope | undefined {
  let cur: ModuleScope | undefined = scope;
  for (const p of path) {
    cur = cur?.submodules.get(p);
    if (!cur) return undefined;
  }
  return cur;
}

export interface BuildOptions {
  /**
   * Mapping de Module Dotted Name (como aparece en `Require Import X.Y.`) al
   * basename del archivo correspondiente. Si se provee, se usa con prioridad
   * sobre el fallback de "basename simple sin .v". Útil cuando hay
   * `_CoqProject` con subdirectorios o nombres lógicos.
   */
  moduleToFile?: Map<string, string>;
}

function basenameStem(relpath: string): string {
  const parts = relpath.split(/[/\\]/);
  const last = parts[parts.length - 1];
  return last.endsWith('.v') ? last.slice(0, -2) : last;
}

export function buildGraph(
  files: InputFile[],
  opts?: BuildOptions,
): BuiltGraph {
  // Parsear todos los archivos.
  const fileData = new Map<string, ParsedFile>();
  for (const f of files) {
    fileData.set(f.relpath, parseFile(f));
  }

  // Mapping nombre de módulo -> relpath del archivo. Si el caller provee un
  // mapping explícito (vía `opts.moduleToFile`), se respeta. Sino, fallback:
  // por cada archivo, registramos `<stem> -> <relpath>` para soportar el
  // caso típico `Require Import Foo.` con `Foo.v` en raíz.
  const moduleToFile = new Map<string, string>();
  if (opts?.moduleToFile) {
    for (const [k, v] of opts.moduleToFile) moduleToFile.set(k, v);
  }
  for (const f of files) {
    const stem = basenameStem(f.relpath);
    if (!moduleToFile.has(stem)) moduleToFile.set(stem, f.relpath);
  }

  /**
   * Resuelve un dotted-module-name a basename usando el mapping. Si el dotted
   * completo no se encuentra, prueba sufijos (Foo.Bar -> Bar) como heurística.
   */
  function resolveModuleToFile(dotted: string): string | undefined {
    if (moduleToFile.has(dotted)) return moduleToFile.get(dotted);
    const parts = dotted.split('.');
    for (let i = 1; i < parts.length; i += 1) {
      const suffix = parts.slice(i).join('.');
      if (moduleToFile.has(suffix)) return moduleToFile.get(suffix);
    }
    return undefined;
  }

  const nodeId = (file: string, qualified: string) => `${file}::${qualified}`;
  const ADMIT_TACTIC_RE = /\badmit\b/;

  // FASE 1: registrar nodos. Estable por (file, qualified_name).
  // qualified_name = module_path + '.' + name (o solo name si top-level).
  const nodes: GraphNode[] = [];
  for (const [filename, data] of fileData) {
    for (const e of data.entries) {
      const qualified = e.module_path ? `${e.module_path}.${e.name}` : e.name;
      const nid = nodeId(filename, qualified);
      e.id = nid;
      const hasAdmit =
        e.terminator === 'Admitted' ||
        (e.proof !== '' && ADMIT_TACTIC_RE.test(e.proof));
      const labels = [e.kind];
      if (hasAdmit) labels.push('Admitted');
      nodes.push({
        id: nid,
        labels,
        props: {
          name: e.name,
          qualified_name: qualified,
          module_path: e.module_path,
          kind: e.kind,
          file: e.file,
          line: e.line,
          has_proof: Boolean(e.proof),
          terminator: e.terminator,
          admitted: hasAdmit,
          head_start: e.head_start,
          head_end: e.head_end,
          proof_start: e.proof_start,
          proof_end: e.proof_end,
        },
      });
      for (const child of e.children) {
        const childQualified = e.module_path
          ? `${e.module_path}.${child.name}`
          : child.name;
        const cid = nodeId(filename, childQualified);
        const childKind =
          child.role === 'field'
            ? 'Field'
            : CONSTRUCTOR_KIND[e.kind] ?? 'Constructor';
        nodes.push({
          id: cid,
          labels: [childKind],
          props: {
            name: child.name,
            qualified_name: childQualified,
            module_path: e.module_path,
            kind: childKind,
            file: e.file,
            line: e.line,
            parent: e.name,
          },
        });
      }
    }
  }

  // FASE 2: construir un ModuleScope tree por archivo con todas sus defs.
  // Esto sirve cuando otro archivo lo importa y queremos resolver `File.foo`
  // o las defs después de un `Require Import` topo. Indexado por relpath.
  const fileScopes = new Map<string, ModuleScope>();
  for (const filename of fileData.keys()) {
    fileScopes.set(filename, makeScope(basenameStem(filename), ''));
  }
  /** Resuelve un dotted module name al fileScope correspondiente. */
  function fileScopeForModule(modName: string): ModuleScope | undefined {
    const relpath = resolveModuleToFile(modName);
    return relpath ? fileScopes.get(relpath) : undefined;
  }
  for (const [filename, data] of fileData) {
    const fileScope = fileScopes.get(filename)!;
    for (const e of data.entries) {
      const target = e.module_path
        ? findOrCreateSubmodule(fileScope, e.module_path.split('.'))
        : fileScope;
      target.defs.set(e.name, e.id);
      for (const child of e.children) {
        target.defs.set(
          child.name,
          nodeId(
            filename,
            e.module_path ? `${e.module_path}.${child.name}` : child.name,
          ),
        );
      }
    }
    // Procesar aliases: registrar el submódulo alias apuntando a su target.
    for (const [aliasQualified, targetPath] of data.aliases) {
      const aliasParts = aliasQualified.split('.');
      const parent =
        aliasParts.length > 1
          ? findOrCreateSubmodule(fileScope, aliasParts.slice(0, -1))
          : fileScope;
      const aliasName = aliasParts[aliasParts.length - 1];
      // Resolver el target. Si target[0] es un módulo del proyecto, usar su
      // fileScope; sino, buscar en el fileScope propio.
      let resolved: ModuleScope | undefined;
      const targetFile = fileScopeForModule(targetPath[0]);
      if (targetFile && targetPath.length === 1) {
        resolved = targetFile;
      } else if (targetFile) {
        resolved = findSubmodule(targetFile, targetPath.slice(1));
      } else {
        resolved = findSubmodule(fileScope, targetPath);
      }
      if (resolved) {
        parent.submodules.set(aliasName, resolved);
      }
    }
  }

  // FASE 3: closure transitivo de imports en post-order DFS.
  function importClosure(filename: string): string[] {
    const out: string[] = [];
    const visited = new Set<string>();
    function dfs(f: string): void {
      if (visited.has(f)) return;
      visited.add(f);
      const data = fileData.get(f);
      if (!data) return;
      for (const imp of data.imports) {
        const impFile = resolveModuleToFile(imp);
        if (impFile) dfs(impFile);
      }
      if (f !== filename) out.push(f);
    }
    dfs(filename);
    return out;
  }

  // FASE 4: edges. Por cada archivo, resolución incremental con stack.
  const duplicates = new Set<string>();
  const edges: GraphEdge[] = [];
  let edgeCounter = 0;
  function addEdge(
    src: string,
    tgt: string,
    label: string,
    where?: string,
  ): void {
    if (src === tgt) return;
    const eid = `e${edgeCounter}`;
    edgeCounter += 1;
    const props: Record<string, unknown> = {};
    // Renombrado de `where` → `ref_kind` (where es palabra reservada GQL, no
    // se puede manipular vía DML). Mantenemos el parámetro como `where` por
    // claridad semántica interna.
    if (where) props.ref_kind = where;
    edges.push({
      id: eid,
      labels: [label],
      endpoints: [src, tgt],
      directionality: '->',
      props,
    });
  }

  for (const [filename, data] of fileData) {
    const fileScope = fileScopes.get(filename)!;
    // Pila: arranca con un scope "seed" virtual (defs visibles desde el archivo)
    // que populamos con imports topológicos. Después se va layereando con
    // sub-scopes según vamos entrando a Modules.
    const seed = makeScope('<seed>', '');
    function shadowAdd(
      scope: ModuleScope,
      name: string,
      id: string,
    ): void {
      const prev = scope.defs.get(name);
      if (prev && prev !== id) duplicates.add(name);
      scope.defs.set(name, id);
    }
    // Cargar imports topológicos en seed (defs visibles, shadow del más reciente).
    for (const impFile of importClosure(filename)) {
      const impData = fileData.get(impFile);
      if (!impData) continue;
      const impFileScope = fileScopes.get(impFile)!;
      // Por defecto, después de `Require Import X.` los nombres top-level de X
      // entran al scope. Submodules quedan accesibles como qualified.
      for (const [name, id] of impFileScope.defs) {
        shadowAdd(seed, name, id);
      }
      // Submodules del archivo importado: registrar en seed.submodules.
      for (const [subName, sub] of impFileScope.submodules) {
        seed.submodules.set(subName, sub);
      }
    }
    // Resolución de alias para qualified: recorre aliases registrados.
    function resolveAlias(parts: string[]): string[] {
      const aliases = data.aliases;
      // Probar todas las longitudes posibles de prefijo: Foo, Foo.Bar, ...
      for (let i = parts.length; i >= 1; i -= 1) {
        const prefix = parts.slice(0, i).join('.');
        if (aliases.has(prefix)) {
          const target = aliases.get(prefix)!;
          return [...target, ...parts.slice(i)];
        }
      }
      return parts;
    }
    // Pila de scopes activa durante el recorrido secuencial de comandos.
    const stack: ModuleScope[] = [seed, fileScope];
    // El fileScope tiene TODAS las defs ya cargadas, pero queremos shadowing
    // por orden. Mejor mantenemos un scope vacío para el archivo y lo
    // populamos conforme vamos viendo entries.
    // Reemplazo: usar un "live" file scope vacío.
    const liveFile = makeScope(fileScope.name, fileScope.qualifiedPath);
    stack[1] = liveFile;
    // Submodules ya conocidos del archivo (para resolver refs cualificadas
    // que apuntan a un submodule definido más arriba en el archivo).
    function bringSubmodule(qpath: string[]): void {
      const sub = findSubmodule(fileScope, qpath);
      if (!sub) return;
      // Encajar dentro de liveFile o de un nested submodule (no implementado
      // en detalle: para evitar perder defs, agregamos al liveFile).
      let cur = liveFile;
      for (let i = 0; i < qpath.length - 1; i += 1) {
        let nxt = cur.submodules.get(qpath[i]);
        if (!nxt) {
          nxt = makeScope(qpath[i], qpath.slice(0, i + 1).join('.'), cur);
          cur.submodules.set(qpath[i], nxt);
        }
        cur = nxt;
      }
      cur.submodules.set(qpath[qpath.length - 1], sub);
    }

    // Procesar entries en orden por byte offset.
    // Para Module entries en el flujo: cuando entramos a un Module local,
    // pusheamos su sub-scope para que las defs internas se vean entre sí; al
    // salir, popeamos. La info de orden de Module begin/end no está en
    // `entries` (solo entries de definiciones); el path es estático en cada
    // entry, así que basta seguir el module_path para sincronizar la pila.
    // Stack management por module_path:
    const moduleStack: string[] = [];
    function syncStack(targetPath: string[]): void {
      // Pop hasta common prefix.
      while (
        moduleStack.length > 0 &&
        (moduleStack.length > targetPath.length ||
          moduleStack[moduleStack.length - 1] !==
            targetPath[moduleStack.length - 1])
      ) {
        moduleStack.pop();
        stack.pop();
      }
      // Push lo que falta.
      while (moduleStack.length < targetPath.length) {
        const next = targetPath[moduleStack.length];
        moduleStack.push(next);
        const top = stack[stack.length - 1];
        let sub = top.submodules.get(next);
        if (!sub) {
          sub = makeScope(
            next,
            moduleStack.join('.'),
            top,
          );
          top.submodules.set(next, sub);
        }
        stack.push(sub);
      }
    }

    // Mid-file imports: cuando vemos un entry cuyo offset >= inlineImport.at,
    // ya aplicó. Recorremos entries en orden y trackeamos qué imports han
    // sido aplicados.
    const inlineImports = [...data.inlineImports].sort((a, b) => a.at - b.at);
    let inlineImportIdx = 0;

    // Recorremos entries en orden de byte offset.
    const sortedEntries = [...data.entries].sort(
      (a, b) => a.cmd_start_char - b.cmd_start_char,
    );

    for (const e of sortedEntries) {
      // Aplicar inline imports que ocurrieron antes de este entry.
      while (
        inlineImportIdx < inlineImports.length &&
        inlineImports[inlineImportIdx].at < e.cmd_start_char
      ) {
        const imp = inlineImports[inlineImportIdx];
        // El path puede ser:
        //   ["Foo"]          - Module local del archivo activo
        //   ["A"]            - archivo importado del proyecto
        //   ["A", "Foo"]     - sub-Module dentro de archivo importado
        //   ["Foo", "Sub"]   - sub-Module anidado del archivo activo
        let resolved: ModuleScope | undefined;
        const head = imp.path[0];
        const importedFileScope = fileScopeForModule(head);
        if (importedFileScope) {
          resolved =
            imp.path.length === 1
              ? importedFileScope
              : findSubmodule(importedFileScope, imp.path.slice(1));
        } else {
          resolved = findSubmodule(fileScope, imp.path);
        }
        if (resolved) {
          for (const [name, id] of resolved.defs) {
            shadowAdd(seed, name, id);
          }
          for (const [subName, sub] of resolved.submodules) {
            seed.submodules.set(subName, sub);
          }
        }
        inlineImportIdx += 1;
      }

      const targetPath = e.module_path ? e.module_path.split('.') : [];
      syncStack(targetPath);
      // Asegurar que submodules previos del archivo estén accesibles via
      // lookup qualified (e.g., otra entry referencia `Foo.bar` donde Foo es
      // un Module ya cerrado).
      // (Por simplicidad: el fileScope completo ya tiene los submodules, y
      // resolveQualified los va a encontrar via fileScopes[stem].)

      const ownNames = new Set<string>([
        e.name,
        ...e.children.map((c) => c.name),
      ]);

      // BELONGS_TO + REFERENCES_IN_TYPE de constructors / fields.
      for (const child of e.children) {
        const childQualified = e.module_path
          ? `${e.module_path}.${child.name}`
          : child.name;
        const cid = nodeId(filename, childQualified);
        addEdge(cid, e.id, 'BELONGS_TO');
        if (!child.type) continue;
        for (const ident of collectIdents(child.type)) {
          const parts = ident.split('.');
          if (parts.length === 1) {
            if (ownNames.has(ident)) continue;
            const tgt = lookupSimple(stack, ident);
            if (tgt) addEdge(cid, tgt, 'REFERENCES_IN_TYPE', 'type');
          } else {
            const tgt = lookupQualified(
              stack,
              parts,
              fileScopeForModule,
              resolveAlias,
              fileScope,
            );
            if (tgt) addEdge(cid, tgt, 'REFERENCES_IN_TYPE', 'type');
          }
        }
      }

      // REFERENCES desde el head.
      const headIdents = collectIdents(e.head);
      const headTargets = new Set<string>();
      for (const ident of headIdents) {
        const parts = ident.split('.');
        if (parts.length === 1) {
          if (ownNames.has(ident)) continue;
          const tgt = lookupSimple(stack, ident);
          if (tgt) headTargets.add(tgt);
        } else {
          const tgt = lookupQualified(
            stack,
            parts,
            fileScopeForModule,
            resolveAlias,
            fileScope,
          );
          if (tgt) headTargets.add(tgt);
        }
      }
      for (const tgt of [...headTargets].sort()) {
        addEdge(e.id, tgt, 'REFERENCES_IN_TYPE', 'head');
      }

      // REFERENCES desde el proof.
      if (e.proof) {
        const proofIdents = collectIdents(e.proof);
        const proofTargets = new Set<string>();
        for (const ident of proofIdents) {
          const parts = ident.split('.');
          if (parts.length === 1) {
            if (ownNames.has(ident)) continue;
            const tgt = lookupSimple(stack, ident);
            if (tgt) proofTargets.add(tgt);
          } else {
            const tgt = lookupQualified(
              stack,
              parts,
              fileScopeForModule,
              resolveAlias,
              fileScope,
            );
            if (tgt) proofTargets.add(tgt);
          }
        }
        for (const tgt of [...proofTargets].sort()) {
          if (headTargets.has(tgt)) continue;
          addEdge(e.id, tgt, 'REFERENCES_IN_PROOF', 'proof');
        }
      }

      // Después de resolver las refs, agregar e al scope actual.
      const topScope = stack[stack.length - 1];
      shadowAdd(topScope, e.name, e.id);
      for (const child of e.children) {
        const childQualified = e.module_path
          ? `${e.module_path}.${child.name}`
          : child.name;
        shadowAdd(topScope, child.name, nodeId(filename, childQualified));
      }
      // Si este entry está dentro de un Module en el archivo, asegurarnos de
      // que el submodule correspondiente al module_path en liveFile contenga
      // esta def (para que refs cualificadas Foo.bar desde otra entry del
      // mismo archivo o de otro archivo lo encuentren).
      if (e.module_path) {
        bringSubmodule(e.module_path.split('.'));
      }
    }
  }

  return {
    nodes,
    edges,
    _meta: {
      files: files.map((f) => f.path),
      node_count: nodes.length,
      edge_count: edges.length,
      duplicate_names: [...duplicates].sort(),
    },
  };
}

/** Crea (o devuelve) un submodule en la jerarquía dado un path dotted. */
function findOrCreateSubmodule(
  root: ModuleScope,
  path: string[],
): ModuleScope {
  let cur = root;
  const acc: string[] = [];
  for (const p of path) {
    acc.push(p);
    let next = cur.submodules.get(p);
    if (!next) {
      next = makeScope(p, acc.join('.'), cur);
      cur.submodules.set(p, next);
    }
    cur = next;
  }
  return cur;
}
