'use strict';
/* Alur turnamen: braket -> heat -> braket -> ... -> juara. */

const RACERS = [
  { name: 'ORNY',  color: '#ff8c1a', dark: '#b35c00' },
  { name: 'BLUB',  color: '#2f7bff', dark: '#1a4fb0' },
  { name: 'CYAN',  color: '#22d3ee', dark: '#0e7d94' },
  { name: 'TEALO', color: '#14b8a6', dark: '#0b6b5e' },
  { name: 'GREN',  color: '#4ade80', dark: '#239a4c' },
  { name: 'PINKY', color: '#ff5fa2', dark: '#b03268' },
  { name: 'PURP',  color: '#a855f7', dark: '#6d28b8' },
  { name: 'REDY',  color: '#ef2d2d', dark: '#a31313' },
  { name: 'YELLO', color: '#ffd21f', dark: '#b3900a' },
  { name: 'CHOCO', color: '#a16207', dark: '#6b4004' },
  { name: 'SHADY', color: '#3b3b46', dark: '#17171c' },
  { name: 'FROST', color: '#f1f5f9', dark: '#9aa7b5' },
  { name: 'LIMO',  color: '#a3e635', dark: '#64940f' },
  { name: 'MAGY',  color: '#e041d8', dark: '#96208f' },
  { name: 'NAVY',  color: '#3b5bdb', dark: '#22377e' },
  { name: 'CORAL', color: '#ff6b4a', dark: '#b23a22' },
];

const T = {
  groups: null, w: {}, heatIdx: 0, heats: [],
  race: null, speed: 1, running: false, champConfetti: null,
};

const $ = (id) => document.getElementById(id);
const cv = $('game'), banner = $('banner');

function chipHTML(r, extra) {
  return '<div class="chip ' + (extra || '') + '" style="--c:' + r.color + '">' +
    '<span class="sq"></span><span class="nm">' + r.name + '</span></div>';
}
function slotHTML(id, r) {
  return '<div class="wslot" id="' + id + '">' + (r ? chipHTML(r, 'win') : '?') + '</div>';
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function newTournament() {
  const s = shuffle(RACERS);
  T.groups = { A: s.slice(0, 4), B: s.slice(4, 8), C: s.slice(8, 12), D: s.slice(12, 16) };
  T.w = {}; T.heatIdx = 0; T.running = false;
  T.heats = [
    { key: 'A',   label: 'ROUND 1 · GROUP A', get: () => T.groups.A },
    { key: 'B',   label: 'ROUND 1 · GROUP B', get: () => T.groups.B },
    { key: 'C',   label: 'ROUND 1 · GROUP C', get: () => T.groups.C },
    { key: 'D',   label: 'ROUND 1 · GROUP D', get: () => T.groups.D },
    { key: 'SF1', label: 'SEMIFINAL 1',       get: () => [T.w.A, T.w.B] },
    { key: 'SF2', label: 'SEMIFINAL 2',       get: () => [T.w.C, T.w.D] },
    { key: 'F',   label: 'FINAL',             get: () => [T.w.SF1, T.w.SF2] },
  ];
  stopChampConfetti();
  $('champion').classList.add('hidden');
  renderBracket();
  showStage('bracket');
  $('btn-start').textContent = '▶ MULAI TURNAMEN';
  $('btn-start').classList.remove('hidden');
  setRaceButtons(false);
  $('round-label').textContent = 'BRACKET';
  $('timer').textContent = '00:00.0';
}

function renderBracket() {
  const g = T.groups, w = T.w;
  const sq = (r) => '<div class="bq" style="--c:' + r.color + '"><span class="face"></span></div><div class="bnm">' + r.name + '</div>';
  const slot = (id, r) => '<div class="bslot" id="' + id + '">' + (r ? sq(r) : '<span class="q">?</span>') + '</div>';
  const node = (id, r, label) =>
    '<div class="bnode">' + slot(id, r) + (label ? '<div class="blab">' + label + '</div>' : '') + '</div>';
  const grp = (k) =>
    '<div class="bnode">' + slot('w-' + k, w[k]) +
    '<div class="bmem">' + g[k].map((r) =>
      '<div class="bq sm" style="--c:' + r.color + '" title="' + r.name + '"><span class="face"></span></div>'
    ).join('') + '</div>' +
    '<div class="blab">GROUP ' + k + '</div></div>';
  $('bracket-grid').innerHTML =
    '<div class="btree">' +
      '<div class="blvl lvl1">' + node('w-CH', w.F, '★ CHAMPION') + '</div>' +
      '<div class="blvl lvl2"><div class="conn-h"></div>' +
        node('w-SF1', w.SF1, 'SF 1') + node('w-SF2', w.SF2, 'SF 2') + '</div>' +
      '<div class="blvl lvl4"><div class="conn-h"></div>' +
        grp('A') + grp('B') + grp('C') + grp('D') + '</div>' +
    '</div>';
}

function showStage(which) {
  // bracket-bar & trek selalu terlihat (satu layar ala video); hanya champion overlay yg toggle
  $('champion').classList.toggle('hidden', which !== 'champion');
  if (which === 'champion') stopRaceCanvas();
}
function stopRaceCanvas() {
  if (T.race) { T.race.destroy(); T.race = null; }
}

function setRaceButtons(on) {
  $('btn-speed').classList.toggle('hidden', !on);
  $('btn-skip').classList.toggle('hidden', !on);
}

function showBanner(main, sub, ms) {
  $('banner-main').textContent = main;
  $('banner-sub').textContent = sub || '';
  banner.classList.remove('hidden');
  clearTimeout(showBanner._t);
  if (ms !== 0) showBanner._t = setTimeout(() => banner.classList.add('hidden'), ms || 2200);
}
function hideBanner() { clearTimeout(showBanner._t); banner.classList.add('hidden'); }

function fmtT(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), d = Math.floor((s % 1) * 10);
  return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec + '.' + d;
}

function playHeat() {
  const h = T.heats[T.heatIdx];
  const racers = h.get();
  showStage('race');
  hideBanner();
  setRaceButtons(true);
  $('btn-start').classList.add('hidden');
  $('round-label').textContent = h.label;
  $('next-tag').classList.add('hidden');

  T.race = new Race(cv, racers, h.label, {
    speed: T.speed,
    onTick: (t) => { $('timer').textContent = fmtT(t); },
    showBanner: (m, s) => showBanner(m, s, 2400),
    onDone: (winner) => {
      T.w[h.key] = winner;
      setRaceButtons(false);
      // bracket selalu terlihat — update langsung di tempat
      setTimeout(() => {
        renderBracket();
        $('round-label').textContent = 'BRACKET';
        T.heatIdx++;
        if (T.heatIdx < T.heats.length) {
          const nx = T.heats[T.heatIdx];
          const tag = $('next-tag');
          tag.textContent = 'NEXT: ' + nx.label;
          tag.classList.remove('hidden');
          setTimeout(playHeat, 2400);
        } else {
          setTimeout(showChampion, 1200);
        }
      }, 400);
    },
  });
  T.race.start();
}

function showChampion() {
  const w = T.w.F;
  $('champ-chip').innerHTML = chipHTML(w);
  showStage('champion');
  $('round-label').textContent = 'CHAMPION';
  startChampConfetti();
}

/* konfeti ringan di canvas belakang layar juara */
function startChampConfetti() {
  stopChampConfetti();
  cv.style.visibility = 'visible';
  const c = cv.getContext('2d');
  const cols = ['#ffd21f', '#ff5fa2', '#22d3ee', '#a855f7', '#4ade80', '#ffffff'];
  const ps = [];
  for (let i = 0; i < 130; i++) ps.push({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height,
    vy: 90 + Math.random() * 160, vx: (Math.random() - 0.5) * 60,
    s: 5 + Math.random() * 7, col: cols[(Math.random() * cols.length) | 0],
    rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 8,
  });
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    c.clearRect(0, 0, cv.width, cv.height);
    c.fillStyle = '#0a0714'; c.fillRect(0, 0, cv.width, cv.height);
    for (const p of ps) {
      p.y += p.vy * dt; p.x += p.vx * dt + Math.sin(now / 300 + p.rot) * 0.6; p.rot += p.vr * dt;
      if (p.y > cv.height + 20) { p.y = -20; p.x = Math.random() * cv.width; }
      c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
      c.fillStyle = p.col; c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      c.restore();
    }
    T.champConfetti = requestAnimationFrame(loop);
  };
  T.champConfetti = requestAnimationFrame(loop);
}
function stopChampConfetti() {
  if (T.champConfetti) cancelAnimationFrame(T.champConfetti);
  T.champConfetti = null;
}

/* ---------- wiring ---------- */
$('btn-start').addEventListener('click', () => {
  if (T.running) return;
  T.running = true;
  playHeat();
});
// ?autostart=1 : langsung mulai (untuk screenshot/testing lokal)
if (new URLSearchParams(location.search).get('autostart') === '1') {
  setTimeout(() => $('btn-start').click(), 400);
}
$('btn-again').addEventListener('click', () => { newTournament(); });
$('btn-speed').addEventListener('click', (e) => {
  T.speed = T.speed === 1 ? 2 : (T.speed === 2 ? 4 : 1);
  e.target.textContent = T.speed + 'x';
  if (T.race) T.race.setSpeed(T.speed);
});
$('btn-skip').addEventListener('click', () => { if (T.race) T.race.skip(); });
$('btn-full').addEventListener('click', () => {
  const st = $('stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (st.requestFullscreen) st.requestFullscreen();
});

newTournament();
