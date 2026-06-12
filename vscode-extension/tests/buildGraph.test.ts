import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildGraph, BuiltGraph, GraphNode, GraphEdge } from '../src/buildGraph';

function f(relpath: string, text: string): {
  path: string;
  relpath: string;
  text: string;
} {
  return { path: `/${relpath}`, relpath, text };
}

function node(g: BuiltGraph, pred: (n: GraphNode) => boolean): GraphNode {
  const n = g.nodes.find(pred);
  if (!n) throw new Error('no node matching predicate');
  return n;
}

function nodeMaybe(
  g: BuiltGraph,
  pred: (n: GraphNode) => boolean,
): GraphNode | undefined {
  return g.nodes.find(pred);
}

function edgesFrom(g: BuiltGraph, srcId: string): GraphEdge[] {
  return g.edges.filter((e) => e.endpoints[0] === srcId);
}

function hasEdge(g: BuiltGraph, srcId: string, tgtId: string): boolean {
  return g.edges.some(
    (e) => e.endpoints[0] === srcId && e.endpoints[1] === tgtId,
  );
}

describe('buildGraph — basic', () => {
  test('extrae una Definition simple', () => {
    const g = buildGraph([f('A.v', 'Definition x := 1.')]);
    const x = node(g, (n) => n.props.name === 'x');
    assert.equal(x.props.kind, 'Definition');
    assert.equal(x.props.file, 'A.v');
    assert.equal(x.props.qualified_name, 'x');
    assert.equal(x.props.module_path, '');
    assert.equal(x.id, 'A.v::x');
  });

  test('arista entre referenciador y referenciado', () => {
    const g = buildGraph([f('A.v', 'Definition x := 1. Definition y := x.')]);
    const x = node(g, (n) => n.props.name === 'x');
    const y = node(g, (n) => n.props.name === 'y');
    assert.ok(hasEdge(g, y.id, x.id), 'esperada arista y -> x');
  });

  test('Theorem con Qed limpio NO marca admitted', () => {
    const g = buildGraph([
      f('A.v', 'Lemma foo : True. Proof. trivial. Qed.'),
    ]);
    const foo = node(g, (n) => n.props.name === 'foo');
    assert.equal(foo.props.admitted, false);
    assert.ok(!foo.labels.includes('Admitted'));
  });

  test('Lemma con táctica admit y Qed se marca admitted', () => {
    const g = buildGraph([
      f('A.v', 'Lemma foo : True. Proof. admit. Qed.'),
    ]);
    const foo = node(g, (n) => n.props.name === 'foo');
    assert.equal(foo.props.admitted, true);
    assert.ok(foo.labels.includes('Admitted'));
  });

  test('Admitted como terminator se marca admitted', () => {
    const g = buildGraph([f('A.v', 'Lemma foo : True. Proof. Admitted.')]);
    const foo = node(g, (n) => n.props.name === 'foo');
    assert.equal(foo.props.admitted, true);
    assert.ok(foo.labels.includes('Admitted'));
  });
});

describe('buildGraph — forward reference', () => {
  test('ref a global antes de redefinir local apunta al global; después apunta al local', () => {
    const g = buildGraph([
      f('A.v', 'Definition foo := 1.'),
      f(
        'B.v',
        [
          'Require Import A.',
          'Definition usesGlobal := foo.',
          'Definition foo := 99.',
          'Definition usesLocal := foo.',
        ].join('\n'),
      ),
    ]);
    const fooA = node(
      g,
      (n) => n.props.name === 'foo' && n.props.file === 'A.v',
    );
    const fooB = node(
      g,
      (n) => n.props.name === 'foo' && n.props.file === 'B.v',
    );
    const usesGlobal = node(g, (n) => n.props.name === 'usesGlobal');
    const usesLocal = node(g, (n) => n.props.name === 'usesLocal');

    const ugTargets = new Set(edgesFrom(g, usesGlobal.id).map((e) => e.endpoints[1]));
    assert.ok(
      ugTargets.has(fooA.id),
      'usesGlobal debería apuntar al foo de A',
    );
    assert.ok(
      !ugTargets.has(fooB.id),
      'usesGlobal NO debería apuntar al foo de B (forward ref)',
    );

    const ulTargets = new Set(edgesFrom(g, usesLocal.id).map((e) => e.endpoints[1]));
    assert.ok(ulTargets.has(fooB.id), 'usesLocal debería apuntar al foo de B');
    assert.ok(
      !ulTargets.has(fooA.id),
      'usesLocal NO debería apuntar al foo de A (ya está shadowed)',
    );
  });
});

describe('buildGraph — cross-file imports', () => {
  test('Require Import permite resolver refs a un archivo previo', () => {
    const g = buildGraph([
      f('A.v', 'Definition foo := 1.'),
      f('B.v', 'Require Import A.\nDefinition usesFoo := foo.'),
    ]);
    const foo = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'foo');
    const usesFoo = node(g, (n) => n.props.name === 'usesFoo');
    assert.ok(hasEdge(g, usesFoo.id, foo.id));
  });

  test('sin Require Import, la ref no resuelve cross-file', () => {
    const g = buildGraph([
      f('A.v', 'Definition foo := 1.'),
      f('B.v', 'Definition usesFoo := foo.'),
    ]);
    const usesFoo = node(g, (n) => n.props.name === 'usesFoo');
    // No debe haber arista usesFoo -> A.v::foo
    assert.equal(edgesFrom(g, usesFoo.id).length, 0);
  });

  test('dos archivos definen el mismo nombre, ref desde C importa B (shadow del último)', () => {
    const g = buildGraph([
      f('A.v', 'Definition x := 1.'),
      f('B.v', 'Definition x := 2.'),
      f(
        'C.v',
        'Require Import A.\nRequire Import B.\nDefinition uses := x.',
      ),
    ]);
    const xA = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'x');
    const xB = node(g, (n) => n.props.file === 'B.v' && n.props.name === 'x');
    const uses = node(g, (n) => n.props.name === 'uses');
    const targets = new Set(
      edgesFrom(g, uses.id).map((e) => e.endpoints[1]),
    );
    assert.ok(targets.has(xB.id), 'el último import (B) gana por shadowing');
    assert.ok(!targets.has(xA.id));
  });
});

describe('buildGraph — Module namespacing', () => {
  test('Module Foo. Definition x. End Foo. genera id qualificado y resuelve Foo.x', () => {
    const g = buildGraph([
      f(
        'A.v',
        [
          'Module Foo.',
          '  Definition x := 1.',
          'End Foo.',
          'Definition z := Foo.x.',
        ].join('\n'),
      ),
    ]);
    const x = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'x');
    assert.equal(x.props.qualified_name, 'Foo.x');
    assert.equal(x.props.module_path, 'Foo');
    assert.equal(x.id, 'A.v::Foo.x');

    const z = node(g, (n) => n.props.name === 'z');
    assert.ok(hasEdge(g, z.id, x.id), 'z := Foo.x debe enlazar a Foo.x');
  });

  test('Module anidado: Foo.Inner.x', () => {
    const g = buildGraph([
      f(
        'A.v',
        [
          'Module Foo.',
          '  Module Inner.',
          '    Definition x := 1.',
          '  End Inner.',
          'End Foo.',
          'Definition z := Foo.Inner.x.',
        ].join('\n'),
      ),
    ]);
    const x = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'x');
    assert.equal(x.props.qualified_name, 'Foo.Inner.x');
    assert.equal(x.props.module_path, 'Foo.Inner');
    const z = node(g, (n) => n.props.name === 'z');
    assert.ok(hasEdge(g, z.id, x.id));
  });

  test('dos archivos con Module Foo y x adentro no colisionan', () => {
    const g = buildGraph([
      f('A.v', 'Module Foo. Definition x := 1. End Foo.'),
      f('B.v', 'Module Foo. Definition x := 2. End Foo.'),
    ]);
    const xA = nodeMaybe(g, (n) => n.props.file === 'A.v' && n.props.name === 'x');
    const xB = nodeMaybe(g, (n) => n.props.file === 'B.v' && n.props.name === 'x');
    assert.ok(xA, 'falta x de A.v');
    assert.ok(xB, 'falta x de B.v (caso del bug original)');
    assert.notEqual(xA!.id, xB!.id);
  });
});

describe('buildGraph — moduleToFile mapping (CoqProject)', () => {
  test('mapping explícito resuelve `Require Import Sub.A.` al archivo correcto', () => {
    const g = buildGraph(
      [
        f('A.v', 'Definition foo := 1.'),
        f('B.v', 'Require Import Sub.A.\nDefinition z := foo.'),
      ],
      {
        moduleToFile: new Map([
          ['Sub.A', 'A.v'],
          ['Sub.B', 'B.v'],
        ]),
      },
    );
    const foo = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'foo');
    const z = node(g, (n) => n.props.name === 'z');
    assert.ok(
      hasEdge(g, z.id, foo.id),
      'el mapping explícito debe permitir resolver `Require Import Sub.A.` a A.v',
    );
  });

  test('sin mapping, `Require Import Sub.A.` falla a basename y aún resuelve si A.v existe top-level', () => {
    // El fallback `tok.split('.').pop()` reduce `Sub.A` a `A`, y si A.v existe
    // top-level, mapea. Para grafos sin _CoqProject esto sigue funcionando.
    const g = buildGraph([
      f('A.v', 'Definition foo := 1.'),
      f('B.v', 'Require Import Sub.A.\nDefinition z := foo.'),
    ]);
    // Sin mapping no debería resolver Sub.A directamente. La heurística de
    // sufijo en `resolveModuleToFile` prueba `A` y lo encuentra (stem de A.v).
    const foo = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'foo');
    const z = node(g, (n) => n.props.name === 'z');
    assert.ok(hasEdge(g, z.id, foo.id));
  });
});

describe('buildGraph — Module cross-file', () => {
  test('Require Import A. Definition z := Foo.x. resuelve a A.v::Foo.x', () => {
    const g = buildGraph([
      f('A.v', 'Module Foo.\n  Definition x := 1.\nEnd Foo.'),
      f('B.v', 'Require Import A.\nDefinition z := Foo.x.'),
    ]);
    const x = node(
      g,
      (n) => n.props.file === 'A.v' && n.props.qualified_name === 'Foo.x',
    );
    const z = node(g, (n) => n.props.name === 'z' && n.props.file === 'B.v');
    assert.ok(
      hasEdge(g, z.id, x.id),
      'Require Import A debe exponer Foo como submodule en B',
    );
  });

  test('Require Import A. Definition z := A.Foo.x. (qualified completo) resuelve', () => {
    const g = buildGraph([
      f('A.v', 'Module Foo.\n  Definition x := 1.\nEnd Foo.'),
      f('B.v', 'Require Import A.\nDefinition z := A.Foo.x.'),
    ]);
    const x = node(
      g,
      (n) => n.props.file === 'A.v' && n.props.qualified_name === 'Foo.x',
    );
    const z = node(g, (n) => n.props.name === 'z' && n.props.file === 'B.v');
    assert.ok(
      hasEdge(g, z.id, x.id),
      'qualified completo A.Foo.x debe resolver al .x en Foo de A.v',
    );
  });

  test('Require Import A. Import A.Foo. Definition z := x. resuelve a Foo.x de A', () => {
    const g = buildGraph([
      f('A.v', 'Module Foo.\n  Definition x := 1.\nEnd Foo.'),
      f(
        'B.v',
        'Require Import A.\nImport A.Foo.\nDefinition z := x.',
      ),
    ]);
    const x = node(
      g,
      (n) => n.props.file === 'A.v' && n.props.qualified_name === 'Foo.x',
    );
    const z = node(g, (n) => n.props.name === 'z' && n.props.file === 'B.v');
    assert.ok(
      hasEdge(g, z.id, x.id),
      'Import A.Foo. debe abrir el namespace y exponer x simple',
    );
  });

  test('dos archivos con Module Foo.x: la ref desde un tercer archivo que importa B resuelve a B.Foo.x', () => {
    const g = buildGraph([
      f('A.v', 'Module Foo.\n  Definition x := 1.\nEnd Foo.'),
      f('B.v', 'Module Foo.\n  Definition x := 2.\nEnd Foo.'),
      f(
        'C.v',
        'Require Import A.\nRequire Import B.\nDefinition z := Foo.x.',
      ),
    ]);
    const xA = node(
      g,
      (n) => n.props.file === 'A.v' && n.props.qualified_name === 'Foo.x',
    );
    const xB = node(
      g,
      (n) => n.props.file === 'B.v' && n.props.qualified_name === 'Foo.x',
    );
    const z = node(g, (n) => n.props.file === 'C.v' && n.props.name === 'z');
    const targets = new Set(edgesFrom(g, z.id).map((e) => e.endpoints[1]));
    assert.ok(targets.has(xB.id), 'shadow del último import (B) debe ganar');
    assert.ok(!targets.has(xA.id));
  });
});

describe('buildGraph — Module alias', () => {
  test('Module Bar := Foo. Definition z := Bar.x. resuelve a Foo.x', () => {
    const g = buildGraph([
      f(
        'A.v',
        [
          'Module Foo.',
          '  Definition x := 1.',
          'End Foo.',
          'Module Bar := Foo.',
          'Definition z := Bar.x.',
        ].join('\n'),
      ),
    ]);
    const x = node(g, (n) => n.props.qualified_name === 'Foo.x');
    const z = node(g, (n) => n.props.name === 'z');
    assert.ok(
      hasEdge(g, z.id, x.id),
      'z := Bar.x debe resolver vía alias a Foo.x',
    );
  });
});

describe('buildGraph — Import mid-file', () => {
  test('Import Foo. abre el namespace para refs simples después', () => {
    const g = buildGraph([
      f(
        'A.v',
        [
          'Module Foo.',
          '  Definition x := 1.',
          'End Foo.',
          'Import Foo.',
          'Definition z := x.',
        ].join('\n'),
      ),
    ]);
    const x = node(g, (n) => n.props.qualified_name === 'Foo.x');
    const z = node(g, (n) => n.props.name === 'z');
    assert.ok(
      hasEdge(g, z.id, x.id),
      'tras Import Foo, `x` simple debe resolver a Foo.x',
    );
  });
});

describe('buildGraph — Section flat', () => {
  test('Section no introduce namespace; las defs salen al archivo', () => {
    const g = buildGraph([
      f(
        'A.v',
        [
          'Section S.',
          '  Definition x := 1.',
          'End S.',
          'Definition z := x.',
        ].join('\n'),
      ),
    ]);
    const x = node(g, (n) => n.props.name === 'x');
    assert.equal(x.props.module_path, '');
    assert.equal(x.props.qualified_name, 'x');
    const z = node(g, (n) => n.props.name === 'z');
    assert.ok(hasEdge(g, z.id, x.id));
  });
});

describe('buildGraph — Inductive y Record', () => {
  test('Inductive nat-like con constructors hijos', () => {
    const g = buildGraph([
      f('A.v', 'Inductive bit := zero | one.'),
    ]);
    const bit = node(g, (n) => n.props.name === 'bit');
    const zero = node(g, (n) => n.props.name === 'zero');
    const one = node(g, (n) => n.props.name === 'one');
    assert.equal(zero.props.kind, 'Constructor');
    assert.equal(one.props.kind, 'Constructor');
    assert.ok(hasEdge(g, zero.id, bit.id), 'zero -> bit (BELONGS_TO)');
    assert.ok(hasEdge(g, one.id, bit.id));
  });

  test('Record con fields hijos', () => {
    const g = buildGraph([
      f('A.v', 'Record Pair := { l : nat; r : nat }.'),
    ]);
    const pair = node(g, (n) => n.props.name === 'Pair');
    const l = node(g, (n) => n.props.name === 'l');
    const r = node(g, (n) => n.props.name === 'r');
    assert.equal(l.props.kind, 'Field');
    assert.equal(r.props.kind, 'Field');
    assert.ok(hasEdge(g, l.id, pair.id));
    assert.ok(hasEdge(g, r.id, pair.id));
  });
});
