// Combina el grafo textual (buildGraph.ts) con el grafo del kernel (dpdgraph.ts).
//
// - Los nodos del textual son la fuente principal de posiciones (file, line,
//   byte ranges). El dpdgraph aporta metadata: body, prop, kind del kernel,
//   y weight en aristas.
// - Las aristas del dpdgraph que no aparecen en el textual se agregan como
//   REFERENCES_ELABORATED (refs implícitas vía tactics, typeclasses, notations).
// - Las aristas textuales que no aparecen en el dpdgraph se mantienen tal cual
//   (sirven para BELONGS_TO y para referencias que el kernel resolvió a algo
//   fuera del proyecto pero el textual sí registró).
//
// Desambiguación: cada DpdNode lleva sourceModule (el módulo dotted-name del
// que provino). Combinado con el mapping moduleToFile del CoqProject sabemos
// el archivo exacto, evitando matches cross-file por colisión de nombres.

import type { BuiltGraph, GraphEdge, GraphNode } from './buildGraph';
import type { DpdGraph, DpdNode } from './dpdgraph';

export interface MergeStats {
  matchedNodes: number;
  unmatchedDpdNodes: number;
  enrichedEdges: number;
  addedElaboratedEdges: number;
}

/** Mapa module-dotted-name -> basename del archivo .v. */
export type ModuleToFile = Map<string, string>;

export function mergeGraphs(
  textual: BuiltGraph,
  dpd: DpdGraph,
  moduleToFile: ModuleToFile,
): { graph: BuiltGraph; stats: MergeStats } {
  const stats: MergeStats = {
    matchedNodes: 0,
    unmatchedDpdNodes: 0,
    enrichedEdges: 0,
    addedElaboratedEdges: 0,
  };

  // Índice (file, qualified_name) -> nodo textual. Es el match canónico, y
  // distingue defs en Modules (Mod.x vs top-level x).
  const byFileQualified = new Map<string, GraphNode>();
  // Índice de respaldo por solo name simple, para fallback cuando sourceFile
  // no resuelve.
  const byName = new Map<string, GraphNode[]>();
  for (const n of textual.nodes) {
    const name = String(n.props.name ?? '');
    const qualified = String(n.props.qualified_name ?? name);
    const file = String(n.props.file ?? '');
    if (!name) continue;
    if (file) byFileQualified.set(`${file}::${qualified}`, n);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(n);
  }

  const dpdToTextual = new Map<number, GraphNode>();
  for (const d of dpd.nodes) {
    const matched = chooseMatch(d, moduleToFile, byFileQualified, byName);
    if (!matched) {
      stats.unmatchedDpdNodes += 1;
      continue;
    }
    dpdToTextual.set(d.id, matched);
    enrichNodeProps(matched, d);
    stats.matchedNodes += 1;
  }

  // Índice de aristas por endpoints.
  const edgeBySrcTgt = new Map<string, GraphEdge[]>();
  for (const e of textual.edges) {
    const key = `${e.endpoints[0]}|${e.endpoints[1]}`;
    if (!edgeBySrcTgt.has(key)) edgeBySrcTgt.set(key, []);
    edgeBySrcTgt.get(key)!.push(e);
  }

  let counter = textual.edges.length;
  for (const de of dpd.edges) {
    const srcNode = dpdToTextual.get(de.src);
    const tgtNode = dpdToTextual.get(de.tgt);
    if (!srcNode || !tgtNode) continue;
    const key = `${srcNode.id}|${tgtNode.id}`;
    const existing = edgeBySrcTgt.get(key) ?? [];
    if (existing.length > 0) {
      for (const e of existing) {
        const prev =
          typeof e.props.dpd_weight === 'number'
            ? (e.props.dpd_weight as number)
            : 0;
        e.props.dpd_weight = prev + de.weight / existing.length;
      }
      stats.enrichedEdges += 1;
      continue;
    }
    const newEdge: GraphEdge = {
      id: `edpd${counter}`,
      labels: ['REFERENCES_ELABORATED'],
      endpoints: [srcNode.id, tgtNode.id],
      directionality: '->',
      props: {
        ref_kind: 'elaborated',
        weight: de.weight,
      },
    };
    counter += 1;
    textual.edges.push(newEdge);
    if (!edgeBySrcTgt.has(key)) edgeBySrcTgt.set(key, []);
    edgeBySrcTgt.get(key)!.push(newEdge);
    stats.addedElaboratedEdges += 1;
  }

  textual._meta.edge_count = textual.edges.length;
  return { graph: textual, stats };
}

function enrichNodeProps(n: GraphNode, d: DpdNode): void {
  n.props.dpd_kind = d.kind;
  n.props.dpd_body = d.body;
  n.props.dpd_prop = d.prop;
  if (d.sourceFile) n.props.dpd_file = d.sourceFile;
  if (d.modulePath) n.props.dpd_module = d.modulePath;
}

/** Elige el nodo textual que corresponde al nodo del dpdgraph. */
function chooseMatch(
  d: DpdNode,
  moduleToFile: ModuleToFile,
  byFileQualified: Map<string, GraphNode>,
  byName: Map<string, GraphNode[]>,
): GraphNode | null {
  // Camino canónico: sourceFile -> basename -> (file, qualified_name).
  const file = moduleToFile.get(d.sourceFile);
  if (file) {
    const node = byFileQualified.get(`${file}::${d.qualifiedName}`);
    if (node) return node;
  }

  // Fallback: candidatos por nombre simple, filtrados por kind.
  const candidates = byName.get(d.name) ?? [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const byKind = candidates.filter((c) =>
    kindCompatible(d.kind, String(c.props.kind ?? '')),
  );
  if (byKind.length === 1) return byKind[0];

  // Sin más info, dejar sin match para no inventar aristas espurias.
  return null;
}

function kindCompatible(dpdKind: string, textualKind: string): boolean {
  const tk = textualKind.toLowerCase();
  switch (dpdKind) {
    case 'cnst':
      return (
        tk === 'definition' ||
        tk === 'theorem' ||
        tk === 'lemma' ||
        tk === 'corollary' ||
        tk === 'proposition' ||
        tk === 'fact' ||
        tk === 'remark' ||
        tk === 'fixpoint' ||
        tk === 'cofixpoint' ||
        tk === 'function' ||
        tk === 'equations' ||
        tk === 'example' ||
        tk === 'instance' ||
        tk === 'axiom' ||
        tk === 'parameter' ||
        tk === 'variable' ||
        tk === 'hypothesis'
      );
    case 'inductive':
      return tk === 'inductive' || tk === 'coinductive' || tk === 'record';
    case 'construct':
      return tk === 'constructor' || tk === 'field';
    default:
      return true;
  }
}
