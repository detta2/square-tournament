'use strict';
/* Maze generation + BFS pathfinding validation (LEGACY, tidak dipakai lagi).
 * Grid tile: 1 = dinding, 0 = jalur. Ukuran 15 x 11 tile.
 * Baris 0-2 : saluran start hijau (per kolom channel)
 * Baris 3-8 : labirin (recursive backtracker + braid biar ada banyak jalur)
 * Baris 9   : lintasan sprint terbuka
 * Baris 10  : garis finis kotak-kotak
 *
 * ARENA BARU (marble-race, dipakai Race): lihat bagian ARENA di bawah.
 * Ukuran: 20 x 12 tile, TILE tetap 48px -> pas canvas 960x600.
 */
const TILE = 48, TC = 20, TR = 12;

function genMaze(channels) {
  const W = TC, H = TR;
  const g = new Uint8Array(W * H).fill(1);
  const idx = (x, y) => y * W + x;

  // 1) saluran start (selalu terbuka vertikal)
  for (const c of channels) { g[idx(c, 0)] = 0; g[idx(c, 1)] = 0; g[idx(c, 2)] = 0; }

  // 2) labirin: cell (i,j) -> tile (2i+1, 2j+3), i:0..6, j:0..2
  const CW = 7, CH = 3;
  const visited = new Uint8Array(CW * CH);
  const stack = [[0, 0]];
  visited[0] = 1;
  g[idx(1, 3)] = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const ci = top[0], cj = top[1];
    const opts = [];
    for (let d = 0; d < 4; d++) {
      const ni = ci + dirs[d][0], nj = cj + dirs[d][1];
      if (ni >= 0 && nj >= 0 && ni < CW && nj < CH && !visited[nj * CW + ni]) {
        opts.push([ni, nj, dirs[d][0], dirs[d][1]]);
      }
    }
    if (!opts.length) { stack.pop(); continue; }
    const p = opts[(Math.random() * opts.length) | 0];
    visited[p[1] * CW + p[0]] = 1;
    g[idx(2 * ci + 1 + p[2], 2 * cj + 3 + p[3])] = 0; // dinding antar cell
    g[idx(2 * p[0] + 1, 2 * p[1] + 3)] = 0;           // cell baru
    stack.push([p[0], p[1]]);
  }

  // 3) baris sprint + finis selalu terbuka (tepi kiri/kanan tetap dinding)
  for (let x = 1; x < W - 1; x++) { g[idx(x, 9)] = 0; g[idx(x, 10)] = 0; }

  // 4) braid: bobol sebagian dinding interior biar ada loop/jalur alternatif
  for (let y = 3; y <= 8; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (g[idx(x, y)] !== 1) continue;
      const horiz = g[idx(x - 1, y)] === 0 && g[idx(x + 1, y)] === 0;
      const vert = g[idx(x, y - 1)] === 0 && g[idx(x, y + 1)] === 0;
      if ((horiz || vert) && Math.random() < 0.24) g[idx(x, y)] = 0;
    }
  }

  // 5) kolam air (zona lambat) di tile jalur acak
  const water = new Set();
  let tries = 0;
  while (water.size < 3 && tries++ < 300) {
    const x = 1 + ((Math.random() * (W - 2)) | 0);
    const y = 3 + ((Math.random() * 6) | 0);
    const id = idx(x, y);
    if (g[id] !== 0 || channels.indexOf(x) !== -1) continue;
    water.add(id);
  }

  // 6) pilih tile boss api: harus tetap ada jalur meski tile-nya diblokir
  let fireTile = -1;
  tries = 0;
  while (tries++ < 120) {
    const x = 2 + ((Math.random() * (W - 4)) | 0);
    const y = 4 + ((Math.random() * 4) | 0);
    const id = idx(x, y);
    if (g[id] !== 0 || water.has(id) || channels.indexOf(x) !== -1) continue;
    const blocked = new Set([id]);
    const d = bfsDist(g, W, H, blocked);
    let ok = true;
    for (const c of channels) { if (d[idx(c, 3)] < 0) { ok = false; break; } }
    if (ok) { fireTile = id; break; }
  }
  // fallback: tile tengah yang pasti aman
  if (fireTile < 0) {
    outer: for (let y = 4; y <= 7; y++) for (let x = 2; x < W - 2; x++) {
      if (g[idx(x, y)] === 0 && !water.has(idx(x, y))) { fireTile = idx(x, y); break outer; }
    }
  }

  const dist = bfsDist(g, W, H, null);
  // peta jarak versi "hindari boss": AI tidak akan menargetkan tile boss api
  const distNB = bfsDist(g, W, H, new Set([fireTile]));

  // 7) VALIDASI AKHIR: semua channel harus mencapai finis, kalau tidak -> null (generate ulang)
  for (const c of channels) {
    if (dist[idx(c, 3)] < 0) return null;
  }
  return { grid: g, water: water, fireTile: fireTile, dist: dist, distNB: distNB, channels: channels.slice() };
}

/* BFS dari seluruh baris finis (baris 10). blocked = Set tile yg dianggap dinding. */
function bfsDist(g, W, H, blocked) {
  const idx = (x, y) => y * W + x;
  const dist = new Int16Array(W * H).fill(-1);
  const qx = [], qy = [];
  for (let x = 0; x < W; x++) { dist[idx(x, H - 1)] = 0; qx.push(x); qy.push(H - 1); }
  let head = 0;
  while (head < qx.length) {
    const x = qx[head], y = qy[head]; head++;
    const nd = dist[idx(x, y)] + 1;
    const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (let k = 0; k < 4; k++) {
      const nx = nb[k][0], ny = nb[k][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const id = idx(nx, ny);
      if (dist[id] !== -1 || g[id] !== 0) continue;
      if (blocked && blocked.has(id)) continue;
      dist[id] = nd;
      qx.push(nx); qy.push(ny);
    }
  }
  return dist;
}

function tileCX(ax, tx) { return ax + tx * TILE + TILE / 2; }
function tileCY(ay, ty) { return ay + ty * TILE + TILE / 2; }

/* bungkus aman: generate sampai valid (maks 40x) */
function genMazeSafe(channels) {
  for (let i = 0; i < 40; i++) {
    const m = genMaze(channels);
    if (m) return m;
  }
  throw new Error('genMazeSafe: gagal membuat labirin valid');
}

/* ================================================================
 * ARENA (marble-race): 5 tipe stage + rintangan baru.
 * Simbol ASCII per tile (grid 20x12):
 *   '#' dinding   '.' lantai   'F' zona finis (strip VERTIKAL kanan, ala video)
 *   'W' air (zona lambat)   'S' area spawn   'G' gerbang flood-gate
 *   'L' lava (menyentuh = terbakar!)   'I' es (licin, susah belok)
 *   'P'/'Q' portal (teleport ke pasangan sehuruf)
 *   'B' bumper (mental kuat)   'X' spinner (palang berputar)
 *   'T' tornado (pusaran menyedot)
 * Baris 8 = dinding + gerbang G, baris 9-10 = kandang spawn.
 * ================================================================ */
const PAL_DEFAULT = { wall: '#7c3aed', wallHi: '#a78bfa', wallLo: '#5b21b6', floorA: '#ffd9e8', floorB: '#f7e8c3' };

const ARENAS = [
  { name: 'Kawah Lava', bosses: 1, bossSpeed: 112,
    geysers: [[8, 4], [10, 5], [7, 6]],
    palette: { wall: '#991b1b', wallHi: '#ef4444', wallLo: '#450a0a', floorA: '#33231a', floorB: '#2a1c14' },
    map: [
      "####################",
      "#..................#",
      "#..LLLL....LLLL....#",
      "#..LLLL....LLLL..FF#",
      "#......B....B....FF#",
      "#..LLLL....LLLL..FF#",
      "#..LLLL....LLLL....#",
      "#.....LLL..LLL.....#",
      "###GG######GG###GG##",
      "#..................#",
      "#......SSSSSS......#",
      "####################",
    ]},
  { name: 'Gua Es', bosses: 1,
    palette: { wall: '#0284c7', wallHi: '#7dd3fc', wallLo: '#075985', floorA: '#e8f6ff', floorB: '#cdeafd' },
    map: [
      "####################",
      "#..................#",
      "#..IIIII...IIIII...#",
      "#..IIIII...IIIII.FF#",
      "#......X.........FF#",
      "#..IIIII...IIIII.FF#",
      "#..IIIII...IIIII...#",
      "#..................#",
      "###GG######GG###GG##",
      "#..................#",
      "#......SSSSSS......#",
      "####################",
    ]},
  { name: 'Labirin Portal', bosses: 1,
    palette: { wall: '#7c3aed', wallHi: '#a78bfa', wallLo: '#5b21b6', floorA: '#f1e9ff', floorB: '#e2d2ff' },
    map: [
      "####################",
      "#..................#",
      "#.P...........Q....#",
      "#.P...........Q..FF#",
      "#.....B.....B....FF#",
      "#.Q...........P..FF#",
      "#.Q...........P....#",
      "#..................#",
      "###GG######GG###GG##",
      "#..................#",
      "#......SSSSSS......#",
      "####################",
    ]},
  { name: 'Arena Badai', bosses: 1,
    palette: { wall: '#0f766e', wallHi: '#5eead4', wallLo: '#134e4a', floorA: '#e6fffa', floorB: '#c9f2ec' },
    map: [
      "####################",
      "#..................#",
      "#......TTT.........#",
      "#......TTT.......FF#",
      "#..W...TTT...W...FF#",
      "#......TTT.......FF#",
      "#......TTT.........#",
      "#.....X............#",
      "###GG######GG###GG##",
      "#..................#",
      "#......SSSSSS......#",
      "####################",
    ]},
  { name: 'Sarang GARGANT', bosses: 2,
    palette: { wall: '#3f3f46', wallHi: '#a1a1aa', wallLo: '#18181b', floorA: '#2e2e33', floorB: '#26262b' },
    map: [
      "####################",
      "#..................#",
      "#..LLL......LLL....#",
      "#..LLL......LLL..FF#",
      "#.....BB....BB...FF#",
      "#..LLL......LLL..FF#",
      "#..LLL......LLL....#",
      "#..................#",
      "###GG######GG###GG##",
      "#..................#",
      "#......SSSSSS......#",
      "####################",
    ]},
];

function parseArena(def) {
  const H = def.map.length, W = def.map[0].length;
  const grid = new Uint8Array(W * H);
  const water = new Set(), spawns = [], finish = [], gates = [];
  const lava = new Set(), ice = new Set();
  const portalTiles = { P: [], Q: [] };
  const bumpers = [], spinners = [], tornadoTiles = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ch = def.map[y][x], id = y * W + x;
    if (ch === '#') grid[id] = 1;
    else {
      grid[id] = 0;
      if (ch === 'W') water.add(id);
      else if (ch === 'F') finish.push(id);
      else if (ch === 'S') spawns.push(id);
      else if (ch === 'G') gates.push(id);
      else if (ch === 'L') lava.add(id);
      else if (ch === 'I') ice.add(id);
      else if (ch === 'P' || ch === 'Q') portalTiles[ch].push(id);
      else if (ch === 'B') bumpers.push(id);
      else if (ch === 'X') spinners.push(id);
      else if (ch === 'T') tornadoTiles.push(id);
    }
  }
  // portal: pasangan silang (paruh pertama <-> paruh kedua) biar teleport jauh
  const portals = [];
  for (const k of ['P', 'Q']) {
    const ts = portalTiles[k].slice().sort((a, b) => a - b);
    const half = Math.floor(ts.length / 2);
    for (let i = 0; i < half; i++) portals.push({ a: ts[i], b: ts[i + half] });
  }
  // tornado: satu pusaran di centroid semua tile T
  const tornadoes = [];
  if (tornadoTiles.length) {
    let sx = 0, sy = 0;
    for (const t of tornadoTiles) { sx += t % W; sy += (t / W) | 0; }
    tornadoes.push({
      tx: sx / tornadoTiles.length, ty: sy / tornadoTiles.length,
      r: TILE * Math.sqrt(tornadoTiles.length) * 0.55,
    });
  }
  return { name: def.name, bosses: def.bosses, bossSpeed: def.bossSpeed,
    geysers: def.geysers || [], palette: def.palette || PAL_DEFAULT,
    grid: grid, water: water, spawns: spawns, finish: finish, gates: gates,
    lava: lava, ice: ice, portals: portals, bumpers: bumpers,
    spinners: spinners, tornadoes: tornadoes, W: W, H: H };
}

/* BFS: semua spawn harus bisa mencapai zona finis (lewat tile jalan). */
function arenaConnected(a) {
  const W = a.W, H = a.H, g = a.grid;
  const seen = new Uint8Array(W * H);
  const q = [];
  for (const f of a.finish) { seen[f] = 1; q.push(f); }
  let head = 0;
  while (head < q.length) {
    const id = q[head++], x = id % W, y = (id / W) | 0;
    const nb = [];
    if (x + 1 < W) nb.push(id + 1);
    if (x - 1 >= 0) nb.push(id - 1);
    if (y + 1 < H) nb.push(id + W);
    if (y - 1 >= 0) nb.push(id - W);
    for (const n of nb) if (!seen[n] && g[n] === 0) { seen[n] = 1; q.push(n); }
  }
  for (const s of a.spawns) if (!seen[s]) return false;
  return a.spawns.length > 0 && a.finish.length > 0 && a.gates.length > 0;
}

/* Pilih arena acak yang valid; ?arena=N untuk paksa stage tertentu (testing/foto).
 * Fallback ke ARENAS[0]. */
function genArena() {
  let force = -1;
  try {
    if (typeof location !== 'undefined') {
      const n = parseInt(new URLSearchParams(location.search).get('arena'), 10);
      if (!isNaN(n) && n >= 0 && n < ARENAS.length) force = n;
    }
  } catch (e) {}
  const order = [];
  if (force >= 0) order.push(force);
  else {
    for (let i = 0; i < ARENAS.length; i++) order.push(i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
  }
  for (const i of order) {
    const a = parseArena(ARENAS[i]);
    if (arenaConnected(a)) return a;
  }
  return parseArena(ARENAS[0]);
}

// dukung node --check & test via eval
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TILE, TC, TR, genMaze, genMazeSafe, bfsDist, tileCX, tileCY,
    ARENAS, parseArena, genArena };
}
