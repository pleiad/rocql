import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mergeGraphs } from '../src/mergeGraph';
import type { BuiltGraph } from '../src/buildGraph';
import type { DpdGraph } from '../src/dpdgraph';

function textualFixture(): BuiltGraph {
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

describe('mergeGraphs', () => {
  test('matchea por (file, qualified_name)', () => {
    const textual = textualFixture();
    const dpd: DpdGraph = {
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
    const { graph, stats } = mergeGraphs(textual, dpd, moduleToFile);
    assert.equal(stats.matchedNodes, 2);
    assert.equal(stats.unmatchedDpdNodes, 0);
    // foo y x.foo deben tener dpd_kind enriquecido.
    const foo = graph.nodes.find((n) => n.id === 'A.v::foo')!;
    assert.equal(foo.props.dpd_kind, 'cnst');
    const fooX = graph.nodes.find((n) => n.id === 'A.v::Foo.x')!;
    assert.equal(fooX.props.dpd_kind, 'cnst');
    assert.equal(fooX.props.dpd_module, 'Foo');
    // Arista del dpd no estaba en textual → se agrega como ELABORATED.
    const elab = graph.edges.find(
      (e) => e.labels[0] === 'REFERENCES_ELABORATED',
    );
    assert.ok(elab);
    assert.equal(elab!.endpoints[0], 'A.v::foo');
    assert.equal(elab!.endpoints[1], 'A.v::Foo.x');
    assert.equal(stats.addedElaboratedEdges, 1);
  });

  test('enriquece arista textual ya existente con dpd_weight', () => {
    const textual = textualFixture();
    textual.edges.push({
      id: 'e0',
      labels: ['REFERENCES_IN_TYPE'],
      endpoints: ['A.v::foo', 'A.v::Foo.x'],
      directionality: '->',
      props: { ref_kind: 'head' },
    });
    const dpd: DpdGraph = {
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
    const { graph, stats } = mergeGraphs(
      textual,
      dpd,
      new Map([['A', 'A.v']]),
    );
    assert.equal(stats.enrichedEdges, 1);
    assert.equal(stats.addedElaboratedEdges, 0);
    const e = graph.edges.find((x) => x.id === 'e0')!;
    assert.equal(e.props.dpd_weight, 7);
  });

  test('nodo dpd sin match queda como unmatched (no inventa arista espuria)', () => {
    const textual = textualFixture();
    const dpd: DpdGraph = {
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
    const { stats } = mergeGraphs(
      textual,
      dpd,
      new Map([['A', 'A.v']]),
    );
    assert.equal(stats.matchedNodes, 0);
    assert.equal(stats.unmatchedDpdNodes, 1);
  });
});
