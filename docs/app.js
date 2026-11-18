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
  dedupe: 'on', absorbSliver: true,
};

const S = {
  img: null, name: 'image', W: 0, H: 0,   // 元画像
  w: 0, h: 0, rgba: null,                  // 処理解像度の画素
  labels: null, palette: [], bgLabel: -1,  // 段階1：ラベル画像
  enabled: new Set(),                      // 出力するラベル
  rawCache: new Map(),                     // 段階2：ラベルごとの生の輪郭
  loops: [],                               // 段階3：出力する輪郭（処理解像度の px 座標）
  circle: null,                            // 全輪郭の点を囲む最小の円（元画像の px 座標）
  clean: null, graph: null,                // 重複を減らす方式：吸収後のラベル画像と境界線の区間
  results: null,                           // { legacy, dedupe }：両方式の輪郭・外接円・重複区間
  vec: null,                               // 読み込んだ Point Curve / DXF：{ curves, notes, kind }（このとき img は null）
};

// ---------------------------------------------------------------- 画像読み込み

function loadFile(file) {
  if (!file) return;
  const ext = (file.name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  if (ext === 'txt' || ext === 'dxf' || ext === 'stl') { loadVector(file, ext); return; }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    setStatus('PNG / JPEG / WebP の画像、Point Curve（.txt）、DXF（.dxf）、STL（.stl）を選択してください。', true);
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    S.img = img; S.vec = null;
    setSourceKind('image');
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

// Point Curve TXT / DXF / STL を読み込む。座標は mm のまま変えずに、そのまま出力する。
// STL は Z の高さを選んで、その断面を曲線にする。
function loadVector(file, ext) {
  const reader = new FileReader();
  reader.onload = () => {
    let v;
    try {
      if (ext === 'stl') {
        const mesh = parseStl(reader.result);
        v = { curves: [], notes: [], mesh, z: (mesh.zmin + mesh.zmax) / 2 };
      } else v = ext === 'dxf' ? parseDxf(reader.result) : parsePointCurveTxt(reader.result);
    } catch (e) {
      console.error(e);
      setStatus('読み込めませんでした：' + e.message, true);
      return;
    }
    if (ext !== 'stl' && !v.curves.length) { setStatus('曲線が見つかりませんでした。' + (v.notes.length ? v.notes.join('。') + '。' : ''), true); return; }
    if (v.polyline !== null && v.polyline !== undefined) $('txtPolyline').value = v.polyline ? 'true' : 'false';
    S.vec = { ...v, kind: ext };
    S.img = null; S.loops = []; S.results = null;
    S.name = file.name.replace(/\.[^.]+$/, '') || 'curve';
    clearTimeout(timer); pending = 0;
    setSourceKind(ext === 'stl' ? 'stl' : 'vector');
    $('srcInfo').textContent = '';
    $('previews').hidden = false;
    $('dropZone').classList.add('compact');
    if (ext === 'stl') { setupSlider(); sliceAt(v.z); return; }
    drawVector();
    showVectorInfo();
  };
  reader.onerror = () => setStatus('ファイルを読み込めませんでした。', true);
  if (ext === 'stl') reader.readAsArrayBuffer(file); else reader.readAsText(file);
}

// 画像と Point Curve / DXF / STL で、表示する欄を切り替える
function setSourceKind(kind) {
  document.body.classList.toggle('vector-mode', kind !== 'image');
  document.body.classList.toggle('stl-mode', kind === 'stl');
  $('outCaption').textContent = kind === 'stl' ? 'STL の断面' : kind === 'vector' ? '読み込んだ曲線' : '抽出した輪郭';
}

// ---------------------------------------------------------------- STL の Z 断面

// Z のバーを STL の高さの範囲に合わせ、平らな面の高さに目盛りを付ける
function setupSlider() {
  const m = S.vec.mesh, range = m.zmax - m.zmin;
  const step = range > 0 ? Math.pow(10, Math.floor(Math.log10(range / 1000))) : 0.001;
  for (const id of ['zSlider', 'zInput']) {
    const el = $(id);
    el.min = m.zmin; el.max = m.zmax; el.step = step;
  }
  $('zRange').textContent = `${fmtZ(m.zmin)} 〜 ${fmtZ(m.zmax)} mm`;
  const box = $('zTicks');
  box.textContent = '';
  for (const z of m.levels) {
    const t = document.createElement('button');
    t.type = 'button'; t.className = 'ztick';
    t.style.left = (range > 0 ? (z - m.zmin) / range * 100 : 50) + '%';
    t.title = `平らな面 Z = ${fmtZ(z)} mm`;
    t.setAttribute('aria-label', t.title);
    t.addEventListener('click', () => sliceAt(z));
    box.append(t);
  }
  $('zLevels').textContent = m.levels.length
    ? '平らな面の高さ（形が変わる位置）：' + m.levels.map(fmtZ).join('、') + ' mm'
    : '平らな面は見つかりませんでした。';
}
const fmtZ = v => (Math.round(v * 10000) / 10000).toString();

// 指定した高さで切って表示する。バーを動かしている間は、描画 1 回ぶんにまとめる
let sliceReq = 0, sliceZ = 0;
function sliceAt(z) {
  sliceZ = z;
  if (sliceReq) return;
  sliceReq = requestAnimationFrame(() => {
    sliceReq = 0;
    const m = S.vec && S.vec.mesh;
    if (!m) return;
    const z = Math.min(m.zmax, Math.max(m.zmin, Number(sliceZ)));
    const r = sliceStl(m, z);
    S.vec.curves = r.curves; S.vec.z = r.z; S.vec.zAsked = z;
    $('zSlider').value = z;
    if (document.activeElement !== $('zInput')) $('zInput').value = fmtZ(z);
    drawVector();
    showVectorInfo();
  });
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
// min3 が真なら、面積のない線にならないよう少なくとも3点を残す（重複を減らす方式で使う。
// 従来の方式は以前と同じ結果にするため使わず、3点未満になった輪郭は捨てる）。
function simplifyClosed(p, eps, min3) {
  const n = p.length / 2;
  if (n < 4) return Float64Array.from(p);
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
  // 3点未満なら、始点と最遠点を結ぶ線から最も離れた点を加える
  let kept = 0;
  for (let i = 0; i < n; i++) kept += keep[i];
  if (min3 && kept < 3) {
    const dx = X(far) - p[0], dy = Y(far) - p[1], len = Math.hypot(dx, dy) || 1;
    let mi = -1, md = -1;
    for (let i = 1; i < n; i++) {
      if (keep[i]) continue;
      const d = Math.abs(dx * (Y(i) - p[1]) - dy * (X(i) - p[0])) / len;
      if (d > md) { md = d; mi = i; }
    }
    if (mi > 0) keep[mi] = 1;
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return new Float64Array(out);
}

// 段階1.5（重複を減らす方式）：小さな領域・中間色を吸収し、境界線を区間に分ける
// 出力する色によって斜めのつながりの優先度が変わるため、出力する色を変えたときも作り直す（段階2）
function buildGraphStage() {
  const pri = colorPriority(S.palette, S.enabled);
  S.clean = cleanLabels(S.labels, S.w, S.h, S.palette, S.rgba, {
    minArea: Number($('minArea').value),
    sliver: $('mode').value === 'color' && $('absorbSliver').checked,
    pri,
  });
  S.graph = buildGraph(S.clean.labels, S.w, S.h, pri);
}

// 段階3：両方式の輪郭を作り、比較用の重複区間を測る
function buildLoops() {
  const iters = Number($('smooth').value), eps = Number($('epsilon').value);
  S.results = { legacy: makeResult(legacyLoops()), dedupe: null };
  simplifyChains(S.graph, iters, eps);
  const G = S.graph, { chosen, exact } = selectFaces(G, c => S.enabled.has(G.compLabel[c]));
  const loops = faceLoops(G, chosen)
    .map(l => ({ label: l.label, p: l.p, hole: signedArea(l.p) > 0 }))
    .sort((a, b) => a.label - b.label || Math.abs(signedArea(b.p)) - Math.abs(signedArea(a.p)));
  S.results.dedupe = makeResult(loops);
  S.results.dedupe.exact = exact;
  applyMethod();
}

function makeResult(loops) {
  const sx = S.W / S.w, sy = S.H / S.h, pts = [];
  for (const l of loops) for (let i = 0; i < l.p.length; i += 2) pts.push([l.p[i] * sx, l.p[i + 1] * sy]);
  const dup = duplicateMetric(loops, DUP_TOL);
  return { loops, circle: pts.length ? enclosingCircle(pts) : null, dup };
}
const DUP_TOL = 1.2;   // 重複とみなす距離（処理解像度の px）

function applyMethod() {
  const r = S.results[dedupeOn() ? 'dedupe' : 'legacy'];
  S.loops = r.loops; S.circle = r.circle;
}
const dedupeOn = () => $('dedupe').value === 'on';

// 従来の方式：出力する色ごとに、その色の領域の輪郭をすべて出力する
function legacyLoops() {
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
  return loops;
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

// level 1: ラベル画像から作り直す / 2: 出力する色・吸収の変更（領域と境界線を作り直す）
// 3: 平滑化・簡略化の変更 / 4: 表示する方式の切り替え・出力サイズのみ
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
    if (level <= 2) buildGraphStage();
    if (level <= 3) buildLoops();
    if (level === 4) applyMethod();
    drawResult();
    showInfo();
  } catch (e) {
    console.error(e);
    setStatus('処理できませんでした：' + e.message, true);
    $('downloadTxt').disabled = $('downloadDxf').disabled = true;
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
  $('downloadTxt').disabled = $('downloadDxf').disabled = nLoops === 0;
  if (!nLoops) { setStatus('輪郭が見つかりません。しきい値・出力する色・ノイズ除去の設定を見直してください。', true); return; }
  const b = outBounds();
  const size = circleMode()
    ? `直径 ${fmt(outD())} mm の円に収めました。形状の外形 ${fmt(b.maxX - b.minX)} × ${fmt(b.maxY - b.minY)} mm`
    : `出力サイズ ${fmt(outW())} × ${fmt(outH())} mm`;
  const extra = [];
  if (dedupeOn() && S.clean) {
    if (S.clean.nSmall || S.clean.nSliver) extra.push(`隣の色に吸収した領域：小さな領域 ${S.clean.nSmall}・境界の中間色 ${S.clean.nSliver}`);
    if (S.results.dedupe && !S.results.dedupe.exact) extra.push('領域が多いため、出力する領域の選び方は近似です');
  }
  setStatus(`輪郭 ${nLoops} 本（外周 ${nLoops - holes}・内側 ${holes}）、合計 ${nPts.toLocaleString()} 点。` +
    `${size}。処理解像度 ${S.w} × ${S.h} px。` + (extra.length ? extra.join('。') + '。' : ''));
  renderCompare();
}

// 従来の方式と重複を減らす方式の比較表
function renderCompare() {
  const rows = [['legacy', '従来の方式'], ['dedupe', '重複を減らす方式']];
  const cur = dedupeOn() ? 'dedupe' : 'legacy';
  const tb = $('compareBody');
  tb.textContent = '';
  for (const [k, name] of rows) {
    const r = S.results[k], tr = document.createElement('tr');
    if (k === cur) tr.className = 'current';
    const nPts = r.loops.reduce((a, l) => a + l.p.length / 2 + 1, 0);
    const mm = r.dup.length * mmPerPx(r);
    for (const t of [name + (k === cur ? '（表示中）' : ''), r.loops.length + ' 本', nPts.toLocaleString() + ' 点', fmt1(mm) + ' mm'])
      tr.append(Object.assign(document.createElement('td'), { textContent: t }));
    tb.append(tr);
  }
  $('compare').hidden = false;
}
const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);
// 処理解像度の 1px が出力で何 mm か
function mmPerPx(r) {
  if (circleMode() && r.circle) return outD() / Math.max(2 * r.circle.r, 1e-9) * (S.W / S.w);
  return outW() / S.w;
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
  // 出力する色の領域を塗る（輪郭を出力しない領域も、どの色として抽出されたか分かるように）
  if ($('showFill').checked) {
    const labels = dedupeOn() && S.clean ? S.clean.labels : S.labels;
    const off = document.createElement('canvas');
    off.width = S.w; off.height = S.h;
    const octx = off.getContext('2d'), id = octx.createImageData(S.w, S.h), d = id.data;
    const lut = S.palette.map(p => fillOf(p.rgb));
    for (let i = 0; i < labels.length; i++) {
      if (!S.enabled.has(labels[i])) continue;
      const c = lut[labels[i]];
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 72;
    }
    octx.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, S.w * scale, S.h * scale);
    ctx.imageSmoothingEnabled = true;
  }
  ctx.lineWidth = lw; ctx.lineJoin = 'round';
  for (const l of S.loops) {
    ctx.beginPath(); pathLoop(ctx, l.p, scale);
    ctx.strokeStyle = strokeOf(S.palette[l.label].rgb);
    ctx.stroke();
  }
  if ($('showDup').checked) {
    const r = S.results[dedupeOn() ? 'dedupe' : 'legacy'];
    ctx.save();
    ctx.strokeStyle = 'rgba(220,30,30,.85)'; ctx.lineWidth = lw * 4; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const s of r.dup.spans) { ctx.moveTo(s[0] * scale, s[1] * scale); ctx.lineTo(s[2] * scale, s[3] * scale); }
    ctx.stroke();
    ctx.restore();
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

// 読み込んだ曲線のプレビュー（mm 座標、Y 上向き）
function drawVector() {
  // STL は断面ごとに拡大率が変わらないよう、STL 全体の XY の範囲で描く
  const curves = S.vec.curves, b = S.vec.mesh ? S.vec.mesh.frame : curveBounds(curves);
  const w = Math.max(b.maxX - b.minX, 1e-9), h = Math.max(b.maxY - b.minY, 1e-9);
  const m = Math.max(w, h) * 0.03, scale = 1200 / (Math.max(w, h) + 2 * m);
  const c = $('outCanvas');
  c.width = Math.max(1, Math.round((w + 2 * m) * scale)); c.height = Math.max(1, Math.round((h + 2 * m) * scale));
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const X = x => (x - b.minX + m) * scale, Y = y => (b.maxY - y + m) * scale;
  const lw = Math.max(1, c.width / 700);
  ctx.lineWidth = lw; ctx.lineJoin = 'round';
  for (const cv of curves) {
    const p = cv.pts;
    ctx.beginPath(); ctx.moveTo(X(p[0]), Y(p[1]));
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(X(p[i]), Y(p[i + 1]));
    if (cv.closed) ctx.closePath();
    // 開いた曲線は色を変えて区別する
    ctx.strokeStyle = cv.closed ? '#2f6fb0' : '#c0392b';
    ctx.stroke();
  }
  if ($('showPoints').checked) {
    ctx.fillStyle = '#dc6b31';
    const r = lw * 1.4;
    for (const cv of curves) for (let i = 0; i < cv.pts.length; i += 2) ctx.fillRect(X(cv.pts[i]) - r, Y(cv.pts[i + 1]) - r, r * 2, r * 2);
  }
}

function showVectorInfo() {
  const curves = S.vec.curves, nOpen = curves.filter(c => !c.closed).length;
  const nPts = curves.reduce((a, c) => a + c.pts.length / 2 + (c.closed ? 1 : 0), 0);
  const b = curveBounds(curves);
  const layers = [...new Set(curves.map(c => c.layer))];
  $('resultInfo').textContent = `${curves.length} 本・${nPts.toLocaleString()} 点`;
  $('downloadTxt').disabled = $('downloadDxf').disabled = curves.length === 0;
  if (S.vec.mesh) {
    $('zNow').textContent = `Z = ${fmtZ(S.vec.z)} mm`;
    if (!curves.length) { setStatus(`Z = ${fmtZ(S.vec.z)} mm には断面がありません。`, true); return; }
  }
  const head = S.vec.mesh
    ? `STL（三角形 ${S.vec.mesh.n.toLocaleString()} 枚）の Z = ${fmtZ(S.vec.z)} mm の断面`
      + (Math.abs(S.vec.z - S.vec.zAsked) > 1e-12 ? `（Z = ${fmtZ(S.vec.zAsked)} mm は面や頂点と重なるため、少しずらして切りました）` : '')
    : `${S.vec.kind === 'dxf' ? 'DXF' : 'Point Curve'} を読み込みました`;
  const msg = [`${head}。曲線 ${curves.length} 本（閉曲線 ${curves.length - nOpen}・開いた曲線 ${nOpen}）、合計 ${nPts.toLocaleString()} 点`,
    `範囲 X ${fmt(b.minX)}〜${fmt(b.maxX)}・Y ${fmt(b.minY)}〜${fmt(b.maxY)} mm（${fmt(b.maxX - b.minX)} × ${fmt(b.maxY - b.minY)} mm）`];
  if (S.vec.kind === 'dxf') msg.push('画層 ' + layers.join('、'));
  if (S.vec.polyline !== null && S.vec.polyline !== undefined) msg.push(`読み込み方式（Polyline）をファイルに合わせて ${S.vec.polyline ? 'True' : 'False'} にしました`);
  if (nOpen) msg.push('開いた曲線は赤で表示しています。DesignSpark Mechanical は開いた Point Curve を読み込めません');
  setStatus(msg.concat(S.vec.notes).join('。') + '。', nOpen > 0);
}

function curveBounds(curves) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of curves) for (let i = 0; i < c.pts.length; i += 2) {
    const x = c.pts[i], y = c.pts[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function pathLoop(ctx, p, s) {
  ctx.moveTo(p[0] * s, p[1] * s);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * s, p[i + 1] * s);
  ctx.closePath();
}
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const fillOf = c => lum(c) > 215 ? [120, 135, 150] : c;
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

// 出力する曲線：{ pts（mm）, closed, layer, aci }。
// 画像からは抽出した輪郭を mm に換算し、読み込んだ Point Curve / DXF は座標をそのまま使う。
function outputCurves() {
  if (S.vec) return S.vec.curves.map(c => ({ ...c, aci: c.aci || 7 }));
  const f = mmMapper(), mono = $('mode').value === 'mono';
  return S.loops.map(l => {
    const pts = new Float64Array(l.p.length);
    for (let i = 0; i < l.p.length; i += 2) [pts[i], pts[i + 1]] = f(l.p[i], l.p[i + 1]);
    return {
      pts, closed: true,
      layer: mono ? 'CONTOUR' : `COLOR_${String(l.label + 1).padStart(2, '0')}`,
      aci: mono ? 7 : aciOf(S.palette[l.label].rgb),
    };
  });
}

function txtString() {
  const pt = (x, y) => `0 ${x.toFixed(4)} ${y.toFixed(4)}`;
  // 閉曲線は最後に始点を再出力する。開いた曲線はそのまま出力する
  const blocks = outputCurves().map(c => {
    const rows = [];
    for (let i = 0; i < c.pts.length; i += 2) rows.push(pt(c.pts[i], c.pts[i + 1]));
    if (c.closed) rows.push(rows[0]);
    return rows.join('\r\n');
  });
  return `Polyline=${$('txtPolyline').value === 'true' ? 'True' : 'False'}\r\n` + blocks.join('\r\n\r\n') + '\r\n';
}

// DXF（R12 / AC1009 の ASCII 形式）。互換性を優先し、各輪郭を閉じた POLYLINE として出力する。
// 単位は mm（$INSUNITS=4）。カラーでは出力する色ごとに画層を分け、読み込んだ DXF は元の画層を保つ。
function dxfString() {
  const curves = outputCurves();
  const layers = new Map();
  for (const c of curves) if (c.layer !== '0' && !layers.has(c.layer)) layers.set(c.layer, c.aci);
  const out = [];
  const g = (code, v) => out.push(String(code), String(v));
  const num = v => v.toFixed(4);
  const b = curveBounds(curves);

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$MEASUREMENT'); g(70, 1);
  g(9, '$EXTMIN'); g(10, num(b.minX)); g(20, num(b.minY)); g(30, '0.0');
  g(9, '$EXTMAX'); g(10, num(b.maxX)); g(20, num(b.maxY)); g(30, '0.0');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.size + 1);
  g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
  for (const [name, aci] of layers) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, aci); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const c of curves) {
    g(0, 'POLYLINE'); g(8, c.layer); g(66, 1); g(10, '0.0'); g(20, '0.0'); g(30, '0.0'); g(70, c.closed ? 1 : 0);
    for (let i = 0; i < c.pts.length; i += 2) {
      g(0, 'VERTEX'); g(8, c.layer); g(10, num(c.pts[i])); g(20, num(c.pts[i + 1])); g(30, '0.0');
    }
    g(0, 'SEQEND'); g(8, c.layer);
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

// 画層の色：AutoCAD 色番号（ACI）の基本色から最も近いものを選ぶ。
// 白に近い色は、背景が白でも黒でも見える 7（白／黒）にする。
const ACI = [[1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]], [5, [0, 0, 255]],
  [6, [255, 0, 255]], [7, [255, 255, 255]], [7, [0, 0, 0]], [8, [128, 128, 128]], [9, [192, 192, 192]]];
function aciOf(rgb) {
  let best = 7, bd = Infinity;
  for (const [n, c] of ACI) {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
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
  $('sliverField').hidden = !(color && dedupeOn());
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
  if (S.img) { $('mode').value = detectMode(); syncHeightFromWidth(); }  syncModeControls(); syncOutputs();
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
$('absorbSliver').addEventListener('change', () => process(2));
['epsilon', 'smooth'].forEach(id => $(id).addEventListener('input', () => { syncOutputs(); process(3); }));
$('minArea').addEventListener('input', () => { syncOutputs(); process(2); });
$('dedupe').addEventListener('change', () => { syncModeControls(); process(4); });
$('showDup').addEventListener('change', () => { if (S.img) drawResult(); });
$('sizeMode').addEventListener('change', () => { syncModeControls(); if (S.img) { drawResult(); showInfo(); } });
$('outD').addEventListener('input', () => { if (S.img) showInfo(); });
$('showPoints').addEventListener('change', () => { if (S.vec) drawVector(); });
$('zSlider').addEventListener('input', e => sliceAt(Number(e.target.value)));
$('zInput').addEventListener('change', e => { const v = Number(e.target.value); if (Number.isFinite(v)) sliceAt(v); });
$('zInput').addEventListener('blur', () => { if (S.vec && S.vec.mesh) $('zInput').value = fmtZ(S.vec.zAsked); });
['showImage', 'showPoints', 'showFill', 'showCircle'].forEach(id => $(id).addEventListener('change', () => { if (S.img) drawResult(); }));
$('outW').addEventListener('input', () => { syncHeightFromWidth(); if (S.img) showInfo(); });
$('outH').addEventListener('input', () => { syncWidthFromHeight(); if (S.img) showInfo(); });
$('reset').addEventListener('click', () => { applyDefaults(); if (S.img) process(1); });
function outputReady() {
  if (S.vec) return S.vec.curves.length > 0;
  if (!S.loops.length) return false;
  const ok = circleMode() ? Number($('outD').value) > 0 : Number($('outW').value) > 0 && Number($('outH').value) > 0;
  if (!ok) setStatus('出力サイズには正の値を入力してください。', true);
  return ok;
}
// STL の断面は、切った高さをファイル名に入れる
const outName = () => S.vec && S.vec.mesh ? `${S.name}_z${fmtZ(S.vec.z)}` : S.name;
$('downloadTxt').addEventListener('click', () => { if (outputReady()) download(`${outName()}_point_curve.txt`, txtString()); });
$('downloadDxf').addEventListener('click', () => { if (outputReady()) download(`${outName()}.dxf`, dxfString()); });

applyDefaults();
