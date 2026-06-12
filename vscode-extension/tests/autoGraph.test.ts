import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BuiltGraph, GraphEdge, GraphNode } from '../src/buildGraph';
import {
  builtGraphFingerprint,
  edgeIdentityKey,
  nodeIdentityKey,
  preserveEnrichmentBuilt,
  refKindOf,
} from '../src/autoGraph';

function node(
  file: string,
  qname: string,
  extra?: Partial<GraphNode>,
): GraphNode {
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

function edge(
  src: GraphNode,
  tgt: GraphNode,
  label = 'REFERENCES_IN_TYPE',
  ref_kind = 'head',
): GraphEdge {
  return {
    id: `${src.id}->${tgt.id}/${label}/${ref_kind}`,
    labels: [label],
    endpoints: [nodeIdentityKey(src), nodeIdentityKey(tgt)],
    directionality: '->',
    props: { ref_kind },
  };
}

function built(nodes: GraphNode[], edges: GraphEdge[]): BuiltGraph {
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

test('refKindOf: prefers ref_kind, falls back to where', () => {
  assert.equal(refKindOf({ ref_kind: 'head' }), 'head');
  assert.equal(refKindOf({ where: 'head' }), 'head');
  assert.equal(refKindOf({ ref_kind: 'proof', where: 'head' }), 'proof');
  assert.equal(refKindOf(undefined), '');
  assert.equal(refKindOf({}), '');
});

test('nodeIdentityKey: file::qualified_name', () => {
  const n = node('A.v', 'Foo.bar');
  assert.equal(nodeIdentityKey(n), 'A.v::Foo.bar');
});

test('edgeIdentityKey: composite of endpoints + label + ref_kind', () => {
  const a = node('A.v', 'a');
  const b = node('B.v', 'b');
  const e = edge(a, b, 'REFERENCES_IN_TYPE', 'head');
  assert.equal(
    edgeIdentityKey(e),
    'A.v::a|B.v::b|REFERENCES_IN_TYPE|head',
  );
});

test('builtGraphFingerprint: stable across reorderings', () => {
  const a = node('A.v', 'a');
  const b = node('B.v', 'b');
  const e1 = edge(a, b, 'REFERENCES_IN_TYPE', 'head');
  const e2 = edge(a, b, 'REFERENCES_IN_PROOF', 'proof');
  const fp1 = builtGraphFingerprint(built([a, b], [e1, e2]));
  const fp2 = builtGraphFingerprint(built([b, a], [e2, e1]));
  assert.equal(fp1, fp2);
});

test('builtGraphFingerprint: differs when a prop changes', () => {
  const a1 = node('A.v', 'a', { props: { line: 1 } });
  const a2 = node('A.v', 'a', { props: { line: 42 } });
  const fp1 = builtGraphFingerprint(built([a1], []));
  const fp2 = builtGraphFingerprint(built([a2], []));
  assert.notEqual(fp1, fp2);
});

test('preserveEnrichmentBuilt: copies dpd_* props from prev onto textual', () => {
  const aPrev = node('A.v', 'a', {
    props: { line: 1, dpd_kind: 'definition', dpd_body: true },
  });
  const aCurr = node('A.v', 'a', { props: { line: 42 } });
  const merged = preserveEnrichmentBuilt(built([aCurr], []), built([aPrev], []));
  const m = merged.nodes[0];
  assert.equal(m.props.line, 42); // textual prop wins
  assert.equal(m.props.dpd_kind, 'definition'); // dpd prop preserved
  assert.equal(m.props.dpd_body, true);
});

test('preserveEnrichmentBuilt: drops dpd when textual no longer has the node', () => {
  const aPrev = node('A.v', 'a', { props: { dpd_kind: 'definition' } });
  const merged = preserveEnrichmentBuilt(built([], []), built([aPrev], []));
  assert.equal(merged.nodes.length, 0);
});

test('preserveEnrichmentBuilt: keeps REFERENCES_ELABORATED when both endpoints survive', () => {
  const a = node('A.v', 'a');
  const b = node('B.v', 'b');
  const elaborated = edge(a, b, 'REFERENCES_ELABORATED', 'elaborated');
  const merged = preserveEnrichmentBuilt(
    built([a, b], []),
    built([a, b], [elaborated]),
  );
  const elabCount = merged.edges.filter(
    (e) => e.labels[0] === 'REFERENCES_ELABORATED',
  ).length;
  assert.equal(elabCount, 1);
});

test('preserveEnrichmentBuilt: drops REFERENCES_ELABORATED when an endpoint disappeared', () => {
  const a = node('A.v', 'a');
  const b = node('B.v', 'b');
  const elaborated = edge(a, b, 'REFERENCES_ELABORATED', 'elaborated');
  const merged = preserveEnrichmentBuilt(
    built([a], []),
    built([a, b], [elaborated]),
  );
  const elab = merged.edges.find((e) => e.labels[0] === 'REFERENCES_ELABORATED');
  assert.equal(elab, undefined);
});

test('preserveEnrichmentBuilt: forwards dpd_weight onto textual edges', () => {
  const a = node('A.v', 'a');
  const b = node('B.v', 'b');
  const prevEdge: GraphEdge = {
    id: 'p',
    labels: ['REFERENCES_IN_TYPE'],
    endpoints: [nodeIdentityKey(a), nodeIdentityKey(b)],
    directionality: '->',
    props: { ref_kind: 'head', dpd_weight: 3 },
  };
  const textualEdge: GraphEdge = {
    id: 't',
    labels: ['REFERENCES_IN_TYPE'],
    endpoints: [nodeIdentityKey(a), nodeIdentityKey(b)],
    directionality: '->',
    props: { ref_kind: 'head' },
  };
  const merged = preserveEnrichmentBuilt(
    built([a, b], [textualEdge]),
    built([a, b], [prevEdge]),
  );
  const e = merged.edges[0];
  assert.equal((e.props as { dpd_weight: number }).dpd_weight, 3);
});
