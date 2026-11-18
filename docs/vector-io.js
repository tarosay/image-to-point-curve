'use strict';
// Point Curve TXT と DXF の読み込み。
// 結果はどちらも { curves: [{ pts: Float64Array（mm の x,y の並び）, closed, layer, aci? }], notes: [文字列], polyline? }。
// 閉じた曲線は始点を末尾に重ねて持たない。

const VIO_ARC_TOL = 0.01;     // 円弧を折れ線にするときの最大の弦の誤差（mm）
const VIO_JOIN_TOL = 1e-4;    // 端点を同じ点とみなす距離（mm）

// ---------------------------------------------------------------- Point Curve TXT

// 先頭の「キー=値」行（Polyline・3d）、空行で区切られた曲線、数値の行を読む。
// 数値の列：3d でないとき「X Y」または「番号 X Y」、3d のとき「X Y Z」または「番号 X Y Z」。
// 番号が変わったところでも曲線を区切る。Z は捨てる。
function parsePointCurveTxt(text) {
  const notes = [];
  let polyline = null, is3d = false, nonzeroZ = false;
  const curves = [];
  let cur = [], curIdx = null;
  const flush = () => {
    if (cur.length >= 2) curves.push(finishCurve(cur, 'CONTOUR'));
    else if (cur.length) notes.push('点が1つだけの曲線を読み飛ばしました');
    cur = []; curIdx = null;
  };
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  lines.forEach((raw, n) => {
    const line = raw.trim();
    if (!line) { flush(); return; }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(\S+)$/);
    if (kv) {
      const k = kv[1].toLowerCase(), v = kv[2].toLowerCase() === 'true';
      if (k === 'polyline') polyline = v;
      else if (k === '3d') is3d = v;
      return;
    }
    const t = line.split(/[\s,]+/).map(Number);
    if (t.some(v => !Number.isFinite(v))) throw new Error(`${n + 1} 行目を数値として読めません：${line.slice(0, 40)}`);
    let idx = null, x, y, z = 0;
    if (is3d) {
      if (t.length === 4) [idx, x, y, z] = t;
      else if (t.length === 3) [x, y, z] = t;
      else throw new Error(`${n + 1} 行目の列の数が 3d=True の形式と合いません`);
    } else {
      if (t.length === 3) [idx, x, y] = t;
      else if (t.length === 2) [x, y] = t;
      else throw new Error(`${n + 1} 行目の列の数が合いません（2 列または 3 列）`);
    }
    if (idx !== null && curIdx !== null && idx !== curIdx) flush();
    curIdx = idx;
    if (z) nonzeroZ = true;
    cur.push(x, y);
  });
  flush();
  if (nonzeroZ) notes.push('Z 座標を捨てて XY 平面に投影しました');
  return { curves, notes, polyline };
}

// ---------------------------------------------------------------- DXF

const DXF_UNITS = { 0: [1, ''], 1: [25.4, 'インチ'], 2: [304.8, 'フィート'], 4: [1, ''], 5: [10, 'cm'], 6: [1000, 'm'], 8: [25.4e-6, 'マイクロインチ'], 9: [0.0254, 'ミル'], 13: [1e-3, 'μm'], 14: [100, 'dm'] };

function parseDxf(text) {
  if (text.startsWith('AutoCAD Binary DXF')) throw new Error('バイナリ形式の DXF には対応していません。ASCII 形式で保存してください。');
  const L = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < L.length; i += 2) {
    const code = parseInt(L[i].trim(), 10);
    if (!Number.isFinite(code)) throw new Error(`${i + 1} 行目のグループコードを読めません。DXF ファイルではない可能性があります。`);
    pairs.push([code, L[i + 1].trim()]);
  }
  // セクションごとに、エンティティ（0 の行から次の 0 の行まで）に分ける
  let section = null, unitsCode = 0;
  const ents = [], layerColor = new Map();
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'SECTION') { section = pairs[i + 1] && pairs[i + 1][1]; continue; }
    if (c === 0 && v === 'ENDSEC') { section = null; continue; }
    if (section === 'HEADER' && c === 9 && v === '$INSUNITS') {
      const nx = pairs[i + 1];
      if (nx && nx[0] === 70) unitsCode = parseInt(nx[1], 10);
    }
    if (section === 'TABLES' && c === 0 && v === 'LAYER') {
      let name = null, color = 7;
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 2) name = pairs[j][1];
        else if (pairs[j][0] === 62) color = Math.abs(parseInt(pairs[j][1], 10)) || 7;   // 負の値は非表示の画層
      }
      if (name !== null) layerColor.set(name, color);
    }
    if (section === 'ENTITIES' && c === 0) {
      const g = [];
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) g.push(pairs[j]);
      ents.push({ type: v, g });
    }
  }
  if (!ents.length && !pairs.some(p => p[0] === 0 && p[1] === 'SECTION')) throw new Error('DXF のセクションが見つかりません。');

  const notes = [];
  const unit = DXF_UNITS[unitsCode];
  let k = 1;
  if (unit) { k = unit[0]; if (unit[1]) notes.push(`単位を ${unit[1]} から mm に換算しました`); }
  else notes.push(`単位（$INSUNITS = ${unitsCode}）に対応していないため、mm として読みました`);

  const closed = [], open = [], skipped = {};
  const skip = t => { skipped[t] = (skipped[t] || 0) + 1; };
  const add = (pts, isClosed, layer) => {
    if (pts.length < 4) return;
    const s = Float64Array.from(pts, v => v * k);
    const c = finishCurve(s, layer, isClosed);
    (c.closed ? closed : open).push(c);
  };

  for (let i = 0; i < ents.length; i++) {
    const e = ents[i], G = e.g;
    const one = code => { const p = G.find(q => q[0] === code); return p ? p[1] : undefined; };
    const num = (code, d = 0) => { const v = one(code); return v === undefined ? d : Number(v); };
    const layer = one(8) || '0';
    const mirror = num(230, 1) < 0;   // 押し出し方向が -Z のときは OCS の X が反転する
    const mx = x => mirror ? -x : x;
    switch (e.type) {
      case 'LWPOLYLINE': {
        const vs = [];
        for (const [c, v] of G) {
          if (c === 10) vs.push({ x: mx(Number(v)), y: 0, b: 0 });
          else if (c === 20 && vs.length) vs[vs.length - 1].y = Number(v);
          else if (c === 42 && vs.length) vs[vs.length - 1].b = mirror ? -Number(v) : Number(v);
        }
        const isClosed = (num(70) & 1) === 1;
        add(bulgePolyline(vs, isClosed), isClosed, layer);
        break;
      }
      case 'POLYLINE': {
        const flags = num(70);
        const vs = [];
        let j = i + 1;
        for (; j < ents.length && ents[j].type === 'VERTEX'; j++) {
          const V = ents[j].g, vf = Number((V.find(q => q[0] === 70) || [0, 0])[1]);
          if (vf & (16 | 128)) continue;   // スプラインの制御点・ポリフェースの面は使わない
          const val = c => Number((V.find(q => q[0] === c) || [0, 0])[1]);
          vs.push({ x: (flags & 8) ? val(10) : mx(val(10)), y: val(20), b: (flags & 8) ? 0 : (mirror ? -val(42) : val(42)) });
        }
        if (j < ents.length && ents[j].type === 'SEQEND') j++;
        i = j - 1;
        if (flags & (16 | 64)) { skip('POLYLINE（メッシュ）'); break; }
        const isClosed = (flags & 1) === 1;
        add(bulgePolyline(vs, isClosed), isClosed, layer);
        break;
      }
      case 'LINE':
        add([num(10), num(20), num(11), num(21)], false, layer);
        break;
      case 'ARC': {
        const r = num(40), a0 = num(50) * Math.PI / 180;
        let a1 = num(51) * Math.PI / 180;
        while (a1 <= a0) a1 += Math.PI * 2;
        const pts = arcPoints(mx(num(10)), num(20), r, mirror ? Math.PI - a0 : a0, mirror ? -(a1 - a0) : a1 - a0, r * k);
        add(pts, false, layer);
        break;
      }
      case 'CIRCLE': {
        const r = num(40), pts = arcPoints(mx(num(10)), num(20), r, 0, Math.PI * 2, r * k);
        add(pts.slice(0, -2), true, layer);
        break;
      }
      case 'ELLIPSE': {
        const cx = num(10), cy = num(20), ax = num(11), ay = num(21), ratio = num(40, 1);
        const t0 = num(41, 0);
        let t1 = num(42, Math.PI * 2);
        while (t1 <= t0) t1 += Math.PI * 2;
        const sweep = t1 - t0, full = Math.abs(sweep - Math.PI * 2) < 1e-9;
        // ELLIPSE の座標は WCS。短軸の向きは押し出し方向 × 長軸なので、-Z のときは逆になる
        const R = Math.hypot(ax, ay), sg = mirror ? -1 : 1, bx = -ay * ratio * sg, by = ax * ratio * sg;
        const n = arcSegments(R * k, sweep), pts = [];
        for (let s = 0; s <= n; s++) {
          const t = t0 + sweep * s / n, c = Math.cos(t), si = Math.sin(t);
          pts.push(cx + ax * c + bx * si, cy + ay * c + by * si);
        }
        add(full ? pts.slice(0, -2) : pts, full, layer);
        break;
      }
      case 'SPLINE': {
        const sp = splinePoints(G);
        if (!sp) { skip('SPLINE（読めない形式）'); break; }
        add(sp.pts, sp.closed, layer);
        if (sp.fitOnly) notes.push('制御点のない SPLINE は通過点を結ぶ折れ線にしました');
        break;
      }
      case 'VERTEX': case 'SEQEND': break;
      default: skip(e.type);
    }
  }

  const joined = joinOpen(open);
  const curves = closed.concat(joined);
  for (const c of curves) c.aci = layerColor.get(c.layer) || 7;
  const sk = Object.entries(skipped).map(([t, n]) => `${t} ${n}`);
  if (sk.length) notes.push('対応していない要素を読み飛ばしました：' + sk.join('、'));
  if (joined.length < open.length) notes.push(`端点がつながる開いた線 ${open.length} 本を ${joined.length} 本にまとめました`);
  return { curves, notes: [...new Set(notes)] };
}

// 頂点の列（ふくらみ b 付き）を点の並びにする。b ≠ 0 の区間は円弧として分割する。
function bulgePolyline(vs, isClosed) {
  if (!vs.length) return [];
  const pts = [vs[0].x, vs[0].y];
  const nSeg = isClosed ? vs.length : vs.length - 1;
  for (let i = 0; i < nSeg; i++) {
    const a = vs[i], b = vs[(i + 1) % vs.length];
    if (a.b && (a.x !== b.x || a.y !== b.y)) {
      const theta = 4 * Math.atan(a.b), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      const h = (d / 2) / Math.tan(theta / 2);
      const cx = (a.x + b.x) / 2 - dy / d * h, cy = (a.y + b.y) / 2 + dx / d * h;
      const r = Math.hypot(a.x - cx, a.y - cy);
      const arc = arcPoints(cx, cy, r, Math.atan2(a.y - cy, a.x - cx), theta, r);
      for (let j = 2; j < arc.length - 2; j += 2) pts.push(arc[j], arc[j + 1]);
    }
    pts.push(b.x, b.y);
  }
  if (isClosed) pts.length -= 2;   // 最後に戻ってきた始点は持たない
  return pts;
}

// 円弧の分割数。rMm は mm に換算した半径で、弦の誤差が VIO_ARC_TOL 以下になるようにする。
function arcSegments(rMm, sweep) {
  const step = rMm > VIO_ARC_TOL ? Math.max(2 * Math.acos(1 - VIO_ARC_TOL / rMm), Math.PI / 360) : Math.PI / 4;
  return Math.max(1, Math.min(4096, Math.ceil(Math.abs(sweep) / Math.min(step, Math.PI / 4))));
}
function arcPoints(cx, cy, r, a0, sweep, rMm) {
  const n = arcSegments(rMm, sweep), pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * i / n;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}

// SPLINE：制御点があれば NURBS を de Boor 法で評価し、なければ通過点を結ぶ。
function splinePoints(G) {
  const flags = Number((G.find(q => q[0] === 70) || [0, 0])[1]);
  const p = Number((G.find(q => q[0] === 71) || [0, 3])[1]);
  const knots = [], ctrl = [], w = [], fit = [];
  for (const [c, v] of G) {
    if (c === 40) knots.push(Number(v));
    else if (c === 41) w.push(Number(v));
    else if (c === 10) ctrl.push([Number(v), 0]);
    else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = Number(v);
    else if (c === 11) fit.push([Number(v), 0]);
    else if (c === 21 && fit.length) fit[fit.length - 1][1] = Number(v);
  }
  const n = ctrl.length;
  if (n >= 2 && knots.length === n + p + 1 && p >= 1) {
    const W = w.length === n ? w : ctrl.map(() => 1);
    const pts = [];
    for (let s = p; s < n; s++) {
      const ka = knots[s], kb = knots[s + 1];
      if (kb <= ka) continue;
      const steps = 24;
      for (let q = pts.length ? 1 : 0; q <= steps; q++) {
        const t = ka + (kb - ka) * q / steps;
        const d = [];
        for (let j = 0; j <= p; j++) { const P = ctrl[j + s - p], ww = W[j + s - p]; d.push([P[0] * ww, P[1] * ww, ww]); }
        for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
          const den = knots[j + 1 + s - r] - knots[j + s - p], al = den ? (t - knots[j + s - p]) / den : 0;
          for (let m = 0; m < 3; m++) d[j][m] = (1 - al) * d[j - 1][m] + al * d[j][m];
        }
        pts.push(d[p][0] / d[p][2], d[p][1] / d[p][2]);
      }
    }
    if (pts.length < 4) return null;
    return { pts, closed: (flags & 1) === 1 };
  }
  if (fit.length >= 2) return { pts: fit.flat(), closed: (flags & 1) === 1, fitOnly: true };
  return null;
}

// 点の並びを曲線にする。始点と終点が一致すれば閉じた曲線とし、重なった終点を除く。
function finishCurve(pts, layer, closedFlag) {
  let a = Float64Array.from(pts), closed = !!closedFlag;
  const n = a.length;
  if (n >= 6 && Math.hypot(a[0] - a[n - 2], a[1] - a[n - 1]) <= VIO_JOIN_TOL) { a = a.slice(0, n - 2); closed = true; }
  return { pts: a, closed: closed && a.length >= 6, layer };
}

// 同じ画層で端点を共有する開いた線をつなぐ。3本以上が集まる点ではつながない。
function joinOpen(open) {
  if (open.length < 2) return open;
  const key = (l, x, y) => `${l}|${Math.round(x / VIO_JOIN_TOL)}|${Math.round(y / VIO_JOIN_TOL)}`;
  const ends = open.map(c => {
    const p = c.pts, n = p.length;
    return [key(c.layer, p[0], p[1]), key(c.layer, p[n - 2], p[n - 1])];
  });
  const at = new Map();
  ends.forEach((e, i) => e.forEach((k, side) => { if (!at.has(k)) at.set(k, []); at.get(k).push([i, side]); }));
  const used = new Uint8Array(open.length), out = [];
  const fwd = j => Array.from(open[j].pts);
  const rev = j => { const p = open[j].pts, r = []; for (let m = p.length - 2; m >= 0; m -= 2) r.push(p[m], p[m + 1]); return r; };
  // 点 k でつながる相手（ちょうど2本が集まる点の、まだ使っていない方）
  const nextAt = k => { const h = at.get(k); return h.length === 2 ? h.find(([j]) => !used[j]) || null : null; };
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let pts = fwd(i);
    // 終点側へ延ばす：相手はその点から始まる向きにする
    for (let k = ends[i][1], nx; (nx = nextAt(k));) {
      const [j, side] = nx; used[j] = 1;
      pts = pts.concat((side === 0 ? fwd(j) : rev(j)).slice(2));
      k = ends[j][side ^ 1];
    }
    // 始点側へ延ばす：相手はその点で終わる向きにする
    for (let k = ends[i][0], nx; (nx = nextAt(k));) {
      const [j, side] = nx; used[j] = 1;
      pts = (side === 1 ? fwd(j) : rev(j)).slice(0, -2).concat(pts);
      k = ends[j][side ^ 1];
    }
    out.push(finishCurve(pts, open[i].layer));
  }
  return out;
}

// ---------------------------------------------------------------- STL（Z 断面）

// バイナリ形式・テキスト形式の STL を読む。座標の単位は mm とみなす（STL には単位の決まりがない）。
// 結果：{ tris: Float32Array（三角形ごとに x,y,z ×3）, n, zmin, zmax, frame（XY の範囲）, levels（平らな面の Z） }
function parseStl(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let tris;
  const binN = buf.byteLength >= 84 ? dv.getUint32(80, true) : -1;
  if (binN >= 0 && 84 + binN * 50 === buf.byteLength) {
    tris = new Float32Array(binN * 9);
    for (let i = 0; i < binN; i++) for (let k = 0; k < 9; k++) tris[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
  } else {
    const text = new TextDecoder().decode(u8);
    if (!/^\s*solid/i.test(text) || !/facet/i.test(text)) throw new Error('STL ファイルとして読めません。');
    const v = [];
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
    for (let m; (m = re.exec(text));) v.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!v.length || v.length % 9 || v.some(x => !Number.isFinite(x))) throw new Error('STL の頂点を読めません。');
    tris = Float32Array.from(v);
  }
  const n = tris.length / 9;
  if (!n) throw new Error('STL に三角形がありません。');
  let zmin = Infinity, zmax = -Infinity, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  // 平らな面（3 頂点の Z がそろう三角形）の高さを、面積の合計が無視できないものだけ集める
  const tol = Math.max(1e-6, (zmax - zmin) * 1e-6), area = new Map();
  for (let t = 0; t < n; t++) {
    const o = t * 9, z0 = tris[o + 2], z1 = tris[o + 5], z2 = tris[o + 8];
    if (Math.max(z0, z1, z2) - Math.min(z0, z1, z2) > tol) continue;
    const a = Math.abs((tris[o + 3] - tris[o]) * (tris[o + 7] - tris[o + 1]) - (tris[o + 4] - tris[o + 1]) * (tris[o + 6] - tris[o])) / 2;
    const key = Math.round(z0 / 1e-4);
    area.set(key, (area.get(key) || 0) + a);
  }
  const total = (maxX - minX) * (maxY - minY);
  const levels = [...area].filter(([, a]) => a > total * 1e-4).map(([k]) => k * 1e-4).sort((a, b) => a - b);
  return { tris, n, zmin, zmax, frame: { minX, minY, maxX, maxY }, levels };
}

// 高さ z の水平面で切った断面を、閉曲線（つながらなければ開いた曲線）の配列で返す。
// 頂点がちょうど z にあると断面が定まらないので、そのときは z を少しずらす。結果の z は実際に切った高さ。
function sliceStl(mesh, z) {
  const T = mesh.tris, n = mesh.n, nudge = Math.max(1e-5, (mesh.zmax - mesh.zmin) * 1e-5);
  for (let k = 0; k < 8; k++) {
    let hit = false;
    for (let i = 2; i < T.length; i += 3) if (Math.abs(T[i] - z) < nudge * 0.5) { hit = true; break; }
    if (!hit) break;
    z += z + nudge <= mesh.zmax ? nudge : -nudge;
  }
  // 断面の線分は三角形の辺どうしを結ぶ。辺（2 頂点の組）をキーにすると、隣の三角形と確実につながる
  const vkey = i => `${T[i]},${T[i + 1]},${T[i + 2]}`;
  const segA = [], segB = [], pt = new Map();
  for (let t = 0; t < n; t++) {
    const o = t * 9, ends = [];
    for (let e = 0; e < 3; e++) {
      let a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      const za = T[a + 2] - z, zb = T[b + 2] - z;
      if (!(za * zb < 0)) continue;
      let ka = vkey(a), kb = vkey(b);
      if (ka > kb) { [a, b] = [b, a]; [ka, kb] = [kb, ka]; }   // 辺の向きをそろえ、両側の三角形で同じ点を計算する
      const key = ka + '|' + kb;
      if (!pt.has(key)) {
        const s = (z - T[a + 2]) / (T[b + 2] - T[a + 2]);
        pt.set(key, [T[a] + s * (T[b] - T[a]), T[a + 1] + s * (T[b + 1] - T[a + 1])]);
      }
      ends.push(key);
    }
    if (ends.length === 2 && ends[0] !== ends[1]) { segA.push(ends[0]); segB.push(ends[1]); }
  }
  const at = new Map();
  const put = (k, i) => { const l = at.get(k); if (l) l.push(i); else at.set(k, [i]); };
  segA.forEach((k, i) => { put(k, i); put(segB[i], i); });
  const used = new Uint8Array(segA.length), curves = [];
  const other = (i, k) => segA[i] === k ? segB[i] : segA[i];
  const nextAt = (k) => { const l = at.get(k); return l.length === 2 ? l.find(j => !used[j]) : undefined; };
  for (let i = 0; i < segA.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const fwd = [segA[i], segB[i]], back = [];
    for (let k = segB[i], j; (j = nextAt(k)) !== undefined;) { used[j] = 1; k = other(j, k); fwd.push(k); }
    for (let k = segA[i], j; (j = nextAt(k)) !== undefined;) { used[j] = 1; k = other(j, k); back.push(k); }
    const keys = back.reverse().concat(fwd), pts = [];
    for (const k of keys) { const p = pt.get(k); pts.push(p[0], p[1]); }
    curves.push(finishCurve(pts, 'CONTOUR'));
  }
  return { z, curves: curves.filter(c => c.pts.length >= 4) };
}
