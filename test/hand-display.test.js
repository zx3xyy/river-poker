import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { evaluate } from '../engine.js';

// Exercise the browser's actual display function, including hands with fewer than five cards.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function currentHandType('), app.indexOf('\nfunction card(value'));
const handType = runInNewContext(`(${source.trim()})`);

test('current hand display works before the flop and covers tricky completed hands', () => {
  assert.equal(handType(['As', 'Ad']), '一对');
  assert.equal(handType(['As', 'Kd']), '高牌');
  assert.equal(handType('As 2d 3c 4h 5s'.split(' ')), '顺子');
  assert.equal(handType('As Ks Qs Js Ts 2d 2c'.split(' ')), '皇家同花顺');
  assert.equal(handType('As Ad Ac Ks Kd Kc 2h'.split(' ')), '葫芦');
  assert.equal(handType('As Ks Qs Js 2s Tc 9d'.split(' ')), '同花');
});

test('displayed categories agree with the server evaluator on random 5–7 card hands', () => {
  const deck = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
  let seed = 42;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let trial = 0; trial < 2000; trial++) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const cards = shuffled.slice(0, 5 + trial % 3);
    assert.equal(handType(cards), evaluate(cards).label, cards.join(' '));
  }
});
