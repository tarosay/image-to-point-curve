'use strict';
// Image to Point Curve — 画像の輪郭を抽出し DesignSpark Mechanical 用 Point Curve TXT を出力する。
// 処理はすべてブラウザ内で完結する。

const $ = id => document.getElementById(id);

const DEFAULTS = {
  txtPolyline: 'true', sizeMode: 'circle', outD: 78.5, outW: 100, mode: 'mono',
  threshold: 128, autoThreshold: true, invert: false,
  maxColors: 8, colorTol: 40,
  epsilon: 1, smooth: 2, resolution: '1000',
  minArea: 20, majority: 0,
};

const S = {
  img: null, name: 'image', W: 0, H: 0,   // 元画像
  w: 0, h: 0, rgba: null,                  // 処理解像度の画素
  labels: null, palette: [], bgLabel: -1,  // 段階1：ラベル画像
  enabled: new Set(),                      // 出力するラベル
  rawCache: new Map(),                     // 段階2：ラベルごとの生の輪郭
  loops: [],                               // 段階3：出力する輪郭（処理解像度の px 座標）
  circle: null,                            // 全輪郭の点を囲む最小の円（元画像の px 座標）
};

// ---------------------------------------------------------------- 画像読み込み

function loadFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    setStatus('PNG / JPEG / WebP の画像を選択してください。', true);
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    S.img = img;
    S.name = file.name.replace(/\.[^.]+$/, '') || 'image';
    S.W = img.naturalWidth; S.H = img.naturalHeight;
    $('srcInfo').textContent = `${S.W} × ${S.H} px`;
    $('previews').hidden = false;
    $('dropZone').classList.add('compact');
    drawSource();
    rasterize();
    $('mode').value = detectMode();
    syncModeControls();
    syncHeightFromWidth();
    process(1);
  };
  img.onerror = () => { URL.revokeObjectURL(url); setStatus('画像を読み込めませんでした。', true); };
  img.src = url;
}

function drawSource() {
  const c = $('srcCanvas'), k = Math.min(1, 1200 / Math.max(S.W, S.H));
  c.width = Math.round(S.W * k); c.height = Math.round(S.H * k);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(S.img, 0, 0, c.width, c.height);
}

// 処理解像度に縮小し、透明部分は白の上に合成する。
function rasterize() {
  const max = Number($('resolution').value), k = Math.min(1, max / Math.max(S.W, S.H));
  S.w = Math.max(1, Math.round(S.W * k)); S.h = Math.max(1, Math.round(S.H * k));
  const c = document.createElement('canvas');
  c.width = S.w; c.height = S.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S.w, S.h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.img, 0, 0, S.w, S.h);
  S.rgba = ctx.getImageData(0, 0, S.w, S.h).data;
}

// 彩度のある画素が一定割合を超えればカラー、そうでなければ白黒。
function detectMode() {
  const d = S.rgba, n = S.w * S.h, step = Math.max(1, Math.floor(n / 200000));
  let colored = 0, total = 0;
  for (let i = 0; i < n; i += step) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++;
    total++;
  }
  return colored / total > 0.02 ? 'color' : 'mono';
}

// ---------------------------------------------------------------- 段階1：ラベル画像

function buildLabels() {
  const mode = $('mode').value;
  if (mode === 'mono') buildMono(); else buildColor();
  for (let i = Number($('majority').value); i > 0; i--) majorityFilter();
}

function buildMono() {
  const d = S.rgba, n = S.w * S.h, gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) gray[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  if ($('autoThreshold').checked) {
    $('threshold').value = otsu(gray);
  }
  $('thresholdVal').textContent = $('threshold').value;
  const t = Number($('threshold').value), inv = $('invert').checked;
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) labels[i] = (inv ? gray[i] >= t : gray[i] < t) ? 1 : 0;
  S.labels = labels;
  S.palette = [{ rgb: [255, 255, 255], n: 0 }, { rgb: [0, 0, 0], n: 0 }];
  S.bgLabel = 0;
  S.enabled = new Set([1]);
}

function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 255; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; t = i + 1; }
  }
  return Math.min(254, Math.max(1, t));
}

// 色ヒストグラム（RGB 各5bit）を頻度順に許容差でまとめ、最大色数まで減らしてから k-means で整える。
function buildColor() {
  const d = S.rgba, n = S.w * S.h;
  const cnt = new Float64Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  const key = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    key[i] = k; cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
  }
  const bins = [];
  for (let k = 0; k < 32768; k++) if (cnt[k]) bins.push({ k, n: cnt[k], r: sr[k] / cnt[k], g: sg[k] / cnt[k], b: sb[k] / cnt[k] });
  bins.sort((a, b) => b.n - a.n);

  const tol = Number($('colorTol').value), maxC = Number($('maxColors').value);
  let pal = [];
  const nearest = (p, b) => {
    let bi = -1, bd = Infinity;
    for (let j = 0; j < p.length; j++) {
      const dr = p[j].r - b.r, dg = p[j].g - b.g, db = p[j].b - b.b, dd = dr * dr + dg * dg + db * db;
      if (dd < bd) { bd = dd; bi = j; }
    }
    return [bi, Math.sqrt(bd)];
  };
  for (const b of bins) {
    const [j, dist] = nearest(pal, b);
    if (j < 0 || (dist > tol && pal.length < maxC)) { pal.push({ r: b.r, g: b.g, b: b.b, n: b.n }); continue; }
    const p = pal[j], m = p.n + b.n;
    p.r = (p.r * p.n + b.r * b.n) / m; p.g = (p.g * p.n + b.g * b.n) / m; p.b = (p.b * p.n + b.b * b.n) / m; p.n = m;
  }
  // k-means で中心を整える（ビン単位なので高速）。ごく少数の色は除く。
  for (let it = 0; it < 6; it++) {
    const acc = pal.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (const b of bins) { const a = acc[nearest(pal, b)[0]]; a.r += b.r * b.n; a.g += b.g * b.n; a.b += b.b * b.n; a.n += b.n; }
    const minN = n * 0.002;
    const next = [];
    acc.forEach((a, j) => { if (a.n > 0 && (a.n >= minN || pal.length === 1)) next.push({ r: a.r / a.n, g: a.g / a.n, b: a.b / a.n, n: a.n }); });
    if (!next.length) next.push(pal[0]);
    pal = next;
  }
  // 最後に許容差以内の色同士をまとめる
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < pal.length; a++) for (let b = a + 1; b < pal.length; b++) {
      const p = pal[a], q = pal[b], dist = Math.hypot(p.r - q.r, p.g - q.g, p.b - q.b);
      if (dist <= tol) {
        const m = p.n + q.n;
        pal[a] = { r: (p.r * p.n + q.r * q.n) / m, g: (p.g * p.n + q.g * q.n) / m, b: (p.b * p.n + q.b * q.n) / m, n: m };
        pal.splice(b, 1); merged = true; break outer;
      }
    }
  }
  const lut = new Uint8Array(32768);
  for (const b of bins) lut[b.k] = nearest(pal, b)[0];
  const labels = new Uint8Array(n), counts = new Float64Array(pal.length);
  for (let i = 0; i < n; i++) { const l = lut[key[i]]; labels[i] = l; counts[l]++; }
  // 出現数の多い順に並べ替える
  const order = pal.map((_, j) => j).sort((a, b) => counts[b] - counts[a]);
  const remap = new Uint8Array(pal.length);
  order.forEach((j, idx) => { remap[j] = idx; });
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
  // 色の構成が変わるため、出力する色の選択は作り直す
  S.palette = order.map(j => ({ rgb: [pal[j].r, pal[j].g, pal[j].b].map(Math.round), n: counts[j] }));
  S.labels = labels;
  S.bgLabel = borderLabel(labels, S.palette.length);
  S.enabled = new Set(S.palette.map((_, j) => j).filter(j => j !== S.bgLabel));
}

function borderLabel(labels, m) {
  const c = new Float64Array(m), w = S.w, h = S.h;
  for (let x = 0; x < w; x++) { c[labels[x]]++; c[labels[(h - 1) * w + x]]++; }
  for (let y = 0; y < h; y++) { c[labels[y * w]]++; c[labels[y * w + w - 1]]++; }
  let best = 0;
  for (let j = 1; j < m; j++) if (c[j] > c[best]) best = j;
  return best;
}

// 3×3 多数決。最多ラベルが過半（5以上）のときだけ置き換える。
function majorityFilter() {
  const w = S.w, h = S.h, src = S.labels, dst = new Uint8Array(src);
  const cnt = new Uint8Array(256), seen = new Uint8Array(9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let ns = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx, l = src[yy * w + xx];
        if (!cnt[l]++) seen[ns++] = l;
      }
    }
    let bl = src[y * w + x], bc = 0;
    for (let k = 0; k < ns; k++) { const l = seen[k]; if (cnt[l] > bc) { bc = cnt[l]; bl = l; } cnt[l] = 0; }
    if (bc >= 5) dst[y * w + x] = bl;
  }
  S.labels = dst;
}

// ---------------------------------------------------------------- 段階2：輪郭追跡（マーチングスクエア）

// mask の境界を閉曲線の配列として返す。座標は画素の左上を (0,0) とする px 座標（y 下向き）。
// 前景を一定の側に置く向きで追跡するため、外周と穴は符号付き面積の正負が逆になる。
function traceMask(mask, w, h) {
  const at = (cx, cy) => (cx >= 1 && cy >= 1 && cx <= w && cy <= h) ? mask[(cy - 1) * w + (cx - 1)] : 0;
  const HN = (w + 1) * (h + 2), VN = (w + 2) * (h + 1);
  const hid = (i, j) => j * (w + 1) + i;          // 角 (i,j)-(i+1,j) 間の辺
  const vid = (i, j) => HN + j * (w + 2) + i;     // 角 (i,j)-(i,j+1) 間の辺
  const next = new Int32Array(HN + VN).fill(-1);
  const pos = id => id < HN
    ? [id % (w + 1), Math.floor(id / (w + 1)) - 0.5]
    : [(id - HN) % (w + 2) - 0.5, Math.floor((id - HN) / (w + 2))];

  const link = (e1, e2, tx, ty, tv) => {
    const [x1, y1] = pos(e1), [x2, y2] = pos(e2);
    const cr = (x2 - x1) * (ty - y1) - (y2 - y1) * (tx - x1);
    if ((cr > 0) === (tv === 1)) next[e2] = e1; else next[e1] = e2;
  };
  for (let j = 0; j <= h; j++) for (let i = 0; i <= w; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    const code = (a << 3) | (b << 2) | (c << 1) | d;
    if (code === 0 || code === 15) continue;
    const T = hid(i, j), B = hid(i, j + 1), L = vid(i, j), R = vid(i + 1, j);
    // 角の中心座標（px）：角 (i,j) は画素 (i-1,j-1) の中心
    const ax = i - 0.5, ay = j - 0.5, bx = i + 0.5, cy = j + 0.5;
    if (code === 10 || code === 5) {            // 鞍点：前景を斜めにつなぐ
      if (a) { link(T, R, bx, ay, b); link(B, L, ax, cy, d); }
      else { link(L, T, ax, ay, a); link(R, B, bx, cy, c); }
      continue;
    }
    const e = [];
    if (a !== b) e.push('T'); if (b !== c) e.push('R'); if (d !== c) e.push('B'); if (a !== d) e.push('L');
    const s = e.join('');
    const E = { T, R, B, L };
    // 判定に使う角：隣り合う辺なら共有する角、向かい合う辺なら角 a
    let tx = ax, ty = ay, tv = a;
    if (s === 'TR') { tx = bx; ty = ay; tv = b; }
    else if (s === 'RB') { tx = bx; ty = cy; tv = c; }
    else if (s === 'BL') { tx = ax; ty = cy; tv = d; }
    link(E[e[0]], E[e[1]], tx, ty, tv);
  }
  const loops = [];
  for (let s = 0; s < next.length; s++) {
    if (next[s] < 0) continue;
    const pts = [];
    let id = s;
    while (id >= 0 && next[id] >= 0) {
      const p = pos(id); pts.push(p[0], p[1]);
      const nx = next[id]; next[id] = -2; id = nx;
    }
    if (pts.length >= 6) loops.push(new Float64Array(pts));
  }
  return loops;
}

function signedArea(p) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return a / 2;
}

function rawLoopsFor(label) {
  if (S.rawCache.has(label)) return S.rawCache.get(label);
  const n = S.w * S.h, mask = new Uint8Array(n), L = S.labels;
  for (let i = 0; i < n; i++) mask[i] = L[i] === label ? 1 : 0;
  const loops = traceMask(mask, S.w, S.h).map(p => ({ p, area: signedArea(p) }));
  S.rawCache.set(label, loops);
  return loops;
}

// ---------------------------------------------------------------- 段階3：ノイズ除去・平滑化・簡略化

function smoothLoop(p, iters) {
  const n = p.length / 2;
  if (n < 4) return p;
  let a = Float64Array.from(p), b = new Float64Array(p.length);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      const pi = (i + n - 1) % n, ni = (i + 1) % n;
      b[i * 2] = (a[pi * 2] + 2 * a[i * 2] + a[ni * 2]) / 4;
      b[i * 2 + 1] = (a[pi * 2 + 1] + 2 * a[i * 2 + 1] + a[ni * 2 + 1]) / 4;
    }
    [a, b] = [b, a];
  }
  return a;
}

// 閉曲線の Douglas–Peucker。始点と最遠点で2分割してから各区間を簡略化する。
function simplifyClosed(p, eps) {
  const n = p.length / 2;
  if (n < 4) return p;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const X = i => p[(i % n) * 2], Y = i => p[(i % n) * 2 + 1];
  const stack = [[0, far], [far, n]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const sx = X(s), sy = Y(s), dx = X(e) - sx, dy = Y(e) - sy, len = Math.hypot(dx, dy);
    let mi = -1, md = -1;
    for (let i = s + 1; i < e; i++) {
      const d = len > 1e-12
        ? Math.abs(dx * (Y(i) - sy) - dy * (X(i) - sx)) / len
        : Math.hypot(X(i) - sx, Y(i) - sy);
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return new Float64Array(out);
}

function buildLoops() {
  const minArea = Number($('minArea').value), iters = Number($('smooth').value), eps = Number($('epsilon').value);
  const loops = [];
  for (let label = 0; label < S.palette.length; label++) {
    if (!S.enabled.has(label)) continue;
    const raw = rawLoopsFor(label).filter(l => Math.abs(l.area) >= Math.max(minArea, 0.5))
      .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    for (const l of raw) {
      const p = simplifyClosed(smoothLoop(l.p, iters), eps);
      if (p.length < 6) continue;
      // traceMask の向きでは、外周の符号付き面積が負（y 下向き座標）、穴が正になる
      loops.push({ label, p, hole: l.area > 0 });
    }
  }
  S.loops = loops;
  const sx = S.W / S.w, sy = S.H / S.h, pts = [];
  for (const l of loops) for (let i = 0; i < l.p.length; i += 2) pts.push([l.p[i] * sx, l.p[i + 1] * sy]);
  S.circle = pts.length ? enclosingCircle(pts) : null;
}

// 最小包含円（Welzl のアルゴリズムの反復版。点の順序をランダムにして期待 O(n)）
// 輪郭は点を結ぶ折れ線なので、すべての点を含む円は折れ線全体も含む。
function enclosingCircle(pts) {
  for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
  const inC = (c, p) => Math.hypot(p[0] - c.x, p[1] - c.y) <= c.r * (1 + 1e-9) + 1e-9;
  const c2 = (a, b) => ({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, r: Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 });
  const c3 = (a, b, c) => {
    const bx = b[0] - a[0], by = b[1] - a[1], cx = c[0] - a[0], cy = c[1] - a[1], d = 2 * (bx * cy - by * cx);
    if (Math.abs(d) < 1e-12) { // 一直線上：最も離れた2点を直径とする
      const cs = [c2(a, b), c2(a, c), c2(b, c)];
      return cs.reduce((m, q) => q.r > m.r ? q : m);
    }
    const b2 = bx * bx + by * by, cc = cx * cx + cy * cy;
    const ux = (cy * b2 - by * cc) / d, uy = (bx * cc - cx * b2) / d;
    return { x: a[0] + ux, y: a[1] + uy, r: Math.hypot(ux, uy) };
  };
  let c = { x: pts[0][0], y: pts[0][1], r: 0 };
  for (let i = 1; i < pts.length; i++) {
    if (inC(c, pts[i])) continue;
    c = { x: pts[i][0], y: pts[i][1], r: 0 };
    for (let j = 0; j < i; j++) {
      if (inC(c, pts[j])) continue;
      c = c2(pts[i], pts[j]);
      for (let k = 0; k < j; k++) if (!inC(c, pts[k])) c = c3(pts[i], pts[j], pts[k]);
    }
  }
  return c;
}

// ---------------------------------------------------------------- 処理の流れ

// level 1: ラベル画像から作り直す / 2: 出力する色の変更 / 3: 簡略化などの変更 / 4: 出力サイズのみ
let pending = 0, timer = 0;
function process(level) {
  pending = pending ? Math.min(pending, level) : level;
  clearTimeout(timer);
  timer = setTimeout(runPending, level <= 1 ? 60 : 30);
}
function runPending() {
  const level = pending; pending = 0;
  if (!S.img) return;
  try {
    if (level <= 1) { buildLabels(); S.rawCache.clear(); renderPalette(); }
    if (level <= 3) buildLoops();
    drawResult();
    showInfo();
  } catch (e) {
    console.error(e);
    setStatus('処理できませんでした：' + e.message, true);
    $('downloadTxt').disabled = true;
  }
}

function setStatus(msg, warn) {
  const s = $('status');
  s.textContent = msg; s.classList.toggle('warn', !!warn);
}

function showInfo() {
  const nLoops = S.loops.length, nPts = S.loops.reduce((a, l) => a + l.p.length / 2 + 1, 0);
  const holes = S.loops.filter(l => l.hole).length;
  $('resultInfo').textContent = `${nLoops} 本・${nPts.toLocaleString()} 点`;
  $('downloadTxt').disabled = nLoops === 0;
  if (!nLoops) { setStatus('輪郭が見つかりません。しきい値・出力する色・ノイズ除去の設定を見直してください。', true); return; }
  const b = outBounds();
  const size = circleMode()
    ? `直径 ${fmt(outD())} mm の円に収めました。形状の外形 ${fmt(b.maxX - b.minX)} × ${fmt(b.maxY - b.minY)} mm`
    : `出力サイズ ${fmt(outW())} × ${fmt(outH())} mm`;
  setStatus(`輪郭 ${nLoops} 本（外周 ${nLoops - holes}・内側 ${holes}）、合計 ${nPts.toLocaleString()} 点。` +
    `${size}。処理解像度 ${S.w} × ${S.h} px。`);
}

// 出力座標（mm）の範囲
function outBounds() {
  const f = mmMapper();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of S.loops) for (let i = 0; i < l.p.length; i += 2) {
    const [x, y] = f(l.p[i], l.p[i + 1]);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------- プレビュー描画

function drawResult() {
  // 表示範囲（処理解像度の px）。外接円を表示するときは円が収まるまで広げる。
  const showCircle = circleMode() && $('showCircle').checked && S.circle;
  let x0 = 0, y0 = 0, x1 = S.w, y1 = S.h, cc = null;
  if (showCircle) {
    const k = S.w / S.W;
    cc = { x: S.circle.x * k, y: S.circle.y * k, r: S.circle.r * k };
    const m = cc.r * 0.02;
    x0 = Math.min(x0, cc.x - cc.r - m); y0 = Math.min(y0, cc.y - cc.r - m);
    x1 = Math.max(x1, cc.x + cc.r + m); y1 = Math.max(y1, cc.y + cc.r + m);
  }
  // プレビューは長辺 1200px 前後で描く（小さい画像は最大2倍まで拡大）
  const c = $('outCanvas'), scale = Math.min(1200 / Math.max(x1 - x0, y1 - y0), 2);
  c.width = Math.round((x1 - x0) * scale); c.height = Math.round((y1 - y0) * scale);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.translate(-x0 * scale, -y0 * scale);
  if ($('showImage').checked) {
    ctx.globalAlpha = 0.35; ctx.drawImage(S.img, 0, 0, S.w * scale, S.h * scale); ctx.globalAlpha = 1;
  }
  const lw = Math.max(1, c.width / 700);
  // 色ごとに偶奇規則で塗る（穴は抜ける）
  if ($('showFill').checked) {
    for (let label = 0; label < S.palette.length; label++) {
      const ls = S.loops.filter(l => l.label === label);
      if (!ls.length) continue;
      ctx.beginPath();
      for (const l of ls) pathLoop(ctx, l.p, scale);
      ctx.fillStyle = rgbaOf(S.palette[label].rgb, 0.28);
      ctx.fill('evenodd');
    }
  }
  ctx.lineWidth = lw; ctx.lineJoin = 'round';
  for (const l of S.loops) {
    ctx.beginPath(); pathLoop(ctx, l.p, scale);
    ctx.strokeStyle = strokeOf(S.palette[l.label].rgb);
    ctx.stroke();
  }
  if (cc) {
    ctx.save();
    ctx.setLineDash([lw * 6, lw * 4]); ctx.strokeStyle = '#dc6b31'; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(cc.x * scale, cc.y * scale, cc.r * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  if ($('showPoints').checked) {
    ctx.fillStyle = '#dc6b31';
    const r = lw * 1.4;
    for (const l of S.loops) for (let i = 0; i < l.p.length; i += 2) {
      ctx.fillRect(l.p[i] * scale - r, l.p[i + 1] * scale - r, r * 2, r * 2);
    }
  }
}

function pathLoop(ctx, p, s) {
  ctx.moveTo(p[0] * s, p[1] * s);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * s, p[i + 1] * s);
  ctx.closePath();
}
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const rgbaOf = (c, a) => lum(c) > 215 ? `rgba(120,135,150,${a})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
function strokeOf(c) {
  if ($('mode').value === 'mono') return '#2f6fb0';
  const L = lum(c);
  if (L > 215) return '#5b6874';
  if (L > 150) { const f = 150 / L; return `rgb(${c.map(v => Math.round(v * f)).join(',')})`; }
  return `rgb(${c.join(',')})`;
}

function renderPalette() {
  const box = $('palette');
  box.textContent = '';
  if ($('mode').value !== 'color') return;
  const total = S.w * S.h;
  S.palette.forEach((p, j) => {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = S.enabled.has(j);
    cb.addEventListener('change', () => {
      if (cb.checked) S.enabled.add(j); else S.enabled.delete(j);
      lab.classList.toggle('off', !cb.checked);
      process(2);
    });
    const sw = document.createElement('span');
    sw.className = 'swatch'; sw.style.background = `rgb(${p.rgb.join(',')})`;
    const name = document.createElement('span');
    name.textContent = j === S.bgLabel ? '背景' : `色 ${j + 1}`;
    const pct = document.createElement('span');
    pct.className = 'pct'; pct.textContent = (p.n / total * 100).toFixed(1) + '%';
    lab.append(cb, sw, name, pct);
    lab.classList.toggle('off', !cb.checked);
    lab.title = `RGB(${p.rgb.join(', ')})`;
    box.append(lab);
  });
}

// ---------------------------------------------------------------- 出力

const fmt = v => (Math.round(v * 100) / 100).toString();
const outW = () => Math.max(0.0001, Number($('outW').value) || 0);
const outH = () => Math.max(0.0001, Number($('outH').value) || 0);

function syncHeightFromWidth() { if (S.W) $('outH').value = fmt(outW() * S.H / S.W); }
function syncWidthFromHeight() { if (S.H) $('outW').value = fmt(outH() * S.W / S.H); }

const outD = () => Math.max(0.0001, Number($('outD').value) || 0);
const circleMode = () => $('sizeMode').value === 'circle';

// 処理解像度の px 座標（y 下向き）→ 出力 mm 座標（Y 上向き）
function mmMapper() {
  if (circleMode() && S.circle) {
    // 円の中心を原点に、最小包含円の直径が指定値になるよう拡大縮小
    const c = S.circle, k = outD() / Math.max(2 * c.r, 1e-9), sx = S.W / S.w, sy = S.H / S.h;
    return (x, y) => [(x * sx - c.x) * k, (c.y - y * sy) * k];
  }
  const kx = outW() / S.w, ky = outH() / S.h, H = outH();
  return (x, y) => [x * kx, H - y * ky];
}

function txtString() {
  const f = mmMapper();
  const pt = (x, y) => { const [X, Y] = f(x, y); return `0 ${X.toFixed(4)} ${Y.toFixed(4)}`; };
  const blocks = S.loops.map(l => {
    const rows = [];
    for (let i = 0; i < l.p.length; i += 2) rows.push(pt(l.p[i], l.p[i + 1]));
    rows.push(rows[0]);
    return rows.join('\r\n');
  });
  return `Polyline=${$('txtPolyline').value === 'true' ? 'True' : 'False'}\r\n` + blocks.join('\r\n\r\n') + '\r\n';
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ---------------------------------------------------------------- UI

function syncModeControls() {
  const color = $('mode').value === 'color';
  $('monoControls').hidden = color;
  $('colorControls').hidden = !color;
  const circle = circleMode();
  $('circleControls').hidden = !circle;
  $('imageControls').hidden = circle;
  $('showCircleLabel').hidden = !circle;
}
function syncOutputs() {
  $('thresholdVal').textContent = $('threshold').value;
  $('threshold').disabled = $('autoThreshold').checked;
  $('maxColorsVal').textContent = $('maxColors').value;
  $('colorTolVal').textContent = $('colorTol').value;
  $('epsilonVal').textContent = Number($('epsilon').value).toFixed(1) + ' px';
  $('smoothVal').textContent = $('smooth').value;
  $('minAreaVal').textContent = $('minArea').value + ' px²';
  $('majorityVal').textContent = $('majority').value;
}

function applyDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  if (S.img) { $('mode').value = detectMode(); syncHeightFromWidth(); }
  syncModeControls(); syncOutputs();
}

function openPicker() { $('fileInput').click(); }

$('dropZone').addEventListener('click', openPicker);
$('dropZone').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } });
$('chooseFile').addEventListener('click', openPicker);
$('fileInput').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('dropZone').classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) $('dropZone').classList.remove('over'); }));
document.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });

$('resolution').addEventListener('change', () => { if (S.img) { rasterize(); process(1); } });
$('mode').addEventListener('change', () => { syncModeControls(); process(1); });
['threshold', 'maxColors', 'colorTol', 'majority'].forEach(id => $(id).addEventListener('input', () => { syncOutputs(); process(1); }));
['autoThreshold', 'invert'].forEach(id => $(id).addEventListener('change', () => { syncOutputs(); process(1); }));
['epsilon', 'smooth', 'minArea'].forEach(id => $(id).addEventListener('input', () => { syncOutputs(); process(3); }));
$('sizeMode').addEventListener('change', () => { syncModeControls(); if (S.img) { drawResult(); showInfo(); } });
$('outD').addEventListener('input', () => { if (S.img) showInfo(); });
['showImage', 'showPoints', 'showFill', 'showCircle'].forEach(id => $(id).addEventListener('change', () => { if (S.img) drawResult(); }));
$('outW').addEventListener('input', () => { syncHeightFromWidth(); if (S.img) showInfo(); });
$('outH').addEventListener('input', () => { syncWidthFromHeight(); if (S.img) showInfo(); });
$('reset').addEventListener('click', () => { applyDefaults(); if (S.img) process(1); });
$('downloadTxt').addEventListener('click', () => {
  if (!S.loops.length) return;
  const ok = circleMode() ? Number($('outD').value) > 0 : Number($('outW').value) > 0 && Number($('outH').value) > 0;
  if (!ok) { setStatus('出力サイズには正の値を入力してください。', true); return; }
  download(`${S.name}_point_curve.txt`, txtString());
});

applyDefaults();
