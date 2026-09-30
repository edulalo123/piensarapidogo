const { validate } = require('./quizStore');

const MAX_P = 20, MAX_S = 6, START = 100, RESULT_MS = 10000;

class Game {
  constructor(code, hostToken, io) {
    Object.assign(this, {
      code, hostToken, io, phase: 'lobby', quiz: null, qIndex: -1,
      people: new Map(), host: null, timer: null, endsAt: 0, created: Date.now(),
    });
  }

  isHost(t) { return t === this.hostToken; }
  list(role) { return [...this.people.values()].filter(p => !role || p.role === role); }

  /* ---------- Acceso y reconexión ---------- */
  join(sid, token, name, role) {
    if (this.isHost(token)) { this.host = { sid, online: true }; return { ok: true }; }
    let p = this.people.get(token);
    if (!p && name) { // reconexión por nombre (p. ej. cambió de dispositivo o cerró la pestaña)
      const q = this.list().find(x => x.name.toLowerCase() === name.toLowerCase());
      if (q) {
        if (q.online) return { error: 'Ese nombre ya está en uso (si te desconectaste, espera unos segundos y reintenta)' };
        this.people.delete(q.token); q.token = token; this.people.set(token, q); p = q;
      }
    }
    if (p) { p.sid = sid; p.online = true; return { ok: true }; }
    if (!name) return { error: 'Ingresa tu nombre' };
    if (role === 'player') {
      if (this.phase !== 'lobby') return { error: 'La partida ya inició: entra como espectador' };
      if (this.list('player').length >= MAX_P) return { error: 'Los 20 cupos de jugador están llenos: entra como espectador' };
    } else {
      role = 'spectator';
      if (this.list('spectator').length >= MAX_S) return { error: 'Los 6 cupos de espectador están llenos' };
    }
    this.people.set(token, {
      token, name, role, sid, online: true, coins: role === 'player' ? START : 0,
      base: 0, bets: [], confirmed: false, bonus: 0, delta: null, hit: false, history: [],
    });
    return { ok: true };
  }

  leave(token, sid) {
    if (this.isHost(token)) { if (this.host && this.host.sid === sid) this.host.online = false; }
    else {
      const p = this.people.get(token);
      if (!p || p.sid !== sid) return;
      if (this.phase === 'lobby') this.people.delete(token); else p.online = false; // conserva monedas e historial
    }
    this.emitAll();
  }

  /* ---------- Flujo de la partida ---------- */
  start(data) {
    if (this.phase !== 'lobby') return { error: 'La partida ya inició' };
    const v = validate(data);
    if (v.error) return v;
    if (!this.list('player').length) return { error: 'Necesitas al menos 1 jugador' };
    this.quiz = v;
    this.next();
    return { ok: true };
  }

  next() {
    clearTimeout(this.timer);
    this.qIndex++;
    const { n, alts, time } = this.quiz;
    if (this.qIndex >= n) { this.phase = 'final'; return this.emitAll(); }
    for (const p of this.list('player')) {
      Object.assign(p, { base: p.coins, bets: Array(alts).fill(0), confirmed: false, bonus: 0, delta: null, hit: false });
    }
    this.phase = 'question';
    this.endsAt = Date.now() + time * 1000;
    this.timer = setTimeout(() => this.resolve(), time * 1000);
    this.emitAll();
  }

  /* Validación estricta en servidor: la suma apostada nunca supera el pozo de la ronda */
  check(token, bets) {
    const p = this.people.get(token);
    if (!p || this.phase !== 'question' || p.role !== 'player' || p.confirmed || this.endsAt <= Date.now())
      return { error: 'No puedes apostar ahora' };
    if (!Array.isArray(bets) || bets.length !== this.quiz.alts) return { error: 'Apuesta inválida' };
    const b = bets.map(Number);
    if (b.some(x => !Number.isInteger(x) || x < 0)) return { error: 'Solo montos enteros' };
    if (b.reduce((a, x) => a + x, 0) > p.base) return { error: `No puedes apostar más de tu pozo (${p.base})` };
    return { p, b };
  }

  bet(token, bets) { const r = this.check(token, bets); if (r.p) r.p.bets = r.b; } // borrador

  confirm(token, bets) {
    const r = this.check(token, bets);
    if (!r.p) return r;
    const { p, b } = r;
    if (p.base > 0 && b.every(x => x === 0)) return { error: 'Apuesta al menos 1 moneda' };
    p.bets = b; p.confirmed = true;
    p.bonus = Math.floor((this.endsAt - Date.now()) / 1000); // 1 moneda por segundo restante
    p.coins = p.base + p.bonus;
    this.emitAll();
    return { ok: true, bonus: p.bonus };
  }

  resolve() {
    if (this.phase !== 'question') return;
    clearTimeout(this.timer);
    const c = this.quiz.questions[this.qIndex].correct;
    for (const p of this.list('player')) {
      const kept = p.bets[c] || 0;       // solo lo apostado a la correcta se conserva
      p.hit = kept > 0;
      p.coins = kept + p.bonus;          // + bonus por rapidez (si confirmó)
      p.delta = p.coins - p.base;
      p.history.push({ q: this.qIndex + 1, delta: p.delta, coins: p.coins });
    }
    this.phase = 'results';              // pantalla de Ranking
    this.timer = setTimeout(() => this.next(), RESULT_MS);
    this.emitAll();
  }

  skip() { if (this.phase === 'results') this.next(); }

  /* ---------- Estado hacia cada cliente ---------- */
  state(token) {
    const res = this.phase === 'results';
    const q = this.quiz && this.quiz.questions[this.qIndex];
    const showQ = q && (this.phase === 'question' || res);
    const players = this.list('player').sort((a, b) => b.coins - a.coins).map(p => ({
      name: p.name, coins: p.coins, online: p.online,
      delta: res ? p.delta : null, confirmed: this.phase === 'question' && p.confirmed,
    }));
    const me = this.people.get(token), top = players[0] ? players[0].coins : 0;
    return {
      code: this.code, phase: this.phase, qIndex: this.qIndex, total: this.quiz ? this.quiz.n : 0,
      remaining: this.phase === 'question' ? Math.max(0, this.endsAt - Date.now()) : 0,
      question: showQ ? { text: q.text, options: q.options } : null,
      correct: showQ && res ? q.correct : null,
      players, specs: this.list('spectator').map(p => p.name), maxP: MAX_P, maxS: MAX_S,
      winners: this.phase === 'final' ? players.filter(p => p.coins === top && top > 0).map(p => p.name) : null,
      you: me ? {
        host: false, name: me.name, role: me.role, coins: me.coins, pool: me.base, confirmed: me.confirmed,
        bonus: me.bonus, bets: me.bets, delta: me.delta, hit: me.hit, history: me.history,
      } : { host: this.isHost(token) },
    };
  }

  emitAll() {
    const send = (sid, t) => this.io.to(sid).emit('state', this.state(t));
    if (this.host && this.host.online) send(this.host.sid, this.hostToken);
    for (const p of this.people.values()) if (p.online) send(p.sid, p.token);
  }
}

module.exports = Game;
