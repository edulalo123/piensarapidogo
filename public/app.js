const socket = io(), $ = s => document.querySelector(s), app = $('#app'), L = 'ABCDE';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sg = n => (n >= 0 ? '+' : '') + n, sum = a => a.reduce((x, y) => x + y, 0);
let S = null, key = '', bets = [], endAt = 0, lastTick = 0, quizCode = null;

const toast = m => { const t = $('#toast'); t.textContent = m; t.className = 'show'; setTimeout(() => (t.className = ''), 3000); };
const tk = () => sessionStorage.tk || (sessionStorage.tk = Math.random().toString(36).slice(2) + Date.now().toString(36));
const canBet = () => S && S.phase === 'question' && S.you.role === 'player' && !S.you.confirmed && endAt > Date.now();

/* ---------- Conexión y reconexión ---------- */
function join(code, name, role, auto) {
  socket.emit('join', { code, name, role, token: tk() }, r => {
    if (r.error) {
      if (auto || r.error === 'Sala no encontrada') { delete sessionStorage.room; S = null; key = ''; Sound.stopMusic(); home(); }
      return toast(r.error);
    }
    Object.assign(sessionStorage, { room: r.code, name: name || '', role: role || '' });
    history.replaceState(null, '', '/sala/' + r.code);
  });
}
// Al (re)conectar, vuelve solo a la partida activa con el mismo nombre
socket.on('connect', () => { if (sessionStorage.room) join(sessionStorage.room, sessionStorage.name || '', sessionStorage.role || 'player', true); });
socket.on('state', s => { S = s; render(); });

/* ---------- Inicio ---------- */
function home() {
  const c = (location.pathname.split('/')[2] || '').toUpperCase();
  app.innerHTML = `<section class="card center"><h1>🧠 Trivia de Apuestas</h1></section>
    <section class="card"><h2>Unirme a una sala</h2>
      <input id="nm" placeholder="Tu nombre" maxlength="20">
      <input id="cd" placeholder="Código de sala" maxlength="5" value="${esc(c)}">
      <div class="roles"><label><input type="radio" name="role" value="player" checked>Jugador</label>
      <label><input type="radio" name="role" value="spectator">Espectador</label></div>
      <button id="jn" class="big">Entrar</button></section>
    <section class="card"><h2>Organizar una partida</h2><button id="cr" class="big alt">Crear sala</button></section>`;
  $('#jn').onclick = () => join($('#cd').value.trim().toUpperCase(), $('#nm').value.trim(), document.querySelector('[name=role]:checked').value);
  $('#cr').onclick = () => socket.emit('create', null, r => { sessionStorage.tk = r.token; join(r.code, '', ''); });
}

/* ---------- Render por fase ---------- */
function render() {
  const y = S.you;
  const k = S.phase + (S.qIndex >= 0 && S.phase !== 'final' ? S.qIndex : '') + (y.confirmed ? 'c' : '');
  if (k !== key) { key = k; document.body.dataset.tab = 'q'; build(); }
  update();
  if (S.phase === 'question') Sound.music(); else Sound.stopMusic();
}

const ctl = j => `<div class="ctl"><button data-a="-" data-j="${j}">−</button>
  <input type="number" min="0" value="${bets[j]}" data-j="${j}"><button data-a="+" data-j="${j}">+</button>
  <button class="alt" data-a="all" data-j="${j}">All-in</button></div>`;

function build() {
  const y = S.you, q = S.question;
  lastTick = 0;
  if (S.phase === 'lobby') return lobby();

  if (S.phase === 'final') {
    Sound.win();
    app.innerHTML = `<section class="card center"><h1>🏆 Ranking definitivo</h1><h2 id="win"></h2></section>
      <section class="card" id="people"></section>
      ${y.role === 'player' && y.history.length ? `<section class="card"><h3>Tu historial</h3><div class="chips">${y.history.map(h => `<span>P${h.q}: ${sg(h.delta)} → ${h.coins}</span>`).join('')}</div></section>` : ''}`;
    return;
  }

  if (S.phase === 'results') { // Pantalla de transición: respuesta correcta + ranking
    if (y.role === 'player' && !y.hit) Sound.bad(); else Sound.good();
    app.innerHTML = `<section class="card center"><h2>Respuesta correcta</h2><div class="ans" id="ans"></div>
      <p id="mine"></p><p class="muted">La siguiente pregunta empieza sola.</p>
      ${y.host ? '<button id="skip">Siguiente ahora</button>' : ''}</section><section class="card" id="people"></section>`;
    return;
  }

  // Pantalla de pregunta
  bets = y.bets && y.bets.length === q.options.length ? y.bets.slice() : Array(q.options.length).fill(0);
  const pl = y.role === 'player', act = pl && !y.confirmed;
  app.innerHTML = `${pl ? '' : '<nav class="tabs"><button data-t="q">Pregunta</button><button data-t="rank">Ranking</button></nav>'}
    <section class="card" id="qsec"><div class="bar"><span>Pregunta ${S.qIndex + 1}/${S.total}</span><b id="timer" class="timer"></b></div>
    <h2 class="qt">${esc(q.text)}</h2>
    ${q.options.map((o, j) => `<div class="row"><b>${L[j]}</b><span>${esc(o)}</span>${act ? ctl(j) : pl ? `<strong>${bets[j]} 🪙</strong>` : ''}</div>`).join('')}
    <div id="hud"></div>
    ${act ? '<div class="actions"><button id="eq" class="alt">Repartir por igual</button><button id="clr" class="alt">Limpiar</button></div><button id="ok" class="big">Confirmar apuesta</button>' : ''}
    </section>${pl ? '' : '<section class="card tabbed" id="people"></section>'}`;
}

function update() {
  const y = S.you, pe = $('#people');
  if (S.phase === 'lobby') {
    const chips = a => a.map(n => `<span>${esc(n)}</span>`).join('') || '<em>Nadie aún</em>';
    pe.innerHTML = `<h3>Jugadores (${S.players.length}/${S.maxP})</h3><div class="chips">${chips(S.players.map(p => p.name))}</div>
      <h3>Espectadores (${S.specs.length}/${S.maxS})</h3><div class="chips">${chips(S.specs)}</div>`;
    return;
  }
  if (S.phase === 'question') { endAt = Date.now() + S.remaining; hud(); }
  if (S.phase === 'results') {
    $('#ans').textContent = `${L[S.correct]}. ${S.question.options[S.correct]}`;
    $('#mine').innerHTML = y.role === 'player'
      ? `${y.hit ? '✅ ¡Acertaste!' : '❌ No acertaste'}<br>Ahora tienes <b>${y.coins} 🪙</b> (${sg(y.delta)})${y.bonus ? ` · bonus por rapidez +${y.bonus}` : ''}` : '';
  }
  if (S.phase === 'final')
    $('#win').textContent = S.winners.length ? `${S.winners.length > 1 ? 'Ganadores' : 'Ganador'}: ${S.winners.join(', ')} · ${S.players[0].coins} 🪙` : 'Nadie tiene monedas';
  if (pe) pe.innerHTML = rankHTML();
}

function rankHTML() {
  const res = S.phase === 'results';
  return `<h2>Ranking</h2><table>` + S.players.map(p =>
    `<tr class="${p.name === S.you.name ? 'me' : ''}"><td>${S.players.findIndex(x => x.coins === p.coins) + 1}</td>
    <td>${esc(p.name)}${p.online ? '' : ' ⚫'}</td><td>${p.coins} 🪙</td>
    <td>${res && p.delta !== null ? sg(p.delta) : ''}</td><td>${S.phase === 'question' && p.confirmed ? '✔' : ''}</td></tr>`).join('') + '</table>';
}

function hud() {
  const h = $('#hud'); if (!h) return;
  const y = S.you;
  if (y.role === 'player') {
    const left = y.pool - sum(bets);
    h.innerHTML = y.confirmed
      ? `✅ Apuesta confirmada · bonus <b>+${y.bonus}</b> · total <b>${y.coins} 🪙</b>`
      : y.pool === 0 ? 'Sin monedas: confirma rápido para ganar el bonus por tiempo.'
      : `Pozo: <b>${y.pool} 🪙</b> · Sin asignar: <b>${left}</b> ${left ? '<small>(se pierden si no las apuestas)</small>' : ''}`;
  } else h.innerHTML = `Confirmaron <b>${S.players.filter(p => p.confirmed).length}</b> de ${S.players.length} jugadores.`;
}

/* ---------- Apuestas (validación en frontend: nunca superar el pozo) ---------- */
function sync(send = true) {
  document.querySelectorAll('input[data-j]').forEach(i => { if (i !== document.activeElement) i.value = bets[+i.dataset.j]; });
  hud();
  if (send) socket.emit('bet', bets);
}
function setBet(j, v) {
  if (!canBet()) return;
  const others = sum(bets) - bets[j];
  bets[j] = Math.max(0, Math.min(Math.floor(v) || 0, S.you.pool - others)); // tope = pozo - lo ya asignado
  sync();
}
function confirmBet() {
  if (sum(bets) > S.you.pool) return toast('No puedes apostar más de tu pozo');
  if (S.you.pool > 0 && sum(bets) === 0) return toast('Apuesta al menos 1 moneda');
  socket.emit('confirm', bets, r => (r.error ? toast(r.error) : Sound.coin()));
}

app.addEventListener('click', e => {
  const t = e.target, id = t.id, a = t.dataset.a, j = +t.dataset.j;
  if (id === 'skip') return socket.emit('skip');
  if (t.dataset.t) { document.body.dataset.tab = t.dataset.t; return; }
  if (!canBet()) return;
  const pool = S.you.pool;
  if (id === 'ok') return confirmBet();
  if (id === 'clr') bets = bets.map(() => 0);
  else if (id === 'eq') bets = bets.map((_, i) => Math.floor(pool / bets.length) + (i < pool % bets.length ? 1 : 0)); // reparte el resto entre las primeras
  else if (a === 'all') bets = bets.map((_, i) => (i === j ? pool : 0));
  else if (a) { setBet(j, bets[j] + (a === '+' ? 10 : -10)); return Sound.coin(); }
  else return;
  if (id !== 'clr') Sound.coin();
  sync();
});
app.addEventListener('input', e => { const i = e.target; if (i.type === 'number' && i.dataset.j !== undefined) setBet(+i.dataset.j, +i.value); });
app.addEventListener('change', e => { if (e.target.type === 'number' && e.target.dataset.j !== undefined) sync(false); });

setInterval(() => {
  const t = $('#timer'); if (!t || !S || S.phase !== 'question') return;
  const s = Math.ceil(Math.max(0, endAt - Date.now()) / 1000);
  t.textContent = s + ' s'; t.classList.toggle('low', s <= 10);
  if (s <= 10 && s > 0 && s !== lastTick) { lastTick = s; Sound.tick(); }
}, 200);

/* ---------- Lobby y editor del creador ---------- */
function lobby() {
  const host = S.you.host;
  app.innerHTML = `<section class="card"><h1>🧠 Sala <span class="code">${S.code}</span></h1>
    <div class="linkrow"><input id="link" readonly value="${location.origin}/sala/${S.code}"><button id="copy">Copiar</button></div></section>
    ${host ? editorHTML() : '<section class="card center"><h2>Esperando a que el creador inicie…</h2></section>'}
    <section class="card" id="people"></section>`;
  $('#copy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('#link').value); toast('Enlace copiado'); };
  if (host) initEditor();
}

function editorHTML() {
  const opts = (vals, def, u) => vals.map(v => `<option value="${v}"${v === def ? ' selected' : ''}>${v}${u}</option>`).join('');
  return `<section class="card"><h2>Configuración</h2><div class="grid3">
      <label>Preguntas<select id="n">${opts([5, 10, 15], 10, '')}</select></label>
      <label>Alternativas<select id="alts">${opts([4, 5], 5, '')}</select></label>
      <label>Tiempo<select id="time">${opts([30, 60, 90, 120], 60, ' s')}</select></label></div></section>
    <section class="card"><h2>Rondas guardadas</h2><p id="qc" class="muted"></p>
      <div class="linkrow"><input id="lc" placeholder="Código de ronda" maxlength="6"><button id="load">Cargar</button></div>
      <div class="linkrow"><button id="save">Guardar</button><button id="savenew" class="alt">Guardar como nueva</button><button id="newq" class="alt">Limpiar</button></div></section>
    <div id="editor">${Array.from({ length: 15 }, (_, i) => `<section class="card q"><h3>Pregunta ${i + 1}</h3>
      <textarea rows="2" maxlength="300" placeholder="Enunciado"></textarea>
      ${[0, 1, 2, 3, 4].map(j => `<label class="eo"><input type="radio" name="c${i}" value="${j}" title="Correcta"><b>${L[j]}</b><input type="text" maxlength="120" placeholder="Alternativa ${L[j]}"></label>`).join('')}
      <small>Marca el círculo de la respuesta correcta.</small></section>`).join('')}</div>
    <button id="start" class="big">Iniciar partida</button>`;
}

const collect = () => ({
  n: +$('#n').value, alts: +$('#alts').value, time: +$('#time').value,
  questions: [...document.querySelectorAll('.q')].map(c => ({
    text: c.querySelector('textarea').value,
    options: [...c.querySelectorAll('input[type=text]')].map(i => i.value),
    correct: +((c.querySelector('input[type=radio]:checked') || { value: -1 }).value),
  })),
});
const saveDraft = () => { localStorage.draft2 = JSON.stringify({ quizCode, ...collect() }); };
const showQC = () => { $('#qc').innerHTML = quizCode ? `Editando la ronda <span class="code">${quizCode}</span>` : 'Ronda nueva (aún sin guardar)'; };

function applyCfg() {
  const n = +$('#n').value, a = +$('#alts').value;
  document.querySelectorAll('.q').forEach((c, i) => { c.hidden = i >= n; c.querySelectorAll('.eo')[4].hidden = a < 5; });
}
function fill(d) {
  $('#n').value = d.n; $('#alts').value = d.alts; $('#time').value = d.time;
  document.querySelectorAll('.q').forEach((c, i) => {
    const q = (d.questions || [])[i] || { text: '', options: [], correct: -1 };
    c.querySelector('textarea').value = q.text || '';
    c.querySelectorAll('input[type=text]').forEach((x, j) => (x.value = (q.options || [])[j] || ''));
    c.querySelectorAll('input[type=radio]').forEach(r => (r.checked = +r.value === +q.correct));
  });
  applyCfg();
}

function initEditor() {
  try { const d = JSON.parse(localStorage.draft2 || 'null'); if (d) { quizCode = d.quizCode || null; fill(d); } } catch (e) { /* borrador dañado */ }
  applyCfg(); showQC();
  ['#n', '#alts', '#time'].forEach(s => ($(s).onchange = () => { applyCfg(); saveDraft(); }));
  $('#editor').addEventListener('input', saveDraft); $('#editor').addEventListener('change', saveDraft);
  $('#load').onclick = () => socket.emit('quiz:load', $('#lc').value.trim(), r => {
    if (r.error) return toast(r.error);
    quizCode = r.code; fill(r.quiz); showQC(); saveDraft(); toast('Ronda cargada');
  });
  const store = code => socket.emit('quiz:save', { code, quiz: collect() }, r => {
    if (r.error) return toast(r.error);
    quizCode = r.code; showQC(); saveDraft(); toast('Ronda guardada: ' + r.code);
  });
  $('#save').onclick = () => store(quizCode);       // edita la ronda cargada (o crea una si es nueva)
  $('#savenew').onclick = () => store(null);        // siempre crea un código nuevo
  $('#newq').onclick = () => { quizCode = null; fill({ n: 10, alts: 5, time: 60, questions: [] }); showQC(); saveDraft(); };
  $('#start').onclick = () => socket.emit('start', collect(), r => r && r.error && toast(r.error));
}

/* ---------- Sonido ---------- */
document.addEventListener('pointerdown', Sound.init);
$('#snd').textContent = Sound.muted ? '🔇' : '🔊';
$('#snd').onclick = () => { Sound.toggle(); $('#snd').textContent = Sound.muted ? '🔇' : '🔊'; if (S && S.phase === 'question') Sound.music(); };

home();
