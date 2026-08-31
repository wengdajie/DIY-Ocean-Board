/* ============================================================
 * imagetrace.js - 位图 -> 矢量轮廓 (无依赖第三方库)
 *
 * 流程: ImageData -> 灰度 -> Otsu/手动阈值 -> 二值掩膜
 *        -> 去噪(连通域过滤) -> 裂缝追踪(crack following)
 *        -> Douglas-Peucker 简化 -> 按绕向分出外轮廓/孔 -> 缩放到 mm
 *
 * 掩膜: Uint8Array(w*h)，1 = 材料。像素坐标 y 向下。
 * 追踪输出: 像素角点整数坐标的闭合环（y 向下）。
 *   由构造保证: 外轮廓与孔的绕向相反 —— 用带符号面积即可区分，无需嵌套测试。
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G;

  /* ---------------- 灰度 / 阈值 ---------------- */
  function grayFrom(img) {
    var d = img.data, n = img.width * img.height;
    var g = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var a = d[i * 4 + 3] / 255;
      // 透明区域按白色(背景)处理，便于抠好的 PNG 直接用
      var r = d[i * 4] * a + 255 * (1 - a);
      var gg = d[i * 4 + 1] * a + 255 * (1 - a);
      var b = d[i * 4 + 2] * a + 255 * (1 - a);
      g[i] = (r * 0.299 + gg * 0.587 + b * 0.114) | 0;
    }
    return g;
  }

  function histOf(gray) {
    var h = new Float64Array(256);
    for (var i = 0; i < gray.length; i++) h[gray[i]]++;
    return h;
  }

  /* Otsu 最大类间方差自动阈值
   * 注意: 纯黑白图(直方图只有 0 和 255 两根)时, 0..254 的类间方差完全相同。
   * 若只取"首个"最大值会得到 0（等价于阈值几乎无效）。
   * 因此这里记录并列最优的整个区间, 返回其中点 —— 对双峰图即为 127。 */
  function otsu(gray) {
    var h = histOf(gray), total = gray.length;
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * h[i];
    var sumB = 0, wB = 0, best = -1, lo = 127, hi = 127;
    for (i = 0; i < 256; i++) {
      wB += h[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * h[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best * (1 + 1e-12) && Math.abs(v - best) > best * 1e-12) { best = v; lo = hi = i; }
      else if (Math.abs(v - best) <= Math.abs(best) * 1e-12) { hi = i; }
    }
    return Math.round((lo + hi) / 2);
  }

  /* ---------------- 二值化 ----------------
   * 默认: 深色 = 材料 (gray <= threshold)
   * invert: 浅色 = 材料
   * alphaOnly: 只按透明度取材料(适合已抠图 PNG)
   */
  function maskFrom(img, opts) {
    opts = opts || {};
    var w = img.width, h = img.height, n = w * h;
    var mask = new Uint8Array(n), i;
    if (opts.alphaOnly) {
      var d = img.data, at = opts.alphaThreshold === undefined ? 128 : opts.alphaThreshold;
      for (i = 0; i < n; i++) mask[i] = d[i * 4 + 3] >= at ? 1 : 0;
    } else {
      var gray = grayFrom(img);
      var t = (opts.threshold === undefined || opts.threshold === null || opts.threshold < 0) ? otsu(gray) : opts.threshold;
      for (i = 0; i < n; i++) mask[i] = (gray[i] <= t) ? 1 : 0;
      opts.usedThreshold = t;
    }
    if (opts.invert) for (i = 0; i < n; i++) mask[i] = mask[i] ? 0 : 1;
    return { mask: mask, w: w, h: h, threshold: opts.usedThreshold };
  }

  /* ---------------- 连通域 ---------------- */
  // 返回 {labels:Int32Array, sizes:[], count} ；conn = 4 或 8
  function labelComponents(mask, w, h, target, conn) {
    var labels = new Int32Array(w * h).fill(-1);
    var sizes = [], stack = [], count = 0;
    var dx4 = [1, -1, 0, 0], dy4 = [0, 0, 1, -1];
    var dx8 = [1, -1, 0, 0, 1, 1, -1, -1], dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
    var dx = conn === 8 ? dx8 : dx4, dy = conn === 8 ? dy8 : dy4;
    for (var s = 0; s < w * h; s++) {
      if (mask[s] !== target || labels[s] !== -1) continue;
      var id = count++, size = 0;
      stack.length = 0; stack.push(s); labels[s] = id;
      while (stack.length) {
        var p = stack.pop(); size++;
        var px = p % w, py = (p - px) / w;
        for (var k = 0; k < dx.length; k++) {
          var nx = px + dx[k], ny = py + dy[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var q = ny * w + nx;
          if (mask[q] !== target || labels[q] !== -1) continue;
          labels[q] = id; stack.push(q);
        }
      }
      sizes.push(size);
    }
    return { labels: labels, sizes: sizes, count: count };
  }

  /* 去噪: 删掉面积 < minArea 的材料斑点，并填掉面积 < minHole 的孔洞 */
  function despeckle(m, minArea, minHole) {
    var mask = m.mask, w = m.w, h = m.h, i;
    if (minArea > 0) {
      var fg = labelComponents(mask, w, h, 1, 8);
      for (i = 0; i < mask.length; i++) {
        if (mask[i] === 1 && fg.sizes[fg.labels[i]] < minArea) mask[i] = 0;
      }
    }
    if (minHole > 0) {
      var bg = labelComponents(mask, w, h, 0, 4);
      // 与图像边框相连的背景是"外部"，不能填
      var outside = {};
      for (i = 0; i < w; i++) { outside[bg.labels[i]] = 1; outside[bg.labels[(h - 1) * w + i]] = 1; }
      for (i = 0; i < h; i++) { outside[bg.labels[i * w]] = 1; outside[bg.labels[i * w + w - 1]] = 1; }
      for (i = 0; i < mask.length; i++) {
        var L = bg.labels[i];
        if (mask[i] === 0 && !outside[L] && bg.sizes[L] < minHole) mask[i] = 1;
      }
    }
    return m;
  }

  function maskArea(m) {
    var n = 0;
    for (var i = 0; i < m.mask.length; i++) if (m.mask[i]) n++;
    return n;
  }
  function maskBBox(m) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var y = 0; y < m.h; y++) {
      for (var x = 0; x < m.w; x++) {
        if (!m.mask[y * m.w + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < x0) return null;
    return { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /* ---------------- 裂缝追踪 ----------------
   * 沿"像素之间的缝"走边界，得到精确的直角多边形。
   * 对每个材料像素，把与背景相邻的那条边作为有向边推入：
   *   上邻空 -> (x,y)->(x+1,y)      右邻空 -> (x+1,y)->(x+1,y+1)
   *   下邻空 -> (x+1,y+1)->(x,y+1)  左邻空 -> (x,y+1)->(x,y)
   * 该定向使材料恒在前进方向右侧(图像 y 向下)，
   * 因此外轮廓与孔的绕向天然相反。
   */
  function traceMask(m) {
    var mask = m.mask, w = m.w, h = m.h;
    var at = function (x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return 0;
      return mask[y * w + x];
    };
    var edges = new Map();      // key(起点) -> [终点...]
    var key = function (x, y) { return x * 100003 + y; };
    function push(x0, y0, x1, y1) {
      var k = key(x0, y0);
      var a = edges.get(k);
      if (!a) { a = []; edges.set(k, a); }
      a.push({ x: x1, y: y1, used: false, sx: x0, sy: y0 });
    }
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!at(x, y)) continue;
        if (!at(x, y - 1)) push(x, y, x + 1, y);
        if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1);
        if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1);
        if (!at(x - 1, y)) push(x, y + 1, x, y);
      }
    }
    var loops = [];
    edges.forEach(function (list) {
      list.forEach(function (e0) {
        if (e0.used) return;
        // 从这条未用边开始串一个闭环
        var loop = [], cur = e0, guard = 0, limit = w * h * 4 + 64;
        var startX = e0.sx, startY = e0.sy;
        while (cur && !cur.used && guard++ < limit) {
          cur.used = true;
          loop.push({ x: cur.sx, y: cur.sy });
          var nx = cur.x, ny = cur.y;
          if (nx === startX && ny === startY) break;
          var cand = edges.get(key(nx, ny));
          if (!cand) break;
          var avail = cand.filter(function (c) { return !c.used; });
          if (!avail.length) break;
          if (avail.length === 1) { cur = avail[0]; continue; }
          // 对角相接处有歧义: 选"最右转"的分支，保持 4-连通材料不被错误合并
          var idir = { x: cur.x - cur.sx, y: cur.y - cur.sy };
          var best = null, bestScore = -Infinity;
          avail.forEach(function (c) {
            var od = { x: c.x - c.sx, y: c.y - c.sy };
            var crs = idir.x * od.y - idir.y * od.x;   // y 向下: >0 为右转
            var dt = idir.x * od.x + idir.y * od.y;
            var score = crs > 0 ? 3 : (crs === 0 && dt > 0 ? 2 : (crs < 0 ? 1 : 0));
            if (score > bestScore) { bestScore = score; best = c; }
          });
          cur = best;
        }
        if (loop.length >= 4) loops.push(loop);
      });
    });
    return loops;
  }

  /* ---------------- Douglas-Peucker (闭合环) ---------------- */
  function dpOpen(pts, tol) {
    if (pts.length < 3) return pts.slice();
    var keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1];
      if (b <= a + 1) continue;
      var A = pts[a], B = pts[b];
      var dx = B.x - A.x, dy = B.y - A.y;
      var L = Math.hypot(dx, dy);
      var worst = -1, wi = -1;
      for (var i = a + 1; i < b; i++) {
        var d;
        if (L < 1e-12) d = Math.hypot(pts[i].x - A.x, pts[i].y - A.y);
        else d = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / L;
        if (d > worst) { worst = d; wi = i; }
      }
      if (worst > tol && wi > 0) {
        keep[wi] = 1;
        stack.push([a, wi]); stack.push([wi, b]);
      }
    }
    var out = [];
    for (var k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
    return out;
  }

  function simplifyClosed(loop, tol) {
    if (!tol || tol <= 0 || loop.length < 4) return loop.slice();
    // 以相距最远的两点切开，分别简化，避免起点被误删
    var i0 = 0, i1 = 0, best = -1;
    for (var i = 1; i < loop.length; i++) {
      var d = (loop[i].x - loop[0].x) * (loop[i].x - loop[0].x) + (loop[i].y - loop[0].y) * (loop[i].y - loop[0].y);
      if (d > best) { best = d; i1 = i; }
    }
    var a = loop.slice(i0, i1 + 1);
    var b = loop.slice(i1).concat([loop[0]]);
    var sa = dpOpen(a, tol), sb = dpOpen(b, tol);
    var out = sa.slice(0, sa.length - 1).concat(sb.slice(0, sb.length - 1));
    return out.length >= 3 ? out : loop.slice();
  }

  /* 去掉共线的冗余顶点(裂缝追踪与 DP 简化会留下一些) */
  function dropCollinear(pts, tol) {
    tol = tol || 1e-9;
    var n = pts.length;
    if (n < 4) return pts.map(function (p) { return G.P(p.x, p.y); });
    var out = [];
    for (var i = 0; i < n; i++) {
      var a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      var cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cr) > tol) out.push(G.P(b.x, b.y));
    }
    return out.length >= 3 ? out : pts.map(function (p) { return G.P(p.x, p.y); });
  }

  /* ---------------- 环 -> 零件几何 ----------------
   * 输出 CAD 坐标(y 向上, mm), 外轮廓 CCW / 孔 CW
   * 返回 [{outer, holes}]，按面积降序
   */
  function loopsToShapes(loops, opts) {
    opts = opts || {};
    var scale = opts.scale || 1;
    var H = opts.imgH || 0;
    var minAreaMM = opts.minAreaMM || 0;

    /* 关键: 先在"图像坐标系"里判定外轮廓/孔, 再翻转 y。
     * traceMask 的定向使材料恒在前进方向右侧(图像 y 向下),
     * 于是图像坐标下 外轮廓面积 > 0、孔面积 < 0。
     * 翻转 y 会让所有面积反号, 若在翻转后再判定就会把两者搞反。 */
    var conv = loops.map(function (lp) {
      var imgArea = G.signedArea(lp);
      var pts = lp.map(function (p) { return { x: p.x * scale, y: (H - p.y) * scale }; });
      return { pts: pts, imgArea: imgArea, area: Math.abs(imgArea) * scale * scale };
    }).filter(function (o) { return o.area >= minAreaMM; });

    var outers = conv.filter(function (o) { return o.imgArea > 0; });
    var holes = conv.filter(function (o) { return o.imgArea < 0; });
    outers.sort(function (a, b) { return b.area - a.area; });

    var shapes = outers.map(function (o) {
      return { outer: G.ensureOrient(dropCollinear(o.pts), true), holes: [] };
    });
    // 每个孔归属到"包含它且面积最小"的外轮廓
    holes.forEach(function (hl) {
      var host = -1, hostArea = Infinity;
      for (var i = 0; i < shapes.length; i++) {
        var op = G.flatten(shapes[i].outer, 0.5);
        if (!G.pointInPoly(hl.pts[0], op)) continue;
        var ar = Math.abs(outers[i].area);
        if (ar < hostArea) { hostArea = ar; host = i; }
      }
      if (host >= 0) {
        shapes[host].holes.push(G.ensureOrient(dropCollinear(hl.pts), false));
      }
    });
    return shapes;
  }

  /* ---------------- 掩膜编辑(用于加榫头 / 开槽) ----------------
   * 直接在位图上加/减材料，之后再追踪 —— 这样不需要任何多边形布尔运算，
   * 拓扑变化(开槽把一块切成两半等)由追踪器自动处理。
   */
  function paintRect(m, x0, y0, x1, y1, val) {
    var xa = Math.max(0, Math.round(Math.min(x0, x1))), xb = Math.min(m.w, Math.round(Math.max(x0, x1)));
    var ya = Math.max(0, Math.round(Math.min(y0, y1))), yb = Math.min(m.h, Math.round(Math.max(y0, y1)));
    for (var y = ya; y < yb; y++) {
      for (var x = xa; x < xb; x++) m.mask[y * m.w + x] = val;
    }
    return m;
  }

  // 在四周加边距，保证加榫头/开槽后仍在画布内
  function padMask(m, pad) {
    if (!pad) return m;
    var w2 = m.w + pad * 2, h2 = m.h + pad * 2;
    var nm = new Uint8Array(w2 * h2);
    for (var y = 0; y < m.h; y++) {
      for (var x = 0; x < m.w; x++) {
        if (m.mask[y * m.w + x]) nm[(y + pad) * w2 + (x + pad)] = 1;
      }
    }
    return { mask: nm, w: w2, h: h2, threshold: m.threshold };
  }

  /* 底部着地区间: 返回像素列区间 [[x0,x1]..]，这些列的材料延伸到最低行附近
   * tolPx: 允许离最低行的偏差
   */
  function bottomSpans(m, tolPx) {
    tolPx = tolPx === undefined ? 2 : tolPx;
    var w = m.w, h = m.h, colBottom = new Int32Array(w).fill(-1);
    for (var x = 0; x < w; x++) {
      for (var y = h - 1; y >= 0; y--) {
        if (m.mask[y * w + x]) { colBottom[x] = y; break; }
      }
    }
    var maxY = -1;
    for (var i = 0; i < w; i++) if (colBottom[i] > maxY) maxY = colBottom[i];
    if (maxY < 0) return { spans: [], baseY: -1 };
    var spans = [], cur = null;
    for (var x2 = 0; x2 < w; x2++) {
      var on = colBottom[x2] >= maxY - tolPx;
      if (on) { if (!cur) cur = [x2, x2 + 1]; else cur[1] = x2 + 1; }
      else if (cur) { spans.push(cur); cur = null; }
    }
    if (cur) spans.push(cur);
    return { spans: spans, baseY: maxY + 1 };
  }

  /* ---------------- 保角平滑 (pin-smooth) ----------------
   * 裂缝追踪出来的环全是 90 度像素锯齿, 直接 DP 简化在斜边上会留下大量
   * "楼梯"顶点(容差略小于台阶高度时无法压平)。做法:
   *   1) 先用较大容差 DP 找出"结构性拐角"(星角/直角), 标记为 pin(不动)
   *   2) 其余点做若干次 [1,2,1]/4 平滑, 把锯齿抹平成近似直线/圆弧
   *   3) 再用目标容差 DP 简化
   * 结果: 五角星 10~13 点, 圆 30 点左右, 矩形/十字仍精确 4/12 点, 面积误差 <0.5%
   */
  function smoothLoop(loop, tol, iters) {
    var n = loop.length;
    if (n < 8 || !tol || tol <= 0) return loop.map(function (p) { return G.P(p.x, p.y); });
    iters = iters === undefined ? 2 : iters;
    // 用 2x 容差找结构拐角
    var keep = simplifyClosed(loop, Math.max(2, tol * 2));
    var pin = new Uint8Array(n), idx = 0;
    for (var i = 0; i < n && idx < keep.length; i++) {
      if (loop[i] === keep[idx]) { pin[i] = 1; idx++; }
    }
    if (idx < keep.length) {           // 引用未命中(被复制过) -> 退化为坐标匹配
      pin = new Uint8Array(n);
      var key = {};
      keep.forEach(function (p) { key[p.x + ',' + p.y] = 1; });
      for (var j = 0; j < n; j++) if (key[loop[j].x + ',' + loop[j].y]) pin[j] = 1;
    }
    var cur = loop.map(function (p) { return { x: p.x, y: p.y }; });
    for (var it = 0; it < iters; it++) {
      var nx = new Array(n);
      for (var k = 0; k < n; k++) {
        if (pin[k]) { nx[k] = { x: cur[k].x, y: cur[k].y }; continue; }
        var a = cur[(k - 1 + n) % n], b = cur[k], c = cur[(k + 1) % n];
        nx[k] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 };
      }
      cur = nx;
    }
    return cur.map(function (p) { return G.P(p.x, p.y); });
  }

  /* 描摹后处理一条龙: 保角平滑 + 简化。smooth=false 则只简化。 */
  function refineLoop(loop, tol, smooth) {
    if (smooth === false) return simplifyClosed(loop, tol);
    return simplifyClosed(smoothLoop(loop, tol, 2), tol);
  }

  global.Trace = {
    grayFrom: grayFrom, otsu: otsu, maskFrom: maskFrom,
    labelComponents: labelComponents, despeckle: despeckle,
    maskArea: maskArea, maskBBox: maskBBox,
    traceMask: traceMask, simplifyClosed: simplifyClosed, dpOpen: dpOpen,
    smoothLoop: smoothLoop, refineLoop: refineLoop,
    loopsToShapes: loopsToShapes, dropCollinear: dropCollinear,
    paintRect: paintRect, padMask: padMask, bottomSpans: bottomSpans
  };
})(typeof window !== 'undefined' ? window : this);
