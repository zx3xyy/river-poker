import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, addPlayer, startHand, act, legalActions, evaluate, finish, publicState, ACTIVE } from '../engine.js';

function table(n = 3) {
  const room = createRoom('TESTAA', { title: 'Test', smallBlind: 10, bigBlind: 20, buyIn: 2000, turnSeconds: 30 });
  for (let i = 0; i < n; i++) addPlayer(room, `P${i}`).connected = true;
  return room;
}
function move(r, action, amount) { act(r, r.actorId, action, amount, r.turnId); }

test('hand rankings, wheel, kickers and best five of seven', () => {
  const hands = ['As Kd 9c 7h 3s', 'As Ad 9c 7h 3s', 'As Ad 9c 9h 3s', 'As Ad Ac 7h 3s', 'As 2d 3c 4h 5s', 'As Js 9s 7s 3s', 'As Ad Ac 7h 7s', 'As Ad Ac Ah 3s', '9s Ts Js Qs Ks'];
  let previous = -1;
  hands.forEach((h, category) => { const result = evaluate(h.split(' ')); assert.equal(result.category, category); assert.ok(result.score > previous); previous = result.score; });
  assert.ok(evaluate('2s 3d 4c 5h 6s'.split(' ')).score > evaluate('As 2d 3c 4h 5s'.split(' ')).score);
  assert.ok(evaluate('As Ad Kc 7h 3s'.split(' ')).score > evaluate('As Ad Qc 7h 3s'.split(' ')).score);
  assert.equal(evaluate('As Ks Qs Js Ts 2d 2c'.split(' ')).label, '皇家同花顺');
});

test('heads-up blind and action order, big blind option, stale actions', () => {
  const r = table(2); startHand(r, r.hostId);
  assert.equal(r.smallBlindId, r.players[0].id);
  assert.equal(r.actorId, r.players[0].id);
  assert.throws(() => act(r, r.actorId, 'call', undefined, r.turnId - 1));
  move(r, 'call'); assert.equal(r.actorId, r.bigBlindId); assert.equal(r.phase, 'preflop');
  move(r, 'check'); assert.equal(r.phase, 'flop'); assert.equal(r.actorId, r.bigBlindId);
  move(r, 'fold'); assert.equal(r.phase, 'showdown');
  assert.equal(r.players.reduce((n, p) => n + p.stack, 0), 4000);
  startHand(r, r.hostId); assert.equal(r.button, 1);
});

test('private cards are never included in another active player state', () => {
  const r = table(); startHand(r, r.hostId);
  const s = publicState(r, r.players[0].id);
  assert.equal(s.players[0].cards.length, 2);
  assert.deepEqual(s.players[1].cards, [null, null]);
  assert.ok(!('deck' in s)); assert.ok(s.players.every(p => !('token' in p)));
});

test('a short all-in does not reopen a previous full raise', () => {
  const r = table(); r.players[1].stack = 150; startHand(r, r.hostId);
  move(r, 'raise', 100); move(r, 'raise', 150); move(r, 'call');
  assert.equal(r.actorId, r.players[0].id);
  assert.equal(legalActions(r, r.actorId).canRaise, false);
  assert.throws(() => move(r, 'raise', 300));
  move(r, 'call'); assert.equal(r.phase, 'flop');
});

test('side pots, unmatched chips, ties and odd chips are settled correctly', () => {
  const r = table();
  r.button = 2; r.board = ['2c', '3d', '7h', '9s', 'Jc'];
  r.players.forEach((p, i) => Object.assign(p, { inHand: true, cards: [['As','Ad'],['Ks','Kd'],['Qs','Qd']][i], stack: 0, totalBet: [100,200,300][i] }));
  finish(r, true);
  assert.deepEqual(r.players.map(p => p.stack), [300,200,100]);
  assert.equal(r.result.pots[2].refund, true);
  const t = table(); t.button = 0; t.board = ['As','Ks','Qs','Js','Ts'];
  t.players.forEach((p, i) => Object.assign(p, { inHand: true, folded: i === 2, cards: [['2c','3c'],['4c','5c'],['6c','7c']][i], stack: 0, totalBet: 5 }));
  finish(t, true); assert.deepEqual(t.players.map(p => p.stack), [7,8,0]);
});

test('hundreds of varied 2–8 player hands terminate and conserve every chip', () => {
  let seed = 127;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let trial = 0; trial < 350; trial++) {
    const r = table(2 + trial % 7);
    r.players.forEach(p => p.stack = 1 + Math.floor(random() * 1000));
    const total = r.players.reduce((n, p) => n + p.stack, 0);
    startHand(r, r.hostId);
    let steps = 0;
    while (ACTIVE.has(r.phase)) {
      assert.ok(++steps < 200, 'hand must terminate');
      const a = legalActions(r, r.actorId), choice = random();
      if (choice < 0.15) move(r, 'fold');
      else if (choice < 0.55 && a.canRaise) move(r, 'raise', choice < 0.3 ? a.maxRaise : Math.min(a.minRaise, a.maxRaise));
      else move(r, a.canCheck ? 'check' : 'call');
      assert.ok(r.players.every(p => Number.isSafeInteger(p.stack) && p.stack >= 0));
    }
    assert.equal(r.players.reduce((n, p) => n + p.stack, 0), total);
    assert.equal(new Set([...r.players.flatMap(p => p.cards), ...r.board]).size, r.players.length * 2 + r.board.length);
  }
});
