"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = require("node:assert");
const autoGraph_1 = require("../src/autoGraph");
function node(file, qname, extra) {
    return {
        id: `${file}::${qname}`,
        labels: extra?.labels ?? ['Definition'],
        props: {
            name: qname.split('.').pop() ?? qname,
            qualified_name: qname,
            file,
            kind: 'Definition',
            line: 1,
            ...(extra?.props ?? {}),
        },
    };
}
function edge(src, tgt, label = 'REFERENCES_IN_TYPE', ref_kind = 'head') {
    return {
        id: `${src.id}->${tgt.id}/${label}/${ref_kind}`,
        labels: [label],
        endpoints: [(0, autoGraph_1.nodeIdentityKey)(src), (0, autoGraph_1.nodeIdentityKey)(tgt)],
        directionality: '->',
        props: { ref_kind },
    };
}
function built(nodes, edges) {
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
(0, node_test_1.test)('refKindOf: prefers ref_kind, falls back to where', () => {
    node_assert_1.strict.equal((0, autoGraph_1.refKindOf)({ ref_kind: 'head' }), 'head');
    node_assert_1.strict.equal((0, autoGraph_1.refKindOf)({ where: 'head' }), 'head');
    node_assert_1.strict.equal((0, autoGraph_1.refKindOf)({ ref_kind: 'proof', where: 'head' }), 'proof');
    node_assert_1.strict.equal((0, autoGraph_1.refKindOf)(undefined), '');
    node_assert_1.strict.equal((0, autoGraph_1.refKindOf)({}), '');
});
(0, node_test_1.test)('nodeIdentityKey: file::qualified_name', () => {
    const n = node('A.v', 'Foo.bar');
    node_assert_1.strict.equal((0, autoGraph_1.nodeIdentityKey)(n), 'A.v::Foo.bar');
});
(0, node_test_1.test)('edgeIdentityKey: composite of endpoints + label + ref_kind', () => {
    const a = node('A.v', 'a');
    const b = node('B.v', 'b');
    const e = edge(a, b, 'REFERENCES_IN_TYPE', 'head');
    node_assert_1.strict.equal((0, autoGraph_1.edgeIdentityKey)(e), 'A.v::a|B.v::b|REFERENCES_IN_TYPE|head');
});
(0, node_test_1.test)('builtGraphFingerprint: stable across reorderings', () => {
    const a = node('A.v', 'a');
    const b = node('B.v', 'b');
    const e1 = edge(a, b, 'REFERENCES_IN_TYPE', 'head');
    const e2 = edge(a, b, 'REFERENCES_IN_PROOF', 'proof');
    const fp1 = (0, autoGraph_1.builtGraphFingerprint)(built([a, b], [e1, e2]));
    const fp2 = (0, autoGraph_1.builtGraphFingerprint)(built([b, a], [e2, e1]));
    node_assert_1.strict.equal(fp1, fp2);
});
(0, node_test_1.test)('builtGraphFingerprint: differs when a prop changes', () => {
    const a1 = node('A.v', 'a', { props: { line: 1 } });
    const a2 = node('A.v', 'a', { props: { line: 42 } });
    const fp1 = (0, autoGraph_1.builtGraphFingerprint)(built([a1], []));
    const fp2 = (0, autoGraph_1.builtGraphFingerprint)(built([a2], []));
    node_assert_1.strict.notEqual(fp1, fp2);
});
(0, node_test_1.test)('preserveEnrichmentBuilt: copies dpd_* props from prev onto textual', () => {
    const aPrev = node('A.v', 'a', {
        props: { line: 1, dpd_kind: 'definition', dpd_body: true },
    });
    const aCurr = node('A.v', 'a', { props: { line: 42 } });
    const merged = (0, autoGraph_1.preserveEnrichmentBuilt)(built([aCurr], []), built([aPrev], []));
    const m = merged.nodes[0];
    node_assert_1.strict.equal(m.props.line, 42); // textual prop wins
    node_assert_1.strict.equal(m.props.dpd_kind, 'definition'); // dpd prop preserved
    node_assert_1.strict.equal(m.props.dpd_body, true);
});
(0, node_test_1.test)('preserveEnrichmentBuilt: drops dpd when textual no longer has the node', () => {
    const aPrev = node('A.v', 'a', { props: { dpd_kind: 'definition' } });
    const merged = (0, autoGraph_1.preserveEnrichmentBuilt)(built([], []), built([aPrev], []));
    node_assert_1.strict.equal(merged.nodes.length, 0);
});
(0, node_test_1.test)('preserveEnrichmentBuilt: keeps REFERENCES_ELABORATED when both endpoints survive', () => {
    const a = node('A.v', 'a');
    const b = node('B.v', 'b');
    const elaborated = edge(a, b, 'REFERENCES_ELABORATED', 'elaborated');
    const merged = (0, autoGraph_1.preserveEnrichmentBuilt)(built([a, b], []), built([a, b], [elaborated]));
    const elabCount = merged.edges.filter((e) => e.labels[0] === 'REFERENCES_ELABORATED').length;
    node_assert_1.strict.equal(elabCount, 1);
});
(0, node_test_1.test)('preserveEnrichmentBuilt: drops REFERENCES_ELABORATED when an endpoint disappeared', () => {
    const a = node('A.v', 'a');
    const b = node('B.v', 'b');
    const elaborated = edge(a, b, 'REFERENCES_ELABORATED', 'elaborated');
    const merged = (0, autoGraph_1.preserveEnrichmentBuilt)(built([a], []), built([a, b], [elaborated]));
    const elab = merged.edges.find((e) => e.labels[0] === 'REFERENCES_ELABORATED');
    node_assert_1.strict.equal(elab, undefined);
});
(0, node_test_1.test)('preserveEnrichmentBuilt: forwards dpd_weight onto textual edges', () => {
    const a = node('A.v', 'a');
    const b = node('B.v', 'b');
    const prevEdge = {
        id: 'p',
        labels: ['REFERENCES_IN_TYPE'],
        endpoints: [(0, autoGraph_1.nodeIdentityKey)(a), (0, autoGraph_1.nodeIdentityKey)(b)],
        directionality: '->',
        props: { ref_kind: 'head', dpd_weight: 3 },
    };
    const textualEdge = {
        id: 't',
        labels: ['REFERENCES_IN_TYPE'],
        endpoints: [(0, autoGraph_1.nodeIdentityKey)(a), (0, autoGraph_1.nodeIdentityKey)(b)],
        directionality: '->',
        props: { ref_kind: 'head' },
    };
    const merged = (0, autoGraph_1.preserveEnrichmentBuilt)(built([a, b], [textualEdge]), built([a, b], [prevEdge]));
    const e = merged.edges[0];
    node_assert_1.strict.equal(e.props.dpd_weight, 3);
});
//# sourceMappingURL=autoGraph.test.js.map