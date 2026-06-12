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
const coqProject_1 = require("../src/coqProject");
function withTmpDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocq-test-'));
    try {
        return fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
(0, node_test_1.describe)('discoverCoqProject', () => {
    (0, node_test_1.test)('sin _CoqProject usa default -Q . ""', () => {
        withTmpDir((dir) => {
            const foo = path.join(dir, 'Foo.v');
            fs.writeFileSync(foo, '');
            const p = (0, coqProject_1.discoverCoqProject)(dir, [foo]);
            node_assert_1.default.equal(p.modules.get(foo), 'Foo');
            node_assert_1.default.deepEqual(p.compileArgs, ['-Q', '.', '']);
        });
    });
    (0, node_test_1.test)('sin _CoqProject y .v en subdirectorio: binding por directorio, nombre plano', () => {
        withTmpDir((dir) => {
            fs.mkdirSync(path.join(dir, 'rocq'));
            const foo = path.join(dir, 'rocq', 'Foo.v');
            const bar = path.join(dir, 'Bar.v');
            fs.writeFileSync(foo, '');
            fs.writeFileSync(bar, '');
            const p = (0, coqProject_1.discoverCoqProject)(dir, [foo, bar]);
            // Foo se nombra plano (`Foo`, no `rocq.Foo`) para que el
            // `Require Import Foo.` de un hermano resuelva.
            node_assert_1.default.equal(p.modules.get(foo), 'Foo');
            node_assert_1.default.equal(p.modules.get(bar), 'Bar');
            node_assert_1.default.deepEqual(p.compileArgs, ['-Q', '.', '', '-Q', 'rocq', '']);
        });
    });
    (0, node_test_1.test)('_RocqProject (convención Rocq 9) se lee igual que _CoqProject', () => {
        withTmpDir((dir) => {
            const foo = path.join(dir, 'Foo.v');
            fs.writeFileSync(foo, '');
            fs.writeFileSync(path.join(dir, '_RocqProject'), '-Q . ""\n');
            const p = (0, coqProject_1.discoverCoqProject)(dir, [foo]);
            node_assert_1.default.equal(p.modules.get(foo), 'Foo');
            node_assert_1.default.deepEqual(p.compileArgs, ['-Q', '.', '']);
        });
    });
    (0, node_test_1.test)('archivo de proyecto en subdirectorio: rootDir efectivo es el subdirectorio', () => {
        withTmpDir((dir) => {
            // Workspace abierto un nivel arriba del proyecto Rocq (caso thesis/rocq).
            fs.mkdirSync(path.join(dir, 'rocq'));
            const foo = path.join(dir, 'rocq', 'Foo.v');
            fs.writeFileSync(foo, '');
            fs.writeFileSync(path.join(dir, 'rocq', '_RocqProject'), '-Q . ""\n');
            const p = (0, coqProject_1.discoverCoqProject)(dir, [foo]);
            node_assert_1.default.equal(p.rootDir, path.join(dir, 'rocq'));
            // Con -Q . "" relativo a rocq/, Foo.v se nombra plano.
            node_assert_1.default.equal(p.modules.get(foo), 'Foo');
            node_assert_1.default.deepEqual(p.compileArgs, ['-Q', '.', '']);
        });
    });
    (0, node_test_1.test)('_CoqProject con -Q phys logical', () => {
        withTmpDir((dir) => {
            fs.mkdirSync(path.join(dir, 'src'));
            const foo = path.join(dir, 'src', 'Foo.v');
            fs.writeFileSync(foo, '');
            fs.writeFileSync(path.join(dir, '_CoqProject'), '-Q src MyLib\nsrc/Foo.v\n');
            const p = (0, coqProject_1.discoverCoqProject)(dir, [foo]);
            node_assert_1.default.equal(p.modules.get(foo), 'MyLib.Foo');
        });
    });
    (0, node_test_1.test)('archivo en subdirectorio con -Q . ""', () => {
        withTmpDir((dir) => {
            fs.mkdirSync(path.join(dir, 'sub'));
            const foo = path.join(dir, 'sub', 'Foo.v');
            fs.writeFileSync(foo, '');
            fs.writeFileSync(path.join(dir, '_CoqProject'), '-Q . ""\n');
            const p = (0, coqProject_1.discoverCoqProject)(dir, [foo]);
            node_assert_1.default.equal(p.modules.get(foo), 'sub.Foo');
        });
    });
    (0, node_test_1.test)('múltiples load paths: elige el más específico', () => {
        withTmpDir((dir) => {
            fs.mkdirSync(path.join(dir, 'src'));
            fs.mkdirSync(path.join(dir, 'src', 'inner'));
            const foo = path.join(dir, 'src', 'inner', 'Foo.v');
            fs.writeFileSync(foo, '');
            // El más específico (-Q src/inner Inner) debe ganar sobre el general (-Q src Lib).
            fs.writeFileSync(path.join(dir, '_CoqProject'), '-Q src Lib\n-Q src/inner Inner\n');
            const p = (0, coqProject_1.discoverCoqProject)(dir, [foo]);
            node_assert_1.default.equal(p.modules.get(foo), 'Inner.Foo');
        });
    });
    (0, node_test_1.test)('compileArgs reflejan las directivas crudas del _CoqProject', () => {
        withTmpDir((dir) => {
            fs.writeFileSync(path.join(dir, '_CoqProject'), '-Q . MyLib\n-R extra ExtraLib\n');
            const p = (0, coqProject_1.discoverCoqProject)(dir, []);
            node_assert_1.default.deepEqual(p.compileArgs, [
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
//# sourceMappingURL=coqProject.test.js.map