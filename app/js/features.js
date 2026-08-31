/* ============================================================
 * features.js - 加工特征库（对标慧切 cutlist 的工艺项）
 *
 *   · 圆孔 / 矩形孔(可圆角) / 腰形长槽
 *   · 洞洞板阵列孔（孔径 / 孔距 / 错排 / 局部删孔）
 *   · 四角顶点切口 / 圆角 / 斜角
 *   · 边部切口（边上开一个缺口）
 *   · 定深铣槽 pocket（不切透，深度 < 板厚）
 *
 * 约定
 *   - 所有"孔"返回 CW 环（与 Part.addHole 一致：材料恒在左侧 => 孔为 CW）
 *   - 所有坐标以零件左下角为原点，单位 mm
 *   - pocket 返回 {loop(CW), depth, note}
 * 依赖: geom.js, joints.js
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G, J = global.J;

  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }

  /* ---------------- 单个孔 ---------------- */
  function roundHole(cx, cy, dia) {
    return G.ensureOrient(G.circle(cx, cy, dia), false);
  }
  function rectHole(cx, cy, w, h, r) {
    r = num(r, 0);
    var lp = r > 1e-6 ? G.roundRect(cx - w / 2, cy - h / 2, w, h, r) : G.rectC(cx, cy, w, h);
    return G.ensureOrient(lp, false);
  }
  /* 腰形孔(圆头长槽): len = 总长(含两端圆头), dia = 宽 */
  function slotHole(cx, cy, len, dia, angDeg) {
    var L = Math.max(num(len, dia), dia);
    var lp = G.slotC(0, 0, L, dia);
    if (angDeg) lp = G.xform(lp, { rot: angDeg });
    lp = G.translate(lp, cx, cy);
    return G.ensureOrient(lp, false);
  }

  /* 参考点换算: ref = bl(默认) | center | br | tl | tr */
  function anchor(w, h, ref) {
    switch (ref) {
      case 'center': return { x: w / 2, y: h / 2 };
      case 'br': return { x: w, y: 0 };
      case 'tl': return { x: 0, y: h };
      case 'tr': return { x: w, y: h };
      default: return { x: 0, y: 0 };
    }
  }

  /* ---------------- 孔位表 -> 环 ----------------
   * spec: [{type:'circle'|'rect'|'slot', x, y, ref, d/w/h/len/r/ang}]
   * 返回 {holes:[loop], warnings:[]}
   */
  function holesFromSpec(spec, w, h, opt) {
    opt = opt || {};
    var minEdge = num(opt.minEdge, 3);
    var out = [], warn = [];
    (spec || []).forEach(function (s, i) {
      var a = anchor(w, h, s.ref);
      var cx = a.x + num(s.x, 0), cy = a.y + num(s.y, 0);
      var lp = null, tag = '孔#' + (i + 1);
      if (s.type === 'rect') {
        var rw = num(s.w, 0), rh = num(s.h, 0);
        if (rw <= 0 || rh <= 0) { warn.push({ level: 'warn', text: tag + ': 矩形孔尺寸无效，已跳过' }); return; }
        lp = rectHole(cx, cy, rw, rh, num(s.r, 0));
      } else if (s.type === 'slot') {
        var sd = num(s.d, 0), sl = num(s.len, 0);
        if (sd <= 0 || sl <= 0) { warn.push({ level: 'warn', text: tag + ': 腰形孔尺寸无效，已跳过' }); return; }
        lp = slotHole(cx, cy, sl, sd, num(s.ang, 0));
      } else {
        var d = num(s.d, 0);
        if (d <= 0) { warn.push({ level: 'warn', text: tag + ': 圆孔直径无效，已跳过' }); return; }
        lp = roundHole(cx, cy, d);
      }
      var b = G.loopBBox(lp);
      if (b.x0 < minEdge - 1e-9 || b.y0 < minEdge - 1e-9 ||
          b.x1 > w - minEdge + 1e-9 || b.y1 > h - minEdge + 1e-9) {
        warn.push({
          level: b.x0 < 0 || b.y0 < 0 || b.x1 > w || b.y1 > h ? 'error' : 'warn',
          text: tag + ': 距板边不足 ' + minEdge + 'mm（' +
            [G.round(b.x0, 1), G.round(b.y0, 1), G.round(w - b.x1, 1), G.round(h - b.y1, 1)].join('/') + '）'
        });
        if (b.x0 < 0 || b.y0 < 0 || b.x1 > w || b.y1 > h) return;   // 越界直接丢弃
      }
      out.push(lp);
    });
    return { holes: out, warnings: warn };
  }

  /* ---------------- 洞洞板阵列孔 ----------------
   * o: {dia, pitch, pitchY, margin/marginX/marginY, stagger, rows, cols, skip:[[r,c]..]}
   * 行列均 1 起。返回 {holes, positions, rows, cols, count, warnings}
   */
  function pegboard(w, h, o) {
    o = o || {};
    var warn = [];
    var dia = num(o.dia, 12), pitch = num(o.pitch, 36);
    var pitchY = num(o.pitchY, 0) || pitch;
    var mx = num(o.marginX, num(o.margin, 30));
    var my = num(o.marginY, num(o.margin, 30));
    var res = { holes: [], positions: [], rows: 0, cols: 0, count: 0, pitch: pitch, dia: dia, warnings: warn };
    if (dia <= 0 || pitch <= 0) { warn.push({ level: 'warn', text: '洞洞板: 孔径与孔距必须为正' }); return res; }
    if (pitch < dia + 3) warn.push({ level: 'warn', text: '洞洞板: 孔距 ' + pitch + 'mm 与孔径 ' + dia + 'mm 太近，孔间壁 <3mm 易崩边' });
    var availW = w - 2 * mx - dia, availH = h - 2 * my - dia;
    if (availW < -1e-9 || availH < -1e-9) {
      warn.push({ level: 'warn', text: '洞洞板: 留边 ' + mx + '/' + my + 'mm 过大，板面排不下孔' });
      return res;
    }
    var cols = o.cols ? Math.max(1, Math.round(o.cols)) : Math.floor(availW / pitch + 1e-9) + 1;
    var rows = o.rows ? Math.max(1, Math.round(o.rows)) : Math.floor(availH / pitchY + 1e-9) + 1;
    while (cols > 1 && (cols - 1) * pitch > availW + 1e-9) cols--;
    while (rows > 1 && (rows - 1) * pitchY > availH + 1e-9) rows--;
    var stag = !!o.stagger;
    if (stag && cols < 2) { stag = false; warn.push({ level: 'info', text: '洞洞板: 只有 1 列，错排已忽略' }); }
    var spanX = (cols - 1) * pitch, spanY = (rows - 1) * pitchY;
    var x0 = (w - spanX) / 2, y0 = (h - spanY) / 2;
    var skip = {};
    (o.skip || []).forEach(function (s) { skip[(s[0] | 0) + ',' + (s[1] | 0)] = 1; });
    for (var r = 0; r < rows; r++) {
      var n = cols, sx = x0;
      if (stag && r % 2 === 1) { n = cols - 1; sx = x0 + pitch / 2; }   // 砖砌错排, 仍左右对称
      for (var c = 0; c < n; c++) {
        if (skip[(r + 1) + ',' + (c + 1)]) continue;
        var x = sx + c * pitch, y = y0 + r * pitchY;
        res.positions.push({ x: G.round(x, 4), y: G.round(y, 4), row: r + 1, col: c + 1 });
        res.holes.push(roundHole(x, y, dia));
      }
    }
    res.rows = rows; res.cols = cols; res.count = res.holes.length;
    if (!res.count) warn.push({ level: 'warn', text: '洞洞板: 没有生成任何孔' });
    return res;
  }

  /* ---------------- 四角处理 ----------------
   * corners: {bl,br,tr,tl} 或 {all}, 每项 {type:'notch'|'round'|'chamfer', size}
   *   notch   四角顶点切口(挖掉一个 size×size 方角, 会产生内凹角 -> 需让位)
   *   round   圆角
   *   chamfer 斜角(45°)
   */
  var CORNERS = [
    { key: 'bl', p: [0, 0], pre: [0, -1], nx: [1, 0] },
    { key: 'br', p: [1, 0], pre: [1, 0], nx: [0, 1] },
    { key: 'tr', p: [1, 1], pre: [0, 1], nx: [-1, 0] },
    { key: 'tl', p: [0, 1], pre: [-1, 0], nx: [0, -1] }
  ];
  function cornerSpec(corners, key) {
    if (!corners) return null;
    var c = corners[key] || corners.all;
    if (!c) return null;
    var size = num(c.size, 0);
    if (size <= 1e-6) return null;
    return { type: c.type || 'notch', size: size };
  }
  /* 单个角的替换点序列 */
  function cornerPts(w, h, cn, spec) {
    var P = G.P, cx = cn.p[0] * w, cy = cn.p[1] * h;
    if (!spec) return [P(cx, cy)];
    var s = Math.min(spec.size, w / 2, h / 2);
    var ax = cx - cn.pre[0] * s, ay = cy - cn.pre[1] * s;      // 入边上的点
    var bx = cx + cn.nx[0] * s, by = cy + cn.nx[1] * s;        // 出边上的点
    if (spec.type === 'round') return [P(ax, ay, G.bulgeOf(90)), P(bx, by)];
    if (spec.type === 'chamfer') return [P(ax, ay), P(bx, by)];
    // notch: 入边点 -> 内凹角 -> 出边点
    return [P(ax, ay), P(ax + cn.nx[0] * s, ay + cn.nx[1] * s), P(bx, by)];
  }

  /* ---------------- 边缺口 profile ----------------
   * u0 起点, len 长度, depth 深度(切入)
   */
  function notchProfile(u0, len, depth, o) {
    o = o || {};
    var d = num(depth, 0), L = num(len, 0);
    if (d <= 0 || L <= 0) return [];
    return [
      { u: u0, v: 0 }, { u: u0, v: -d },
      { u: u0 + L, v: -d }, { u: u0 + L, v: 0 }
    ];
  }
  /* 若干段 profile 合并成一条边: 按起点 u 排序后拼接（避免自交） */
  function mergeEdge(list) {
    var segs = (list || []).filter(function (p) { return p && p.length; });
    segs.sort(function (a, b) { return a[0].u - b[0].u; });
    var out = [];
    segs.forEach(function (s) { s.forEach(function (p) { out.push(p); }); });
    return out;
  }
  /* 同一条边上的段做冲突消解。
   * 重叠的段合并成一条轮廓一定自交, 所以只能丢弃。策略: 按起点排序,
   * 贪心保留不与已保留段重叠的; 被丢弃的通过 dropped 报告给调用方,
   * 让 UI 能给出"哪块板和哪块板打架"的可操作提示, 而不是丢一句几何错误。
   * 返回 {prof, kept, dropped} */
  function resolveEdge(list) {
    var segs = (list || []).filter(function (p) { return p && p.length; }).map(function (p, i) {
      var lo = Infinity, hi = -Infinity;
      p.forEach(function (q) { lo = Math.min(lo, q.u); hi = Math.max(hi, q.u); });
      return { prof: p, lo: lo, hi: hi, i: i };
    }).sort(function (a, b) { return a.lo - b.lo || a.hi - b.hi; });
    var kept = [], dropped = [], last = -Infinity;
    segs.forEach(function (sg) {
      if (sg.lo < last - 1e-6) { dropped.push(sg); return; }
      kept.push(sg);
      last = sg.hi;
    });
    var out = [];
    kept.forEach(function (sg) { sg.prof.forEach(function (q) { out.push(q); }); });
    /* dropped 既要能当索引数组用(老调用方), 又要能拿回段本身以读取 .src 溯源。
     * 这里返回索引数组 + 平行的 profs 数组, 兼顾两者。 */
    return {
      prof: out,
      kept: kept.length,
      dropped: dropped.map(function (sg) { return sg.i; }),
      droppedProfs: dropped.map(function (sg) { return sg.prof; }),
      keptProfs: kept.map(function (sg) { return sg.prof; })
    };
  }

  /* 同一条边上的 profile 段是否重叠(重叠会生成非法轮廓) */
  function edgeConflict(list) {
    var segs = (list || []).filter(function (p) { return p && p.length; }).map(function (p) {
      var lo = Infinity, hi = -Infinity;
      p.forEach(function (q) { lo = Math.min(lo, q.u); hi = Math.max(hi, q.u); });
      return [lo, hi];
    }).sort(function (a, b) { return a[0] - b[0]; });
    for (var i = 1; i < segs.length; i++) {
      if (segs[i][0] < segs[i - 1][1] - 1e-6) return true;
    }
    return false;
  }

  /* ---------------- 面板轮廓 ----------------
   * 在 Models.panel 之上增加四角处理。
   * o: {edges:{bottom,right,top,left}, corners}
   */
  function panelOutline(w, h, o) {
    o = o || {};
    var E = o.edges || {};
    var profs = [E.bottom, E.right, E.top, E.left];
    var lens = [w, h, w, h];
    var pts = [];
    CORNERS.forEach(function (cn, i) {
      var sp = cornerSpec(o.corners, cn.key);
      cornerPts(w, h, cn, sp).forEach(function (p) { pts.push(p); });
      var pr = profs[i];
      if (pr && pr.length) {
        var A, B;
        if (i === 0) { A = G.P(0, 0); B = G.P(w, 0); }
        else if (i === 1) { A = G.P(w, 0); B = G.P(w, h); }
        else if (i === 2) { A = G.P(w, h); B = G.P(0, h); }
        else { A = G.P(0, h); B = G.P(0, 0); }
        G.frame(A, B).map(pr).forEach(function (p) { pts.push(p); });
      }
    });
    return G.cleanLoop(pts);
  }
  /* 边 profile 是否被四角处理吃掉（会造成轮廓错乱） */
  function cornerClash(w, h, o) {
    o = o || {};
    var E = o.edges || {}, bad = [];
    var pairs = [['bottom', E.bottom, w, 'bl', 'br'], ['right', E.right, h, 'br', 'tr'],
      ['top', E.top, w, 'tr', 'tl'], ['left', E.left, h, 'tl', 'bl']];
    pairs.forEach(function (q) {
      if (!q[1] || !q[1].length) return;
      var lo = Infinity, hi = -Infinity;
      q[1].forEach(function (p) { lo = Math.min(lo, p.u); hi = Math.max(hi, p.u); });
      var s0 = cornerSpec(o.corners, q[3]), s1 = cornerSpec(o.corners, q[4]);
      if (s0 && lo < Math.min(s0.size, w / 2, h / 2) - 1e-6) bad.push(q[0] + '边起点');
      if (s1 && hi > q[2] - Math.min(s1.size, w / 2, h / 2) + 1e-6) bad.push(q[0] + '边终点');
    });
    return bad;
  }

  /* ---------------- 定深铣槽 pocket ---------------- */
  function pocketRect(cx, cy, w, h, depth, r) {
    return { loop: rectHole(cx, cy, w, h, r), depth: num(depth, 0) };
  }
  /* 板面上的一条定深直槽(dado): 沿 A->B, 宽 = 配合板厚 + fit */
  function pocketGroove(A, B, thickness, depth, o) {
    o = o || {};
    return {
      loop: J.grooveLoop(A, B, thickness, { fit: num(o.fit, 0), u0: o.u0, u1: o.u1, vOffset: o.vOffset }),
      depth: num(depth, 0)
    };
  }

  global.Feat = {
    roundHole: roundHole, rectHole: rectHole, slotHole: slotHole,
    anchor: anchor, holesFromSpec: holesFromSpec,
    pegboard: pegboard,
    cornerSpec: cornerSpec, cornerPts: cornerPts, panelOutline: panelOutline,
    cornerClash: cornerClash, CORNERS: CORNERS,
    notchProfile: notchProfile, mergeEdge: mergeEdge, edgeConflict: edgeConflict,
    resolveEdge: resolveEdge,
    pocketRect: pocketRect, pocketGroove: pocketGroove
  };
})(typeof window !== 'undefined' ? window : this);
