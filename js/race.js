'use strict';
/* Satu heat balapan: arena TERBUKA top-down, gerakan chaos ala kelereng
 * (marble-race), boss api pemburu, kill feed, flood gate.
 * TIDAK ada pathfinding — pembalap wander + momentum + pantul dinding. */
const STEP = 1 / 120;          // fixed timestep fisika
const BASE_SPEED = 100;        // px/detik — lincah, kelihatan balapan (jangan terlalu cepat!)
const BOSS_SPEED = 104;        // boss seimbang dengan pembalap -> tetap mengancam
const HEAT_TIMEOUT = 150;      // detik sim; habis -> pemenang = yg terdekat finis

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
    // cermin banner ke canvas: banner DOM tidak ikut terekam MediaRecorder,
    // jadi teks banner digambar juga di canvas selama 2.6 dtk
    this.canvasBanner = null;
    const _domBanner = this.showBanner;
    this.showBanner = (m, s) => {
      this.canvasBanner = { main: m, sub: s || '', until: performance.now() + 2600 };
      _domBanner(m, s);
    };

    // arena acak (20x12 tile, TILE=48 -> 960x576, pas canvas 960x600)
    this.arena = genArena();
    const AW = this.arena.W, AH = this.arena.H;
    this.ax = (this.W - AW * TILE) / 2;   // 0
    this.ay = (this.H - AH * TILE) / 2;   // 12
    // titik tengah zona finis (untuk bias target & penentu leader)
    let ffx = 0, ffy = 0;
    for (const f of this.arena.finish) { ffx += f % AW; ffy += (f / AW) | 0; }
    ffx /= this.arena.finish.length; ffy /= this.arena.finish.length;
    this.finCX = this.ax + ffx * TILE + TILE / 2;
    this.finCY = this.ay + ffy * TILE + TILE / 2;
    this.finishSet = new Set(this.arena.finish);
    // daftar tile jalan (untuk target acak)
    this.floorTiles = [];
    for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++)
      if (this.arena.grid[y * AW + x] === 0) this.floorTiles.push(y * AW + x);
    // tile jalan di LUAR kandang spawn — target acak tidak boleh di kandang
    // (biar pembalap tidak balik arah ke bawah setelah keluar)
    let penTop = AH;
    for (const s of this.arena.spawns) penTop = Math.min(penTop, (s / AW) | 0);
    this.openTiles = this.floorTiles.filter((t) => ((t / AW) | 0) < penTop);
    if (!this.openTiles.length) this.openTiles = this.floorTiles;

    // --- FLOOD GATE: gerbang G disegel saat gate-mode; buka saat meteran penuh ---
    this.gateMode = opts.gate !== undefined ? opts.gate : Math.random() < 0.35;
    this.gateTiles = this.arena.gates.slice();
    this.gate = null;
    if (this.gateMode && this.gateTiles.length > 0) {
      for (const t of this.gateTiles) this.arena.grid[t] = 2;
      this.gate = { fill: 0, open: false, rate: 1 / 9 };
    } else this.gateMode = false;

    // --- unit balap: spawn di tile S ---
    const sp = this.arena.spawns;
    this.units = racers.map((r, k) => {
      const s = sp[k % sp.length];
      const sx = tileCX(this.ax, s % AW), sy = tileCY(this.ay, (s / AW) | 0);
      return {
        name: r.name, color: r.color, dark: r.dark,
        x: sx + (Math.random() - 0.5) * 20, y: sy + (Math.random() - 0.5) * 20,
        vx: 0, vy: 0, r: 18,
        skill: 0.92 + Math.random() * 0.16,
        wtx: sx, wty: sy, retarget: Math.random() * 2,
        stuckT: 0, lastPX: 0, lastPY: 0,
        burnT: 0, alive: true, mood: 'normal',
        blink: 2 + Math.random() * 3, inWater: false
      };
    });

    // --- BOSS: kotak api oranye, berkeliaran + memburu ---
    // semifinal/final -> 2 boss di posisi beda
    const nBoss = /SEMIFINAL|FINAL/.test(label || '') ? 2 : 1;
    this.bosses = [];
    for (let i = 0; i < nBoss; i++) {
      const bp = this._bossSpawn(i);
      this.bosses.push({
        x: bp.x, y: bp.y, vx: 0, vy: 0, r: 26,
        wob: Math.random() * 6, wtx: bp.x, wty: bp.y,
        retarget: 1 + Math.random() * 2, chaseT: 0, restT: 0, name: 'GARGANT'
      });
    }

    this.particles = [];
    this.feed = [];        // kill feed: {text, t}
    this.xmarks = [];      // X permanen: {x, y, color}
    this.state = 'countdown';
    this.countT = 0; this.countStage = 0;
    this.time = 0;
    this.shake = 0;
    this.winner = null;
    this.endT = 0;
    this.acc = 0; this.last = 0; this.raf = 0;
    this.dead = 0;
    this.lastDead = null;
    this._otShown = false;

    this.staticLayer = document.createElement('canvas');
    this.staticLayer.width = this.W; this.staticLayer.height = this.H;
    this._renderStatic();
  }

  /* posisi spawn boss: tile jalan acak, jauh dari kandang spawn */
  _bossSpawn(i) {
    const AW = this.arena.W, g = this.arena.grid;
    const pen = new Set(this.arena.spawns);
    for (let tries = 0; tries < 200; tries++) {
      const t = this.floorTiles[(Math.random() * this.floorTiles.length) | 0];
      const tx = t % AW, ty = (t / AW) | 0;
      if (pen.has(t)) continue;
      if (ty >= 8) continue;                 // jangan di dekat kandang
      if (this.finishSet.has(t)) continue;   // jangan di garis finis
      const x = tileCX(this.ax, tx), y = tileCY(this.ay, ty);
      let ok = true;
      for (const b of this.bosses)
        if (Math.hypot(b.x - x, b.y - y) < 300) { ok = false; break; }
      if (ok || tries > 150) return { x: x, y: y };
    }
    const t = this.floorTiles[(Math.random() * this.floorTiles.length) | 0];
    return { x: tileCX(this.ax, t % AW), y: tileCY(this.ay, (t / AW) | 0) };
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

  /* SFX aman: no-op kalau modul Sfx tidak ada (mis. saat test node) */
  _sfx(name) { try { if (typeof Sfx !== 'undefined') Sfx.play(name); } catch (e) {} }

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
        if (stage === 2) { this.state = 'running'; this._burstText(); this._sfx('go'); }
      }
      return;
    }
    if (this.state !== 'running') {
      if (this.state === 'finished') {
        this.endT += dt;
        for (const b of this.bosses) b.wob += dt;
        if (this.endT > 2.6) { this.state = 'over'; this.onDone(this.winner); }
      }
      return;
    }

    this.time += dt;
    if (this.time > HEAT_TIMEOUT) { this._finish(this._leader(), 'TIME UP ⏱'); return; }
    if (!this._otShown && this.time > 75) {
      this._otShown = true;
      this.showBanner('OVERTIME!', 'gaspol ke finis!');
    }

    for (const u of this.units) if (u.alive) this._updateUnit(u, dt);
    this._collidePairs();
    this._updateBosses(dt);

    // flood gate: isi meteran, penuh -> dinding kebuka!
    if (this.gate && !this.gate.open) {
      this.gate.fill += dt * this.gate.rate;
      if (this.gate.fill >= 1) {
        this.gate.fill = 1; this.gate.open = true;
        for (const t of this.gateTiles) this.arena.grid[t] = 0;
        this.showBanner('GATE OPEN!', 'gaspol!');
        this.shake = Math.max(this.shake, 10);
        this._sfx('gate');
        for (const t of this.gateTiles) {
          const gx = tileCX(this.ax, t % this.arena.W), gy = tileCY(this.ay, (t / this.arena.W) | 0);
          this._explode(gx, gy, '#9adcff', 18);
        }
      }
    }

    // cek survival: tinggal 1 yang hidup -> menang
    const aliveN = this._aliveCount();
    if (aliveN === 1) {
      const s = this.units.find((u) => u.alive);
      this._finish(s, 'SURVIVOR!'); return;
    }
    if (aliveN === 0) { this._finish(this.lastDead || this.units[0], 'SURVIVOR!'); return; }

    // cek finis: sentuh zona F (tile atau dekat pusat finis — buat chaos yg susah presisi)
    for (const u of this.units) {
      if (!u.alive) continue;
      const t = this._tileAt(u.x, u.y);
      const onTile = t >= 0 && this.finishSet.has(t);
      const nearFin = Math.hypot(u.x - this.finCX, u.y - this.finCY) < 44;
      if (onTile || nearFin) { this._finish(u, null); return; }
    }
  }

  _tileAt(px, py) {
    const AW = this.arena.W, AH = this.arena.H;
    const tx = Math.floor((px - this.ax) / TILE), ty = Math.floor((py - this.ay) / TILE);
    if (tx < 0 || ty < 0 || tx >= AW || ty >= AH) return -2;
    return ty * AW + tx;
  }
  _solidAt(px, py) {
    const t = this._tileAt(px, py);
    return t === -2 || this.arena.grid[t] !== 0;
  }

  /* ============ GERAKAN PEMBALAP (marble chaos) ============
   * Tidak ada pathfinding. Tiap pembalap punya titik target:
   * 70% titik acak di arena, 30% bias ke zona finis.
   * Gerak = akselerasi lembut (momentum) + pantul dinding.
   * Panik kalau boss dekat -> kabur menjauhi boss. */
  _pickTarget(u) {
    u.retarget = 2.5 + Math.random() * 2;
    // arena terbuka: sejak awal mayoritas target = finis (kelihatan balapan, bukan ngider).
    // makin lama heat berjalan, makin kuat diarahkan ke finis (biar tidak molor)
    // overtime (>75 dtk): hampir pasti ke finis -> heat dijamin selesai
    const biasP = this.time > 75 ? 0.97 : (this.time > 40 ? 0.9 : 0.8);
    if (Math.random() < biasP) {
      // bias ke finis: titik acak di sekitar zona finis
      u.wtx = this.finCX + (Math.random() - 0.5) * 3 * TILE;
      u.wty = this.finCY + Math.random() * 1.5 * TILE;
    } else {
      const pool = this.openTiles;
      const t = pool[(Math.random() * pool.length) | 0];
      u.wtx = tileCX(this.ax, t % this.arena.W);
      u.wty = tileCY(this.ay, (t / this.arena.W) | 0);
    }
  }

  _updateUnit(u, dt) {
    // terbakar: hitung mundur 1 detik -> mati (masih bisa gerak panik!)
    if (u.burnT > 0) {
      u.burnT -= dt;
      if (Math.random() < dt * 30) {
        this._spawnP(u.x + (Math.random() - 0.5) * 22, u.y + (Math.random() - 0.5) * 22,
          (Math.random() - 0.5) * 60, -60 - Math.random() * 60,
          Math.random() < 0.5 ? '#ff7b1c' : '#ffdd44', 0.5, 5 + Math.random() * 5, -80);
      }
      if (u.burnT <= 0) { this._killBurn(u); return; }
    }

    // panik: boss dekat (<120px) -> kabur menjauhinya
    let pdx = 0, pdy = 0, panic = false;
    for (const b of this.bosses) {
      const dx = u.x - b.x, dy = u.y - b.y, d = Math.hypot(dx, dy);
      if (d < 120 && d > 0.001) { panic = true; pdx += dx / d; pdy += dy / d; }
    }
    // pemutus loop panik: panik terus >4 dtk -> dash acak (biar tidak osilasi di tempat)
    if (panic) {
      u.panicT = (u.panicT || 0) + dt;
      if (u.panicT > 4) {
        u.panicT = 0;
        this._pickTarget(u);
        const pa = Math.random() * 6.283;
        u.vx = Math.cos(pa) * 380; u.vy = Math.sin(pa) * 380;
      }
    } else u.panicT = 0;

    // target baru kalau sudah sampai / waktu habis
    u.retarget -= dt;
    const tdx = u.wtx - u.x, tdy = u.wty - u.y;
    // endgame lock: kalau sudah dekat finis, kunci target ke finis (jangan osilasi)
    const distFin = Math.hypot(u.x - this.finCX, u.y - this.finCY);
    if (distFin < 280) {
      u.wtx = this.finCX; u.wty = this.finCY;
      u.retarget = 0.5;
    } else if (u.retarget <= 0 || Math.hypot(tdx, tdy) < 36) this._pickTarget(u);

    let dx = u.wtx - u.x, dy = u.wty - u.y;
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    if (panic) {
      const pl = Math.hypot(pdx, pdy) || 1;
      dx = dx * 0.3 + (pdx / pl) * 0.7;
      dy = dy * 0.3 + (pdy / pl) * 0.7;
      const nl = Math.hypot(dx, dy) || 1; dx /= nl; dy /= nl;
    }

    // susur dinding: kalau depan padat, geser sepanjang sumbu yang bebas
    // (biar bisa muterin ujung dinding, tidak nempel terus)
    const probeX = u.x + dx * 36, probeY = u.y + dy * 36;
    if (this._solidAt(probeX, probeY)) {
      const bx = this._solidAt(u.x + (dx >= 0 ? 36 : -36), u.y);
      const by = this._solidAt(u.x, u.y + (dy >= 0 ? 36 : -36));
      if (bx && !by) { dx = 0; dy = dy >= 0 ? 1 : -1; }
      else if (by && !bx) { dy = 0; dx = dx >= 0 ? 1 : -1; }
      else if (bx && by) {
        // pojok: pilih sumbu yg lebih sejajar arah target
        if (Math.abs(dx) > Math.abs(dy)) { dy = 0; dx = dx >= 0 ? 1 : -1; }
        else { dx = 0; dy = dy >= 0 ? 1 : -1; }
      } else {
        // graze diagonal: pilih sisi yg lebih dekat ke target
        const lx = -dy, ly = dx, rx = dy, ry = -dx;
        const gx = u.wtx - u.x, gy = u.wty - u.y;
        const s = (gx * lx + gy * ly) > (gx * rx + gy * ry);
        const sx = s ? lx : rx, sy = s ? ly : ry;
        dx = dx * 0.25 + sx * 0.75; dy = dy * 0.25 + sy * 0.75;
      }
      const nl = Math.hypot(dx, dy) || 1; dx /= nl; dy /= nl;
    }

    // kecepatan santai; panik & terbakar lebih ngebut; overtime ngebut ke finis
    let sp = BASE_SPEED * u.skill;
    const tid = this._tileAt(u.x, u.y);
    u.inWater = tid >= 0 && this.arena.water.has(tid);
    if (u.inWater) { sp *= 0.55; if (Math.random() < dt * 8) this._splash(u.x, u.y); }
    if (panic) sp *= 1.25;
    if (u.burnT > 0) sp *= 1.4;
    if (this.time > 75) sp *= 1.3;   // overtime
    u.mood = 'normal';

    // momentum ala kelereng: akselerasi lembut -> meluncur lurus, belok malas
    const k = Math.min(1, 3 * dt);
    u.vx += (dx * sp - u.vx) * k;
    u.vy += (dy * sp - u.vy) * k;
    u.x += u.vx * dt; u.y += u.vy * dt;

    this._collideTiles(u);   // memantul di dinding

    // anti-stuck sederhana: kalau 2.5 dtk cuma gerak <10px, tendang acak
    u.stuckT = (u.stuckT || 0) + dt;
    if (u.stuckT > 2.5) {
      u.stuckT = 0;
      const moved = Math.hypot(u.x - (u.lastPX || u.x), u.y - (u.lastPY || u.y));
      u.lastPX = u.x; u.lastPY = u.y;
      if (moved < 10) {
        this._pickTarget(u);
        const a = Math.random() * 6.283;
        u.vx = Math.cos(a) * 320; u.vy = Math.sin(a) * 320;
      }
    }

    u.blink -= dt;
    if (u.blink < -0.12) u.blink = 2 + Math.random() * 3;
  }

  /* ============ BOSS API (GARGANT) ============
   * Kotak oranye berkeliaran; kejar pembalap terdekat dalam 350px.
   * Sentuh -> bakar 1 detik -> mati (X permanen + kill feed). */
  _updateBosses(dt) {
    for (const b of this.bosses) {
      b.wob += dt;
      // target: pembalap hidup terdekat — tapi saat overtime boss tidak mengejar
      let tgt = null, td = 1e9;
      const overtime = this.time > 75;
      if (!overtime) {
        for (const u of this.units) {
          if (!u.alive) continue;
          const d = Math.hypot(u.x - b.x, u.y - b.y);
          if (d < td) { td = d; tgt = u; }
        }
      }
      if (tgt && td < 350 && b.restT <= 0) {
        // kejar! tapi maksimal 7 detik, lalu menyerah & istirahat 4 detik
        // (biar tidak eternal chase -> heat macet)
        if (b.chaseT <= 0) b.chaseT = 7;
        b.wtx = tgt.x; b.wty = tgt.y;
        b.chaseT -= dt;
        if (b.chaseT <= 0) { b.chaseT = 0; b.restT = 4; }
      } else {
        b.retarget -= dt;
        if (b.retarget <= 0) {                                 // berkeliaran
          b.retarget = 3 + Math.random() * 2;
          const t = this.floorTiles[(Math.random() * this.floorTiles.length) | 0];
          b.wtx = tileCX(this.ax, t % this.arena.W);
          b.wty = tileCY(this.ay, (t / this.arena.W) | 0);
        }
      }
      b.restT = Math.max(0, b.restT - dt);
      // gerak lurus + pantul dinding
      const dx = b.wtx - b.x, dy = b.wty - b.y, d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, 2.5 * dt);
      b.vx += ((dx / d) * BOSS_SPEED - b.vx) * k;
      b.vy += ((dy / d) * BOSS_SPEED - b.vy) * k;
      b.x += b.vx * dt; b.y += b.vy * dt;
      this._collideTiles(b);
      // sentuh pembalap -> bakar!
      for (const u of this.units) {
        if (!u.alive || u.burnT > 0) continue;
        const ox = u.x - b.x, oy = u.y - b.y, rr = u.r + b.r;
        if (ox * ox + oy * oy < rr * rr) {
          u.burnT = 1.0;
          this._explode(u.x, u.y, '#ff7b1c', 10);
          this.shake = Math.max(this.shake, 6);
          this._sfx('burn');
        }
      }
    }
  }

  _killBurn(u) {
    u.alive = false; u.burnT = 0; this.dead++;
    this.lastDead = u;
    this.xmarks.push({ x: u.x, y: u.y, color: u.color });
    this.feed.push({ text: '🔥 ' + u.name + ' gosong!', t: this.time });
    if (this.feed.length > 8) this.feed.shift();
    this._explode(u.x, u.y, '#ff7b1c', 24);
    this._explode(u.x, u.y, u.color, 12);
    this.shake = Math.max(this.shake, 9);
  }

  _collideTiles(e) {
    const AW = this.arena.W, AH = this.arena.H;
    const r = e.r, g = this.arena.grid;
    const x0 = Math.max(0, Math.floor((e.x - r - this.ax) / TILE));
    const x1 = Math.min(AW - 1, Math.floor((e.x + r - this.ax) / TILE));
    const y0 = Math.max(0, Math.floor((e.y - r - this.ay) / TILE));
    const y1 = Math.min(AH - 1, Math.floor((e.y + r - this.ay) / TILE));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      if (g[ty * AW + tx] === 0) continue;   // 1 = dinding, 2 = gerbang terkunci
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
      if (vn < 0) {
        e.vx -= 1.55 * vn * ux; e.vy -= 1.55 * vn * uy;
        // SFX pantulan: benturan keras + throttle
        if (vn < -140 && this.time - (this._lastBounceSfx || -9) > 0.12) {
          this._lastBounceSfx = this.time;
          this._sfx('bounce');
        }
      }
    }
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

  /* leader = yg terdekat ke zona finis (untuk skip & time-up) */
  _leader() {
    let bu = null, bd = 1e9;
    for (const u of this.units) {
      if (!u.alive) continue;
      const d = Math.hypot(u.x - this.finCX, u.y - this.finCY);
      if (d < bd) { bd = d; bu = u; }
    }
    return bu || this.units[0];
  }
  _aliveCount() { let n = 0; for (const u of this.units) if (u.alive) n++; return n; }

  _finish(w, tag) {
    if (this.state === 'finished' || this.state === 'over') return;
    this.state = 'finished'; this.winner = w; this.endT = 0;
    w.mood = 'happy';
    // hujan konfeti di zona finis
    for (let i = 0; i < 90; i++) {
      const cols = ['#ffd21f', '#ff5fa2', '#22d3ee', '#a855f7', '#4ade80', '#ffffff'];
      this._spawnP(this.finCX + (Math.random() - 0.5) * 160, this.finCY + Math.random() * 60,
        (Math.random() - 0.5) * 260, -120 - Math.random() * 200,
        cols[(Math.random() * cols.length) | 0], 1.6 + Math.random() * 1.4, 4 + Math.random() * 5, 420, true);
    }
    this.shake = Math.max(this.shake, 6);
    this.showBanner(w.name + ' WINS!', tag || this.label);
    this._sfx('win');
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
    const AW = this.arena.W, AH = this.arena.H, g = this.arena.grid;
    // bingkai bata cokelat
    c.fillStyle = '#7c4a1e'; c.fillRect(this.ax - 20, this.ay - 20, AW * TILE + 40, AH * TILE + 40);
    c.strokeStyle = '#4a2a0e'; c.lineWidth = 3;
    for (let y = -20; y < AH * TILE + 20; y += 24) {
      c.beginPath(); c.moveTo(this.ax - 20, this.ay + y); c.lineTo(this.ax + AW * TILE + 20, this.ay + y); c.stroke();
    }
    for (let x = -20; x < AW * TILE + 20; x += 48) {
      c.beginPath(); c.moveTo(this.ax + x, this.ay - 20); c.lineTo(this.ax + x, this.ay + AH * TILE + 20); c.stroke();
    }
    // aksen kuning-hijau di bingkai dalam
    c.fillStyle = '#a3e635'; c.fillRect(this.ax - 8, this.ay - 8, AW * TILE + 16, 8);
    c.fillRect(this.ax - 8, this.ay + AH * TILE, AW * TILE + 16, 8);
    c.fillStyle = '#ffd21f'; c.fillRect(this.ax - 8, this.ay - 8, 8, AH * TILE + 16);
    c.fillRect(this.ax + AW * TILE, this.ay - 8, 8, AH * TILE + 16);

    for (let ty = 0; ty < AH; ty++) for (let tx = 0; tx < AW; tx++) {
      const x = this.ax + tx * TILE, y = this.ay + ty * TILE, id = ty * AW + tx;
      if (g[id] === 1) {
        // dinding ungu + highlight 3D
        c.fillStyle = '#7c3aed'; c.fillRect(x, y, TILE, TILE);
        c.fillStyle = '#a78bfa'; c.fillRect(x, y, TILE, 6); c.fillRect(x, y, 6, TILE);
        c.fillStyle = '#5b21b6'; c.fillRect(x, y + TILE - 6, TILE, 6); c.fillRect(x + TILE - 6, y, 6, TILE);
      } else {
        // lantai pink muda / krem (papan catur halus)
        c.fillStyle = (tx + ty) % 2 === 0 ? '#ffd9e8' : '#f7e8c3';
        c.fillRect(x, y, TILE, TILE);
      }
      if (this.arena.water.has(id)) {
        c.fillStyle = 'rgba(56,189,248,.35)'; c.fillRect(x, y, TILE, TILE);
      }
      if (this.finishSet.has(id)) {
        // zona finis kotak-kotak
        const s = TILE / 4;
        for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) {
          c.fillStyle = (ix + iy) % 2 ? '#111' : '#fff';
          c.fillRect(x + ix * s, y + iy * s, s, s);
        }
      }
    }
    // area spawn: tint hijau
    c.fillStyle = 'rgba(74,222,128,.30)';
    for (const s of this.arena.spawns) {
      const tx = s % AW, ty = (s / AW) | 0;
      c.fillRect(this.ax + tx * TILE, this.ay + ty * TILE, TILE, TILE);
    }
  }

  _render() {
    const c = this.ctx;
    c.save();
    c.clearRect(0, 0, this.W, this.H);
    c.fillStyle = '#0a0714'; c.fillRect(0, 0, this.W, this.H);
    if (this.shake > 0.2) c.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);

    c.drawImage(this.staticLayer, 0, 0);
    const t = performance.now() / 1000;
    const AW = this.arena.W;

    // air animasi (zona lambat)
    for (const id of this.arena.water) {
      const tx = id % AW, ty = (id / AW) | 0;
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

    // X permanen (korban boss)
    for (const m of this.xmarks) {
      c.strokeStyle = 'rgba(25,12,12,.8)'; c.lineWidth = 7; c.lineCap = 'round';
      c.beginPath();
      c.moveTo(m.x - 13, m.y - 13); c.lineTo(m.x + 13, m.y + 13);
      c.moveTo(m.x + 13, m.y - 13); c.lineTo(m.x - 13, m.y + 13);
      c.stroke();
      c.lineCap = 'butt';
    }

    // boss
    for (const b of this.bosses) this._drawBoss(c, t, b);

    // ---- FLOOD GATE: gerbang + air naik + counter ----
    if (this.gate && !this.gate.open) {
      const f = this.gate.fill, g = this.arena.grid;
      // air naik di kandang spawn (baris 9-10, hanya tile jalan)
      let top = 9, bot = 10;
      const chTop = this.ay + top * TILE, chBot = this.ay + (bot + 1) * TILE;
      const wlvl = chBot - (chBot - chTop) * f;
      for (let ty = top; ty <= bot; ty++) for (let tx = 0; tx < AW; tx++) {
        if (g[ty * AW + tx] !== 0) continue;
        const x = this.ax + tx * TILE, y = this.ay + ty * TILE;
        const wtop = Math.max(y, wlvl);
        if (wtop < y + TILE - 2) {
          c.fillStyle = 'rgba(56,189,248,.5)';
          c.fillRect(x, wtop, TILE, y + TILE - wtop);
        }
      }
      c.strokeStyle = '#bae6fd'; c.lineWidth = 3;
      c.beginPath();
      let started = false;
      for (let tx = 0; tx < AW; tx++) {
        const x = this.ax + tx * TILE, y = wlvl + Math.sin(t * 4 + tx) * 4;
        if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y);
      }
      c.stroke();
      // gerbang: palang besi
      for (const id of this.gateTiles) {
        const tx = id % AW, ty = (id / AW) | 0;
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

    // hantu pembalap
    for (const u of this.units) if (u.alive) this._drawUnit(c, u, t);

    // label ronde kiri atas (ala video)
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.font = 'bold 16px monospace';
    c.fillStyle = '#000'; c.fillText(this.label, 17, 37);
    c.fillStyle = '#fff'; c.fillText(this.label, 16, 36);

    // kill feed kanan atas
    c.textAlign = 'right'; c.textBaseline = 'alphabetic';
    c.font = 'bold 14px monospace';
    let fy = 34, shown = 0;
    for (let i = this.feed.length - 1; i >= 0 && shown < 4; i--) {
      const fe = this.feed[i], age = this.time - fe.t;
      if (age > 5) continue;
      c.globalAlpha = age < 3 ? 1 : Math.max(0, 1 - (age - 3) / 2);
      c.fillStyle = '#000'; c.fillText(fe.text, this.W - 16 + 1, fy + 1);
      c.fillStyle = '#ffb3ab'; c.fillText(fe.text, this.W - 16, fy);
      fy += 24; shown++;
    }
    c.globalAlpha = 1;

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

    // banner cermin (masuk ke rekaman video)
    const cb = this.canvasBanner;
    if (cb && performance.now() < cb.until) {
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const cx = this.W / 2, cy = this.H / 2 - 24;
      c.lineJoin = 'round';
      c.font = '46px "Press Start 2P", monospace';
      c.lineWidth = 10; c.strokeStyle = '#000';
      c.strokeText(cb.main, cx, cy);
      c.fillStyle = '#fff'; c.fillText(cb.main, cx, cy);
      if (cb.sub) {
        c.font = '18px "Press Start 2P", monospace';
        c.lineWidth = 6;
        c.strokeText(cb.sub, cx, cy + 52);
        c.fillText(cb.sub, cx, cy + 52);
      }
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    }
    c.restore();
  }

  /* Hantu ala Pac-Man: badan rounded, bawah bergerigi, 2 mata. */
  _drawUnit(c, u, t) {
    const x = Math.round(u.x), y = Math.round(u.y);
    const w = 44, h = 54;
    // bayangan
    c.fillStyle = 'rgba(0,0,0,.3)';
    c.beginPath(); c.ellipse(x, y + 28, 19, 7, 0, 0, 6.283); c.fill();
    // melayang halus
    const bob = Math.sin(t * 9 + u.x * 0.05) * 2.5;
    const top = y - h / 2 + bob, bot = y + h / 2 + bob;
    const domeY = top + w / 2;
    // path badan
    const bodyPath = () => {
      c.beginPath();
      c.moveTo(x - w / 2, bot);
      const waves = 4, ww = w / waves;
      for (let i = 0; i < waves; i++) {
        const x0 = x - w / 2 + i * ww;
        c.lineTo(x0 + ww / 2, bot - 9 + Math.sin(t * 12 + i * 1.7) * 2);
        c.lineTo(x0 + ww, bot);
      }
      c.lineTo(x + w / 2, domeY);
      c.arc(x, domeY, w / 2, 0, Math.PI, true);   // kubah atas
      c.closePath();
    };
    bodyPath();
    c.fillStyle = '#111'; c.fill();               // alas gelap
    // badan warna (sedikit lebih kecil via clip manual: gambar ulang path)
    c.save();
    c.translate(0, 0);
    bodyPath();
    c.clip();
    const gr = c.createLinearGradient(0, top, 0, bot);
    gr.addColorStop(0, u.color); gr.addColorStop(1, u.dark);
    c.fillStyle = gr;
    c.fillRect(x - w / 2 - 3, top - 3, w + 6, h + 6);
    // highlight
    c.fillStyle = 'rgba(255,255,255,.25)';
    c.fillRect(x - w / 2 + 5, top + 6, 7, h - 16);
    c.restore();
    // outline
    bodyPath();
    c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.55)'; c.stroke();

    // mata (ngikut arah gerak)
    const lookX = Math.max(-2, Math.min(2, u.vx / 90));
    const lookY = Math.max(-1, Math.min(2, u.vy / 120));
    for (const s of [-1, 1]) {
      const ex = x + s * 8.5, ey = top + 16;
      c.fillStyle = '#fff';
      c.beginPath(); c.ellipse(ex + lookX, ey + lookY, 6, 7.5, 0, 0, 6.283); c.fill();
      c.fillStyle = '#2430ff';
      c.beginPath(); c.arc(ex + lookX * 1.6, ey + lookY * 1.6 + 1.5, 3, 0, 6.283); c.fill();
    }
    // senyum kalau menang
    if (u.mood === 'happy') {
      c.strokeStyle = '#111'; c.lineWidth = 3;
      c.beginPath(); c.arc(x, top + 26, 7, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
    }
    // api kalau terbakar
    if (u.burnT > 0) {
      const fl = Math.sin(t * 25) * 3;
      for (let i = 0; i < 3; i++) {
        c.fillStyle = i % 2 ? '#ffdd44' : '#ff7b1c';
        const fx = x - 13 + i * 13 + Math.sin(t * 20 + i * 2) * 3;
        c.beginPath();
        c.moveTo(fx - 5, top + 2 + fl);
        c.lineTo(fx, top - 12 + fl);
        c.lineTo(fx + 5, top + 2 + fl);
        c.closePath(); c.fill();
      }
    }
    // cipratan air
    if (u.inWater) {
      c.fillStyle = 'rgba(125,211,252,.8)';
      c.fillRect(x - w / 2 - 3, bot - 6, 6, 4);
      c.fillRect(x + w / 2 - 3, bot - 6, 6, 4);
    }
  }

  /* Boss: kotak api oranye */
  _drawBoss(c, t, b) {
    const x = Math.round(b.x), y = Math.round(b.y);
    const s = b.r * 2;
    c.fillStyle = 'rgba(0,0,0,.35)';
    c.beginPath(); c.ellipse(x, y + b.r + 5, b.r, 10, 0, 0, 6.283); c.fill();
    const wob = Math.sin(b.wob * 5) * 0.05;
    c.save(); c.translate(x, y); c.rotate(wob);
    c.fillStyle = '#000'; this._rr(c, -s / 2 - 3, -s / 2 - 3, s + 6, s + 6, 10); c.fill();
    const gr = c.createLinearGradient(0, -s / 2, 0, s / 2);
    gr.addColorStop(0, '#ffb14a'); gr.addColorStop(0.55, '#ff7b1c'); gr.addColorStop(1, '#c22e2e');
    c.fillStyle = gr; this._rr(c, -s / 2, -s / 2, s, s, 8); c.fill();
    // lidah api di atas kepala
    for (let i = 0; i < 3; i++) {
      const fx = -s / 4 + i * s / 4, fh = 10 + Math.sin(t * 18 + i * 2.1) * 5;
      c.fillStyle = i % 2 ? '#ffdd44' : '#ff7b1c';
      c.beginPath();
      c.moveTo(fx - 6, -s / 2 + 2); c.lineTo(fx, -s / 2 - fh); c.lineTo(fx + 6, -s / 2 + 2);
      c.closePath(); c.fill();
    }
    // mata marah
    c.fillStyle = '#fff'; c.fillRect(-20, -14, 15, 18); c.fillRect(5, -14, 15, 18);
    c.fillStyle = '#ffdd44';
    c.fillRect(-17, -9, 9, 10); c.fillRect(8, -9, 9, 10);
    c.fillStyle = '#7a1010';
    c.fillRect(-22, -22, 17, 6); c.fillRect(5, -22, 17, 6);   // alis miring
    // mulut bergerigi
    c.fillStyle = '#4a0d0d';
    for (let i = 0; i < 4; i++) c.fillRect(-18 + i * 10, 10, 7, i % 2 ? 11 : 7);
    c.restore();
    c.font = 'bold 10px monospace'; c.textAlign = 'center';
    c.fillStyle = '#000'; c.fillText('GARGANT', x + 1, y - s / 2 - 9);
    c.fillStyle = '#ff9a5e'; c.fillText('GARGANT', x, y - s / 2 - 10);
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
