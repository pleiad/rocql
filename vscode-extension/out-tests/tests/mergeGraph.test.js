"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const mergeGraph_1 = require("../src/mergeGraph");
function textualFixture() {
    return {
        nodes: [
            {
                id: 'A.v::foo',
                labels: ['Definition'],
                props: {
                    name: 'foo',
                    qualified_name: 'foo',
                    module_path: '',
                    file: 'A.v',
                    kind: 'Definition',
                    line: 1,
                },
            },
            {
                id: 'A.v::Foo.x',
                labels: ['Definition'],
                props: {
                    name: 'x',
                    qualified_name: 'Foo.x',
                    module_path: 'Foo',
                    file: 'A.v',
                    kind: 'Definition',
                    line: 3,
                },
            },
        ],
        edges: [],
        _meta: { files: ['/A.v'], node_count: 2, edge_count: 0, duplicate_names: [] },
    };
}
(0, node_test_1.describe)('mergeGraphs', () => {
    (0, node_test_1.test)('matchea por (file, qualified_name)', () => {
        const textual = textualFixture();
        const dpd = {
            nodes: [
                {
                    id: 1,
                    name: 'foo',
                    kind: 'cnst',
                    body: true,
                    prop: false,
                    sourceFile: 'A',
                    modulePath: '',
                    qualifiedName: 'foo',
                },
                {
                    id: 2,
                    name: 'x',
                    kind: 'cnst',
                    body: true,
                    prop: false,
                    sourceFile: 'A',
                    modulePath: 'Foo',
                    qualifiedName: 'Foo.x',
                },
            ],
            edges: [{ src: 1, tgt: 2, weight: 4 }],
        };
        const moduleToFile = new Map([['A', 'A.v']]);
        const { graph, stats } = (0, mergeGraph_1.mergeGraphs)(textual, dpd, moduleToFile);
        node_assert_1.default.equal(stats.matchedNodes, 2);
        node_assert_1.default.equal(stats.unmatchedDpdNodes, 0);
        // foo y x.foo deben tener dpd_kind enriquecido.
        const foo = graph.nodes.find((n) => n.id === 'A.v::foo');
        node_assert_1.default.equal(foo.props.dpd_kind, 'cnst');
        const fooX = graph.nodes.find((n) => n.id === 'A.v::Foo.x');
        node_assert_1.default.equal(fooX.props.dpd_kind, 'cnst');
        node_assert_1.default.equal(fooX.props.dpd_module, 'Foo');
        // Arista del dpd no estaba en textual → se agrega como ELABORATED.
        const elab = graph.edges.find((e) => e.labels[0] === 'REFERENCES_ELABORATED');
        node_assert_1.default.ok(elab);
        node_assert_1.default.equal(elab.endpoints[0], 'A.v::foo');
        node_assert_1.default.equal(elab.endpoints[1], 'A.v::Foo.x');
        node_assert_1.default.equal(stats.addedElaboratedEdges, 1);
    });
    (0, node_test_1.test)('enriquece arista textual ya existente con dpd_weight', () => {
        const textual = textualFixture();
        textual.edges.push({
            id: 'e0',
            labels: ['REFERENCES_IN_TYPE'],
            endpoints: ['A.v::foo', 'A.v::Foo.x'],
            directionality: '->',
            props: { ref_kind: 'head' },
        });
        const dpd = {
            nodes: [
                {
                    id: 1,
                    name: 'foo',
                    kind: 'cnst',
                    body: true,
                    prop: false,
                    sourceFile: 'A',
                    modulePath: '',
                    qualifiedName: 'foo',
                },
                {
                    id: 2,
                    name: 'x',
                    kind: 'cnst',
                    body: true,
                    prop: false,
                    sourceFile: 'A',
                    modulePath: 'Foo',
                    qualifiedName: 'Foo.x',
                },
            ],
            edges: [{ src: 1, tgt: 2, weight: 7 }],
        };
        const { graph, stats } = (0, mergeGraph_1.mergeGraphs)(textual, dpd, new Map([['A', 'A.v']]));
        node_assert_1.default.equal(stats.enrichedEdges, 1);
        node_assert_1.default.equal(stats.addedElaboratedEdges, 0);
        const e = graph.edges.find((x) => x.id === 'e0');
        node_assert_1.default.equal(e.props.dpd_weight, 7);
    });
    (0, node_test_1.test)('nodo dpd sin match queda como unmatched (no inventa arista espuria)', () => {
        const textual = textualFixture();
        const dpd = {
            nodes: [
                {
                    id: 1,
                    name: 'ghost',
                    kind: 'cnst',
                    body: true,
                    prop: false,
                    sourceFile: 'Z',
                    modulePath: '',
                    qualifiedName: 'ghost',
                },
            ],
            edges: [],
        };
        const { stats } = (0, mergeGraph_1.mergeGraphs)(textual, dpd, new Map([['A', 'A.v']]));
        node_assert_1.default.equal(stats.matchedNodes, 0);
        node_assert_1.default.equal(stats.unmatchedDpdNodes, 1);
    });
});
//# sourceMappingURL=mergeGraph.test.js.map