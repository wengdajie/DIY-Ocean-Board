/* ============================================================
 * geom.js - 2D 几何内核（零依赖）
 * 环(loop)表示: [{x, y, b}]  闭合多段线
 *   b = 该点到下一点的 bulge(凸度) = tan(sweep/4)，正=逆时针弧，负=顺时针弧，缺省=直线
 * 约定: 单位 mm；外轮廓逆时针(CCW)，内孔顺时针(CW)。
 *       => 沿路径前进方向，材料恒在左侧，"外法线"= right(dir)
 * ============================================================ */
(function (global) {
  'use strict';

  var EPS = 1e-9, D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2;

  function P(x, y, b) { var p = { x: x, y: y }; if (b) p.b = b; return p; }
  function clone(p) { return P(p.x, p.y, p.b); }
  function eq(a, b, tol) { tol = tol || 1e-6; return Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol; }

  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function mul(a, s) { return { x: a.x * s, y: a.y * s }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function cross(a, b) { return a.x * b.y - a.y * b.x; }
  function len(a) { return Math.hypot(a.x, a.y); }
  function norm(a) { var l = len(a) || 1; return { x: a.x / l, y: a.y / l }; }
  function left(a) { return { x: -a.y, y: a.x }; }
  function right(a) { return { x: a.y, y: -a.x }; }
  function rotv(a, deg) { var c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }; }
  function lerp(a, b, u) { return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function round(v, n) { var f = Math.pow(10, n === undefined ? 4 : n); return Math.round(v * f) / f; }

  /* ---------------- 圆弧 / bulge ---------------- */
  function bulgeOf(sweepDeg) { return Math.tan(sweepDeg * D2R / 4); }
  function sweepOf(b) { return 4 * Math.atan(b); }

  // 由起点、终点、bulge 求圆心/半径/起始角/扫掠角
  function arcFromBulge(p1, p2, b) {
    if (!b) return null;
    var chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (chord < EPS) return null;
    var th = sweepOf(b);
    var sh = Math.sin(th / 2);
    if (Math.abs(sh) < EPS) return null;
    var rs = chord / (2 * sh);                       // 带符号半径
    var mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    var d = norm(sub(p2, p1)), nl = left(d);
    var k = rs * Math.cos(th / 2);
    var c = { x: mid.x + nl.x * k, y: mid.y + nl.y * k };
    return {
      cx: c.x, cy: c.y, r: Math.abs(rs),
      a1: Math.atan2(p1.y - c.y, p1.x - c.x),
      a2: Math.atan2(p2.y - c.y, p2.x - c.x),
      sweep: th, ccw: th > 0
    };
  }

  // 圆弧上参数点 (u: 0..1)
  function arcPoint(a, u) {
    var ang = a.a1 + a.sweep * u;
    return { x: a.cx + a.r * Math.cos(ang), y: a.cy + a.r * Math.sin(ang) };
  }

  // 圆弧在端点处的切向(前进方向)
  function arcTangent(a, u) {
    var ang = a.a1 + a.sweep * u;
    var t = { x: -Math.sin(ang), y: Math.cos(ang) };
    return a.sweep > 0 ? t : { x: -t.x, y: -t.y };
  }

  // 把大圆弧拆成 <= maxDeg 的多段（提升 CAM 兼容性）
  function splitArcs(loop, maxDeg) {
    maxDeg = maxDeg || 90;
    var out = [], n = loop.length;
    for (var i = 0; i < n; i++) {
      var p1 = loop[i], p2 = loop[(i + 1) % n];
      if (!p1.b) { out.push(clone(p1)); continue; }
      var a = arcFromBulge(p1, p2, p1.b);
      if (!a) { out.push(P(p1.x, p1.y)); continue; }
      var total = Math.abs(a.sweep) * R2D;
      var k = Math.max(1, Math.ceil(total / maxDeg));
      var nb = bulgeOf((a.sweep * R2D) / k);
      for (var j = 0; j < k; j++) {
        var pt = arcPoint(a, j / k);
        out.push(P(pt.x, pt.y, nb));
      }
    }
    return out;
  }

  /* ---------------- 离散化 ---------------- */
  function flatten(loop, tol) {
    tol = tol || 0.05;
    var out = [], n = loop.length;
    for (var i = 0; i < n; i++) {
      var p1 = loop[i], p2 = loop[(i + 1) % n];
      out.push({ x: p1.x, y: p1.y });
      if (!p1.b) continue;
      var a = arcFromBulge(p1, p2, p1.b);
      if (!a) continue;
      var step = 2 * Math.acos(clamp(1 - tol / a.r, -1, 1));
      var k = clamp(Math.ceil(Math.abs(a.sweep) / (step || 0.3)), 2, 256);
      for (var j = 1; j < k; j++) out.push(arcPoint(a, j / k));
    }
    return out;
  }

  /* ---------------- 度量 ---------------- */
  function signedArea(pts) {
    var s = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }
  // 精确面积: 多边形面积 + 各圆弧的弓形面积(带符号)
  function loopArea(loop) {
    var n = loop.length;
    var poly = loop.map(function (p) { return { x: p.x, y: p.y }; });
    var A = signedArea(poly);
    for (var i = 0; i < n; i++) {
      var p1 = loop[i], p2 = loop[(i + 1) % n];
      if (!p1.b) continue;
      var a = arcFromBulge(p1, p2, p1.b);
      if (!a) continue;
      A += (a.r * a.r / 2) * (a.sweep - Math.sin(a.sweep));
    }
    return A;
  }
  function loopLength(loop) {
    var L = 0, n = loop.length;
    for (var i = 0; i < n; i++) {
      var p1 = loop[i], p2 = loop[(i + 1) % n];
      if (p1.b) { var a = arcFromBulge(p1, p2, p1.b); L += a ? Math.abs(a.sweep) * a.r : 0; }
      else L += Math.hypot(p2.x - p1.x, p2.y - p1.y);
    }
    return L;
  }
  function bboxOf(pts) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < b.x0) b.x0 = p.x;
      if (p.y < b.y0) b.y0 = p.y;
      if (p.x > b.x1) b.x1 = p.x;
      if (p.y > b.y1) b.y1 = p.y;
    }
    b.w = b.x1 - b.x0; b.h = b.y1 - b.y0;
    b.cx = (b.x0 + b.x1) / 2; b.cy = (b.y0 + b.y1) / 2;
    return b;
  }
  // 精确包围盒: 顶点 + 圆弧上的极值点(0/90/180/270 度)
  function loopBBox(loop) {
    var n = loop.length, pts = [];
    for (var i = 0; i < n; i++) {
      var p1 = loop[i], p2 = loop[(i + 1) % n];
      pts.push({ x: p1.x, y: p1.y });
      if (!p1.b) continue;
      var a = arcFromBulge(p1, p2, p1.b);
      if (!a) continue;
      for (var q = 0; q < 4; q++) {
        var ang = q * Math.PI / 2;
        // 该极值角是否落在弧的扫掠范围内
        var rel = (ang - a.a1) * (a.sweep > 0 ? 1 : -1);
        rel = ((rel % TAU) + TAU) % TAU;
        if (rel <= Math.abs(a.sweep) + 1e-12) {
          pts.push({ x: a.cx + a.r * Math.cos(ang), y: a.cy + a.r * Math.sin(ang) });
        }
      }
    }
    return bboxOf(pts);
  }
  function bboxUnion(a, b) {
    if (!a) return b;
    if (!b) return a;
    return bboxOf([{ x: a.x0, y: a.y0 }, { x: a.x1, y: a.y1 }, { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 }]);
  }

  /* ---------------- 变换 ---------------- */
  // xf: {tx,ty,rot(度),mx(x 镜像)}   顺序: 镜像 -> 旋转 -> 平移
  function xform(loop, xf) {
    var tx = xf.tx || 0, ty = xf.ty || 0, rot = xf.rot || 0, mx = !!xf.mx;
    var c = Math.cos(rot * D2R), s = Math.sin(rot * D2R);
    var out = loop.map(function (p) {
      var x = mx ? -p.x : p.x, y = p.y;
      var b = p.b ? (mx ? -p.b : p.b) : undefined;
      return P(x * c - y * s + tx, x * s + y * c + ty, b);
    });
    return mx ? reverse(out) : out;   // 镜像会翻转走向，需恢复方向
  }
  function reverse(loop) {
    var n = loop.length, out = [];
    for (var k = 0; k < n; k++) {
      var i = (n - 1 - k), j = ((i - 1) % n + n) % n;
      var bb = loop[j].b;
      out.push(P(loop[i].x, loop[i].y, bb ? -bb : undefined));
    }
    return out;
  }
  function ensureOrient(loop, ccw) {
    var a = loopArea(loop);
    if ((a < 0 && ccw) || (a > 0 && !ccw)) return reverse(loop);
    return loop.map(clone);
  }
  function translate(loop, dx, dy) { return xform(loop, { tx: dx, ty: dy }); }

  /* ---------------- 基本形状（均为 CCW） ---------------- */
  function rect(x, y, w, h) { return [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)]; }
  function rectC(cx, cy, w, h) { return rect(cx - w / 2, cy - h / 2, w, h); }
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (r <= 1e-6) return rect(x, y, w, h);
    var b = bulgeOf(90);
    return [
      P(x + r, y), P(x + w - r, y, b),
      P(x + w, y + r), P(x + w, y + h - r, b),
      P(x + w - r, y + h), P(x + r, y + h, b),
      P(x, y + h - r), P(x, y + r, b)
    ];
  }
  function slotC(cx, cy, w, h) {          // 圆头长槽
    return roundRect(cx - w / 2, cy - h / 2, w, h, Math.min(w, h) / 2);
  }
  function circle(cx, cy, d) {
    var r = d / 2, b = bulgeOf(180);
    return [P(cx - r, cy, b), P(cx + r, cy, b)];
  }
  function polygon(pts) { return pts.map(function (p) { return P(p[0], p[1]); }); }

  /* ---------------- 边坐标系 ----------------
   * A->B 定义一条边；u 沿 A->B，v 为离开材料的"外"方向(right)
   * profile: [{u, v, b}] -> 零件坐标环片段
   */
  function frame(A, B) {
    var d = norm(sub(B, A)), no = right(d);
    return {
      A: A, B: B, ex: d, ey: no, L: len(sub(B, A)),
      at: function (u, v, b) {
        return P(A.x + d.x * u + no.x * (v || 0), A.y + d.y * u + no.y * (v || 0), b);
      },
      map: function (profile) {
        var self = this;
        return profile.map(function (p) { return self.at(p.u, p.v, p.b); });
      },
      // 局部(u,v)矩形 -> 零件坐标环 (CCW)
      rectUV: function (u0, v0, du, dv) {
        var self = this;
        var q = [[u0, v0], [u0 + du, v0], [u0 + du, v0 + dv], [u0, v0 + dv]].map(function (p) { return self.at(p[0], p[1]); });
        return ensureOrient(q, true);
      }
    };
  }

  /* ---------------- 环编辑 ---------------- */
  // 用 profile 替换 A->B 这条边（保持环闭合）: 在 loop 的第 i 段插入
  function replaceEdge(loop, i, profile) {
    var n = loop.length, A = loop[i], B = loop[(i + 1) % n];
    var f = frame(A, B);
    var mid = f.map(profile);
    var out = [];
    out.push(P(A.x, A.y));
    for (var k = 0; k < mid.length; k++) out.push(mid[k]);
    for (var j = 1; j < n; j++) out.push(clone(loop[(i + j) % n]));
    return cleanLoop(out);
  }
  function cleanLoop(loop, tol) {
    tol = tol || 1e-5;
    var out = [];
    for (var i = 0; i < loop.length; i++) {
      var p = loop[i], q = loop[(i + 1) % loop.length];
      if (!p.b && Math.hypot(q.x - p.x, q.y - p.y) < tol) continue;
      out.push(clone(p));
    }
    return out.length >= 3 ? out : loop.map(clone);
  }
  function loopFromSegments(segs) {   // 把若干点串首尾相接
    var out = [];
    segs.forEach(function (s) { s.forEach(function (p) { out.push(clone(p)); }); });
    return cleanLoop(out);
  }

  /* ---------------- 等距偏移（激光/铣刀补偿） ----------------
   * d > 0 = 材料变大（外轮廓外扩、内孔内缩），因为材料恒在左侧
   */
  function outNormalAtStart(loop, i) {
    var n = loop.length, p1 = loop[i], p2 = loop[(i + 1) % n];
    if (p1.b) {
      var a = arcFromBulge(p1, p2, p1.b);
      if (a) return right(arcTangent(a, 0));
    }
    return right(norm(sub(p2, p1)));
  }
  function outNormalAtEnd(loop, i) {
    var n = loop.length, p1 = loop[i], p2 = loop[(i + 1) % n];
    if (p1.b) {
      var a = arcFromBulge(p1, p2, p1.b);
      if (a) return right(arcTangent(a, 1));
    }
    return right(norm(sub(p2, p1)));
  }
  function offsetLoop(loop, d) {
    if (!d) return loop.map(clone);
    var n = loop.length, pts = [], i;
    for (i = 0; i < n; i++) {
      var prev = ((i - 1) % n + n) % n;
      var n1 = outNormalAtEnd(loop, prev), n2 = outNormalAtStart(loop, i);
      var bis = norm(add(n1, n2));
      var k = dot(bis, n2);
      var s = d / Math.max(0.3, k);          // 尖角限幅，避免爆刺
      pts.push({ x: loop[i].x + bis.x * s, y: loop[i].y + bis.y * s, b: loop[i].b });
    }
    // 修正圆弧 bulge（半径随偏移变化）
    var out = [];
    for (i = 0; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      if (!p.b) { out.push(P(p.x, p.y)); continue; }
      var a0 = arcFromBulge(loop[i], loop[(i + 1) % n], p.b);
      if (!a0) { out.push(P(p.x, p.y)); continue; }
      var sgn = p.b > 0 ? 1 : -1;            // 正 bulge: 圆心在材料侧 -> 半径增大
      var r2 = a0.r + sgn * d;
      var ch = Math.hypot(q.x - p.x, q.y - p.y);
      var nb;
      if (r2 <= 1e-6 || ch < 1e-9) nb = undefined;
      else {
        var half = Math.asin(clamp(ch / (2 * r2), -1, 1));
        var th = Math.abs(a0.sweep) > Math.PI ? (TAU - 2 * half) : (2 * half);
        nb = Math.tan((th * sgn) / 4);
      }
      out.push(P(p.x, p.y, nb));
    }
    return cleanLoop(out);
  }

  /* ---------------- 点/多边形关系 ---------------- */
  function pointInPoly(pt, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-15) + xi)) inside = !inside;
    }
    return inside;
  }
  function segHit(p1, p2, p3, p4) {
    var d1 = cross(sub(p2, p1), sub(p3, p1)), d2 = cross(sub(p2, p1), sub(p4, p1));
    var d3 = cross(sub(p4, p3), sub(p1, p3)), d4 = cross(sub(p4, p3), sub(p2, p3));
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }
  function polysOverlap(a, b) {
    var ba = bboxOf(a), bb = bboxOf(b), i, j;
    if (ba.x1 < bb.x0 || bb.x1 < ba.x0 || ba.y1 < bb.y0 || bb.y1 < ba.y0) return false;
    for (i = 0; i < a.length; i++) {
      for (j = 0; j < b.length; j++) {
        if (segHit(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
      }
    }
    return pointInPoly(a[0], b) || pointInPoly(b[0], a);
  }
  function selfIntersects(pts) {
    var n = pts.length;
    for (var i = 0; i < n; i++) {
      for (var j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segHit(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
      }
    }
    return false;
  }

  global.G = {
    EPS: EPS, D2R: D2R, R2D: R2D, TAU: TAU,
    P: P, clone: clone, eq: eq, clamp: clamp, round: round,
    add: add, sub: sub, mul: mul, dot: dot, cross: cross, len: len, norm: norm,
    left: left, right: right, rotv: rotv, lerp: lerp,
    bulgeOf: bulgeOf, sweepOf: sweepOf, arcFromBulge: arcFromBulge, arcPoint: arcPoint,
    arcTangent: arcTangent, splitArcs: splitArcs,
    flatten: flatten, signedArea: signedArea, loopArea: loopArea, loopLength: loopLength,
    bboxOf: bboxOf, loopBBox: loopBBox, bboxUnion: bboxUnion,
    xform: xform, reverse: reverse, ensureOrient: ensureOrient, translate: translate,
    rect: rect, rectC: rectC, roundRect: roundRect, slotC: slotC, circle: circle, polygon: polygon,
    frame: frame, replaceEdge: replaceEdge, cleanLoop: cleanLoop, loopFromSegments: loopFromSegments,
    offsetLoop: offsetLoop,
    pointInPoly: pointInPoly, segHit: segHit, polysOverlap: polysOverlap, selfIntersects: selfIntersects
  };
})(typeof window !== 'undefined' ? window : this);
