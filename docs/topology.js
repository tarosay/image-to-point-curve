'use strict';
// 重複を減らす輪郭抽出。
// 色の画像を「領域（同じ色で4近傍につながった画素）」と「領域の境界線」に分け、
// 境界線を3色以上が接する点（分岐点）で区間に分ける。区間は一度だけ平滑化・簡略化するので、
// 同じ境界を共有する輪郭は同じ座標になる。出力する領域は、出力対象の境界線をすべて覆い、
// 両側とも出力されて重複する区間の長さが最小になるように選ぶ。出力はすべて領域の外周か穴なので閉曲線になる。
//
// 座標は処理解像度の px。画素 (x,y) は [x,x+1]×[y,y+1] を占め、境界線は画素の辺（角から角）を通る。

// ---------------------------------------------------------------- 領域（連結成分）

// 上下左右に接する同じ色の画素はつながる。斜めに向かい合う同じ色の画素も、
// その 2×2 でもう一方の対角が同じ色どうしでなければつながる（細い斜めの線が途切れないように）。
// 両方の対角が同じ色どうしで競合するときは pri（色ごとの優先度）が高い方をつなぐ。
// diag[角] = 1：左上と右下がつながる、2：右上と左下がつながる（角 (x,y) は画素 (x-1,y-1)〜(x,y) の中心）。
function labelComponents(labels, w, h, pri) {
  const n = w * h, parent = new Int32Array(n), W1 = w + 1, diag = new Uint8Array(W1 * (h + 1));
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { i = find(i); j = find(j); if (i !== j) parent[Math.max(i, j)] = Math.min(i, j); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x < w - 1 && labels[i] === labels[i + 1]) union(i, i + 1);
    if (y < h - 1 && labels[i] === labels[i + w]) union(i, i + w);
  }
  for (let y = 1; y < h; y++) for (let x = 1; x < w; x++) {
    const ia = (y - 1) * w + x - 1, ib = ia + 1, ic = ia + w, id = ic + 1;
    const a = labels[ia], b = labels[ib], c = labels[ic], d = labels[id];
    const ad = a === d && a !== b && a !== c, bc = b === c && b !== a && b !== d;
    let f = 0;
    if (ad && bc) f = (pri ? pri[a] >= pri[b] : true) ? 1 : 2;
    else if (ad) f = 1;
    else if (bc) f = 2;
    if (f === 1) union(ia, id); else if (f === 2) union(ib, ic);
    diag[y * W1 + x] = f;
  }
  const comp = new Int32Array(n), root = new Int32Array(n).fill(-1), compLabel = [], compArea = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (root[r] < 0) { root[r] = count++; compLabel.push(labels[i]); compArea.push(0); }
    comp[i] = root[r]; compArea[comp[i]]++;
  }
  return { comp, compLabel, compArea, count, diag };
}

// 斜めのつながりで競合したときの色の優先度：出力する色を優先し、次に暗い色（線や縁取りに多い）を優先する
function colorPriority(palette, enabled) {
  return palette.map((p, j) => (enabled.has(j) ? 1000 : 0) + 255 - (0.299 * p.rgb[0] + 0.587 * p.rgb[1] + 0.114 * p.rgb[2]));
}

// ---------------------------------------------------------------- 小さな領域・中間色の吸収

// 次の領域の画素を、隣の色のうち元の画素の色に最も近い色へ塗り替える。
//  ・面積が minArea 未満の領域（点状のゴミ・小さな穴）
//  ・sliver が真のとき：幅2画素以下で、2つの異なる隣の色の「中間の色」をした領域
//    （色の境目のにじみが第3の色に振り分けられたもの）。隣の色が1種類だけの細い線
//    （白地の黒い線など）や、隣の色の中間でない色の線は吸収しない。
function cleanLabels(labels, w, h, palette, rgba, opt) {
  const { comp, compLabel, compArea, count } = labelComponents(labels, w, h, opt.pri);
  const absorb = new Uint8Array(count);
  let nSmall = 0, nSliver = 0;
  for (let c = 0; c < count; c++) if (compArea[c] < opt.minArea) { absorb[c] = 1; nSmall++; }

  if (opt.sliver && palette.length >= 3) {
    const interior = new Uint8Array(count), nbr = new Uint32Array(count);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, c = comp[i];
      if (x > 0 && labels[i - 1] !== labels[i]) nbr[c] |= 1 << labels[i - 1];
      if (x < w - 1 && labels[i + 1] !== labels[i]) nbr[c] |= 1 << labels[i + 1];
      if (y > 0 && labels[i - w] !== labels[i]) nbr[c] |= 1 << labels[i - w];
      if (y < h - 1 && labels[i + w] !== labels[i]) nbr[c] |= 1 << labels[i + w];
      if (interior[c] || x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
      let all = true;
      for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (comp[i + dy * w + dx] !== c) { all = false; break; }
      if (all) interior[c] = 1;
    }
    for (let c = 0; c < count; c++) {
      if (absorb[c] || interior[c]) continue;
      const ls = [];
      for (let l = 0; l < palette.length; l++) if (nbr[c] & (1 << l)) ls.push(l);
      if (ls.length < 2) continue;
      const P = palette[compLabel[c]].rgb;
      let between = false;
      for (let a = 0; a < ls.length && !between; a++) for (let b = a + 1; b < ls.length; b++) {
        const A = palette[ls[a]].rgb, B = palette[ls[b]].rgb;
        const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
        if (!L2) continue;
        const t = ((P[0] - A[0]) * ab[0] + (P[1] - A[1]) * ab[1] + (P[2] - A[2]) * ab[2]) / L2;
        if (t <= 0.05 || t >= 0.95) continue;
        const d = Math.hypot(A[0] + t * ab[0] - P[0], A[1] + t * ab[1] - P[1], A[2] + t * ab[2] - P[2]);
        if (d <= Math.max(20, 0.2 * Math.sqrt(L2))) { between = true; break; }
      }
      if (between) { absorb[c] = 1; nSliver++; }
    }
  }

  const out = Uint8Array.from(labels);
  if (!nSmall && !nSliver) return { labels: out, nSmall, nSliver };
  // 吸収しない画素から内側へ1層ずつ塗り替える（同じ層の中では順序の影響を受けないよう、確定は層ごと）
  const n = w * h, pending = new Uint8Array(n);
  let frontier = [];
  for (let i = 0; i < n; i++) if (absorb[comp[i]]) pending[i] = 1;
  const neighbors = i => {
    const x = i % w, r = [];
    if (x > 0) r.push(i - 1); if (x < w - 1) r.push(i + 1); if (i >= w) r.push(i - w); if (i < n - w) r.push(i + w);
    return r;
  };
  for (let i = 0; i < n; i++) if (pending[i] && neighbors(i).some(j => !pending[j])) frontier.push(i);
  while (frontier.length) {
    const assign = [];
    for (const i of frontier) {
      let best = -1, bd = Infinity;
      for (const j of neighbors(i)) {
        if (pending[j]) continue;
        const c = palette[out[j]].rgb, dd = (rgba[i * 4] - c[0]) ** 2 + (rgba[i * 4 + 1] - c[1]) ** 2 + (rgba[i * 4 + 2] - c[2]) ** 2;
        if (dd < bd) { bd = dd; best = out[j]; }
      }
      if (best >= 0) assign.push(i, best);
    }
    if (!assign.length) break;
    const next = [];
    for (let k = 0; k < assign.length; k += 2) { out[assign[k]] = assign[k + 1]; pending[assign[k]] = 0; }
    for (let k = 0; k < assign.length; k += 2) for (const j of neighbors(assign[k])) if (pending[j] === 1) { pending[j] = 2; next.push(j); }
    for (const j of next) pending[j] = 1;
    frontier = next;
  }
  return { labels: out, nSmall, nSliver };
}

// ---------------------------------------------------------------- 境界線の区間

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];   // 0:東 1:南 2:西 3:北（y 下向き）

// 画素 (px,py) が角 (qx,qy) の斜めにつながる組（diag の値 f）に含まれるか
function inPair(f, qx, qy, px, py) {
  return f === 1 ? (px === qx - 1 && py === qy - 1) || (px === qx && py === qy)
    : (px === qx && py === qy - 1) || (px === qx - 1 && py === qy);
}

function buildGraph(labels, w, h, pri) {
  const { comp, compLabel, compArea, count, diag } = labelComponents(labels, w, h, pri);
  const OUT = count, W1 = w + 1, HN = (h + 1) * w, VN = (w + 1) * h;
  const cp = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? OUT : comp[y * w + x];
  // 水平の辺 h(x,y)：角 (x,y)-(x+1,y)、画素 (x,y-1) と (x,y) の間
  // 垂直の辺 v(x,y)：角 (x,y)-(x,y+1)、画素 (x-1,y) と (x,y) の間
  const isB = new Uint8Array(HN + VN);
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) isB[y * w + x] = cp(x, y - 1) !== cp(x, y) ? 1 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) isB[HN + y * W1 + x] = cp(x - 1, y) !== cp(x, y) ? 1 : 0;
  const incident = (x, y) => [
    x > 0 ? y * w + x - 1 : -1, x < w ? y * w + x : -1,
    y > 0 ? HN + (y - 1) * W1 + x : -1, y < h ? HN + y * W1 + x : -1,
  ];
  const deg = new Uint8Array(W1 * (h + 1));
  for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
    let d = 0;
    for (const c of incident(x, y)) if (c >= 0 && isB[c]) d++;
    deg[y * W1 + x] = d;
  }
  const ends = c => {
    if (c < HN) { const y = Math.floor(c / w), x = c % w; return [y * W1 + x, y * W1 + x + 1]; }
    const j = c - HN, y = Math.floor(j / W1), x = j % W1;
    return [y * W1 + x, (y + 1) * W1 + x];
  };
  const otherEnd = (c, q) => { const e = ends(c); return e[0] === q ? e[1] : e[0]; };
  const pixelsOf = c => {
    if (c < HN) { const y = Math.floor(c / w), x = c % w; return [[x, y - 1], [x, y]]; }
    const j = c - HN, y = Math.floor(j / W1), x = j % W1;
    return [[x - 1, y], [x, y]];
  };
  // 斜めにつながる角 q で、辺 c に接する「つながっていない側」の画素
  const sepPixel = (q, c) => {
    const f = diag[q], qx = q % W1, qy = Math.floor(q / W1), [p1, p2] = pixelsOf(c);
    return inPair(f, qx, qy, p1[0], p1[1]) ? p2 : p1;
  };
  // 境界がそのまま通り抜ける角：境界の辺が2本の角と、斜めにつながる角
  // （斜めにつながる角は、つながっていない側の画素ごとに2本ずつ組になって通り抜ける）
  const through = q => deg[q] === 2 || diag[q] !== 0;
  const otherCrack = (q, c) => {
    const inc = incident(q % W1, Math.floor(q / W1));
    if (diag[q]) {
      const s = sepPixel(q, c);
      for (const k of inc) if (k >= 0 && k !== c && isB[k]) { const t = sepPixel(q, k); if (t[0] === s[0] && t[1] === s[1]) return k; }
      return -1;
    }
    for (const k of inc) if (k >= 0 && k !== c && isB[k]) return k;
    return -1;
  };
  const sides = c => {
    if (c < HN) { const y = Math.floor(c / w), x = c % w; return [cp(x, y - 1), cp(x, y)]; }
    const j = c - HN, y = Math.floor(j / W1), x = j % W1;
    return [cp(x - 1, y), cp(x, y)];
  };

  const crackChain = new Int32Array(HN + VN).fill(-1), crackStart = new Int32Array(HN + VN);
  const chains = [];
  for (let c0 = 0; c0 < HN + VN; c0++) {
    if (!isB[c0] || crackChain[c0] >= 0) continue;
    const [P0, Q0] = ends(c0);
    let cr = [c0], co = [P0, Q0], closed = false, cur = c0, q = Q0;
    while (through(q)) {
      const nc = otherCrack(q, cur);
      if (nc === c0) { closed = true; break; }
      cr.push(nc); q = otherEnd(nc, q); co.push(q); cur = nc;
    }
    if (!closed) {
      const bcr = [], bco = [];
      let p = P0; cur = c0;
      while (through(p)) {
        const nc = otherCrack(p, cur);
        bcr.push(nc); p = otherEnd(nc, p); bco.push(p); cur = nc;
      }
      cr = bcr.reverse().concat(cr); co = bco.reverse().concat(co);
    }
    const id = chains.length;
    for (let k = 0; k < cr.length; k++) { crackChain[cr[k]] = id; crackStart[cr[k]] = co[k]; }
    const m = closed ? co.length - 1 : co.length, pts = new Float64Array(m * 2);
    for (let k = 0; k < m; k++) {
      const q = co[k], qx = q % W1, qy = Math.floor(q / W1);
      if (diag[q]) {
        // 斜めにつながる角は、つながっていない側の画素へ 0.25px 寄せる（角を切る）。
        // 同じ角を通る別の曲線と1点で接しないようにするため。
        const s = sepPixel(q, cr[Math.min(k, cr.length - 1)]);
        pts[k * 2] = qx + 0.5 * (s[0] + 0.5 - qx); pts[k * 2 + 1] = qy + 0.5 * (s[1] + 0.5 - qy);
      } else { pts[k * 2] = qx; pts[k * 2 + 1] = qy; }
    }
    const [a, b] = sides(c0);
    chains.push({ a, b, closed, pts, len: cr.length, sp: null });
  }
  return { w, h, comp, compLabel, compArea, count, OUT, cp, isB, HN, W1, diag, crackChain, crackStart, chains };
}

// ---------------------------------------------------------------- 区間ごとの平滑化・簡略化（1回だけ）

function smoothOpen(p, iters) {
  const n = p.length / 2;
  if (n < 3 || !iters) return Float64Array.from(p);
  let a = Float64Array.from(p), b = Float64Array.from(p);
  for (let it = 0; it < iters; it++) {
    for (let i = 1; i < n - 1; i++) {
      b[i * 2] = (a[i * 2 - 2] + 2 * a[i * 2] + a[i * 2 + 2]) / 4;
      b[i * 2 + 1] = (a[i * 2 - 1] + 2 * a[i * 2 + 1] + a[i * 2 + 3]) / 4;
    }
    [a, b] = [b, a];
  }
  return a;
}

// 端点を固定した Douglas–Peucker。force が真なら、端点だけにならないよう最遠点を1つ残す。
function simplifyOpen(p, eps, force) {
  const n = p.length / 2;
  if (n <= 2) return Float64Array.from(p);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  let first = true;
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const sx = p[s * 2], sy = p[s * 2 + 1], dx = p[e * 2] - sx, dy = p[e * 2 + 1] - sy, len = Math.hypot(dx, dy);
    let mi = -1, md = -1;
    for (let i = s + 1; i < e; i++) {
      const d = len > 1e-12 ? Math.abs(dx * (p[i * 2 + 1] - sy) - dy * (p[i * 2] - sx)) / len
        : Math.hypot(p[i * 2] - sx, p[i * 2 + 1] - sy);
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps || (first && force && md > 1e-6)) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
    first = false;
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return new Float64Array(out);
}

function simplifyChains(G, iters, eps) {
  // 同じ2つの分岐点を結ぶ区間が複数あると、両方が直線に簡略化されて面積のない輪郭になるため、内側の点を1つ残す
  const pairCount = new Map();
  const key = ch => {
    const n = ch.pts.length / 2, a = ch.pts[0] + ',' + ch.pts[1], b = ch.pts[n * 2 - 2] + ',' + ch.pts[n * 2 - 1];
    return a < b ? a + '|' + b : b + '|' + a;
  };
  for (const ch of G.chains) if (!ch.closed) pairCount.set(key(ch), (pairCount.get(key(ch)) || 0) + 1);
  for (const ch of G.chains) {
    if (ch.closed) { ch.sp = simplifyClosed(smoothLoop(ch.pts, iters), eps, true); continue; }
    const n = ch.pts.length / 2, s = smoothOpen(ch.pts, iters);
    if (ch.pts[0] === ch.pts[n * 2 - 2] && ch.pts[1] === ch.pts[n * 2 - 1]) {
      // 始点と終点が同じ分岐点の区間：閉曲線として簡略化し（始点は残る）、終点を付け直す
      const c = simplifyClosed(s.subarray(0, n * 2 - 2), eps, true), r = new Float64Array(c.length + 2);
      r.set(c); r[c.length] = c[0]; r[c.length + 1] = c[1];
      ch.sp = r;
    } else {
      ch.sp = simplifyOpen(s, eps, pairCount.get(key(ch)) > 1);
    }
  }
}

// ---------------------------------------------------------------- 出力する領域の選択

// 戻り値：chosen[c] = 1 なら領域 c の外周と穴を出力する。
// 条件：出力対象の区間（少なくとも片側が出力する色）はすべて、選んだ領域のどれかの縁にある。
//       出力しない区間（両側とも出力しない色、または画像の外）を縁に持つ領域は選ばない。
// 目的：両側とも選ばれる区間の長さの合計を最小にする。
//       選ばない領域の集合 T は「互いに接しない」必要があり、T の領域の縁の長さの合計を最大化すればよい
//       （重み付き最大独立集合）。領域が少ないグループは厳密に、多いグループは貪欲法で解く。
function selectFaces(G, isEnabledComp) {
  const C = G.count, chains = G.chains;
  const en = c => c < C && isEnabledComp(c);
  const req = chains.map(ch => en(ch.a) || en(ch.b));
  const cand = new Uint8Array(C + 1).fill(1);
  cand[C] = 0;
  chains.forEach((ch, i) => { if (!req[i]) { cand[ch.a] = 0; cand[ch.b] = 0; } });
  const chosen = new Uint8Array(C + 1);
  chains.forEach((ch, i) => {
    if (!req[i]) return;
    const ca = cand[ch.a], cb = cand[ch.b];
    if (ca && !cb) chosen[ch.a] = 1;
    else if (cb && !ca) chosen[ch.b] = 1;
    else if (!ca && !cb) { if (en(ch.a)) chosen[ch.a] = 1; if (en(ch.b)) chosen[ch.b] = 1; }
  });
  const free = c => c < C && cand[c] && !chosen[c];
  const weight = new Float64Array(C), adj = new Map();
  chains.forEach((ch, i) => {
    if (!req[i]) return;
    if (free(ch.a)) weight[ch.a] += ch.len;
    if (free(ch.b)) weight[ch.b] += ch.len;
    if (free(ch.a) && free(ch.b)) {
      if (!adj.has(ch.a)) adj.set(ch.a, new Set());
      if (!adj.has(ch.b)) adj.set(ch.b, new Set());
      adj.get(ch.a).add(ch.b); adj.get(ch.b).add(ch.a);
    }
  });
  const seen = new Uint8Array(C);
  let exact = true;
  for (let s = 0; s < C; s++) {
    if (!free(s) || seen[s]) continue;
    const group = [s];
    seen[s] = 1;
    for (let k = 0; k < group.length; k++) for (const v of adj.get(group[k]) || []) if (!seen[v]) { seen[v] = 1; group.push(v); }
    const { set, optimal } = maxWeightIndependentSet(group, adj, weight);
    if (!optimal) exact = false;
    for (const v of group) if (!set.has(v)) chosen[v] = 1;
  }
  // 念のため：覆われていない出力対象の区間があれば、出力する色の側を選ぶ（輪郭を失わないため）
  chains.forEach((ch, i) => {
    if (req[i] && !chosen[ch.a] && !chosen[ch.b]) { if (en(ch.a)) chosen[ch.a] = 1; else chosen[ch.b] = 1; }
  });
  chosen[C] = 0;
  return { chosen, exact };
}

function maxWeightIndependentSet(group, adj, weight) {
  const n = group.length, idx = new Map(group.map((v, i) => [v, i]));
  const nb = group.map(v => [...(adj.get(v) || [])].map(u => idx.get(u)));
  const wt = group.map(v => weight[v]);
  // 貪欲法（重み ÷ (次数+1) の大きい順）
  const order = group.map((_, i) => i).sort((a, b) => wt[b] / (nb[b].length + 1) - wt[a] / (nb[a].length + 1));
  const blocked = new Uint8Array(n);
  let best = 0, bestSet = [];
  for (const i of order) if (!blocked[i]) { bestSet.push(i); best += wt[i]; blocked[i] = 1; for (const j of nb[i]) blocked[j] = 1; }
  let optimal = n <= 1;
  if (n > 1 && n <= 60) {
    let nodes = 0;
    const LIMIT = 300000;
    const rec = (alive, cur, curW) => {
      if (++nodes > LIMIT) return;
      let rem = 0, pick = -1, pd = -1;
      for (let i = 0; i < n; i++) if (alive[i]) {
        rem += wt[i];
        let d = 0;
        for (const j of nb[i]) if (alive[j]) d++;
        if (d > pd) { pd = d; pick = i; }
      }
      if (curW + rem <= best + 1e-9) return;
      if (pd <= 0) {   // 残りは互いに接しないので全部入れる
        const set = cur.slice();
        for (let i = 0; i < n; i++) if (alive[i]) set.push(i);
        best = curW + rem; bestSet = set;
        return;
      }
      const a1 = alive.slice();
      a1[pick] = 0;
      for (const j of nb[pick]) a1[j] = 0;
      cur.push(pick); rec(a1, cur, curW + wt[pick]); cur.pop();
      const a2 = alive.slice();
      a2[pick] = 0;
      rec(a2, cur, curW);
    };
    rec(new Uint8Array(n).fill(1), [], 0);
    optimal = nodes <= LIMIT;
  }
  return { set: new Set(bestSet.map(i => group[i])), optimal };
}

// ---------------------------------------------------------------- 選んだ領域の閉曲線

// 領域を左手に見ながら画素の辺をたどり（4近傍の連結に合わせ、斜めの画素は別の領域として回り込む）、
// 通った区間を簡略化済みの座標に置き換えてつなぐ。
function faceLoops(G, chosen) {
  const { w, h, cp, isB, HN, W1, diag, crackChain, crackStart, chains } = G;
  const leftPix = (x, y, d) => d === 0 ? [x, y - 1] : d === 1 ? [x, y] : d === 2 ? [x - 1, y] : [x - 1, y - 1];
  const rightPix = (x, y, d) => d === 0 ? [x, y] : d === 1 ? [x - 1, y] : d === 2 ? [x - 1, y - 1] : [x, y - 1];
  const crackOf = (x, y, d) => d === 0 ? y * w + x : d === 2 ? y * w + x - 1 : d === 1 ? HN + y * W1 + x : HN + (y - 1) * W1 + x;
  const sideOf = d => (d === 0 || d === 3) ? 0 : 1;
  const visited = new Uint8Array(isB.length * 2);
  const loops = [];

  const trace = (f, sx, sy, sd) => {
    let x = sx, y = sy, d = sd;
    const runs = [];
    do {
      const c = crackOf(x, y, d);
      visited[c * 2 + sideOf(d)] = 1;
      const ch = crackChain[c], fwd = crackStart[c] === y * W1 + x;
      const last = runs[runs.length - 1];
      if (!last || last[0] !== ch || last[1] !== fwd) runs.push([ch, fwd]);
      x += DX[d]; y += DY[d];
      const [ax, ay] = leftPix(x, y, d), [bx, by] = rightPix(x, y, d), al = cp(ax, ay), ar = cp(bx, by);
      if (al === f) { if (ar === f) d = (d + 1) % 4; }
      else if (ar === f && diag[y * W1 + x] && inPair(diag[y * W1 + x], x, y, bx, by)) d = (d + 1) % 4;  // 斜めのつながりを通る
      else d = (d + 3) % 4;
    } while (!(x === sx && y === sy && d === sd));
    if (runs.length > 1 && runs[0][0] === runs[runs.length - 1][0] && runs[0][1] === runs[runs.length - 1][1]) runs.pop();
    const out = [];
    for (const [ch, fwd] of runs) {
      const sp = chains[ch].sp, n = sp.length / 2;
      if (chains[ch].closed) {
        for (let k = 0; k < n; k++) { const i = fwd ? k : (n - k) % n; out.push(sp[i * 2], sp[i * 2 + 1]); }
      } else {
        for (let k = 0; k < n - 1; k++) { const i = fwd ? k : n - 1 - k; out.push(sp[i * 2], sp[i * 2 + 1]); }
      }
    }
    return new Float64Array(out);
  };

  for (let c = 0; c < isB.length; c++) {
    if (!isB[c]) continue;
    let starts;
    if (c < HN) {
      const y = Math.floor(c / w), x = c % w;
      starts = [[cp(x, y - 1), x, y, 0], [cp(x, y), x + 1, y, 2]];
    } else {
      const j = c - HN, y = Math.floor(j / W1), x = j % W1;
      starts = [[cp(x, y), x, y, 1], [cp(x - 1, y), x, y + 1, 3]];
    }
    for (const [f, sx, sy, sd] of starts) {
      if (!chosen[f] || visited[c * 2 + sideOf(sd)]) continue;
      const p = trace(f, sx, sy, sd);
      if (p.length >= 6) loops.push({ comp: f, label: G.compLabel[f], p });
    }
  }
  return loops;
}

// ---------------------------------------------------------------- 重複区間の測定（比較用）

// 各輪郭の線を約1px ごとに調べ、別の色の輪郭の線から tol px 以内にある部分を「重複」とみなす。
// 隣り合う2色の境界が両方の色から出力されたものが重複なので、同じ色の輪郭どうし
// （細い線の表と裏など）は数えない。重なっている2本の両方で数えるため、合計を2で割る。
function duplicateMetric(loops, tol) {
  const segs = [];
  loops.forEach(l => {
    const p = l.p, n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      segs.push([p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], l.label]);
    }
  });
  const G = 6, grid = new Map(), cell = (x, y) => Math.floor(x / G) + ',' + Math.floor(y / G);
  segs.forEach((s, si) => {
    const x0 = Math.floor((Math.min(s[0], s[2]) - tol) / G), x1 = Math.floor((Math.max(s[0], s[2]) + tol) / G);
    const y0 = Math.floor((Math.min(s[1], s[3]) - tol) / G), y1 = Math.floor((Math.max(s[1], s[3]) + tol) / G);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = gx + ',' + gy;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(si);
    }
  });
  const near = (x, y, label) => {
    for (const si of grid.get(cell(x, y)) || []) {
      const s = segs[si];
      if (s[4] === label) continue;
      const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / L2)) : 0;
      if (Math.hypot(x - s[0] - t * dx, y - s[1] - t * dy) <= tol) return true;
    }
    return false;
  };
  let total = 0;
  const spans = [];
  for (const s of segs) {
    const len = Math.hypot(s[2] - s[0], s[3] - s[1]), k = Math.max(1, Math.ceil(len));
    let open = -1;
    for (let i = 0; i <= k; i++) {
      const dup = i < k && near(s[0] + (s[2] - s[0]) * (i + 0.5) / k, s[1] + (s[3] - s[1]) * (i + 0.5) / k, s[4]);
      if (dup) { total += len / k; if (open < 0) open = i; }
      else if (open >= 0) {
        spans.push([s[0] + (s[2] - s[0]) * open / k, s[1] + (s[3] - s[1]) * open / k, s[0] + (s[2] - s[0]) * i / k, s[1] + (s[3] - s[1]) * i / k]);
        open = -1;
      }
    }
  }
  return { length: total / 2, spans };
}
