import { describe, test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverCoqProject } from '../src/coqProject';

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocq-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('discoverCoqProject', () => {
  test('sin _CoqProject usa default -Q . ""', () => {
    withTmpDir((dir) => {
      const foo = path.join(dir, 'Foo.v');
      fs.writeFileSync(foo, '');
      const p = discoverCoqProject(dir, [foo]);
      assert.equal(p.modules.get(foo), 'Foo');
      assert.deepEqual(p.compileArgs, ['-Q', '.', '']);
    });
  });

  test('sin _CoqProject y .v en subdirectorio: binding por directorio, nombre plano', () => {
    withTmpDir((dir) => {
      fs.mkdirSync(path.join(dir, 'rocq'));
      const foo = path.join(dir, 'rocq', 'Foo.v');
      const bar = path.join(dir, 'Bar.v');
      fs.writeFileSync(foo, '');
      fs.writeFileSync(bar, '');
      const p = discoverCoqProject(dir, [foo, bar]);
      // Foo se nombra plano (`Foo`, no `rocq.Foo`) para que el
      // `Require Import Foo.` de un hermano resuelva.
      assert.equal(p.modules.get(foo), 'Foo');
      assert.equal(p.modules.get(bar), 'Bar');
      assert.deepEqual(p.compileArgs, ['-Q', '.', '', '-Q', 'rocq', '']);
    });
  });

  test('_RocqProject (convención Rocq 9) se lee igual que _CoqProject', () => {
    withTmpDir((dir) => {
      const foo = path.join(dir, 'Foo.v');
      fs.writeFileSync(foo, '');
      fs.writeFileSync(path.join(dir, '_RocqProject'), '-Q . ""\n');
      const p = discoverCoqProject(dir, [foo]);
      assert.equal(p.modules.get(foo), 'Foo');
      assert.deepEqual(p.compileArgs, ['-Q', '.', '']);
    });
  });

  test('archivo de proyecto en subdirectorio: rootDir efectivo es el subdirectorio', () => {
    withTmpDir((dir) => {
      // Workspace abierto un nivel arriba del proyecto Rocq (caso thesis/rocq).
      fs.mkdirSync(path.join(dir, 'rocq'));
      const foo = path.join(dir, 'rocq', 'Foo.v');
      fs.writeFileSync(foo, '');
      fs.writeFileSync(path.join(dir, 'rocq', '_RocqProject'), '-Q . ""\n');
      const p = discoverCoqProject(dir, [foo]);
      assert.equal(p.rootDir, path.join(dir, 'rocq'));
      // Con -Q . "" relativo a rocq/, Foo.v se nombra plano.
      assert.equal(p.modules.get(foo), 'Foo');
      assert.deepEqual(p.compileArgs, ['-Q', '.', '']);
    });
  });

  test('_CoqProject con -Q phys logical', () => {
    withTmpDir((dir) => {
      fs.mkdirSync(path.join(dir, 'src'));
      const foo = path.join(dir, 'src', 'Foo.v');
      fs.writeFileSync(foo, '');
      fs.writeFileSync(
        path.join(dir, '_CoqProject'),
        '-Q src MyLib\nsrc/Foo.v\n',
      );
      const p = discoverCoqProject(dir, [foo]);
      assert.equal(p.modules.get(foo), 'MyLib.Foo');
    });
  });

  test('archivo en subdirectorio con -Q . ""', () => {
    withTmpDir((dir) => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const foo = path.join(dir, 'sub', 'Foo.v');
      fs.writeFileSync(foo, '');
      fs.writeFileSync(path.join(dir, '_CoqProject'), '-Q . ""\n');
      const p = discoverCoqProject(dir, [foo]);
      assert.equal(p.modules.get(foo), 'sub.Foo');
    });
  });

  test('múltiples load paths: elige el más específico', () => {
    withTmpDir((dir) => {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'src', 'inner'));
      const foo = path.join(dir, 'src', 'inner', 'Foo.v');
      fs.writeFileSync(foo, '');
      // El más específico (-Q src/inner Inner) debe ganar sobre el general (-Q src Lib).
      fs.writeFileSync(
        path.join(dir, '_CoqProject'),
        '-Q src Lib\n-Q src/inner Inner\n',
      );
      const p = discoverCoqProject(dir, [foo]);
      assert.equal(p.modules.get(foo), 'Inner.Foo');
    });
  });

  test('compileArgs reflejan las directivas crudas del _CoqProject', () => {
    withTmpDir((dir) => {
      fs.writeFileSync(
        path.join(dir, '_CoqProject'),
        '-Q . MyLib\n-R extra ExtraLib\n',
      );
      const p = discoverCoqProject(dir, []);
      assert.deepEqual(p.compileArgs, [
        '-Q',
        '.',
        'MyLib',
        '-R',
        'extra',
        'ExtraLib',
      ]);
    });
  });
});
