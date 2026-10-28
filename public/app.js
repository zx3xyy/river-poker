const app = document.querySelector('#app');
const suit = { c: '♣', d: '♦', h: '♥', s: '♠' };
const phases = { lobby: '等待开局', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '本手结束' };
const active = s => ['preflop', 'flop', 'turn', 'river'].includes(s?.phase);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString('en-US');
const storage = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { toast('浏览器无法保存登录信息，请不要关闭此页面。'); } }, remove(k) { try { localStorage.removeItem(k); } catch {} } };
let state = null, socket = null, connection = 'connecting', reconnectTimer = null, retry = 0, intentional = false;
let currentCode = (new URL(location.href).searchParams.get('room') || '').toUpperCase();
let tab = currentCode ? 'join' : 'create', formError = '', roomMeta = null, busy = false, actionBusy = false;
let nickname = storage.get('river:name') || '', chatDraft = '', raiseValue = 0, lastTurn = null, clockOffset = 0;

function card(value, extra = '') {
  if (value === undefined) return `<div class="card empty ${extra}" aria-label="尚未发牌">♠</div>`;
  if (value === null) return `<div class="card back ${extra}" aria-label="隐藏的底牌"></div>`;
  const rank = value[0] === 'T' ? '10' : value[0];
  return `<div class="card ${'dh'.includes(value[1]) ? 'red' : ''} ${extra}" aria-label="${esc(rank + suit[value[1]])}"><span>${esc(rank)}<span class="corner">${suit[value[1]]}</span></span><span class="suit">${suit[value[1]]}</span><span class="bottom corner">${esc(rank)}${suit[value[1]]}</span></div>`;
}
function brand() { return `<a class="brand" href="/" data-action="home"><span class="brand-icon">♠</span><div><div class="brand-title">RIVER CLUB</div><div class="brand-sub">河 畔 牌 局</div></div></a>`; }
function toast(text) {
  const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 3500);
}
function renderLanding() {
  state = null;
  app.innerHTML = `<header class="site-header">${brand()}<div class="header-right"><span class="muted"><span class="status-dot"></span>朋友，随时入座</span><button class="ghost" data-action="rules">玩法 ↗</button></div></header>
  <main class="hero"><section class="intro"><span class="eyebrow">GOOD FRIENDS. GREAT HANDS.</span><h1>今晚，<br>来<em>一手。</em></h1><p>把朋友聚在一张牌桌。<br>无需下载，分享链接，就能一起玩德州扑克。</p>
  <div class="join-card"><div class="tabs"><button class="tab ${tab === 'create' ? 'active' : ''}" data-action="tab" data-tab="create">创建牌桌</button><button class="tab ${tab === 'join' ? 'active' : ''}" data-action="tab" data-tab="join">加入朋友的牌桌</button></div>
  <form id="entry-form">${formError ? `<div class="error-box" role="alert">${esc(formError)}</div>` : ''}${roomMeta && tab === 'join' ? `<p class="lobby-notice">${esc(roomMeta.title)} · ${roomMeta.count}/8 人已入座${roomMeta.locked ? ' · 需要口令' : ''}</p>` : ''}<div class="field"><label for="player-name">你的牌桌昵称</label><input id="player-name" name="name" placeholder="朋友怎么称呼你？" maxlength="16" value="${esc(nickname)}" autocomplete="nickname" required></div>
  ${tab === 'join' ? `<div class="field"><label for="room-code">房间码</label><input class="room-input" id="room-code" name="code" placeholder="输入 6 位房间码" maxlength="6" minlength="6" value="${esc(currentCode)}" autocapitalize="characters" autocomplete="off" required></div><div class="field"><label for="join-password">房间口令（如果有）</label><input id="join-password" name="password" type="password" maxlength="64" placeholder="没有口令则留空" autocomplete="off"></div>` : `<details><summary>牌桌设置 <span class="muted">· 默认 10/20 盲注，2,000 筹码</span></summary><div class="field"><label for="table-name">牌桌名称</label><input id="table-name" name="title" maxlength="24" placeholder="今晚来一手" value="今晚来一手"></div><div class="settings-grid"><div class="field"><label for="big-blind">大盲注</label><select id="big-blind" name="bigBlind"><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></div><div class="field"><label for="buy-in">每人初始筹码</label><select id="buy-in" name="buyIn"><option value="2000">2,000</option><option value="5000">5,000</option><option value="10000">10,000</option></select></div><div class="field"><label for="turn-seconds">每步思考时间</label><select id="turn-seconds" name="turnSeconds"><option value="30">30 秒</option><option value="60">60 秒</option><option value="90">90 秒</option></select></div><div class="field"><label for="new-password">房间口令（可选）</label><input id="new-password" name="password" type="password" maxlength="64" autocomplete="new-password" placeholder="仅好友知道"></div></div></details>`}
  <button class="primary" type="submit" ${busy ? 'disabled' : ''}><span>${busy ? '正在入座…' : tab === 'create' ? '创建我的牌桌' : '入座，开始玩'}</span><span>↗</span></button><p class="fine-print">2–8 人好友局 · 娱乐筹码 · 无需注册</p></form></div></section>
  <div class="hero-art" aria-hidden="true"><div class="hero-oval"></div><div class="art-brand">THE RIVER CLUB</div><div class="hero-cards">${['As', 'Kh', 'Qs', 'Jh', 'Tc'].map(c => card(c)).join('')}</div><div class="chip art-chip1">100</div><div class="chip green art-chip2">25</div><div class="hero-hole">${card('Ah')}${card('Ad')}</div><div class="art-label">YOUR SEAT IS WAITING.</div></div></main>
  <section class="features"><div class="feature"><span>↗</span><div><strong>链接发到群里，朋友即刻入座</strong><small>私人房间，可设置专属口令</small></div></div><div class="feature"><span>♣</span><div><strong>专心打牌，结算交给我们</strong><small>自动发牌、盲注、边池与摊牌</small></div></div><div class="feature"><span>↻</span><div><strong>掉线了？你的座位还在</strong><small>手机与电脑都能玩，支持断线重连</small></div></div></section><footer class="site-footer"><span>RIVER CLUB © ${new Date().getFullYear()}</span><span>好牌会来，好朋友一直在。</span></footer>`;
}

const desktopPositions = [[50, 88], [19, 77], [8, 46], [23, 15], [50, 10], [77, 15], [92, 46], [81, 77]];
const mobilePositions = [[50, 89], [16, 76], [14, 46], [20, 17], [50, 10], [80, 17], [86, 46], [84, 76]];
function renderSeat(p, position, s) {
  const [x, y] = position;
  if (!p) return `<div class="seat empty-seat" style="left:${x}%;top:${y}%"><div class="empty-circle">＋</div>等一位朋友</div>`;
  const isMe = p.id === s.selfId, isTurn = s.actorId === p.id, won = s.result?.pots.some(pot => !pot.refund && pot.winners.includes(p.id));
  const badge = p.seat === s.button && s.handNo ? 'D' : p.id === s.smallBlindId ? 'SB' : p.id === s.bigBlindId ? 'BB' : '';
  let status = p.leaving ? '已离桌' : p.sittingOut && !p.inHand ? '暂时休息' : !p.connected ? '已断线 · 保留座位' : p.lastAction || (p.inHand ? (p.stack === 0 ? 'ALL IN' : '等待行动') : '准备好了');
  if (won) status = s.result.hands[p.id]?.label || '拿下底池';
  return `<div class="seat ${isMe ? 'you' : ''} ${isTurn ? 'active' : ''} ${p.folded && active(s) ? 'folded' : ''} ${!p.connected ? 'offline' : ''} ${won ? 'winner' : ''}" style="left:${x}%;top:${y}%"><div class="seat-cards">${p.cards.map(c => card(c)).join('')}</div><div class="seat-box">${won ? '<span class="win-tag">WINNER</span>' : ''}${badge ? `<span class="badge">${badge}</span>` : ''}<div class="seat-name">${esc(p.name)}${isMe ? '<span class="seat-label-self">你</span>' : ''}</div><div class="seat-stack">${num(p.stack)}</div><div class="seat-status">${esc(isTurn ? '思考中…' : status)}</div>${isTurn ? '<div class="timer-track"><div class="timer-fill"></div></div>' : ''}</div>${p.streetBet && active(s) ? `<span class="seat-bet">${num(p.streetBet)}</span>` : ''}</div>`;
}
function actionPanel(s, me) {
  const ready = s.players.filter(p => p.connected && !p.sittingOut && p.stack > 0 && !p.leaving).length;
  if (!active(s)) {
    const host = s.players.find(p => p.id === s.hostId);
    const wonNames = [...new Set(s.result?.pots.filter(p => !p.refund).flatMap(p => p.winners) || [])].map(id => s.players.find(p => p.id === id)?.name || '离桌玩家');
    return `<div class="waiting-line"><div><strong>${s.result ? `${wonNames.map(esc).join('、')} 拿下这手` : '牌桌准备好了，等朋友入座。'}</strong>${ready >= 2 ? '已有 ' + ready + ' 位玩家准备好' : '至少两位在线玩家即可开局'}</div>${s.hostId === s.selfId ? `<button class="primary" data-action="start" ${ready < 2 || connection !== 'online' ? 'disabled' : ''}>${s.handNo ? '开始下一手' : '开始第一手'} →</button>` : `<span>等待 ${esc(host?.name || '房主')} 开局</span>`}</div>${s.result?.pots.length > 1 ? `<div class="results-pots">${s.result.pots.map((p, i) => `${p.refund ? '退回' : i ? '边池 ' + i : '主池'} ${num(p.amount)} → ${p.winners.map(id => esc(s.players.find(x => x.id === id)?.name || '离桌玩家')).join('、')}（${esc(p.label)}）`).join('<br>')}</div>` : ''}`;
  }
  if (!s.legal) {
    const current = s.players.find(p => p.id === s.actorId);
    return `<div class="waiting-line"><div><strong>${!me.inHand ? '你将在下一手入局' : me.folded ? '这手已弃牌，稍等下一手' : me.stack === 0 ? '你已全押，等待结算' : `轮到 ${esc(current?.name || '其他玩家')} 行动`}</strong>${me.sittingOut ? '你已选择暂停，下一手将休息' : '底牌只有自己可见 · 好牌值得耐心等待'}</div><span class="muted">${phases[s.phase]}</span></div>`;
  }
  const a = s.legal, min = Math.min(a.minRaise, a.maxRaise), disabled = actionBusy || connection !== 'online';
  return `<div class="action-caption"><strong>轮到你了 <span id="turn-clock"></span></strong><span>${a.canCheck ? '可以免费看下一张牌' : `需跟注 ${num(a.toCall)} 筹码`}</span></div><div class="action-buttons"><button class="secondary fold-btn" data-action="play" data-play="fold" ${disabled ? 'disabled' : ''}>弃牌</button><button class="secondary" data-action="play" data-play="${a.canCheck ? 'check' : 'call'}" ${disabled ? 'disabled' : ''}>${a.canCheck ? '过牌' : a.toCall === me.stack ? '全押跟注 ' + num(a.toCall) : '跟注 ' + num(a.toCall)}</button><button class="primary" id="raise-button" data-action="play" data-play="raise" ${!a.canRaise || disabled ? 'disabled' : ''}>${raiseValue === a.maxRaise ? '全押 ' : '加注至 '}${num(raiseValue)}</button></div>${a.canRaise ? `<div class="raise-options"><input id="raise-slider" type="range" aria-label="加注金额" min="${min}" max="${a.maxRaise}" step="1" value="${raiseValue}"><input id="raise-input" type="number" aria-label="加注至" min="${min}" max="${a.maxRaise}" value="${raiseValue}"><div class="presets"><button data-action="preset" data-value="min">最小</button><button data-action="preset" data-value="half">½ 底池</button><button data-action="preset" data-value="pot">底池</button><button data-action="preset" data-value="all">全押</button></div></div>` : ''}`;
}
function renderRoom() {
  const s = state, me = s.players.find(p => p.id === s.selfId);
  if (!me) return;
  const focused = document.activeElement?.id;
  const selection = focused === 'chat-text' ? document.activeElement.selectionStart : null;
  const positions = innerWidth <= 800 ? mobilePositions : desktopPositions;
  const rotated = Array.from({ length: 8 }, (_, i) => s.players.find(p => p.seat === (me.seat + i) % 8));
  app.innerHTML = `<header class="site-header table-header">${brand()}<div><span class="room-label">朋友的私人牌桌</span><button class="code-button" data-action="copy-code" title="复制房间码">${s.code} ⧉</button></div><div class="header-right"><button class="secondary" data-action="share">邀请好友 ↗</button><button class="ghost" data-action="rules">玩法</button></div></header>${connection !== 'online' ? `<div class="connection-banner" role="status">${connection === 'replaced' ? '这个座位已在另一个窗口打开。刷新可回到这里。' : '连接恢复中… 你的座位与筹码会保留。'}</div>` : ''}
  <main class="table-layout"><section class="table-main"><div class="table-topline"><h1>${esc(s.title)}</h1><span><span class="status-dot"></span>${s.handNo ? '第 ' + s.handNo + ' 手' : '准备入座'} · 无限注德州扑克</span></div><div class="table-shell"><div class="felt"></div><div class="felt-mark">THE RIVER CLUB</div>${s.phase === 'lobby' ? `<div class="center-message"><span class="eyebrow">TAKE A SEAT</span><h2>人齐了，就开局。</h2><p>把链接发给朋友<br>两个人也能打得尽兴</p><button class="primary" data-action="share">复制邀请链接 ↗</button></div>` : `<div class="community">${Array.from({ length: 5 }, (_, i) => card(s.board[i])).join('')}</div><div class="pot-area"><div class="pot-label">${s.phase === 'showdown' ? '本手底池' : 'TOTAL POT'}</div><div class="pot-amount">◉ ${num(s.pot)}</div><div class="street-label">${phases[s.phase]}${s.result?.showdown ? ' · 已摊牌' : ''}</div></div>`}${rotated.map((p, i) => renderSeat(p, positions[i], s)).join('')}</div><div class="action-panel">${actionPanel(s, me)}</div><p class="keyboard-note">认真打牌，轻松相聚。仅使用娱乐筹码。</p></section>
  <aside class="room-side"><section class="side-section"><div class="side-heading">桌上的朋友 <span>${s.players.length} / 8</span></div>${s.players.map(p => { const net = p.stack + (active(s) ? (s.pot ? 0 : 0) : 0) - p.buyIns; return `<div class="player-row"><span class="avatar">${esc([...p.name][0])}</span><div class="player-info"><div>${esc(p.name)}${p.id === s.hostId ? '<span class="host-tag">房主</span>' : ''}${p.id === s.selfId ? '<span class="host-tag">你</span>' : ''}</div><small>${p.leaving ? '已离桌' : !p.connected ? '离线 · 保留座位' : p.sittingOut ? '下一手休息' : p.inHand && active(s) ? (p.folded ? '已弃牌' : '牌局中') : '准备好了'}</small></div><span class="net ${net >= 0 ? 'positive' : 'negative'}">${active(s) ? num(p.stack) : (net > 0 ? '+' : '') + num(net)}</span>${!p.connected && s.hostId === s.selfId && !active(s) ? `<button class="remove-btn" data-action="remove" data-player="${p.id}" title="释放离线座位">×</button>` : ''}</div>`; }).join('')}<div class="seat-controls"><button class="secondary" data-action="sitout">${me.sittingOut ? '重新准备' : '下手休息'}</button>${me.stack === 0 && !(active(s) && me.inHand) ? '<button class="secondary" data-action="rebuy">补充筹码</button>' : ''}<button class="ghost" data-action="leave">离桌</button></div></section><section class="side-section"><div class="side-heading">牌桌设置 <button class="ghost" data-action="rules" style="font-size:11px;padding:0">查看玩法 ↗</button></div><div class="table-rules"><div>大小盲<strong>${num(s.settings.smallBlind)} / ${num(s.settings.bigBlind)}</strong></div><div>思考时间<strong>${s.settings.turnSeconds} 秒</strong></div><div>初始筹码<strong>${num(s.settings.buyIn)}</strong></div></div></section><section class="side-section activity"><div class="side-heading">牌桌动态 <span>聊两句，好牌就来</span></div><div class="activity-log" role="log" aria-label="牌局记录">${s.log.map(l => `<div class="log-line ${l.kind}">${esc(l.text)}</div>`).join('')}</div><form class="chat-form" id="chat-form"><input id="chat-text" aria-label="发送聊天消息" placeholder="和朋友说点什么…" maxlength="160" autocomplete="off" value="${esc(chatDraft)}"><button type="submit" aria-label="发送">↑</button></form></section></aside></main>`;
  const activity = document.querySelector('.activity-log'); activity.scrollTop = activity.scrollHeight;
  if (focused === 'chat-text') { const el = document.querySelector('#chat-text'); el.focus({ preventScroll: true }); el.setSelectionRange(selection, selection); }
  updateClock();
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN || connection !== 'online') return toast('正在恢复连接，请稍等。');
  socket.send(JSON.stringify(message));
}
async function api(path, data) {
  const response = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '暂时无法连接，请重试。');
  return result;
}
function connect(code, token) {
  clearTimeout(reconnectTimer);
  intentional = false;
  connection = 'connecting';
  currentCode = code;
  history.replaceState(null, '', '/?room=' + encodeURIComponent(code));
  if (!state) app.innerHTML = `<div class="connecting"><span class="eyebrow">RIVER CLUB</span><p style="margin-top:20px">正在为你拉开椅子…</p><button class="secondary" data-action="back">返回首页</button></div>`;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  const thisSocket = socket;
  thisSocket.onopen = () => thisSocket.send(JSON.stringify({ type: 'auth', room: code, token }));
  thisSocket.onmessage = event => {
    if (socket !== thisSocket) return;
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      state = message.state; connection = 'online'; retry = 0; actionBusy = false;
      clockOffset = state.serverTime - Date.now();
      if (state.turnId !== lastTurn) { raiseValue = state.legal ? Math.min(state.legal.minRaise, state.legal.maxRaise) : 0; lastTurn = state.turnId; }
      renderRoom();
    } else if (message.type === 'auth-error') {
      intentional = true; storage.remove('river:room:' + code); formError = message.error; renderLanding();
    } else if (message.type === 'error') {
      actionBusy = false; toast(message.error);
      if (state) renderRoom();
      else { intentional = true; formError = message.error; renderLanding(); }
    } else if (message.type === 'left') goHome(true);
  };
  thisSocket.onclose = event => {
    if (socket !== thisSocket || intentional) return;
    if (event.code === 4001) { connection = 'replaced'; if (state) renderRoom(); return; }
    if (event.code === 4003) { formError = '登录已失效，请重新加入。'; storage.remove('river:room:' + code); renderLanding(); return; }
    connection = 'offline'; if (state) renderRoom();
    reconnectTimer = setTimeout(() => connect(code, token), Math.min(1000 * 1.7 ** retry++, 12000));
  };
  thisSocket.onerror = () => {};
}
function goHome(clear = false) {
  intentional = true; clearTimeout(reconnectTimer); if (socket) socket.close(); socket = null;
  if (clear) storage.remove('river:room:' + currentCode);
  state = null; currentCode = ''; roomMeta = null; formError = ''; tab = 'create'; lastTurn = null;
  history.replaceState(null, '', '/'); renderLanding();
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制，发给朋友就能入座。'); }
  catch { window.prompt('复制后发给朋友：', text); }
}
function updateRaise(value) {
  if (!state?.legal) return;
  const a = state.legal;
  raiseValue = Math.max(Math.min(a.minRaise, a.maxRaise), Math.min(a.maxRaise, Math.round(Number(value) || 0)));
  for (const id of ['raise-slider', 'raise-input']) { const el = document.getElementById(id); if (el) el.value = raiseValue; }
  const button = document.querySelector('#raise-button'); if (button) button.textContent = `${raiseValue === a.maxRaise ? '全押 ' : '加注至 '}${num(raiseValue)}`;
}
app.addEventListener('submit', async event => {
  event.preventDefault();
  if (event.target.id === 'chat-form') { const text = chatDraft.trim(); if (text) { send({ type: 'chat', text }); chatDraft = ''; document.querySelector('#chat-text').value = ''; } return; }
  if (event.target.id !== 'entry-form' || busy) return;
  const values = Object.fromEntries(new FormData(event.target)); nickname = values.name.trim(); storage.set('river:name', nickname);
  if (tab === 'join') currentCode = values.code.trim().toUpperCase();
  busy = true; const submit = event.target.querySelector('[type=submit]'); submit.disabled = true; submit.firstElementChild.textContent = '正在入座…';
  try {
    const result = await api(tab === 'create' ? '/api/rooms' : `/api/rooms/${encodeURIComponent(currentCode)}/join`, values);
    storage.set('river:room:' + result.code, result.token); connect(result.code, result.token);
  } catch (error) { busy = false; formError = error.message; renderLanding(); }
  finally { busy = false; if (!socket || socket.readyState === WebSocket.CLOSED) { const button = document.querySelector('#entry-form [type=submit]'); if (button) button.disabled = false; } }
});
app.addEventListener('input', event => {
  if (event.target.id === 'player-name') nickname = event.target.value;
  if (event.target.id === 'chat-text') chatDraft = event.target.value;
  if (event.target.id === 'room-code') { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); currentCode = event.target.value; }
  if (event.target.id === 'raise-slider') updateRaise(event.target.value);
});
app.addEventListener('change', event => { if (event.target.id === 'raise-input') updateRaise(event.target.value); });
app.addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (action === 'home') { event.preventDefault(); if (!state) goHome(); else toast('要离开牌桌，请点击右侧「离桌」。'); }
  else if (action === 'rules') document.querySelector('#rules').showModal();
  else if (action === 'tab') { tab = button.dataset.tab; formError = ''; renderLanding(); }
  else if (action === 'share') copy(`${location.origin}/?room=${currentCode}`);
  else if (action === 'copy-code') copy(currentCode);
  else if (action === 'back') goHome();
  else if (['start', 'sitout', 'rebuy'].includes(action)) send({ type: action });
  else if (action === 'remove') send({ type: 'remove', playerId: button.dataset.player });
  else if (action === 'leave') { if (confirm(active(state) ? '离桌会放弃当前手牌（已全押的牌仍会参与结算）。确定离桌？' : '确定离开这张牌桌？')) send({ type: 'leave' }); }
  else if (action === 'play' && state?.legal && !actionBusy) { actionBusy = true; send({ type: 'action', action: button.dataset.play, amount: raiseValue, turnId: state.turnId }); renderRoom(); }
  else if (action === 'preset' && state?.legal) {
    const me = state.players.find(p => p.id === state.selfId), a = state.legal;
    const targets = { min: a.minRaise, all: a.maxRaise, half: state.currentBet + Math.floor((state.pot + a.toCall) / 2), pot: state.currentBet + state.pot + a.toCall };
    updateRaise(targets[button.dataset.value]);
  }
});
document.querySelector('.close-dialog').addEventListener('click', () => document.querySelector('#rules').close());
document.querySelector('#rules').addEventListener('click', event => { if (event.target === document.querySelector('#rules')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
function updateClock() {
  if (!state?.deadline) return;
  const seconds = Math.max(0, Math.ceil((state.deadline - Date.now() - clockOffset) / 1000));
  const fill = document.querySelector('.timer-fill'); if (fill) fill.style.width = Math.min(100, seconds / state.settings.turnSeconds * 100) + '%';
  const clock = document.querySelector('#turn-clock'); if (clock) clock.textContent = `· ${seconds}s`;
}
setInterval(updateClock, 250);
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state) renderRoom(); }, 100); });
if (currentCode && storage.get('river:room:' + currentCode)) connect(currentCode, storage.get('river:room:' + currentCode));
else {
  renderLanding();
  if (/^[A-Z0-9]{6}$/.test(currentCode)) api('/api/rooms/' + currentCode).then(meta => { if (!state) { roomMeta = meta; renderLanding(); } }).catch(error => { formError = error.message; renderLanding(); });
}
