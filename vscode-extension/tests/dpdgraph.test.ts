import { describe, test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  parseDpd,
  harvestDpdgraph,
  topoSortModules,
  isDpdgraphMissingError,
} from '../src/dpdgraph';
import { discoverCoqProject } from '../src/coqProject';

function withTmpDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocq-test-'));
  return Promise.resolve(fn(dir)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function rocqAvailable(): boolean {
  try {
    execSync('rocq --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('parseDpd', () => {
  test('parsea N: y E: simples', () => {
    const text = [
      'N: 1 "foo" [body=yes, kind=cnst, prop=no, ];',
      'N: 2 "bar" [body=yes, kind=cnst, prop=no, path="Mod", ];',
      'E: 1 2 [weight=3, ];',
    ].join('\n');
    const raw = parseDpd(text);
    assert.equal(raw.nodes.length, 2);
    assert.equal(raw.nodes[0].name, 'foo');
    assert.equal(raw.nodes[0].declaredPath, '');
    assert.equal(raw.nodes[0].body, true);
    assert.equal(raw.nodes[1].declaredPath, 'Mod');
    assert.equal(raw.edges.length, 1);
    assert.equal(raw.edges[0].src, 1);
    assert.equal(raw.edges[0].tgt, 2);
    assert.equal(raw.edges[0].weight, 3);
  });

  test('soporta kind=inductive y kind=construct', () => {
    const text = [
      'N: 1 "nat" [kind=inductive, prop=no, ];',
      'N: 2 "O" [kind=construct, prop=no, ];',
    ].join('\n');
    const raw = parseDpd(text);
    assert.equal(raw.nodes[0].kind, 'inductive');
    assert.equal(raw.nodes[1].kind, 'construct');
  });
});

describe('isDpdgraphMissingError', () => {
  test('detecta la firma del plugin ausente sobre el logical path dpdgraph', () => {
    const stderr =
      'File "./_dpd_AbsInt.v", line 2, characters 8-25:\n' +
      'Error: Cannot find a physical path bound to logical path dpdgraph.';
    assert.equal(isDpdgraphMissingError(stderr), true);
  });

  test('no confunde el mismo error sobre un módulo del proyecto', () => {
    const stderr =
      'File "./GradualSystem.v", line 9, characters 15-27:\n' +
      'Error: Cannot find a physical path bound to logical path StaticSystem.';
    assert.equal(isDpdgraphMissingError(stderr), false);
  });

  test('un error de compilación cualquiera no matchea', () => {
    assert.equal(
      isDpdgraphMissingError('Error: Syntax error: ... unexpected token'),
      false,
    );
  });
});

describe('topoSortModules', () => {
  test('ordena dependencias antes que dependientes, sin importar el orden de descubrimiento', async () => {
    await withTmpDir((dir) => {
      // C requiere B, B requiere A. Descubrimiento en orden inverso.
      fs.writeFileSync(path.join(dir, 'A.v'), 'Definition a := 1.\n');
      fs.writeFileSync(path.join(dir, 'B.v'), 'Require Import A.\nDefinition b := a.\n');
      fs.writeFileSync(path.join(dir, 'C.v'), 'Require Import B.\nDefinition c := b.\n');
      const project = discoverCoqProject(dir, [
        path.join(dir, 'C.v'),
        path.join(dir, 'B.v'),
        path.join(dir, 'A.v'),
      ]);
      const order = topoSortModules(project);
      assert.deepEqual(order, ['A', 'B', 'C']);
    });
  });

  test('resuelve Require corto contra módulo con prefijo lógico, vía sufijo único', async () => {
    await withTmpDir((dir) => {
      fs.writeFileSync(path.join(dir, '_CoqProject'), '-Q . lib\n');
      fs.writeFileSync(path.join(dir, 'Base.v'), 'Definition x := 1.\n');
      fs.writeFileSync(
        path.join(dir, 'Uses.v'),
        'From lib Require Import Base.\nDefinition y := x.\n',
      );
      const project = discoverCoqProject(dir, [
        path.join(dir, 'Uses.v'),
        path.join(dir, 'Base.v'),
      ]);
      const order = topoSortModules(project);
      assert.deepEqual(order, ['lib.Base', 'lib.Uses']);
    });
  });

  test('ignora Require dentro de comentarios y deps externas; ciclos caen al orden original', async () => {
    await withTmpDir((dir) => {
      // A y B se requieren mutuamente (ciclo artificial) + dep externa.
      fs.writeFileSync(
        path.join(dir, 'A.v'),
        '(* Require Import B. *)\nRequire Import Stdlib.Lists.List.\nDefinition a := 1.\n',
      );
      fs.writeFileSync(path.join(dir, 'B.v'), 'Require Import A.\nDefinition b := a.\n');
      const project = discoverCoqProject(dir, [
        path.join(dir, 'B.v'),
        path.join(dir, 'A.v'),
      ]);
      // El Require comentado no cuenta: A no depende de nadie del proyecto.
      const order = topoSortModules(project);
      assert.deepEqual(order, ['A', 'B']);
    });
  });
});

describe('harvestDpdgraph (integración con rocq)', () => {
  if (!rocqAvailable()) {
    test('SKIP: rocq no está disponible en PATH', () => {
      assert.ok(true);
    });
    return;
  }

  test(
    'archivo simple: harvestea foo y bar con arista bar -> foo',
    { timeout: 60_000 },
    async () => {
      await withTmpDir(async (dir) => {
        const aPath = path.join(dir, 'A.v');
        fs.writeFileSync(aPath, 'Definition foo := 1.\nDefinition bar := foo + foo.\n');
        const project = discoverCoqProject(dir, [aPath]);
        const result = await harvestDpdgraph({
          project,
          cacheDir: path.join(dir, '.cache'),
        });
        assert.equal(result.error, undefined, `error: ${result.error ?? ''}`);
        const names = result.graph.nodes
          .map((n) => n.name)
          .sort();
        assert.ok(names.includes('foo'), `foo no aparece, vimos: ${names.join(', ')}`);
        assert.ok(names.includes('bar'));
        const foo = result.graph.nodes.find((n) => n.name === 'foo')!;
        const bar = result.graph.nodes.find((n) => n.name === 'bar')!;
        const edge = result.graph.edges.find(
          (e) => e.src === bar.id && e.tgt === foo.id,
        );
        assert.ok(edge, 'esperada arista bar -> foo');
      });
    },
  );

  test(
    'Module Foo. Definition x. End Foo. reporta x con modulePath=Foo y qualifiedName=Foo.x',
    { timeout: 60_000 },
    async () => {
      await withTmpDir(async (dir) => {
        const aPath = path.join(dir, 'A.v');
        fs.writeFileSync(
          aPath,
          'Module Foo.\n  Definition x := 1.\nEnd Foo.\nDefinition z := Foo.x.\n',
        );
        const project = discoverCoqProject(dir, [aPath]);
        const result = await harvestDpdgraph({
          project,
          cacheDir: path.join(dir, '.cache'),
        });
        assert.equal(result.error, undefined, `error: ${result.error ?? ''}`);
        const x = result.graph.nodes.find(
          (n) => n.name === 'x' && n.modulePath === 'Foo',
        );
        assert.ok(x, 'esperado nodo x con modulePath=Foo');
        assert.equal(x!.qualifiedName, 'Foo.x');
        assert.equal(x!.sourceFile, 'A');
        const z = result.graph.nodes.find((n) => n.name === 'z')!;
        const edge = result.graph.edges.find(
          (e) => e.src === z.id && e.tgt === x!.id,
        );
        assert.ok(edge, 'esperada arista z -> Foo.x');
      });
    },
  );
});
