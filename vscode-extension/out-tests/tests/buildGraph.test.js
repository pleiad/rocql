"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const buildGraph_1 = require("../src/buildGraph");
function f(relpath, text) {
    return { path: `/${relpath}`, relpath, text };
}
function node(g, pred) {
    const n = g.nodes.find(pred);
    if (!n)
        throw new Error('no node matching predicate');
    return n;
}
function nodeMaybe(g, pred) {
    return g.nodes.find(pred);
}
function edgesFrom(g, srcId) {
    return g.edges.filter((e) => e.endpoints[0] === srcId);
}
function hasEdge(g, srcId, tgtId) {
    return g.edges.some((e) => e.endpoints[0] === srcId && e.endpoints[1] === tgtId);
}
(0, node_test_1.describe)('buildGraph — basic', () => {
    (0, node_test_1.test)('extrae una Definition simple', () => {
        const g = (0, buildGraph_1.buildGraph)([f('A.v', 'Definition x := 1.')]);
        const x = node(g, (n) => n.props.name === 'x');
        node_assert_1.default.equal(x.props.kind, 'Definition');
        node_assert_1.default.equal(x.props.file, 'A.v');
        node_assert_1.default.equal(x.props.qualified_name, 'x');
        node_assert_1.default.equal(x.props.module_path, '');
        node_assert_1.default.equal(x.id, 'A.v::x');
    });
    (0, node_test_1.test)('arista entre referenciador y referenciado', () => {
        const g = (0, buildGraph_1.buildGraph)([f('A.v', 'Definition x := 1. Definition y := x.')]);
        const x = node(g, (n) => n.props.name === 'x');
        const y = node(g, (n) => n.props.name === 'y');
        node_assert_1.default.ok(hasEdge(g, y.id, x.id), 'esperada arista y -> x');
    });
    (0, node_test_1.test)('Theorem con Qed limpio NO marca admitted', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Lemma foo : True. Proof. trivial. Qed.'),
        ]);
        const foo = node(g, (n) => n.props.name === 'foo');
        node_assert_1.default.equal(foo.props.admitted, false);
        node_assert_1.default.ok(!foo.labels.includes('Admitted'));
    });
    (0, node_test_1.test)('Lemma con táctica admit y Qed se marca admitted', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Lemma foo : True. Proof. admit. Qed.'),
        ]);
        const foo = node(g, (n) => n.props.name === 'foo');
        node_assert_1.default.equal(foo.props.admitted, true);
        node_assert_1.default.ok(foo.labels.includes('Admitted'));
    });
    (0, node_test_1.test)('Admitted como terminator se marca admitted', () => {
        const g = (0, buildGraph_1.buildGraph)([f('A.v', 'Lemma foo : True. Proof. Admitted.')]);
        const foo = node(g, (n) => n.props.name === 'foo');
        node_assert_1.default.equal(foo.props.admitted, true);
        node_assert_1.default.ok(foo.labels.includes('Admitted'));
    });
});
(0, node_test_1.describe)('buildGraph — forward reference', () => {
    (0, node_test_1.test)('ref a global antes de redefinir local apunta al global; después apunta al local', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Definition foo := 1.'),
            f('B.v', [
                'Require Import A.',
                'Definition usesGlobal := foo.',
                'Definition foo := 99.',
                'Definition usesLocal := foo.',
            ].join('\n')),
        ]);
        const fooA = node(g, (n) => n.props.name === 'foo' && n.props.file === 'A.v');
        const fooB = node(g, (n) => n.props.name === 'foo' && n.props.file === 'B.v');
        const usesGlobal = node(g, (n) => n.props.name === 'usesGlobal');
        const usesLocal = node(g, (n) => n.props.name === 'usesLocal');
        const ugTargets = new Set(edgesFrom(g, usesGlobal.id).map((e) => e.endpoints[1]));
        node_assert_1.default.ok(ugTargets.has(fooA.id), 'usesGlobal debería apuntar al foo de A');
        node_assert_1.default.ok(!ugTargets.has(fooB.id), 'usesGlobal NO debería apuntar al foo de B (forward ref)');
        const ulTargets = new Set(edgesFrom(g, usesLocal.id).map((e) => e.endpoints[1]));
        node_assert_1.default.ok(ulTargets.has(fooB.id), 'usesLocal debería apuntar al foo de B');
        node_assert_1.default.ok(!ulTargets.has(fooA.id), 'usesLocal NO debería apuntar al foo de A (ya está shadowed)');
    });
});
(0, node_test_1.describe)('buildGraph — cross-file imports', () => {
    (0, node_test_1.test)('Require Import permite resolver refs a un archivo previo', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Definition foo := 1.'),
            f('B.v', 'Require Import A.\nDefinition usesFoo := foo.'),
        ]);
        const foo = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'foo');
        const usesFoo = node(g, (n) => n.props.name === 'usesFoo');
        node_assert_1.default.ok(hasEdge(g, usesFoo.id, foo.id));
    });
    (0, node_test_1.test)('sin Require Import, la ref no resuelve cross-file', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Definition foo := 1.'),
            f('B.v', 'Definition usesFoo := foo.'),
        ]);
        const usesFoo = node(g, (n) => n.props.name === 'usesFoo');
        // No debe haber arista usesFoo -> A.v::foo
        node_assert_1.default.equal(edgesFrom(g, usesFoo.id).length, 0);
    });
    (0, node_test_1.test)('dos archivos definen el mismo nombre, ref desde C importa B (shadow del último)', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Definition x := 1.'),
            f('B.v', 'Definition x := 2.'),
            f('C.v', 'Require Import A.\nRequire Import B.\nDefinition uses := x.'),
        ]);
        const xA = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'x');
        const xB = node(g, (n) => n.props.file === 'B.v' && n.props.name === 'x');
        const uses = node(g, (n) => n.props.name === 'uses');
        const targets = new Set(edgesFrom(g, uses.id).map((e) => e.endpoints[1]));
        node_assert_1.default.ok(targets.has(xB.id), 'el último import (B) gana por shadowing');
        node_assert_1.default.ok(!targets.has(xA.id));
    });
});
(0, node_test_1.describe)('buildGraph — Module namespacing', () => {
    (0, node_test_1.test)('Module Foo. Definition x. End Foo. genera id qualificado y resuelve Foo.x', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', [
                'Module Foo.',
                '  Definition x := 1.',
                'End Foo.',
                'Definition z := Foo.x.',
            ].join('\n')),
        ]);
        const x = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'x');
        node_assert_1.default.equal(x.props.qualified_name, 'Foo.x');
        node_assert_1.default.equal(x.props.module_path, 'Foo');
        node_assert_1.default.equal(x.id, 'A.v::Foo.x');
        const z = node(g, (n) => n.props.name === 'z');
        node_assert_1.default.ok(hasEdge(g, z.id, x.id), 'z := Foo.x debe enlazar a Foo.x');
    });
    (0, node_test_1.test)('Module anidado: Foo.Inner.x', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', [
                'Module Foo.',
                '  Module Inner.',
                '    Definition x := 1.',
                '  End Inner.',
                'End Foo.',
                'Definition z := Foo.Inner.x.',
            ].join('\n')),
        ]);
        const x = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'x');
        node_assert_1.default.equal(x.props.qualified_name, 'Foo.Inner.x');
        node_assert_1.default.equal(x.props.module_path, 'Foo.Inner');
        const z = node(g, (n) => n.props.name === 'z');
        node_assert_1.default.ok(hasEdge(g, z.id, x.id));
    });
    (0, node_test_1.test)('dos archivos con Module Foo y x adentro no colisionan', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Module Foo. Definition x := 1. End Foo.'),
            f('B.v', 'Module Foo. Definition x := 2. End Foo.'),
        ]);
        const xA = nodeMaybe(g, (n) => n.props.file === 'A.v' && n.props.name === 'x');
        const xB = nodeMaybe(g, (n) => n.props.file === 'B.v' && n.props.name === 'x');
        node_assert_1.default.ok(xA, 'falta x de A.v');
        node_assert_1.default.ok(xB, 'falta x de B.v (caso del bug original)');
        node_assert_1.default.notEqual(xA.id, xB.id);
    });
});
(0, node_test_1.describe)('buildGraph — moduleToFile mapping (CoqProject)', () => {
    (0, node_test_1.test)('mapping explícito resuelve `Require Import Sub.A.` al archivo correcto', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Definition foo := 1.'),
            f('B.v', 'Require Import Sub.A.\nDefinition z := foo.'),
        ], {
            moduleToFile: new Map([
                ['Sub.A', 'A.v'],
                ['Sub.B', 'B.v'],
            ]),
        });
        const foo = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'foo');
        const z = node(g, (n) => n.props.name === 'z');
        node_assert_1.default.ok(hasEdge(g, z.id, foo.id), 'el mapping explícito debe permitir resolver `Require Import Sub.A.` a A.v');
    });
    (0, node_test_1.test)('sin mapping, `Require Import Sub.A.` falla a basename y aún resuelve si A.v existe top-level', () => {
        // El fallback `tok.split('.').pop()` reduce `Sub.A` a `A`, y si A.v existe
        // top-level, mapea. Para grafos sin _CoqProject esto sigue funcionando.
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Definition foo := 1.'),
            f('B.v', 'Require Import Sub.A.\nDefinition z := foo.'),
        ]);
        // Sin mapping no debería resolver Sub.A directamente. La heurística de
        // sufijo en `resolveModuleToFile` prueba `A` y lo encuentra (stem de A.v).
        const foo = node(g, (n) => n.props.file === 'A.v' && n.props.name === 'foo');
        const z = node(g, (n) => n.props.name === 'z');
        node_assert_1.default.ok(hasEdge(g, z.id, foo.id));
    });
});
(0, node_test_1.describe)('buildGraph — Module cross-file', () => {
    (0, node_test_1.test)('Require Import A. Definition z := Foo.x. resuelve a A.v::Foo.x', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Module Foo.\n  Definition x := 1.\nEnd Foo.'),
            f('B.v', 'Require Import A.\nDefinition z := Foo.x.'),
        ]);
        const x = node(g, (n) => n.props.file === 'A.v' && n.props.qualified_name === 'Foo.x');
        const z = node(g, (n) => n.props.name === 'z' && n.props.file === 'B.v');
        node_assert_1.default.ok(hasEdge(g, z.id, x.id), 'Require Import A debe exponer Foo como submodule en B');
    });
    (0, node_test_1.test)('Require Import A. Definition z := A.Foo.x. (qualified completo) resuelve', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Module Foo.\n  Definition x := 1.\nEnd Foo.'),
            f('B.v', 'Require Import A.\nDefinition z := A.Foo.x.'),
        ]);
        const x = node(g, (n) => n.props.file === 'A.v' && n.props.qualified_name === 'Foo.x');
        const z = node(g, (n) => n.props.name === 'z' && n.props.file === 'B.v');
        node_assert_1.default.ok(hasEdge(g, z.id, x.id), 'qualified completo A.Foo.x debe resolver al .x en Foo de A.v');
    });
    (0, node_test_1.test)('Require Import A. Import A.Foo. Definition z := x. resuelve a Foo.x de A', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Module Foo.\n  Definition x := 1.\nEnd Foo.'),
            f('B.v', 'Require Import A.\nImport A.Foo.\nDefinition z := x.'),
        ]);
        const x = node(g, (n) => n.props.file === 'A.v' && n.props.qualified_name === 'Foo.x');
        const z = node(g, (n) => n.props.name === 'z' && n.props.file === 'B.v');
        node_assert_1.default.ok(hasEdge(g, z.id, x.id), 'Import A.Foo. debe abrir el namespace y exponer x simple');
    });
    (0, node_test_1.test)('dos archivos con Module Foo.x: la ref desde un tercer archivo que importa B resuelve a B.Foo.x', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Module Foo.\n  Definition x := 1.\nEnd Foo.'),
            f('B.v', 'Module Foo.\n  Definition x := 2.\nEnd Foo.'),
            f('C.v', 'Require Import A.\nRequire Import B.\nDefinition z := Foo.x.'),
        ]);
        const xA = node(g, (n) => n.props.file === 'A.v' && n.props.qualified_name === 'Foo.x');
        const xB = node(g, (n) => n.props.file === 'B.v' && n.props.qualified_name === 'Foo.x');
        const z = node(g, (n) => n.props.file === 'C.v' && n.props.name === 'z');
        const targets = new Set(edgesFrom(g, z.id).map((e) => e.endpoints[1]));
        node_assert_1.default.ok(targets.has(xB.id), 'shadow del último import (B) debe ganar');
        node_assert_1.default.ok(!targets.has(xA.id));
    });
});
(0, node_test_1.describe)('buildGraph — Module alias', () => {
    (0, node_test_1.test)('Module Bar := Foo. Definition z := Bar.x. resuelve a Foo.x', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', [
                'Module Foo.',
                '  Definition x := 1.',
                'End Foo.',
                'Module Bar := Foo.',
                'Definition z := Bar.x.',
            ].join('\n')),
        ]);
        const x = node(g, (n) => n.props.qualified_name === 'Foo.x');
        const z = node(g, (n) => n.props.name === 'z');
        node_assert_1.default.ok(hasEdge(g, z.id, x.id), 'z := Bar.x debe resolver vía alias a Foo.x');
    });
});
(0, node_test_1.describe)('buildGraph — Import mid-file', () => {
    (0, node_test_1.test)('Import Foo. abre el namespace para refs simples después', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', [
                'Module Foo.',
                '  Definition x := 1.',
                'End Foo.',
                'Import Foo.',
                'Definition z := x.',
            ].join('\n')),
        ]);
        const x = node(g, (n) => n.props.qualified_name === 'Foo.x');
        const z = node(g, (n) => n.props.name === 'z');
        node_assert_1.default.ok(hasEdge(g, z.id, x.id), 'tras Import Foo, `x` simple debe resolver a Foo.x');
    });
});
(0, node_test_1.describe)('buildGraph — Section flat', () => {
    (0, node_test_1.test)('Section no introduce namespace; las defs salen al archivo', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', [
                'Section S.',
                '  Definition x := 1.',
                'End S.',
                'Definition z := x.',
            ].join('\n')),
        ]);
        const x = node(g, (n) => n.props.name === 'x');
        node_assert_1.default.equal(x.props.module_path, '');
        node_assert_1.default.equal(x.props.qualified_name, 'x');
        const z = node(g, (n) => n.props.name === 'z');
        node_assert_1.default.ok(hasEdge(g, z.id, x.id));
    });
});
(0, node_test_1.describe)('buildGraph — Inductive y Record', () => {
    (0, node_test_1.test)('Inductive nat-like con constructors hijos', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Inductive bit := zero | one.'),
        ]);
        const bit = node(g, (n) => n.props.name === 'bit');
        const zero = node(g, (n) => n.props.name === 'zero');
        const one = node(g, (n) => n.props.name === 'one');
        node_assert_1.default.equal(zero.props.kind, 'Constructor');
        node_assert_1.default.equal(one.props.kind, 'Constructor');
        node_assert_1.default.ok(hasEdge(g, zero.id, bit.id), 'zero -> bit (BELONGS_TO)');
        node_assert_1.default.ok(hasEdge(g, one.id, bit.id));
    });
    (0, node_test_1.test)('Record con fields hijos', () => {
        const g = (0, buildGraph_1.buildGraph)([
            f('A.v', 'Record Pair := { l : nat; r : nat }.'),
        ]);
        const pair = node(g, (n) => n.props.name === 'Pair');
        const l = node(g, (n) => n.props.name === 'l');
        const r = node(g, (n) => n.props.name === 'r');
        node_assert_1.default.equal(l.props.kind, 'Field');
        node_assert_1.default.equal(r.props.kind, 'Field');
        node_assert_1.default.ok(hasEdge(g, l.id, pair.id));
        node_assert_1.default.ok(hasEdge(g, r.id, pair.id));
    });
});
//# sourceMappingURL=buildGraph.test.js.map