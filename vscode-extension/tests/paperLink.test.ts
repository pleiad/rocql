import { describe, test } from 'node:test';
import assert from 'node:assert';
import { findAnchorLine, anchorRegExp, escapeForRegExp } from '../src/paperLink';

describe('findAnchorLine', () => {
  test('encuentra \\rocqanchor por nombre', () => {
    const tex = [
      '\\begin{proposition}[Type Safety]',
      '\\rocqanchor{type_safety}',
      'blah',
    ].join('\n');
    assert.strictEqual(findAnchorLine(tex, 'type_safety'), 2);
  });

  test('encuentra \\label{rocq:name} como alternativa', () => {
    const tex = ['a', 'b', '\\label{rocq:graduality}'].join('\n');
    assert.strictEqual(findAnchorLine(tex, 'graduality'), 3);
  });

  test('tolera espacios dentro de las llaves', () => {
    assert.strictEqual(findAnchorLine('\\rocqanchor{  optimality }', 'optimality'), 1);
  });

  test('ignora líneas comentadas', () => {
    const tex = ['%\\rocqanchor{type_safety}', '\\rocqanchor{type_safety}'].join('\n');
    assert.strictEqual(findAnchorLine(tex, 'type_safety'), 2);
  });

  test('sin ancla devuelve undefined', () => {
    assert.strictEqual(findAnchorLine('\\begin{lemma}[Optimality]', 'optimality'), undefined);
  });

  test('no confunde nombres con prefijo común', () => {
    const tex = '\\rocqanchor{csub}';
    assert.strictEqual(findAnchorLine(tex, 'csub'), 1);
    assert.strictEqual(findAnchorLine(tex, 'csubb'), undefined);
  });

  test('nombres con caracteres regex se escapan', () => {
    assert.ok(anchorRegExp('a.b').test('\\rocqanchor{a.b}'));
    assert.strictEqual(anchorRegExp('a.b').test('\\rocqanchor{axb}'), false);
    assert.strictEqual(escapeForRegExp('a.b'), 'a\\.b');
  });
});
