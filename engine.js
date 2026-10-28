import { randomInt, randomBytes } from 'node:crypto';

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const ACTIVE = new Set(['preflop', 'flop', 'turn', 'river']);
const LABELS = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

export function shuffledDeck() {
  const deck = [...SUITS].flatMap(s => [...RANKS].map(r => r + s));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function evaluate(cards) {
  if (cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length || cards.some(c => !/^[2-9TJQKA][cdhs]$/.test(c))) throw new Error('Invalid cards');
  let best = null;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const hand = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const ranks = hand.map(c => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a);
            const flush = hand.every(c => c[1] === hand[0][1]);
            const unique = [...new Set(ranks)];
            let straight = 0;
            if (unique.length === 5) {
              if (unique[0] - unique[4] === 4) straight = unique[0];
              else if (unique.join(',') === '14,5,4,3,2') straight = 5;
            }
            const groups = [...new Set(ranks)].map(r => [ranks.filter(x => x === r).length, r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
            let value;
            if (flush && straight) value = [8, straight];
            else if (groups[0][0] === 4) value = [7, groups[0][1], groups[1][1]];
            else if (groups[0][0] === 3 && groups[1][0] === 2) value = [6, groups[0][1], groups[1][1]];
            else if (flush) value = [5, ...ranks];
            else if (straight) value = [4, straight];
            else if (groups[0][0] === 3) value = [3, groups[0][1], ...groups.slice(1).map(g => g[1])];
            else if (groups[0][0] === 2 && groups[1][0] === 2) value = [2, Math.max(groups[0][1], groups[1][1]), Math.min(groups[0][1], groups[1][1]), groups[2][1]];
            else if (groups[0][0] === 2) value = [1, groups[0][1], ...groups.slice(1).map(g => g[1])];
            else value = [0, ...ranks];
            while (value.length < 6) value.push(0);
            const score = value.reduce((n, x) => n * 15 + x, 0);
            if (!best || score > best.score) best = { score, category: value[0], label: value[0] === 8 && value[1] === 14 ? '皇家同花顺' : LABELS[value[0]], cards: hand };
          }
  return best;
}

export function log(room, text, kind = 'game') {
  room.log.push({ id: randomBytes(5).toString('hex'), text, kind, at: Date.now() });
  room.log = room.log.slice(-60);
}

export function createRoom(code, settings) {
  return { code, settings, hostId: null, players: [], phase: 'lobby', handNo: 0, button: -1, smallBlindId: null, bigBlindId: null, board: [], deck: [], actorId: null, deadline: null, nextHandAt: null, turnId: 0, currentBet: 0, minRaise: settings.bigBlind, log: [], result: null, createdAt: Date.now(), updatedAt: Date.now(), revision: 0 };
}

export function addPlayer(room, name) {
  if (room.players.length >= 8) throw new Error('房间已经满了，最多 8 位玩家。');
  const occupied = new Set(room.players.map(p => p.seat));
  const seat = Array.from({ length: 8 }, (_, i) => i).find(i => !occupied.has(i));
  const p = { id: randomBytes(8).toString('hex'), token: randomBytes(32).toString('hex'), name, seat, stack: room.settings.buyIn, buyIns: room.settings.buyIn, connected: false, sittingOut: false, inHand: false, folded: false, cards: [], streetBet: 0, totalBet: 0, actedAt: null, lastAction: '等待开局', leaving: false };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  log(room, `${name} 加入了牌桌`, 'system');
  return p;
}

function clockwise(room, from, predicate) {
  return room.players.filter(predicate).sort((a, b) => ((a.seat - from + 7) % 8) - ((b.seat - from + 7) % 8));
}
const contenders = room => room.players.filter(p => p.inHand && !p.folded);
const canAct = p => p.inHand && !p.folded && p.stack > 0;
const needsAction = (room, p) => canAct(p) && (p.actedAt === null || p.streetBet < room.currentBet);

function pay(p, amount) {
  const paid = Math.min(p.stack, amount);
  p.stack -= paid;
  p.streetBet += paid;
  p.totalBet += paid;
  return paid;
}
function setTurn(room, p) {
  room.actorId = p?.id ?? null;
  room.deadline = p ? Date.now() + room.settings.turnSeconds * 1000 : null;
  room.turnId++;
}

export function startHand(room, playerId, deck = shuffledDeck()) {
  if (room.hostId !== playerId) throw new Error('只有房主可以开局。');
  if (ACTIVE.has(room.phase)) throw new Error('这手牌还没结束。');
  const playing = room.players.filter(p => p.connected && !p.sittingOut && p.stack > 0 && !p.leaving);
  if (playing.length < 2) throw new Error('至少需要两位在线、准备好且有筹码的玩家。');
  room.players = room.players.filter(p => !p.leaving);
  for (const p of room.players) Object.assign(p, { inHand: playing.includes(p), folded: false, cards: [], streetBet: 0, totalBet: 0, actedAt: null, lastAction: playing.includes(p) ? '' : '等待下一手' });
  const ids = new Set(playing.map(p => p.id));
  const button = clockwise(room, room.button, p => ids.has(p.id))[0];
  room.button = button.seat;
  room.deck = [...deck];
  room.board = [];
  room.phase = 'preflop';
  room.nextHandAt = null;
  room.handNo++;
  room.result = null;
  room.minRaise = room.settings.bigBlind;
  const sb = playing.length === 2 ? button : clockwise(room, button.seat, p => ids.has(p.id))[0];
  const bb = clockwise(room, sb.seat, p => ids.has(p.id))[0];
  room.smallBlindId = sb.id;
  room.bigBlindId = bb.id;
  const order = clockwise(room, button.seat, p => ids.has(p.id));
  for (let n = 0; n < 2; n++) for (const p of order) p.cards.push(room.deck.pop());
  sb.lastAction = `小盲 ${pay(sb, room.settings.smallBlind)}`;
  bb.lastAction = `大盲 ${pay(bb, room.settings.bigBlind)}`;
  room.currentBet = room.settings.bigBlind;
  log(room, `第 ${room.handNo} 手 · 盲注 ${room.settings.smallBlind}/${room.settings.bigBlind}`, 'hand');
  advance(room, bb.seat);
}

export function legalActions(room, playerId) {
  const p = room.players.find(p => p.id === playerId);
  if (!p || room.actorId !== p.id || !ACTIVE.has(room.phase)) return null;
  const toCall = Math.min(p.stack, Math.max(0, room.currentBet - p.streetBet));
  const maxRaise = p.stack + p.streetBet;
  const hasOpponent = contenders(room).some(x => x.id !== p.id && x.stack > 0);
  const reopened = p.actedAt === null || p.actedAt === 0 || room.currentBet - p.actedAt >= room.minRaise;
  return { toCall, canCheck: toCall === 0, canRaise: hasOpponent && reopened && maxRaise > room.currentBet, minRaise: room.currentBet + room.minRaise, maxRaise, turnId: room.turnId };
}

export function act(room, playerId, action, amount, expectedTurnId) {
  const legal = legalActions(room, playerId);
  if (!legal) throw new Error('现在还没轮到你。');
  if (expectedTurnId !== room.turnId) throw new Error('牌局已更新，请重新选择操作。');
  const p = room.players.find(p => p.id === playerId);
  if (action === 'fold') {
    p.folded = true;
    p.lastAction = '弃牌';
  } else if (action === 'check') {
    if (!legal.canCheck) throw new Error('需要跟注或弃牌。');
    p.lastAction = '过牌';
  } else if (action === 'call') {
    const paid = pay(p, legal.toCall);
    p.lastAction = paid ? (p.stack ? `跟注 ${paid}` : `全押 ${paid}`) : '过牌';
  } else if (action === 'raise') {
    if (!legal.canRaise) throw new Error('当前不能加注。');
    if (!Number.isSafeInteger(amount) || amount <= room.currentBet || amount > legal.maxRaise) throw new Error('加注金额无效。');
    if (amount < legal.minRaise && amount !== legal.maxRaise) throw new Error(`最少加注至 ${legal.minRaise}，或全押。`);
    const raise = amount - room.currentBet;
    pay(p, amount - p.streetBet);
    if (raise >= room.minRaise) room.minRaise = raise;
    room.currentBet = amount;
    p.lastAction = p.stack ? `加注至 ${amount}` : `全押至 ${amount}`;
  } else throw new Error('无效的操作。');
  p.actedAt = room.currentBet;
  log(room, `${p.name} ${p.lastAction}`);
  advance(room, p.seat);
}

function dealStreet(room) {
  room.deck.pop();
  const count = room.phase === 'preflop' ? 3 : 1;
  for (let i = 0; i < count; i++) room.board.push(room.deck.pop());
  room.phase = room.phase === 'preflop' ? 'flop' : room.phase === 'flop' ? 'turn' : 'river';
  for (const p of room.players) { p.streetBet = 0; p.actedAt = null; if (canAct(p)) p.lastAction = ''; }
  room.currentBet = 0;
  room.minRaise = room.settings.bigBlind;
  log(room, { flop: '翻牌', turn: '转牌', river: '河牌' }[room.phase], 'street');
}

function advance(room, fromSeat) {
  const alive = contenders(room);
  if (alive.length === 1) return finish(room, false);
  const betting = alive.filter(canAct);
  if (betting.length <= 1 && (betting.length === 0 || betting[0].streetBet >= Math.max(...alive.filter(p => p.id !== betting[0].id).map(p => p.streetBet)))) {
    while (room.board.length < 5) dealStreet(room);
    return finish(room, true);
  }
  const pending = clockwise(room, fromSeat, p => needsAction(room, p));
  if (pending.length) return setTurn(room, pending[0]);
  if (room.phase === 'river') return finish(room, true);
  dealStreet(room);
  advance(room, room.button);
}

export function finish(room, showdown) {
  const alive = contenders(room);
  const total = room.players.reduce((n, p) => n + p.totalBet, 0);
  const awards = new Map();
  const pots = [];
  const hands = Object.fromEntries(showdown ? alive.map(p => [p.id, evaluate([...p.cards, ...room.board])]) : []);
  const award = (p, n) => { p.stack += n; awards.set(p.id, (awards.get(p.id) || 0) + n); };
  if (!showdown) {
    award(alive[0], total);
    pots.push({ amount: total, winners: [alive[0].id], label: '其他玩家弃牌' });
  } else {
    const levels = [...new Set(room.players.map(p => p.totalBet).filter(Boolean))].sort((a, b) => a - b);
    let previous = 0;
    for (const level of levels) {
      const contributors = room.players.filter(p => p.totalBet >= level);
      const amount = (level - previous) * contributors.length;
      previous = level;
      if (contributors.length === 1) {
        award(contributors[0], amount);
        pots.push({ amount, winners: [contributors[0].id], label: '退回未跟注筹码', refund: true });
        continue;
      }
      const eligible = contributors.filter(p => p.inHand && !p.folded);
      if (!eligible.length) throw new Error('Invalid pot: no eligible player');
      const best = Math.max(...eligible.map(p => hands[p.id].score));
      const winners = clockwise(room, room.button, p => eligible.includes(p) && hands[p.id].score === best);
      let odd = amount % winners.length;
      for (const p of winners) award(p, Math.floor(amount / winners.length) + (odd-- > 0 ? 1 : 0));
      pots.push({ amount, winners: winners.map(p => p.id), label: hands[winners[0].id].label });
    }
  }
  room.phase = 'showdown';
  room.result = { total, showdown, pots, awards: Object.fromEntries(awards), hands };
  setTurn(room, null);
  const winners = [...new Set(pots.filter(p => !p.refund).flatMap(p => p.winners))];
  log(room, winners.map(id => `${room.players.find(p => p.id === id).name} 收回 ${awards.get(id)} 筹码`).join(' · '), 'win');
}

export function leave(room, playerId) {
  const p = room.players.find(p => p.id === playerId);
  if (!p) return;
  p.connected = false;
  p.leaving = true;
  if (ACTIVE.has(room.phase) && p.inHand && !p.folded && p.stack > 0) {
    p.folded = true;
    p.lastAction = '离桌弃牌';
    const currentActor = room.players.find(p => p.id === room.actorId);
    if (room.actorId === p.id || contenders(room).length === 1) advance(room, p.seat);
    else if (currentActor) advance(room, (currentActor.seat + 7) % 8);
  }
  if (!ACTIVE.has(room.phase)) room.players = room.players.filter(x => x.id !== playerId);
  transferHost(room);
  log(room, `${p.name} 离开了牌桌`, 'system');
}

export function transferHost(room) {
  if (!room.players.some(p => p.id === room.hostId && p.connected && !p.leaving)) {
    const next = room.players.find(p => p.connected && !p.leaving);
    if (next) room.hostId = next.id;
  }
}

export function publicState(room, selfId) {
  return {
    code: room.code, title: room.settings.title, settings: room.settings, hostId: room.hostId, selfId,
    phase: room.phase, handNo: room.handNo, button: room.button, smallBlindId: room.smallBlindId, bigBlindId: room.bigBlindId,
    board: room.board, actorId: room.actorId, deadline: room.deadline, nextHandAt: room.nextHandAt ?? null, serverTime: Date.now(), turnId: room.turnId,
    currentBet: room.currentBet, pot: room.players.reduce((n, p) => n + p.totalBet, 0), legal: legalActions(room, selfId),
    log: room.log, result: room.result, revision: room.revision,
    players: room.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat, stack: p.stack, buyIns: p.buyIns, connected: p.connected,
      sittingOut: p.sittingOut, inHand: p.inHand, folded: p.folded, streetBet: p.streetBet, lastAction: p.lastAction, leaving: p.leaving,
      cards: p.id === selfId || (room.result?.showdown && p.inHand && !p.folded) ? p.cards : p.cards.map(() => null)
    }))
  };
}
