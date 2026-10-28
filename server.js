import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ACTIVE, createRoom, addPlayer, startHand, act, leave, transferHost, publicState, log } from './engine.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || resolve(ROOT, 'data');
const ORIGIN = process.env.PUBLIC_ORIGIN || '';
const STATE_PATH = resolve(DATA_DIR, 'rooms.json');
const rooms = new Map();
const sockets = new Map();
const rates = new Map();
const MAX_ROOMS = 100;
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

if (existsSync(STATE_PATH)) {
  try {
    for (const room of JSON.parse(readFileSync(STATE_PATH, 'utf8'))) {
      if (Date.now() - room.updatedAt > 3 * 86400000) continue;
      room.players.forEach(p => p.connected = false);
      if (ACTIVE.has(room.phase)) room.deadline = Date.now() + 60000;
      rooms.set(room.code, room);
    }
  } catch (error) {
    console.error('Cannot safely load saved tables:', error.message);
    process.exit(1);
  }
}

function save() {
  writeFileSync(STATE_PATH + '.tmp', JSON.stringify([...rooms.values()]), { mode: 0o600 });
  renameSync(STATE_PATH + '.tmp', STATE_PATH);
}
function commit(room) {
  room.updatedAt = Date.now();
  room.revision++;
  save();
  for (const p of room.players) {
    const ws = sockets.get(p.id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'state', state: publicState(room, p.id) }));
  }
}
function limited(key, count, duration) {
  const now = Date.now();
  let rate = rates.get(key);
  if (!rate || now > rate.until) { rate = { n: 0, until: now + duration }; rates.set(key, rate); }
  return ++rate.n > count;
}
function ip(req) {
  return process.env.TRUST_PROXY === '1' ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
}
function validOrigin(req) {
  if (!req.headers.origin) return true;
  const expected = ORIGIN || `http://${req.headers.host}`;
  return req.headers.origin === expected;
}
function clean(value, max, fallback = '') {
  return String(value ?? fallback).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max);
}
function integer(value, min, max, fallback) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('房间设置超出范围。');
  return n;
}
function settings(data) {
  const bigBlind = integer(data.bigBlind, 2, 10000, 20);
  if (bigBlind % 2) throw new Error('大盲注请使用偶数。');
  const buyIn = integer(data.buyIn, 100, 1000000, 2000);
  if (buyIn < bigBlind * 10) throw new Error('初始筹码至少为大盲的 10 倍。');
  return { title: clean(data.title, 24, '今晚来一手') || '今晚来一手', bigBlind, smallBlind: bigBlind / 2, buyIn, turnSeconds: integer(data.turnSeconds, 15, 90, 30) };
}
function passwordHash(password, salt) { return scryptSync(password, salt, 32).toString('hex'); }
function checkPassword(room, password) {
  if (!room.password) return true;
  const candidate = passwordHash(String(password || '').slice(0, 128), room.salt);
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(room.password, 'hex'));
}
function getRoom(code) {
  const room = rooms.get(String(code).toUpperCase());
  if (!room) throw new Error('房间不存在或已过期，请检查房间码。');
  return room;
}
function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(randomBytes(6), n => alphabet[n % alphabet.length]).join(''); } while (rooms.has(code));
  return code;
}
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 8192) throw new Error('请求太大。');
  }
  try { const value = JSON.parse(data || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
  catch { throw new Error('请求格式不正确。'); }
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const files = new Map(['/index.html', '/styles.css', '/app.js', '/favicon.svg'].map(path => [path, readFileSync(resolve(ROOT, 'public', path.slice(1)))]));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST') {
      if (!validOrigin(req)) return json(res, 403, { error: '请求来源不允许。' });
      if (limited('post:' + ip(req), 30, 60000)) return json(res, 429, { error: '操作太频繁，请稍后再试。' });
      const data = await body(req);
      const name = clean(data.name, 16);
      if (!name) throw new Error('先取一个昵称吧。');
      if (url.pathname === '/api/rooms') {
        if (rooms.size >= MAX_ROOMS) throw new Error('牌桌暂时满了，请稍后再来。');
        if (limited('create:' + ip(req), 8, 3600000)) throw new Error('创建房间过于频繁，请使用已有房间。');
        const room = createRoom(roomCode(), settings(data));
        if (data.password) {
          room.salt = randomBytes(16).toString('hex');
          room.password = passwordHash(String(data.password).slice(0, 64), room.salt);
        }
        const p = addPlayer(room, name);
        rooms.set(room.code, room);
        commit(room);
        return json(res, 201, { code: room.code, token: p.token });
      }
      const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/join$/i);
      if (match) {
        const room = getRoom(match[1]);
        if (!checkPassword(room, data.password)) throw new Error('房间口令不正确。');
        const p = addPlayer(room, name);
        commit(room);
        return json(res, 200, { code: room.code, token: p.token });
      }
      return json(res, 404, { error: '找不到这个入口。' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持的请求。' });
    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})$/i);
    if (match) {
      const r = getRoom(match[1]);
      return json(res, 200, { code: r.code, title: r.settings.title, count: r.players.length, locked: Boolean(r.password), settings: r.settings });
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!files.has(path)) return json(res, 404, { error: '页面不存在。' });
    res.writeHead(200, { 'Content-Type': types[extname(path)], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : files.get(path));
  } catch (error) { json(res, 400, { error: error.message }); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !validOrigin(req) || wss.clients.size >= 500 || limited('ws:' + ip(req), 30, 60000)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.on('pong', () => ws.alive = true);
  ws.on('error', () => {});
  const authTimeout = setTimeout(() => { if (!ws.playerId) ws.close(4003, 'Authentication required'); }, 8000);
  ws.on('message', raw => {
    try {
      if (limited('message:' + ip(req), 180, 10000)) throw new Error('操作太频繁了。');
      const message = JSON.parse(raw.toString());
      if (!message || typeof message !== 'object') throw new Error('请求格式不正确。');
      if (message.type === 'auth') {
        if (ws.playerId) return;
        const room = getRoom(message.room);
        const p = room.players.find(p => p.token === message.token && !p.leaving);
        if (!p) { ws.send(JSON.stringify({ type: 'auth-error', error: '登录已失效，请重新加入房间。' })); return ws.close(4003); }
        const old = sockets.get(p.id);
        ws.playerId = p.id;
        ws.room = room.code;
        sockets.set(p.id, ws);
        if (old && old !== ws) old.close(4001, 'Opened in another tab');
        p.connected = true;
        transferHost(room);
        clearTimeout(authTimeout);
        commit(room);
        return;
      }
      if (!ws.playerId) throw new Error('请先加入房间。');
      const room = getRoom(ws.room);
      const p = room.players.find(p => p.id === ws.playerId);
      if (!p || p.leaving || sockets.get(p.id) !== ws) throw new Error('连接已失效。');
      if (message.type === 'action') act(room, p.id, message.action, message.amount, message.turnId);
      else if (message.type === 'start') startHand(room, p.id);
      else if (message.type === 'chat') {
        if (limited('chat:' + p.id, 6, 10000)) throw new Error('消息发得太快了。');
        const text = clean(message.text, 160);
        if (text) log(room, `${p.name}：${text}`, 'chat');
      } else if (message.type === 'rebuy') {
        if (ACTIVE.has(room.phase) && p.inHand) throw new Error('这手结束后再补充筹码。');
        if (p.stack !== 0) throw new Error('筹码用完后可以免费补充。');
        p.stack = room.settings.buyIn;
        p.buyIns += room.settings.buyIn;
        log(room, `${p.name} 补充了 ${room.settings.buyIn} 筹码`, 'system');
      } else if (message.type === 'sitout') {
        p.sittingOut = !p.sittingOut;
      } else if (message.type === 'remove') {
        if (room.hostId !== p.id) throw new Error('只有房主可以移除离线玩家。');
        if (ACTIVE.has(room.phase)) throw new Error('请等本手结束后移除玩家。');
        const target = room.players.find(x => x.id === message.playerId);
        if (!target || target.connected) throw new Error('只能移除离线玩家。');
        room.players = room.players.filter(x => x !== target);
        log(room, `${target.name} 的离线座位已释放`, 'system');
      } else if (message.type === 'leave') {
        leave(room, p.id);
        sockets.delete(p.id);
        commit(room);
        ws.send(JSON.stringify({ type: 'left' }));
        return ws.close(1000);
      } else throw new Error('未知的操作。');
      commit(room);
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
    }
  });
  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (!ws.playerId || sockets.get(ws.playerId) !== ws) return;
    sockets.delete(ws.playerId);
    const room = rooms.get(ws.room);
    const p = room?.players.find(p => p.id === ws.playerId);
    if (p) { p.connected = false; transferHost(room); commit(room); }
  });
});

const ticker = setInterval(() => {
  for (const room of rooms.values()) {
    if (ACTIVE.has(room.phase) && room.deadline && Date.now() >= room.deadline) {
      const p = room.players.find(p => p.id === room.actorId);
      if (p) {
        try { act(room, p.id, p.streetBet >= room.currentBet ? 'check' : 'fold', null, room.turnId); commit(room); }
        catch (e) { console.error('Turn timer:', room.code, e.message); }
      }
    }
    if (!room.players.some(p => p.connected) && Date.now() - room.updatedAt > 86400000) { rooms.delete(room.code); save(); }
  }
  for (const [key, value] of rates) if (Date.now() > value.until) rates.delete(key);
}, 1000);
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
}, 25000);

server.listen(PORT, HOST, () => console.log(`River Club ready at http://${HOST}:${PORT}`));
function shutdown() {
  clearInterval(ticker); clearInterval(heartbeat); save();
  wss.clients.forEach(ws => ws.close(1012, 'Server restarting'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
