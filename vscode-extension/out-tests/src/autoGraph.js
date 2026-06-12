"use strict";
// Auto-graph: rebuild del .gdb sobre cada save de .v y sobre cada transición
// de VsRocq a verde.
//
// Por qué full rebuild via importJson y no DML incremental: cada MATCH dentro
// de DML invalida el TripleIndex de frogql y la siguiente lectura paga ~700ms
// de cache rebuild. Para un batch de 50 edges (típico tras editar una entry
// con varias refs), serían >35 s por save. En cambio drop + importJson +
// reopen toma ~25-35 ms para grafos del orden de 5000 nodos/edges. La
// "transacción" es atómica por construcción (escribimos el .gdb nuevo y luego
// reabrimos).
//
// El único trabajo no trivial del módulo es `preserveEnrichmentBuilt`:
// arrastra desde el grafo previo las props `dpd_*` y las aristas
// `REFERENCES_ELABORATED`, porque la capa textual no las produce y sin esto
// cada save sin dpd-corrido borraría el enrichment del último merge.
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotKey = snapshotKey;
exports.refKindOf = refKindOf;
exports.edgeIdentityKey = edgeIdentityKey;
exports.nodeIdentityKey = nodeIdentityKey;
exports.hydrateBuiltFromGdb = hydrateBuiltFromGdb;
exports.preserveEnrichmentBuilt = preserveEnrichmentBuilt;
exports.builtGraphFingerprint = builtGraphFingerprint;
function snapshotKey(file, qname) {
    return `${file}::${qname}`;
}
/**
 * Lee `ref_kind` con fallback a `where` para compat con .gdb generados antes
 * del rename (where es palabra reservada GQL).
 */
function refKindOf(props) {
    if (!props)
        return '';
    const rk = props.ref_kind;
    if (rk)
        return rk;
    const w = props.where;
    return w ?? '';
}
/** Clave estable de una arista para identidad ((src, tgt, label, ref_kind)). */
function edgeIdentityKey(e) {
    const rk = refKindOf(e.props);
    const label = e.labels[0] ?? '';
    return `${e.endpoints[0]}|${e.endpoints[1]}|${label}|${rk}`;
}
/** Clave estable de un nodo (`<file>::<qualified_name>`). */
function nodeIdentityKey(n) {
    const file = String(n.props.file ?? '');
    const qname = String(n.props.qualified_name ?? '');
    return snapshotKey(file, qname);
}
/**
 * Reconstruye un BuiltGraph leyendo el estado actual del .gdb. Útil al
 * reactivar el modo: nos da una base para preservar enrichment del último
 * dpd sin tener que volver a invocarlo.
 */
function hydrateBuiltFromGdb(conn) {
    const nodes = [];
    const edges = [];
    const nodeRows = conn.execute('(n)', 1_000_000);
    for (const row of nodeRows) {
        const path = row._paths?.[0];
        if (!Array.isArray(path) || path.length === 0)
            continue;
        const n = path[0];
        if (!n || n.kind !== 'node')
            continue;
        nodes.push({
            id: nodeIdentityKey({
                id: '',
                labels: n.labels,
                props: n.props,
            }),
            labels: [...n.labels],
            props: normalizeProps(n.props),
        });
    }
    const edgeRows = conn.execute('()-[e]->()', 1_000_000);
    let counter = 0;
    for (const row of edgeRows) {
        const path = row._paths?.[0];
        if (!Array.isArray(path) || path.length < 3)
            continue;
        const src = path[0];
        const edge = path[1];
        const tgt = path[2];
        if (!src || !edge || !tgt)
            continue;
        const srcKey = snapshotKey(String(src.props.file ?? ''), String(src.props.qualified_name ?? ''));
        const tgtKey = snapshotKey(String(tgt.props.file ?? ''), String(tgt.props.qualified_name ?? ''));
        counter += 1;
        edges.push({
            id: `e${counter}`,
            labels: [...edge.labels],
            endpoints: [srcKey, tgtKey],
            directionality: '->',
            props: edgePropsNormalized(edge.props),
        });
    }
    return {
        nodes,
        edges,
        _meta: {
            files: [],
            node_count: nodes.length,
            edge_count: edges.length,
            duplicate_names: [],
        },
    };
}
/** Copia props sustituyendo `where` legacy por `ref_kind`. */
function normalizeProps(props) {
    return { ...props };
}
function edgePropsNormalized(props) {
    if (!props)
        return {};
    const out = { ...props };
    const rk = refKindOf(props);
    if (rk && out.ref_kind === undefined)
        out.ref_kind = rk;
    delete out.where;
    return out;
}
/**
 * Combina un BuiltGraph textual recién parseado con un BuiltGraph previo,
 * arrastrando enrichment dpd. Específicamente:
 *   - Para cada nodo presente en ambos, copia props que empiecen con `dpd_`.
 *   - Conserva aristas `REFERENCES_ELABORATED` del previo cuyos endpoints
 *     siguen vivos en el textual nuevo.
 *   - Para aristas textuales que existían en prev con `dpd_weight`, copia ese
 *     prop forward.
 */
function preserveEnrichmentBuilt(textual, prev) {
    const prevNodeByKey = new Map();
    for (const n of prev.nodes)
        prevNodeByKey.set(nodeIdentityKey(n), n);
    const prevEdgeByKey = new Map();
    for (const e of prev.edges)
        prevEdgeByKey.set(edgeIdentityKey(e), e);
    const nodes = textual.nodes.map((n) => {
        const key = nodeIdentityKey(n);
        const prevN = prevNodeByKey.get(key);
        if (!prevN)
            return n;
        const merged = { ...n.props };
        for (const pk of Object.keys(prevN.props)) {
            if (pk.startsWith('dpd_'))
                merged[pk] = prevN.props[pk];
        }
        return { ...n, props: merged };
    });
    const liveNodeKeys = new Set(nodes.map(nodeIdentityKey));
    const seenEdgeKeys = new Set();
    const edges = [];
    for (const e of textual.edges) {
        const key = edgeIdentityKey(e);
        seenEdgeKeys.add(key);
        const prevE = prevEdgeByKey.get(key);
        if (prevE && prevE.props.dpd_weight !== undefined) {
            edges.push({
                ...e,
                props: {
                    ...(e.props ?? {}),
                    dpd_weight: prevE.props.dpd_weight,
                },
            });
        }
        else {
            edges.push(e);
        }
    }
    for (const e of prev.edges) {
        if (e.labels[0] !== 'REFERENCES_ELABORATED')
            continue;
        const key = edgeIdentityKey(e);
        if (seenEdgeKeys.has(key))
            continue;
        if (!liveNodeKeys.has(e.endpoints[0]) || !liveNodeKeys.has(e.endpoints[1])) {
            continue;
        }
        edges.push(e);
    }
    return {
        nodes,
        edges,
        _meta: {
            files: textual._meta.files,
            node_count: nodes.length,
            edge_count: edges.length,
            duplicate_names: textual._meta.duplicate_names,
        },
    };
}
/**
 * Compara dos BuiltGraph con un hash estable. Sirve para skipear el rebuild
 * cuando el contenido no cambió (e.g. el usuario guardó un .v que sigue
 * generando los mismos nodos/aristas).
 */
function builtGraphFingerprint(g) {
    const nodes = g.nodes
        .map((n) => `${nodeIdentityKey(n)}|${[...n.labels].sort().join(',')}|${stableJson(n.props)}`)
        .sort();
    const edges = g.edges.map((e) => edgeIdentityKey(e)).sort();
    return `${nodes.length}#${edges.length}\n${nodes.join('\n')}\n${edges.join('\n')}`;
}
function stableJson(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    const obj = value;
    const parts = Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`);
    return `{${parts.join(',')}}`;
}
//# sourceMappingURL=autoGraph.js.map