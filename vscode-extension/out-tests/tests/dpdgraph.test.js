"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const dpdgraph_1 = require("../src/dpdgraph");
const coqProject_1 = require("../src/coqProject");
function withTmpDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocq-test-'));
    return Promise.resolve(fn(dir)).finally(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
}
function rocqAvailable() {
    try {
        (0, child_process_1.execSync)('rocq --version', { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
(0, node_test_1.describe)('parseDpd', () => {
    (0, node_test_1.test)('parsea N: y E: simples', () => {
        const text = [
            'N: 1 "foo" [body=yes, kind=cnst, prop=no, ];',
            'N: 2 "bar" [body=yes, kind=cnst, prop=no, path="Mod", ];',
            'E: 1 2 [weight=3, ];',
        ].join('\n');
        const raw = (0, dpdgraph_1.parseDpd)(text);
        node_assert_1.default.equal(raw.nodes.length, 2);
        node_assert_1.default.equal(raw.nodes[0].name, 'foo');
        node_assert_1.default.equal(raw.nodes[0].declaredPath, '');
        node_assert_1.default.equal(raw.nodes[0].body, true);
        node_assert_1.default.equal(raw.nodes[1].declaredPath, 'Mod');
        node_assert_1.default.equal(raw.edges.length, 1);
        node_assert_1.default.equal(raw.edges[0].src, 1);
        node_assert_1.default.equal(raw.edges[0].tgt, 2);
        node_assert_1.default.equal(raw.edges[0].weight, 3);
    });
    (0, node_test_1.test)('soporta kind=inductive y kind=construct', () => {
        const text = [
            'N: 1 "nat" [kind=inductive, prop=no, ];',
            'N: 2 "O" [kind=construct, prop=no, ];',
        ].join('\n');
        const raw = (0, dpdgraph_1.parseDpd)(text);
        node_assert_1.default.equal(raw.nodes[0].kind, 'inductive');
        node_assert_1.default.equal(raw.nodes[1].kind, 'construct');
    });
});
(0, node_test_1.describe)('topoSortModules', () => {
    (0, node_test_1.test)('ordena dependencias antes que dependientes, sin importar el orden de descubrimiento', async () => {
        await withTmpDir((dir) => {
            // C requiere B, B requiere A. Descubrimiento en orden inverso.
            fs.writeFileSync(path.join(dir, 'A.v'), 'Definition a := 1.\n');
            fs.writeFileSync(path.join(dir, 'B.v'), 'Require Import A.\nDefinition b := a.\n');
            fs.writeFileSync(path.join(dir, 'C.v'), 'Require Import B.\nDefinition c := b.\n');
            const project = (0, coqProject_1.discoverCoqProject)(dir, [
                path.join(dir, 'C.v'),
                path.join(dir, 'B.v'),
                path.join(dir, 'A.v'),
            ]);
            const order = (0, dpdgraph_1.topoSortModules)(project);
            node_assert_1.default.deepEqual(order, ['A', 'B', 'C']);
        });
    });
    (0, node_test_1.test)('resuelve Require corto contra módulo con prefijo lógico, vía sufijo único', async () => {
        await withTmpDir((dir) => {
            fs.writeFileSync(path.join(dir, '_CoqProject'), '-Q . lib\n');
            fs.writeFileSync(path.join(dir, 'Base.v'), 'Definition x := 1.\n');
            fs.writeFileSync(path.join(dir, 'Uses.v'), 'From lib Require Import Base.\nDefinition y := x.\n');
            const project = (0, coqProject_1.discoverCoqProject)(dir, [
                path.join(dir, 'Uses.v'),
                path.join(dir, 'Base.v'),
            ]);
            const order = (0, dpdgraph_1.topoSortModules)(project);
            node_assert_1.default.deepEqual(order, ['lib.Base', 'lib.Uses']);
        });
    });
    (0, node_test_1.test)('ignora Require dentro de comentarios y deps externas; ciclos caen al orden original', async () => {
        await withTmpDir((dir) => {
            // A y B se requieren mutuamente (ciclo artificial) + dep externa.
            fs.writeFileSync(path.join(dir, 'A.v'), '(* Require Import B. *)\nRequire Import Stdlib.Lists.List.\nDefinition a := 1.\n');
            fs.writeFileSync(path.join(dir, 'B.v'), 'Require Import A.\nDefinition b := a.\n');
            const project = (0, coqProject_1.discoverCoqProject)(dir, [
                path.join(dir, 'B.v'),
                path.join(dir, 'A.v'),
            ]);
            // El Require comentado no cuenta: A no depende de nadie del proyecto.
            const order = (0, dpdgraph_1.topoSortModules)(project);
            node_assert_1.default.deepEqual(order, ['A', 'B']);
        });
    });
});
(0, node_test_1.describe)('harvestDpdgraph (integración con rocq)', () => {
    if (!rocqAvailable()) {
        (0, node_test_1.test)('SKIP: rocq no está disponible en PATH', () => {
            node_assert_1.default.ok(true);
        });
        return;
    }
    (0, node_test_1.test)('archivo simple: harvestea foo y bar con arista bar -> foo', { timeout: 60_000 }, async () => {
        await withTmpDir(async (dir) => {
            const aPath = path.join(dir, 'A.v');
            fs.writeFileSync(aPath, 'Definition foo := 1.\nDefinition bar := foo + foo.\n');
            const project = (0, coqProject_1.discoverCoqProject)(dir, [aPath]);
            const result = await (0, dpdgraph_1.harvestDpdgraph)({
                project,
                cacheDir: path.join(dir, '.cache'),
            });
            node_assert_1.default.equal(result.error, undefined, `error: ${result.error ?? ''}`);
            const names = result.graph.nodes
                .map((n) => n.name)
                .sort();
            node_assert_1.default.ok(names.includes('foo'), `foo no aparece, vimos: ${names.join(', ')}`);
            node_assert_1.default.ok(names.includes('bar'));
            const foo = result.graph.nodes.find((n) => n.name === 'foo');
            const bar = result.graph.nodes.find((n) => n.name === 'bar');
            const edge = result.graph.edges.find((e) => e.src === bar.id && e.tgt === foo.id);
            node_assert_1.default.ok(edge, 'esperada arista bar -> foo');
        });
    });
    (0, node_test_1.test)('Module Foo. Definition x. End Foo. reporta x con modulePath=Foo y qualifiedName=Foo.x', { timeout: 60_000 }, async () => {
        await withTmpDir(async (dir) => {
            const aPath = path.join(dir, 'A.v');
            fs.writeFileSync(aPath, 'Module Foo.\n  Definition x := 1.\nEnd Foo.\nDefinition z := Foo.x.\n');
            const project = (0, coqProject_1.discoverCoqProject)(dir, [aPath]);
            const result = await (0, dpdgraph_1.harvestDpdgraph)({
                project,
                cacheDir: path.join(dir, '.cache'),
            });
            node_assert_1.default.equal(result.error, undefined, `error: ${result.error ?? ''}`);
            const x = result.graph.nodes.find((n) => n.name === 'x' && n.modulePath === 'Foo');
            node_assert_1.default.ok(x, 'esperado nodo x con modulePath=Foo');
            node_assert_1.default.equal(x.qualifiedName, 'Foo.x');
            node_assert_1.default.equal(x.sourceFile, 'A');
            const z = result.graph.nodes.find((n) => n.name === 'z');
            const edge = result.graph.edges.find((e) => e.src === z.id && e.tgt === x.id);
            node_assert_1.default.ok(edge, 'esperada arista z -> Foo.x');
        });
    });
});
//# sourceMappingURL=dpdgraph.test.js.map