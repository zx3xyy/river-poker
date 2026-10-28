import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';

test('real clients: password, private cards, complete hand, reconnect and restart', { timeout: 25000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'river-test-'));
  const base = 'http://127.0.0.1:14317';
  let process, clients = [];
  async function boot() {
    process = spawn(globalThis.process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...globalThis.process.env, PORT: '14317', DATA_DIR: dir, PUBLIC_ORIGIN: base } });
    await new Promise((resolve, reject) => {
      process.stdout.on('data', d => { if (String(d).includes('ready')) resolve(); });
      process.stderr.on('data', d => reject(new Error(String(d))));
      process.on('error', reject);
    });
  }
  async function stop() { const done = once(process, 'exit'); process.kill('SIGTERM'); await done; }
  async function post(path, data) { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); return { status: r.status, ...await r.json() }; }
  async function connect(credential) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: base });
    const c = { ws, state: null, errors: [] };
    c.wait = predicate => new Promise((resolve, reject) => {
      if (predicate(c)) return resolve(c);
      const timer = setTimeout(() => { ws.off('message', check); reject(new Error('Waiting for client state')); }, 8000);
      function check() { if (predicate(c)) { clearTimeout(timer); ws.off('message', check); resolve(c); } }
      ws.on('message', check);
    });
    c.send = message => ws.send(JSON.stringify(message));
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'state') c.state = m.state; else if (m.type.includes('error')) c.errors.push(m.error); });
    clients.push(c);
    await once(ws, 'open'); c.send({ type: 'auth', room: credential.code, token: credential.token });
    await c.wait(c => c.state); return c;
  }
  try {
    await boot();
    const a = await post('/api/rooms', { name: 'Alpha', password: 'test-only', turnSeconds: 90 });
    assert.equal(a.status, 201);
    assert.equal((await post(`/api/rooms/${a.code}/join`, { name: 'Wrong', password: 'bad' })).status, 400);
    const credentials = [a];
    for (const name of ['Bravo', 'Charlie']) credentials.push(await post(`/api/rooms/${a.code}/join`, { name, password: 'test-only' }));
    for (const credential of credentials) await connect(credential);
    await clients[0].wait(c => c.state.players.filter(p => p.connected).length === 3);
    clients[0].send({ type: 'start' });
    await Promise.all(clients.map(c => c.wait(c => c.state.phase === 'preflop')));
    for (const c of clients) {
      assert.equal(c.state.players.find(p => p.id === c.state.selfId).cards.filter(Boolean).length, 2);
      assert.ok(c.state.players.filter(p => p.id !== c.state.selfId).every(p => p.cards.every(x => x === null)));
      assert.ok(!JSON.stringify(c.state).includes(a.token));
      assert.ok(!('deck' in c.state));
    }
    const first = clients.find(c => c.state.legal);
    first.send({ type: 'action', action: 'call', turnId: -1 });
    await first.wait(c => c.errors.length); assert.equal(first.state.phase, 'preflop');
    for (let n = 0; clients[0].state.phase !== 'showdown'; n++) {
      assert.ok(n < 30);
      const id = clients[0].state.actorId, turn = clients[0].state.turnId;
      const player = clients.find(c => c.state.selfId === id);
      await player.wait(c => c.state.turnId === turn && c.state.legal);
      player.send({ type: 'action', action: player.state.legal.canCheck ? 'check' : 'call', turnId: turn });
      await clients[0].wait(c => c.state.turnId > turn);
    }
    assert.equal(clients[0].state.players.reduce((sum, p) => sum + p.stack, 0), 6000);
    assert.equal(clients[0].state.board.length, 5);
    assert.ok(clients[0].state.nextHandAt > Date.now());
    // Pausing enough players stops the countdown; coming back starts it again.
    clients[1].send({ type: 'sitout' });
    clients[2].send({ type: 'sitout' });
    await clients[0].wait(c => c.state.nextHandAt === null);
    clients[1].send({ type: 'sitout' });
    await clients[0].wait(c => c.state.nextHandAt > Date.now());
    await clients[0].wait(c => c.state.handNo === 2);
    assert.equal(clients[0].state.phase, 'preflop');
    const actor = clients.find(c => c.state.selfId === clients[0].state.actorId);
    await actor.wait(c => c.state.legal);
    actor.send({ type: 'action', action: 'fold', turnId: actor.state.turnId });
    await clients[0].wait(c => c.state.phase === 'showdown');
    const savedId = clients[0].state.selfId;
    clients[0].ws.close();
    const restored = await connect(a); assert.equal(restored.state.selfId, savedId);
    await stop();
    await boot();
    const rebooted = await connect(a);
    assert.equal(rebooted.state.phase, 'showdown');
    assert.equal(rebooted.state.selfId, savedId);
    assert.equal(rebooted.state.players.reduce((sum, p) => sum + p.stack, 0), 6000);
    const exposed = await fetch(base + '/data/rooms.json'); assert.equal(exposed.status, 404);
  } finally {
    clients.forEach(c => c.ws.terminate());
    if (process && process.exitCode === null) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
