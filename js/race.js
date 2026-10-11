'use strict';
/* Satu heat balapan: labirin + fisika + AI + 2 boss + partikel + render canvas. */
const STEP = 1 / 120;          // fixed timestep fisika
const BASE_SPEED = 128;        // px/detik
const HEAT_TIMEOUT = 150;      // detik sim; habis -> pemenang = progres terjauh

class Race {
  constructor(canvas, racers, label, opts) {
    opts = opts || {};
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width; this.H = canvas.height;
    this.label = label;
    this.onDone = opts.onDone || function () {};
    this.onTick = opts.onTick || function () {};
    this.showBanner = opts.showBanner || function () {};
    this.speed = opts.speed || 1;

    this.ax = (this.W - TC * TILE) / 2;   // 120
    this.ay = (this.H - TR * TILE) / 2;   // 36
    this.finY = this.ay + 10 * TILE;      // garis finis (batas baris 9/10)

    const channels = racers.length <= 2 ? [5, 9] : [1, 5, 9, 13];
    this.maze = genMazeSafe(channels);

    // --- FLOOD GATE: gerbang terkunci di tiap saluran start; terbuka saat meteran penuh ---
    this.gateMode = opts.gate !== undefined ? opts.gate : Math.random() < 0.35;
    this.gateTiles = [];
    this.gate = null;
    if (this.gateMode) {
      for (const c of channels) {
        let gr = 2;
        while (gr < TR - 1 && this.maze.grid[gr * TC + c] !== 0) gr++;
        if (gr < TR - 1 && this.maze.grid[gr * TC + c] === 0) {
          this.maze.grid[gr * TC + c] = 2;
          this.gateTiles.push(gr * TC + c);
        }
      }
      if (this.gateTiles.length > 0) {
        let maxR = 0;
        for (const t of this.gateTiles) maxR = Math.max(maxR, (t / TC) | 0);
        this.gate = { fill: 0, open: false, rate: 1 / 9, topRow: maxR };
      } else this.gateMode = false;
    }

    // --- unit balap ---
    this.units = racers.map((r, k) => {
      const c = this.maze.channels[k % this.maze.channels.length];
      const sx = tileCX(this.ax, c), sy = tileCY(this.ay, 0);
      return {
        name: r.name, color: r.color, dark: r.dark,
        x: sx, y: sy,
        vx: 0, vy: 0, r: 14,
        skill: 0.92 + Math.random() * 0.16,
        slowUntil: -1, wanderT: Math.random() * 2,
        wtx: sx, wty: sy + 60, stuckT: 0,
        alive: true, mood: 'normal',
        blink: 2 + Math.random() * 3, inWater: false
      };
    });

    // --- boss api (menara penembak) ---
    const ftx = this.maze.fireTile % TC, fty = (this.maze.fireTile / TC) | 0;
    this.fireBoss = {
      x: tileCX(this.ax, ftx), y: tileCY(this.ay, fty),
      r: 22, cd: 2.0, recoil: 0, aimA: 0, name: 'INFERNO'
    };
    // menara kedua di semifinal/final — ditaruh di tile api cadangan (sisi berlawanan)
    this.fireBoss2 = null;
    if (/SEMIFINAL|FINAL/.test(label || '')) {
      let bx = -1, by = -1, bd = -1;
      for (let y = 1; y < TR - 1; y++) for (let x = 1; x < TC - 1; x++) {
        if (this.maze.grid[y * TC + x] !== 0) continue;
        const wx = tileCX(this.ax, x), wy = tileCY(this.ay, y);
        const d = Math.hypot(wx - this.fireBoss.x, wy - this.fireBoss.y);
        if (d > bd) { bd = d; bx = x; by = y; }
      }
      if (bx >= 0) this.fireBoss2 = {
        x: tileCX(this.ax, bx), y: tileCY(this.ay, by),
        r: 22, cd: 2.6, recoil: 0, aimA: 0, name: 'INFERNO II'
      };
    }

    // --- boss penghancur: BERBURU pembalap terdekat (bukan patroli pasif) ---
    this.crusher = {
      x: this.ax + 3 * TILE, y: this.ay + 9 * TILE + TILE / 2,
      vx: 150, vy: 0, r: 34, wob: 0, name: 'GARGANT',
      minX: this.ax + 1.2 * TILE, maxX: this.ax + 13.8 * TILE,
      mode: 'hunt', modeT: 7   // siklus: berburu 7 dtk -> tidur 3.5 dtk (jendela aman)
    };

    this.fireballs = [];
    this.particles = [];
    this.state = 'countdown';
    this.countT = 0; this.countStage = 0;
    this.time = 0;
    this.shake = 0;
    this.winner = null;
    this.endT = 0;
    this.acc = 0; this.last = 0; this.raf = 0;
    this.dead = 0;

    this.staticLayer = document.createElement('canvas');
    this.staticLayer.width = this.W; this.staticLayer.height = this.H;
    this._renderStatic();
  }

  /* ============ KONTROL ============ */
  start() {
    this.last = performance.now();
    const loop = (now) => {
      let dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.acc += dt * this.speed;
      let n = 0;
      while (this.acc >= STEP && n < 40) { this._update(STEP); this.acc -= STEP; n++; }
      this._render();
      this.onTick(this.time, this.state);
      if (this.state !== 'over') this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  setSpeed(s) { this.speed = s; }
  destroy() { cancelAnimationFrame(this.raf); this.state = 'over'; }

  skip() {
    if (this.state === 'finished' || this.state === 'over') return;
    const w = this._leader();
    this._finish(w, 'SKIPPED ⏭');
  }

  /* ============ UPDATE ============ */
  _update(dt) {
    // shake decay selalu jalan
    this.shake = Math.max(0, this.shake - dt * 26);
    this._updateParticles(dt);

    if (this.state === 'countdown') {
      this.countT += dt;
      const stage = this.countT < 0.9 ? 0 : (this.countT < 1.7 ? 1 : 2);
      if (stage !== this.countStage) {
        this.countStage = stage;
        if (stage === 2) { this.state = 'running'; this._burstText(); }
      }
      return;
    }
    if (this.state !== 'running') {
      if (this.state === 'finished') {
        this.endT += dt;
        this.crusher.wob += dt;
        if (this.endT > 2.6) { this.state = 'over'; this.onDone(this.winner); }
      }
      return;
    }

    this.time += dt;
    if (this.time > HEAT_TIMEOUT) { this._finish(this._leader(), 'TIME UP ⏱'); return; }

    for (const u of this.units) if (u.alive) this._updateUnit(u, dt);
    this._collidePairs();
    this._updateFireBoss(dt);
    this._updateFireballs(dt);
    this._updateCrusher(dt);

    // flood gate: isi meteran, penuh -> dinding kebuka!
    if (this.gate && !this.gate.open) {
      this.gate.fill += dt * this.gate.rate;
      if (this.gate.fill >= 1) {
        this.gate.fill = 1; this.gate.open = true;
        for (const t of this.gateTiles) this.maze.grid[t] = 0;
        this.showBanner('GATE OPEN!', 'gaspol!');
        this.shake = Math.max(this.shake, 10);
        for (const t of this.gateTiles) {
          const gx = tileCX(this.ax, t % TC), gy = tileCY(this.ay, (t / TC) | 0);
          this._explode(gx, gy, '#9adcff', 18);
        }
      }
    }

    // cek finis
    for (const u of this.units) {
      if (u.alive && u.y >= this.finY) { this._finish(u, null); return; }
    }
  }

  _tileAt(px, py) {
    const tx = Math.floor((px - this.ax) / TILE), ty = Math.floor((py - this.ay) / TILE);
    if (tx < 0 || ty < 0 || tx >= TC || ty >= TR) return -2;
    return ty * TC + tx;
  }
  _solidAt(px, py) {
    const t = this._tileAt(px, py);
    return t === -2 || this.maze.grid[t] !== 0;
  }

  _updateUnit(u, dt) {
    const W = TC, g = this.maze.grid, dist = this.maze.distNB;
    const tx = Math.floor((u.x - this.ax) / TILE), ty = Math.floor((u.y - this.ay) / TILE);

    // 1) arah dari flow-field BFS (tetangga dgn jarak terkecil ke finis)
    let dx = 0, dy = 1;
    if (tx >= 0 && ty >= 0 && tx < W && ty < TR) {
      const id = ty * W + tx;
      let best = dist[id], bx = tx, by = ty;
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let k = 0; k < 4; k++) {
        const nx = tx + nb[k][0], ny = ty + nb[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= TR) continue;
        const nid = ny * W + nx;
        if (g[nid] !== 0 || dist[nid] < 0) continue;
        if (best < 0 || dist[nid] < best) { best = dist[nid]; bx = nx; by = ny; }
      }
      dx = (this.ax + bx * TILE + TILE / 2) - u.x;
      dy = (this.ay + by * TILE + TILE / 2) - u.y;
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    }

    // 2) wander: kadang ngintip jalur alternatif (bikin overtake!)
    u.wanderT -= dt;
    if (u.wanderT <= 0) {
      u.wanderT = 1.6 + Math.random() * 2.6;
      for (let t = 0; t < 8; t++) {
        const nx = tx + ((Math.random() * 5) | 0) - 2, ny = ty + ((Math.random() * 5) | 0) - 2;
        if (nx >= 0 && ny >= 0 && nx < W && ny < TR && g[ny * W + nx] === 0) {
          u.wtx = this.ax + nx * TILE + TILE / 2; u.wty = this.ay + ny * TILE + TILE / 2;
          break;
        }
      }
    }
    if (u.wanderT > 0.4) {
      let wx = u.wtx - u.x, wy = u.wty - u.y;
      const wl = Math.hypot(wx, wy);
      if (wl > 12) { wx /= wl; wy /= wl; dx = dx * 0.72 + wx * 0.28; dy = dy * 0.72 + wy * 0.28; }
    }

    // 3) hindari dinding di depan
    const px = u.x + dx * 30, py = u.y + dy * 30;
    if (this._solidAt(px, py)) {
      const side = (Math.floor(u.x + u.y) % 2 === 0) ? 1 : -1;
      const nx = -dy * side, ny = dx * side;
      dx = dx * 0.35 + nx * 0.65; dy = dy * 0.35 + ny * 0.65;
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    }

    // 4) kecepatan: skill + rubber-band + zona
    let sp = BASE_SPEED * u.skill;
    const tid = this._tileAt(u.x, u.y);
    u.inWater = tid >= 0 && this.maze.water.has(tid);
    if (u.inWater) { sp *= 0.55; if (Math.random() < dt * 8) this._splash(u.x, u.y); }
    const slowed = this.time < u.slowUntil;
    if (slowed) sp *= 0.5;
    u.mood = slowed ? 'slow' : 'normal';
    // rubber-band halus: yg ketinggalan dpt boost biar seru
    const lead = this._leaderDist();
    const myD = tid >= 0 ? dist[tid] : 999;
    if (myD - lead > 7) sp *= 1.13;

    u.vx += (dx * sp - u.vx) * Math.min(1, 7 * dt);
    u.vy += (dy * sp - u.vy) * Math.min(1, 7 * dt);
    u.x += u.vx * dt; u.y += u.vy * dt;

    this._collideTiles(u);
    // tabrakan dgn boss api (padat)
    this._collideCircle(u, this.fireBoss);

    // anti-stuck berbasis PERPINDAHAN: kalau 2.5 dtk cuma gerak <10px, selamatkan
    u.stuckTimer = (u.stuckTimer || 0) + dt;
    if (u.stuckTimer > 2.5) {
      u.stuckTimer = 0;
      const moved = Math.hypot(u.x - (u.lastPX === undefined ? u.x : u.lastPX),
                               u.y - (u.lastPY === undefined ? u.y : u.lastPY));
      u.lastPX = u.x; u.lastPY = u.y;
      if (moved < 10) {
        let bx = tx, by = ty, bd = dist[ty * W + tx];
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let k = 0; k < 4; k++) {
          const nx = tx + nb[k][0], ny = ty + nb[k][1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= TR) continue;
          const nid = ny * W + nx, d = dist[nid];
          if (g[nid] === 0 && d >= 0 && d < bd) { bd = d; bx = nx; by = ny; }
        }
        u.wtx = this.ax + bx * TILE + TILE / 2; u.wty = this.ay + by * TILE + TILE / 2;
        u.wanderT = 2.5;
        const a = Math.random() * 6.283;
        u.vx = Math.cos(a) * 380; u.vy = Math.sin(a) * 380;
      }
    }

    u.blink -= dt;
    if (u.blink < -0.12) u.blink = 2 + Math.random() * 3;
  }

  _collideTiles(e) {
    const r = e.r, g = this.maze.grid;
    const x0 = Math.max(0, Math.floor((e.x - r - this.ax) / TILE));
    const x1 = Math.min(TC - 1, Math.floor((e.x + r - this.ax) / TILE));
    const y0 = Math.max(0, Math.floor((e.y - r - this.ay) / TILE));
    const y1 = Math.min(TR - 1, Math.floor((e.y + r - this.ay) / TILE));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      if (g[ty * TC + tx] === 0) continue;   // 1 = dinding, 2 = gerbang terkunci
      const cx = this.ax + tx * TILE, cy = this.ay + ty * TILE;
      const nx = Math.max(cx, Math.min(e.x, cx + TILE));
      const ny = Math.max(cy, Math.min(e.y, cy + TILE));
      let dx = e.x - nx, dy = e.y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      let d = Math.sqrt(d2), ux, uy;
      if (d > 0.001) { ux = dx / d; uy = dy / d; } else { ux = 0; uy = -1; d = 0.001; }
      e.x += ux * (r - d); e.y += uy * (r - d);
      const vn = e.vx * ux + e.vy * uy;
      if (vn < 0) { e.vx -= 1.55 * vn * ux; e.vy -= 1.55 * vn * uy; }
    }
  }

  _collideCircle(e, c) {
    const dx = e.x - c.x, dy = e.y - c.y, rr = e.r + c.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 < 0.001) return;
    const d = Math.sqrt(d2), ux = dx / d, uy = dy / d;
    e.x = c.x + ux * rr; e.y = c.y + uy * rr;
    const vn = e.vx * ux + e.vy * uy;
    if (vn < 0) { e.vx -= 1.6 * vn * ux; e.vy -= 1.6 * vn * uy; }
  }

  _collidePairs() {
    const us = this.units;
    for (let i = 0; i < us.length; i++) {
      const a = us[i]; if (!a.alive) continue;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j]; if (!b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 < 0.001) continue;
        const d = Math.sqrt(d2), ux = dx / d, uy = dy / d, ov = rr - d;
        a.x -= ux * ov / 2; a.y -= uy * ov / 2;
        b.x += ux * ov / 2; b.y += uy * ov / 2;
        const vn = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy;
        if (vn < 0) {
          const imp = -1.6 * vn / 2;
          a.vx -= imp * ux; a.vy -= imp * uy;
          b.vx += imp * ux; b.vy += imp * uy;
        }
      }
    }
  }

  _leaderDist() {
    let best = 1e9;
    for (const u of this.units) {
      if (!u.alive) continue;
      const t = this._tileAt(u.x, u.y);
      const d = t >= 0 ? this.maze.distNB[t] : 999;
      if (d >= 0 && d < best) best = d;
    }
    return best;
  }
  _leader() {
    let bu = null, bd = 1e9;
    for (const u of this.units) {
      if (!u.alive) continue;
      const t = this._tileAt(u.x, u.y);
      const d = t >= 0 ? this.maze.distNB[t] : 999;
      if (d >= 0 && d < bd) { bd = d; bu = u; }
    }
    return bu || this.units[0];
  }
  _aliveCount() { let n = 0; for (const u of this.units) if (u.alive) n++; return n; }

  /* ---- boss api ---- */
  _updateFireBoss(dt) {
    this._updateOneTower(this.fireBoss, dt);
    if (this.fireBoss2) this._updateOneTower(this.fireBoss2, dt);
  }
  _updateOneTower(b, dt) {
    b.cd -= dt; b.recoil = Math.max(0, b.recoil - dt * 4);
    // bidik yg terdekat dalam jangkauan, dgn PREDIKSI gerakan (aim ke depan target)
    let tgt = null, td = 560;
    for (const u of this.units) {
      if (!u.alive) continue;
      const d = Math.hypot(u.x - b.x, u.y - b.y);
      if (d < td) { td = d; tgt = u; }
    }
    if (tgt) {
      const lead = Math.min(0.9, td / 330);   // waktu tempuh bola api
      const px = tgt.x + tgt.vx * lead, py = tgt.y + tgt.vy * lead;
      b.aimA = Math.atan2(py - b.y, px - b.x);
    }
    if (b.cd <= 0 && tgt) {
      b.cd = this.units.length > 2 ? 1.1 : 1.6;   // jauh lebih galak dari 2.0/2.8
      b.recoil = 1;
      this.fireballs.push({
        x: b.x + Math.cos(b.aimA) * 26, y: b.y + Math.sin(b.aimA) * 26,
        a: b.aimA, vx: 0, vy: 0, r: 9, life: 4.5, target: tgt, trail: 0
      });
      this.shake = Math.max(this.shake, 5);
      for (let i = 0; i < 8; i++) this._spawnP(b.x + Math.cos(b.aimA) * 30, b.y + Math.sin(b.aimA) * 30,
        (Math.random() - 0.5) * 160, (Math.random() - 0.5) * 160, '#ffdd44', 0.35, 5, -60);
    }
  }

  _updateFireballs(dt) {
    const SPD = 330, TURN = 5.2;
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i];
      f.life -= dt;
      if (f.target && f.target.alive) {
        const ta = Math.atan2(f.target.y - f.y, f.target.x - f.x);
        let da = ta - f.a;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        f.a += Math.max(-TURN * dt, Math.min(TURN * dt, da));
      }
      f.vx = Math.cos(f.a) * SPD; f.vy = Math.sin(f.a) * SPD;
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.trail -= dt;
      if (f.trail <= 0) {
        f.trail = 0.03;
        this._spawnP(f.x, f.y, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40 - 30,
          Math.random() < 0.5 ? '#ff7b1c' : '#ffdd44', 0.4, 7, -40);
      }
      let dead = f.life <= 0;
      if (!dead && this._solidAt(f.x, f.y)) { this._explode(f.x, f.y, '#ff7b1c', 10); dead = true; }
      if (!dead) {
        for (const u of this.units) {
          if (!u.alive) continue;
          const dx = u.x - f.x, dy = u.y - f.y, rr = u.r + f.r;
          if (dx * dx + dy * dy < rr * rr) {
            // kena! mental + lambat; kena kedua saat masih lambat = gosong (eliminasi)
            const l = Math.hypot(dx, dy) || 1;
            u.vx += (dx / l) * 470; u.vy += (dy / l) * 470;
            if (this.time < u.slowUntil && this._aliveCount() > 1) {
              this._eliminate(u, 'burned');
            } else {
              u.slowUntil = this.time + 3;
              this._explode(f.x, f.y, '#ff9a2e', 14);
              this.shake = Math.max(this.shake, 7);
            }
            dead = true; break;
          }
        }
      }
      if (dead) this.fireballs.splice(i, 1);
    }
  }

  /* ---- boss penghancur: BERBURU pembalap terdekat via pathfinding ---- */
  _bfsFrom(tx, ty) {
    // peta jarak dari tile target; -1 = dinding/tak terjangkau
    const W = TC, H = TR, g = this.maze.grid;
    const dist = new Int16Array(W * H).fill(-1);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return dist;
    let sid = ty * W + tx;
    if (g[sid] !== 0) {  // target di dinding -> cari tile jalan terdekat
      let found = -1;
      for (let r = 1; r < 4 && found < 0; r++)
        for (let y = Math.max(0, ty - r); y <= Math.min(H - 1, ty + r) && found < 0; y++)
          for (let x = Math.max(0, tx - r); x <= Math.min(W - 1, tx + r); x++)
            if (g[y * W + x] === 0) { found = y * W + x; break; }
      if (found < 0) return dist;
      sid = found;
    }
    const q = [sid]; dist[sid] = 0;
    let head = 0;
    while (head < q.length) {
      const id = q[head++], x = id % W, y = (id / W) | 0, nd = dist[id] + 1;
      if (x + 1 < W) { const n = id + 1; if (dist[n] < 0 && g[n] === 0) { dist[n] = nd; q.push(n); } }
      if (x - 1 >= 0) { const n = id - 1; if (dist[n] < 0 && g[n] === 0) { dist[n] = nd; q.push(n); } }
      if (y + 1 < H) { const n = id + W; if (dist[n] < 0 && g[n] === 0) { dist[n] = nd; q.push(n); } }
      if (y - 1 >= 0) { const n = id - W; if (dist[n] < 0 && g[n] === 0) { dist[n] = nd; q.push(n); } }
    }
    return dist;
  }
  _updateCrusher(dt) {
    const c = this.crusher;
    c.wob += dt;
    // siklus berburu/tidur — saat tidur dia harmless (jendela aman buat pembalap)
    c.modeT -= dt;
    if (c.modeT <= 0) {
      if (c.mode === 'hunt') { c.mode = 'sleep'; c.modeT = 3.5; }
      else { c.mode = 'hunt'; c.modeT = 7; }
    }
    const hunting = c.mode === 'hunt';
    // target: pembalap hidup terdekat
    let tgt = null, td = 1e9;
    for (const u of this.units) {
      if (!u.alive) continue;
      const d = Math.hypot(u.x - c.x, u.y - c.y);
      if (d < td) { td = d; tgt = u; }
    }
    // hitung ulang peta jarak ke target tiap 0.5 dtk
    c.repath = (c.repath || 0) - dt;
    if (tgt && hunting && c.repath <= 0) {
      c.repath = 0.5;
      const ex = Math.max(0, Math.min(TC - 1, Math.floor((tgt.x - this.ax) / TILE)));
      const ey = Math.max(0, Math.min(TR - 1, Math.floor((tgt.y - this.ay) / TILE)));
      c.flow = this._bfsFrom(ex, ey);
    }
    // gerak menuruni gradien peta (mendekati target lewat labirin)
    const HUNT = hunting ? 175 : 0;
    let dx = 0, dy = 0;
    if (tgt && hunting && c.flow) {
      const W = TC, g = this.maze.grid;
      const cx = Math.max(0, Math.min(W - 1, Math.floor((c.x - this.ax) / TILE)));
      const cy = Math.max(0, Math.min(TR - 1, Math.floor((c.y - this.ay) / TILE)));
      const cur = c.flow[cy * W + cx];
      let bx = 0, by = 0, bd = cur;
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let k = 0; k < 4; k++) {
        const nx = cx + nb[k][0], ny = cy + nb[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= TR) continue;
        const nid = ny * W + nx, dd = c.flow[nid];
        if (g[nid] === 0 && dd >= 0 && (bd < 0 || dd < bd)) { bd = dd; bx = nb[k][0]; by = nb[k][1]; }
      }
      if (bd >= 0 && bd < cur) {
        dx = tileCX(this.ax, cx + bx) - c.x; dy = tileCY(this.ay, cy + by) - c.y;
      } else { dx = tgt.x - c.x; dy = tgt.y - c.y; }
    } else if (tgt) { dx = tgt.x - c.x; dy = tgt.y - c.y; }
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, 3.2 * dt);
    c.vx += ((dx / d) * HUNT - c.vx) * k;
    c.vy += ((dy / d) * HUNT - c.vy) * k;
    c.x += c.vx * dt; c.y += c.vy * dt;
    this._collideTiles(c);   // mentok dinding, tidak tembus labirin
    for (const u of this.units) {
      if (!u.alive || !hunting) continue;   // saat tidur: harmless, bisa dilewati
      const dx = u.x - c.x, dy = u.y - c.y, rr = u.r + c.r;
      if (dx * dx + dy * dy < rr * rr) {
        if (this._aliveCount() > 1) {
          this._eliminate(u, 'squashed');
        } else {
          // unit terakhir tidak bisa disingkirkan: mental keras
          const l = Math.hypot(dx, dy) || 1;
          u.vx = (dx / l) * 520; u.vy = (dy / l) * 520 - 120;
          this.shake = Math.max(this.shake, 8);
          this._explode(u.x, u.y, '#b6ff5e', 12);
        }
      }
    }
  }

  _eliminate(u, cause) {
    u.alive = false; this.dead++;
    const col = cause === 'burned' ? '#ff7b1c' : '#b6ff5e';
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 220;
      this._spawnP(u.x, u.y, Math.cos(a) * s, Math.sin(a) * s - 60,
        Math.random() < 0.4 ? u.color : col, 0.7 + Math.random() * 0.5, 4 + Math.random() * 6, 320);
    }
    this.shake = Math.max(this.shake, 9);
  }

  _finish(w, tag) {
    if (this.state === 'finished' || this.state === 'over') return;
    this.state = 'finished'; this.winner = w; this.endT = 0;
    w.mood = 'happy';
    // hujan konfeti di garis finis
    for (let i = 0; i < 90; i++) {
      const cols = ['#ffd21f', '#ff5fa2', '#22d3ee', '#a855f7', '#4ade80', '#ffffff'];
      this._spawnP(w.x + (Math.random() - 0.5) * 160, this.finY - Math.random() * 40,
        (Math.random() - 0.5) * 260, -120 - Math.random() * 200,
        cols[(Math.random() * cols.length) | 0], 1.6 + Math.random() * 1.4, 4 + Math.random() * 5, 420, true);
    }
    this.shake = Math.max(this.shake, 6);
    this.showBanner(w.name + ' WINS!', tag || this.label);
  }

  _burstText() { /* GO! kecil di canvas, digambar saat countStage==2 */ }

  /* ============ PARTIKEL ============ */
  _spawnP(x, y, vx, vy, color, life, size, grav, confetti) {
    if (this.particles.length > 450) this.particles.shift();
    this.particles.push({
      x: x, y: y, vx: vx, vy: vy, color: color,
      life: life, max: life, size: size, grav: grav || 0,
      confetti: !!confetti, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 10
    });
  }
  _explode(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 50 + Math.random() * 180;
      this._spawnP(x, y, Math.cos(a) * s, Math.sin(a) * s, color, 0.4 + Math.random() * 0.4, 3 + Math.random() * 5, 60);
    }
  }
  _splash(x, y) {
    this._spawnP(x + (Math.random() - 0.5) * 16, y + 8, (Math.random() - 0.5) * 60, -40 - Math.random() * 40,
      '#7dd3fc', 0.5, 3 + Math.random() * 3, 300);
  }
  _updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vy += p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.confetti) p.rot += p.vr * dt;
    }
  }

  /* ============ RENDER ============ */
  _renderStatic() {
    const c = this.staticLayer.getContext('2d');
    const g = this.maze.grid;
    // bingkai bata cokelat
    c.fillStyle = '#7c4a1e'; c.fillRect(this.ax - 20, this.ay - 20, TC * TILE + 40, TR * TILE + 40);
    c.strokeStyle = '#4a2a0e'; c.lineWidth = 3;
    for (let y = -20; y < TR * TILE + 20; y += 24) {
      c.beginPath(); c.moveTo(this.ax - 20, this.ay + y); c.lineTo(this.ax + TC * TILE + 20, this.ay + y); c.stroke();
    }
    for (let x = -20; x < TC * TILE + 20; x += 48) {
      c.beginPath(); c.moveTo(this.ax + x, this.ay - 20); c.lineTo(this.ax + x, this.ay + TR * TILE + 20); c.stroke();
    }
    // aksen kuning-hijau di bingkai dalam
    c.fillStyle = '#a3e635'; c.fillRect(this.ax - 8, this.ay - 8, TC * TILE + 16, 8);
    c.fillRect(this.ax - 8, this.ay + TR * TILE, TC * TILE + 16, 8);
    c.fillStyle = '#ffd21f'; c.fillRect(this.ax - 8, this.ay - 8, 8, TR * TILE + 16);
    c.fillRect(this.ax + TC * TILE, this.ay - 8, 8, TR * TILE + 16);

    for (let ty = 0; ty < TR; ty++) for (let tx = 0; tx < TC; tx++) {
      const x = this.ax + tx * TILE, y = this.ay + ty * TILE, id = ty * TC + tx;
      if (g[id] === 1) {
        // dinding ungu + highlight 3D
        c.fillStyle = '#7c3aed'; c.fillRect(x, y, TILE, TILE);
        c.fillStyle = '#a78bfa'; c.fillRect(x, y, TILE, 6); c.fillRect(x, y, 6, TILE);
        c.fillStyle = '#5b21b6'; c.fillRect(x, y + TILE - 6, TILE, 6); c.fillRect(x + TILE - 6, y, 6, TILE);
      } else if (ty <= 2) {
        // saluran start hijau
        const isCh = this.maze.channels.indexOf(tx) !== -1;
        c.fillStyle = isCh ? '#4ade80' : '#166534'; c.fillRect(x, y, TILE, TILE);
        if (isCh) {
          c.fillStyle = '#22c55e';
          c.fillRect(x + 14, y + 10, 20, 8); c.fillRect(x + 14, y + 26, 20, 8);
          c.fillStyle = '#bbf7d0';
          c.fillRect(x + 14, y + 10, 20, 3); c.fillRect(x + 14, y + 26, 20, 3);
        }
      } else if (ty === 10) {
        // finis kotak-kotak
        const s = TILE / 4;
        for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) {
          c.fillStyle = (ix + iy) % 2 ? '#111' : '#fff';
          c.fillRect(x + ix * s, y + iy * s, s, s);
        }
      } else if (ty === 9) {
        c.fillStyle = '#f7e8c3'; c.fillRect(x, y, TILE, TILE); // lintasan krem
        c.fillStyle = '#ecd9a8'; c.fillRect(x, y, TILE, 3);
      } else {
        c.fillStyle = '#ffd9e8'; c.fillRect(x, y, TILE, TILE); // jalur pink muda
        c.fillStyle = '#f9c2da';
        if ((tx + ty) % 2 === 0) c.fillRect(x, y, TILE, TILE);
      }
    }
    // nomor saluran
    c.font = 'bold 13px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    this.maze.channels.forEach((ch, i) => {
      c.fillStyle = '#052e16';
      c.fillText(String(i + 1), this.ax + ch * TILE + TILE / 2, this.ay + TILE / 2);
    });
    // pita FINISH
    const fy = this.finY;
    c.fillStyle = '#8a5a2b';
    c.fillRect(this.ax - 14, fy - 46, 14, 60); c.fillRect(this.ax + TC * TILE, fy - 46, 14, 60);
    c.fillStyle = '#ffd21f'; c.fillRect(this.ax - 14, fy - 52, TC * TILE + 28, 34);
    c.fillStyle = '#111'; c.fillRect(this.ax - 14, fy - 52, TC * TILE + 28, 4);
    c.fillRect(this.ax - 14, fy - 22, TC * TILE + 28, 4);
    c.fillStyle = '#7a4d00'; c.font = 'bold 20px "Press Start 2P", monospace';
    c.fillText('FINISH', this.ax + TC * TILE / 2, fy - 34);
  }

  _render() {
    const c = this.ctx;
    c.save();
    c.clearRect(0, 0, this.W, this.H);
    c.fillStyle = '#0a0714'; c.fillRect(0, 0, this.W, this.H);
    if (this.shake > 0.2) c.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);

    c.drawImage(this.staticLayer, 0, 0);

    // air (animasi)
    const t = performance.now() / 1000;
    for (const id of this.maze.water) {
      const tx = id % TC, ty = (id / TC) | 0;
      const x = this.ax + tx * TILE, y = this.ay + ty * TILE;
      c.fillStyle = '#38bdf8'; c.fillRect(x, y, TILE, TILE);
      c.strokeStyle = '#bae6fd'; c.lineWidth = 3;
      for (let w = 0; w < 2; w++) {
        const wy = y + 12 + w * 18 + Math.sin(t * 3 + tx + w * 2) * 3;
        c.beginPath(); c.moveTo(x + 8, wy);
        c.quadraticCurveTo(x + 16, wy - 6, x + 24, wy);
        c.quadraticCurveTo(x + 32, wy + 6, x + 40, wy); c.stroke();
      }
    }

    this._drawFireBoss(c, t);
    this._drawCrusher(c, t);

    // ---- FLOOD GATE: gerbang + air naik + counter ----
    if (this.gate && !this.gate.open) {
      const f = this.gate.fill;
      // air naik di ruang start (hanya tile jalan, baris 0..topRow)
      const chTop = this.ay, chBot = this.ay + (this.gate.topRow + 1) * TILE;
      const wlvl = chBot - (chBot - chTop) * f;   // permukaan air (y)
      const g = this.maze.grid;
      for (let ty = 0; ty <= this.gate.topRow; ty++) for (let tx = 0; tx < TC; tx++) {
        if (g[ty * TC + tx] !== 0) continue;
        const x = this.ax + tx * TILE, y = this.ay + ty * TILE;
        const top = Math.max(y, wlvl);
        if (top < y + TILE - 2) {
          c.fillStyle = 'rgba(56,189,248,.5)';
          c.fillRect(x, top, TILE, y + TILE - top);
        }
      }
      // garis permukaan berombak
      c.strokeStyle = '#bae6fd'; c.lineWidth = 3;
      c.beginPath();
      let started = false;
      for (let tx = 0; tx < TC; tx++) {
        if (g[tx] !== 0 && this.gate.topRow === 0) continue;
        const x = this.ax + tx * TILE;
        const y = wlvl + Math.sin(t * 4 + tx) * 4;
        if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y);
      }
      c.stroke();
      // gerbang: palang besi
      for (const id of this.gateTiles) {
        const tx = id % TC, ty = (id / TC) | 0;
        const x = this.ax + tx * TILE, y = this.ay + ty * TILE;
        c.fillStyle = '#3f3f46'; c.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
        c.fillStyle = '#9adcff';
        for (let b = 0; b < 3; b++) c.fillRect(x + 10 + b * 12, y + 4, 5, TILE - 8);
        c.fillStyle = '#52525b'; c.fillRect(x + 2, y + TILE / 2 - 3, TILE - 4, 6);
      }
      // counter % ala blok 3D abu-abu
      const pct = Math.floor(f * 100);
      const bw = 120, bh = 56, bx = this.W / 2 - bw / 2, by = 14;
      c.fillStyle = '#000'; c.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
      const gg = c.createLinearGradient(0, by, 0, by + bh);
      gg.addColorStop(0, '#c9ccd3'); gg.addColorStop(0.5, '#9aa0a8'); gg.addColorStop(1, '#7c818a');
      c.fillStyle = gg; c.fillRect(bx, by, bw, bh);
      c.fillStyle = '#1c1c22'; c.font = '26px "Press Start 2P", monospace';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(pct + '%', this.W / 2, by + bh / 2 + 2);
    }

    for (const u of this.units) if (u.alive) this._drawUnit(c, u, t);

    // bola api
    for (const f of this.fireballs) {
      const fl = 1 + Math.sin(t * 30) * 0.15;
      const gr = c.createRadialGradient(f.x, f.y, 2, f.x, f.y, f.r * 1.6 * fl);
      gr.addColorStop(0, '#fff7cc'); gr.addColorStop(0.45, '#ffdd44'); gr.addColorStop(1, 'rgba(255,90,20,0)');
      c.fillStyle = gr;
      c.beginPath(); c.arc(f.x, f.y, f.r * 1.6 * fl, 0, 6.283); c.fill();
      c.fillStyle = '#ff7b1c';
      c.beginPath(); c.arc(f.x, f.y, f.r * 0.7, 0, 6.283); c.fill();
    }

    // partikel
    for (const p of this.particles) {
      c.globalAlpha = Math.max(0, p.life / p.max);
      c.fillStyle = p.color;
      if (p.confetti) {
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
        c.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); c.restore();
      } else {
        c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    c.globalAlpha = 1;

    // countdown
    if (this.state === 'countdown') {
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '42px "Press Start 2P", monospace';
      const txt = this.countStage === 0 ? 'READY...' : 'GO!';
      const col = this.countStage === 0 ? '#ffd21f' : '#4ade80';
      c.lineWidth = 8; c.strokeStyle = '#000';
      const cx = this.W / 2, cy = this.H / 2;
      c.strokeText(txt, cx, cy); c.fillStyle = col; c.fillText(txt, cx, cy);
    }
    c.restore();
  }

  _drawUnit(c, u, t) {
    const x = Math.round(u.x), y = Math.round(u.y);
    const s = 34, h = 34;
    // bayangan
    c.fillStyle = 'rgba(0,0,0,.3)';
    c.beginPath(); c.ellipse(x, y + 20, 16, 6, 0, 0, 6.283); c.fill();
    // squash & stretch halus
    const sp = Math.hypot(u.vx, u.vy);
    const sq = 1 + Math.min(0.12, sp / 1600) * Math.sin(t * 14 + u.x);
    const w = s * (2 - sq) / 1, hh = h * sq;
    // badan
    c.fillStyle = '#000';
    this._rr(c, x - w / 2 - 2, y - hh / 2 - 2, w + 4, hh + 4, 7); c.fill();
    c.fillStyle = u.color;
    this._rr(c, x - w / 2, y - hh / 2, w, hh, 5); c.fill();
    c.fillStyle = 'rgba(255,255,255,.25)';
    this._rr(c, x - w / 2 + 4, y - hh / 2 + 4, w - 8, 8, 4); c.fill();
    this._face(c, x, y, u, w);
    // ikon api kalau lambat (peringatan: kena lagi = gosong!)
    if (u.mood === 'slow') {
      const fl = Math.sin(t * 20) * 2;
      c.fillStyle = '#ff7b1c';
      c.fillRect(x - 5, y - hh / 2 - 16 + fl, 10, 12);
      c.fillStyle = '#ffdd44';
      c.fillRect(x - 2, y - hh / 2 - 12 + fl, 4, 6);
    }
    // cipratan air
    if (u.inWater) {
      c.fillStyle = 'rgba(125,211,252,.8)';
      c.fillRect(x - w / 2 - 3, y + hh / 2 - 4, 6, 4);
      c.fillRect(x + w / 2 - 3, y + hh / 2 - 4, 6, 4);
    }
  }

  _face(c, x, y, u, w) {
    const blink = u.blink < 0;
    const lookX = Math.max(-2, Math.min(2, Math.round(u.vx / 90)));
    const lookY = Math.max(-1, Math.min(2, Math.round(u.vy / 120)));
    const ex = 8, ey = -5, ew = 9, eh = 11;
    const dead = !u.alive;
    const dizzy = u.mood === 'slow';
    for (const s of [-1, 1]) {
      const px = x + s * ex - ew / 2, py = y + ey - eh / 2;
      if (dead) {
        c.strokeStyle = '#111'; c.lineWidth = 3;
        c.beginPath();
        c.moveTo(px, py); c.lineTo(px + ew, py + eh);
        c.moveTo(px + ew, py); c.lineTo(px, py + eh);
        c.stroke();
      } else if (blink && !dizzy) {
        c.fillStyle = '#111'; c.fillRect(px, py + eh / 2 - 1, ew, 3);
      } else if (dizzy) {
        // mata ><
        c.strokeStyle = '#111'; c.lineWidth = 3;
        c.beginPath();
        c.moveTo(px, py); c.lineTo(px + ew, py + eh);
        c.moveTo(px + ew, py); c.lineTo(px, py + eh);
        c.stroke();
      } else {
        c.fillStyle = '#fff'; c.fillRect(px, py, ew, eh);
        c.fillStyle = '#111'; c.fillRect(px + ew / 2 - 2 + lookX, py + eh / 2 - 2 + lookY, 5, 6);
      }
    }
    // mulut
    c.fillStyle = '#111';
    if (u.mood === 'happy') {
      c.fillRect(x - 8, y + 9, 16, 4);
      c.fillRect(x - 8, y + 5, 4, 5); c.fillRect(x + 4, y + 5, 4, 5);
    } else if (dizzy || dead) {
      c.fillRect(x - 3, y + 9, 6, 6); // mulut 'o'
    } else {
      c.fillRect(x - 7, y + 10, 14, 3);
    }
  }

  _drawFireBoss(c, t) {
    this._drawOneTower(c, t, this.fireBoss, 0);
    if (this.fireBoss2) this._drawOneTower(c, t + 2.1, this.fireBoss2, 1);
  }
  _drawOneTower(c, t, b, idx) {
    const x = Math.round(b.x), y = Math.round(b.y + Math.sin(t * 2.2) * 3);
    const s = 44;
    c.fillStyle = 'rgba(0,0,0,.3)';
    c.beginPath(); c.ellipse(b.x, b.y + 26, 22, 7, 0, 0, 6.283); c.fill();
    c.fillStyle = '#000'; this._rr(c, x - s / 2 - 2, y - s / 2 - 2, s + 4, s + 4, 8); c.fill();
    const gr = c.createLinearGradient(x, y - s / 2, x, y + s / 2);
    gr.addColorStop(0, '#ff8c42'); gr.addColorStop(1, '#c22e2e');
    c.fillStyle = gr; this._rr(c, x - s / 2, y - s / 2, s, s, 6); c.fill();
    // moncong meriam ke arah bidik
    const mx = x + Math.cos(b.aimA) * (s / 2 + 6 - b.recoil * 8);
    const my = y + Math.sin(b.aimA) * (s / 2 + 6 - b.recoil * 8);
    c.save(); c.translate(x, y); c.rotate(b.aimA);
    c.fillStyle = '#5b1a1a'; c.fillRect(s / 2 - 4, -7, 18 - b.recoil * 8, 14);
    c.fillStyle = '#2b0d0d'; c.fillRect(s / 2 + 10 - b.recoil * 8, -9, 6, 18);
    c.restore();
    // wajah marah
    c.fillStyle = '#fff'; c.fillRect(x - 14, y - 10, 10, 12); c.fillRect(x + 4, y - 10, 10, 12);
    c.fillStyle = '#ffdd44';
    c.fillRect(x - 12, y - 7, 6, 7); c.fillRect(x + 6, y - 7, 6, 7);
    c.fillStyle = '#7a1010';
    c.fillRect(x - 16, y - 16, 14, 5); c.fillRect(x + 2, y - 16, 14, 5); // alis miring
    // label
    c.font = 'bold 9px monospace'; c.textAlign = 'center';
    const nm = b.name;
    c.fillStyle = '#000'; c.fillText(nm, x + 1, y - s / 2 - 7);
    c.fillStyle = '#ff9a5e'; c.fillText(nm, x, y - s / 2 - 8);
    void mx; void my;
  }

  _drawCrusher(c, t) {
    const k = this.crusher;
    const wob = Math.sin(k.wob * 6) * 0.06;
    const s = k.r * 2;
    const x = Math.round(k.x), y = Math.round(k.y);
    c.fillStyle = 'rgba(0,0,0,.35)';
    c.beginPath(); c.ellipse(x, y + k.r + 4, k.r, 10, 0, 0, 6.283); c.fill();
    c.save(); c.translate(x, y); c.rotate(wob);
    c.fillStyle = '#000'; this._rr(c, -s / 2 - 3, -s / 2 - 3, s + 6, s + 6, 10); c.fill();
    const gr = c.createLinearGradient(0, -s / 2, 0, s / 2);
    gr.addColorStop(0, '#7ddf5e'); gr.addColorStop(1, '#2f9e2f');
    c.fillStyle = gr; this._rr(c, -s / 2, -s / 2, s, s, 8); c.fill();
    c.fillStyle = 'rgba(255,255,255,.22)'; this._rr(c, -s / 2 + 7, -s / 2 + 7, s - 14, 12, 6); c.fill();
    // mata besar marah
    c.fillStyle = '#fff'; c.fillRect(-24, -16, 18, 22); c.fillRect(6, -16, 18, 22);
    c.fillStyle = '#c22e2e'; c.fillRect(-20, -10, 10, 12); c.fillRect(10, -10, 10, 12);
    c.fillStyle = '#111'; c.fillRect(-26, -26, 22, 8); c.fillRect(4, -26, 22, 8);
    // mulut bergerigi
    c.fillStyle = '#123d12';
    for (let i = 0; i < 5; i++) c.fillRect(-22 + i * 10, 12, 7, i % 2 ? 12 : 8);
    c.restore();
    c.font = 'bold 10px monospace'; c.textAlign = 'center';
    const glabel = k.mode === 'hunt' ? 'GARGANT' : 'GARGANT 💤';
    c.fillStyle = '#000'; c.fillText(glabel, x + 1, y - s / 2 - 9);
    c.fillStyle = k.mode === 'hunt' ? '#d6ffb0' : '#9db8d6'; c.fillText(glabel, x, y - s / 2 - 10);
    if (k.mode !== 'hunt') {
      // gelembung "Z" saat tidur
      const zb = Math.sin(t * 3) * 4;
      c.font = 'bold 14px monospace';
      c.fillStyle = '#cfe3ff'; c.fillText('Z', x + 30, y - 30 + zb);
      c.fillStyle = '#8fb4dd'; c.fillText('Z', x + 42, y - 44 - zb);
    }
  }

  _rr(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else c.rect(x, y, w, h);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Race, STEP, BASE_SPEED, HEAT_TIMEOUT };
}
