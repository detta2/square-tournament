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
 * ARENA (marble-race): ruangan TERBUKA, bukan labirin.
 * Simbol ASCII per tile:
 *   '#' dinding ungu   '.' lantai   'F' zona finis (strip VERTIKAL kanan, ala video)
 *   'W' air (zona lambat)   'S' area spawn   'G' gerbang flood-gate
 * Grid: 20 kolom x 12 baris. Baris 8 = dinding + gerbang G,
 * baris 9-10 = kandang spawn (disegel saat gate-mode).
 * ================================================================ */
const ARENAS = [
  { name: 'Video1', map: [
    "####################",
    "#..................#",
    "#..................#",
    "#................FF#",
    "#................FF#",
    "#................FF#",
    "#..................#",
    "#........W.........#",
    "###GG######GG###GG##",
    "#..................#",
    "#......SSSSSS......#",
    "####################",
  ]},
  { name: 'Video2', map: [
    "####################",
    "#..................#",
    "#..................#",
    "#................FF#",
    "#................FF#",
    "#................FF#",
    "#..................#",
    "#........W.........#",
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
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ch = def.map[y][x], id = y * W + x;
    if (ch === '#') grid[id] = 1;
    else if (ch === 'W') { grid[id] = 0; water.add(id); }
    else if (ch === 'F') { grid[id] = 0; finish.push(id); }
    else if (ch === 'S') { grid[id] = 0; spawns.push(id); }
    else if (ch === 'G') { grid[id] = 0; gates.push(id); }
    else grid[id] = 0;
  }
  return { name: def.name, grid: grid, water: water, spawns: spawns,
           finish: finish, gates: gates, W: W, H: H };
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

/* Pilih arena acak yang valid; fallback ke Video1. */
function genArena() {
  const order = [0, 1];
  for (let i = order.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = order[i]; order[i] = order[j]; order[j] = t;
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
