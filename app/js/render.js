/* ============================================================
 * render.js - 2D 排样/零件视图 + 3D 等轴测装配预览（纯 Canvas 2D）
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G;

  function dpr() { return Math.min(2, global.devicePixelRatio || 1); }
  function fitCanvas(cv) {
    var r = dpr();
    var w = cv.clientWidth || 800, h = cv.clientHeight || 600;
    if (cv.width !== Math.round(w * r) || cv.height !== Math.round(h * r)) {
      cv.width = Math.round(w * r); cv.height = Math.round(h * r);
    }
    var g = cv.getContext('2d');
    g.setTransform(r, 0, 0, r, 0, 0);
    return { g: g, w: w, h: h };
  }

  function pathLoop(g, loop, tf) {
    var n = loop.length, i;
    for (i = 0; i < n; i++) {
      var p1 = loop[i], p2 = loop[(i + 1) % n];
      var a1 = tf(p1);
      if (i === 0) g.moveTo(a1.x, a1.y);
      if (p1.b) {
        var arc = G.arcFromBulge(p1, p2, p1.b);
        if (arc) {
          var steps = Math.max(4, Math.min(90, Math.ceil(Math.abs(arc.sweep) / 0.12)));
          for (var k = 1; k <= steps; k++) {
            var q = tf(G.arcPoint(arc, k / steps));
            g.lineTo(q.x, q.y);
          }
          continue;
        }
      }
      var a2 = tf(p2);
      g.lineTo(a2.x, a2.y);
    }
    g.closePath();
  }

  /* ---------------- 2D: 排样视图 ---------------- */
  function drawNest(cv, result, opts) {
    opts = opts || {};
    var c = fitCanvas(cv), g = c.g;
    g.clearRect(0, 0, c.w, c.h);
    var sheets = result.sheets;
    if (!sheets.length) { return; }
    var SW = result.stats.sheetW, SH = result.stats.sheetH;
    var pad = 24, gapY = 22;
    // 竖向堆叠所有板
    var totalH = sheets.length * SH + (sheets.length - 1) * (gapY / 1);
    var s = Math.min((c.w - pad * 2) / SW, (c.h - pad * 2) / (SH * sheets.length + gapY * (sheets.length - 1)));
    s *= (opts.zoom || 1);
    var ox = (c.w - SW * s) / 2 + (opts.panX || 0);
    var oy = pad + (opts.panY || 0);

    var tfs = [];
    sheets.forEach(function (sh, si) {
      var y0 = oy + si * (SH + gapY) * s;
      var T = function (p) { return { x: ox + p.x * s, y: y0 + (SH - p.y) * s }; };
      // 板材底
      g.fillStyle = opts.sheetColor || '#f7f4ec';
      g.fillRect(ox, y0, SW * s, SH * s);
      g.strokeStyle = '#b5a68c'; g.lineWidth = 1;
      g.strokeRect(ox, y0, SW * s, SH * s);
      // 留白线
      var m = opts.margin === undefined ? 10 : opts.margin;
      if (m > 0) {
        g.save(); g.setLineDash([4, 4]); g.strokeStyle = '#c0ab84';
        g.strokeRect(ox + m * s, y0 + m * s, (SW - 2 * m) * s, (SH - 2 * m) * s);
        g.restore();
      }
      // 零件
      sh.placements.forEach(function (pl, pi) {
        var q = pl.part.transformed(pl.xf);
        g.beginPath();
        pathLoop(g, q.outer, T);
        q.holes.forEach(function (h) { pathLoop(g, h, T); });
        g.fillStyle = opts.partColor || 'rgba(47,107,176,.30)';
        g.fill('evenodd');
        g.strokeStyle = opts.cutColor || '#1c4f88';
        g.lineWidth = Math.max(0.7, 1.1);
        g.stroke();
        /* 定深铣槽: 虚线绿, 明确区分"不切透" */
        if (q.pockets.length) {
          g.save();
          g.setLineDash([4, 3]);
          g.strokeStyle = opts.pocketColor || '#12a06a';
          g.fillStyle = 'rgba(18,160,106,.18)';
          g.lineWidth = 1;
          q.pockets.forEach(function (pk) {
            g.beginPath(); pathLoop(g, pk.loop, T); g.fill(); g.stroke();
          });
          g.restore();
        }
        // 标签
        var b = q.bbox();
        /* 纹理方向: 在零件上画一组细平行线, 一眼看出顺纹方向 */
        var gr = pl.part.meta && pl.part.meta.grain;
        if ((gr === 'long' || gr === 'cross') && Math.min(b.w, b.h) * s > 26) {
          g.save();
          /* 裁剪区必须**排除孔**(evenodd), 否则纹理线会横穿榫眼/洞洞板孔,
           * 视觉上把已经挖穿的孔又"画回去"了 —— 洞洞板上尤其明显:
           * 某一行孔恰好落在一条纹理线上, 那一整行看起来就没挖通。 */
          g.beginPath();
          pathLoop(g, q.outer, T);
          q.holes.forEach(function (h) { pathLoop(g, h, T); });
          g.clip('evenodd');
          g.strokeStyle = 'rgba(24,66,114,.46)';
          g.lineWidth = 1;
          // 排样后, 纹理走向 = 零件局部 +x 经 rot 旋转后的方向
          var horiz = (pl.rot === 0);
          var step = Math.max(7, Math.min(18, Math.min(b.w, b.h) * s / 5));
          var p0 = T({ x: b.x0, y: b.y0 }), p1 = T({ x: b.x1, y: b.y1 });
          var lx0 = Math.min(p0.x, p1.x), lx1 = Math.max(p0.x, p1.x);
          var ly0 = Math.min(p0.y, p1.y), ly1 = Math.max(p0.y, p1.y);
          g.beginPath();
          if (horiz) {
            for (var yy = ly0 + step; yy < ly1; yy += step) { g.moveTo(lx0, yy); g.lineTo(lx1, yy); }
          } else {
            for (var xx = lx0 + step; xx < lx1; xx += step) { g.moveTo(xx, ly0); g.lineTo(xx, ly1); }
          }
          g.stroke();
          g.restore();
        }
        var cx = ox + (b.x0 + b.w / 2) * s, cy = y0 + (SH - (b.y0 + b.h / 2)) * s;
        var fs = Math.max(8, Math.min(15, Math.min(b.w, b.h) * s / 5));
        if (fs >= 7) {
          g.fillStyle = '#123a5e';
          g.font = '600 ' + fs + 'px "Segoe UI", sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(pl.name, cx, cy);
          if (fs >= 10) {
            g.font = (fs * 0.78) + 'px "Segoe UI", sans-serif';
            g.fillStyle = '#3c5a78';
            g.fillText(Math.round(b.w) + '×' + Math.round(b.h), cx, cy + fs * 1.15);
          }
        }
      });
      // 板号
      g.fillStyle = '#6b6152'; g.font = '11px "Segoe UI", sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText('板材 ' + (si + 1) + '  ' + SW + '×' + SH + 'mm  利用率 ' +
        (sh.utilization * 100).toFixed(1) + '%', ox, y0 - 4);
      tfs.push({ ox: ox, oy: y0, scale: s, T: T });
    });
    return { scale: s, sheetTf: tfs };
  }

  /* ---------------- 2D: 单零件详图 ---------------- */
  function drawParts(cv, parts, opts) {
    opts = opts || {};
    var c = fitCanvas(cv), g = c.g;
    g.clearRect(0, 0, c.w, c.h);
    if (!parts.length) return;
    var cols = Math.ceil(Math.sqrt(parts.length * (c.w / Math.max(1, c.h)) ));
    cols = Math.max(1, Math.min(cols, parts.length));
    var rows = Math.ceil(parts.length / cols);
    var cw = c.w / cols, ch = c.h / rows;
    var tfs = [];
    parts.forEach(function (p, i) {
      var cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
      var b = p.bbox();
      var pad = 26;
      var s = Math.min((cw - pad * 2) / Math.max(1, b.w), (ch - pad * 2) / Math.max(1, b.h)) * (opts.zoom || 1);
      var ox = cx + (cw - b.w * s) / 2 - b.x0 * s;
      var oy = cy + (ch - b.h * s) / 2 + b.y1 * s;
      var T = function (q) { return { x: ox + q.x * s, y: oy - q.y * s }; };
      g.beginPath();
      pathLoop(g, p.outer, T);
      p.holes.forEach(function (h) { pathLoop(g, h, T); });
      g.fillStyle = 'rgba(47,107,176,.15)';
      g.fill('evenodd');
      g.strokeStyle = '#2f6bb0'; g.lineWidth = 1.2; g.stroke();
      // 定深铣槽: 虚线 + 深度文字
      if (p.pockets.length) {
        g.save();
        g.setLineDash([4, 3]);
        g.strokeStyle = '#2f8f6a'; g.fillStyle = 'rgba(47,143,106,.18)'; g.lineWidth = 1.1;
        p.pockets.forEach(function (pk) {
          g.beginPath(); pathLoop(g, pk.loop, T); g.fill(); g.stroke();
        });
        g.restore();
        g.fillStyle = '#237053'; g.font = '10px "Segoe UI", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        p.pockets.forEach(function (pk) {
          var pb = G.loopBBox(pk.loop);
          var mid = T({ x: (pb.x0 + pb.x1) / 2, y: (pb.y0 + pb.y1) / 2 });
          if ((pb.x1 - pb.x0) * s > 30) g.fillText('▽' + G.round(pk.depth, 1), mid.x, mid.y);
        });
      }
      // 名称与尺寸
      g.fillStyle = '#1f1b15'; g.font = '600 12px "Segoe UI", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText(p.name + (p.qty > 1 ? ' ×' + p.qty : ''), cx + cw / 2, cy + 6);
      g.fillStyle = '#6b6152'; g.font = '11px "Segoe UI", sans-serif';
      g.textBaseline = 'bottom';
      var GN = { long: '横纹', cross: '竖纹' };
      g.fillText(Math.round(b.w) + ' × ' + Math.round(b.h) + ' × ' + p.thickness + 'mm' +
        (p.holes.length ? '   孔 ' + p.holes.length : '') +
        (p.pockets.length ? '   铣槽 ' + p.pockets.length : '') +
        (GN[p.meta.grain] ? '   ' + GN[p.meta.grain] : ''), cx + cw / 2, cy + ch - 6);
      // 网格分隔
      g.strokeStyle = '#ddd3bf'; g.lineWidth = 1;
      g.strokeRect(cx + .5, cy + .5, cw - 1, ch - 1);
      tfs.push({ part: p, scale: s, T: T });
    });
    return { tf: tfs, cols: cols, rows: rows };
  }

  /* ---------------- 3D: 等轴测装配 ----------------
   * 用零件的 asm 元数据把 2D 板拉伸成盒子, 再投影到屏幕。
   *
   * 这一版把"假 3D"换成了一套真的相机, 因为旧实现有几处硬伤:
   *   1) 深度排序用 (x+y+z), 但这个和真实视线方向无关。绕到 ang>180 后
   *      前后关系整个反过来, 板会互相穿插(远处的板画在近处板上面)。
   *   2) 明暗按"面的序号"查表(第 0 面固定 0.55 倍), 而不是按面的法向与光源夹角。
   *      于是转视角时同一个物理面亮度不变, 立体感是假的; 转到背面还会更亮。
   *   3) 背面剔除只看屏幕面积符号, 没考虑相机在哪一侧, 某些角度会剔错。
   *
   * 现在的做法: 显式构造相机基向量 (right / up / fwd), 三者正交。
   *   - 投影 = 点在 right/up 上的分量
   *   - 深度 = 点在 fwd 上的分量(唯一正确的排序键)
   *   - 明暗 = 面法向 · 光向 (Lambert) + 环境光
   *   - 剔除 = 面法向 · 视线 < 0
   * 这样任意 ang/tilt 都自洽。
   */
  var D3 = {
    /* ang: 绕 z 轴方位角(度)  tilt: 俯仰(0=水平看, 越大越俯视) */
    cam: function (ang, tilt) {
      var a = (ang === undefined ? 30 : ang) * G.D2R;
      /* 旧参数 tilt 是个 0..1.6 的"压扁系数", 不是角度。为了不破坏已有的
       * 交互手感与存档, 这里把它换算成俯仰角: tilt=0.55 -> 约 29 度。 */
      var el = Math.atan(tilt === undefined ? 0.55 : tilt);
      var ca = Math.cos(a), sa = Math.sin(a), ce = Math.cos(el), se = Math.sin(el);
      /* 视线方向(从相机指向场景) */
      var fwd = { x: -ca * ce, y: -sa * ce, z: -se };
      /* 屏幕右 = 世界 z 轴叉视线, 归一化后水平 */
      var right = { x: -sa, y: ca, z: 0 };
      /* 屏幕上 = right × fwd */
      var up = {
        x: right.y * fwd.z - right.z * fwd.y,
        y: right.z * fwd.x - right.x * fwd.z,
        z: right.x * fwd.y - right.y * fwd.x
      };
      return { right: right, up: up, fwd: fwd };
    },
    /* 世界点 -> 屏幕坐标(未缩放, y 向下为正) */
    project: function (p, cm) {
      return {
        x: p.x * cm.right.x + p.y * cm.right.y + p.z * cm.right.z,
        y: -(p.x * cm.up.x + p.y * cm.up.y + p.z * cm.up.z)
      };
    },
    /* 沿视线的深度: 越大越远 */
    depth: function (p, cm) {
      return p.x * cm.fwd.x + p.y * cm.fwd.y + p.z * cm.fwd.z;
    }
  };

  /* 兼容旧签名: iso(p, ang, tilt) 仍返回屏幕坐标 */
  function iso(p, ang, tilt) {
    return D3.project(p, D3.cam(ang, tilt));
  }

  /* ============================================================
   * 用零件的 asm 元数据把 2D 板"立"到 3D 里。
   *
   * 【meta.asm 的唯一语义】(第 6 轮统一, 以前三种平面各搞一套 -> 3D 全面错位)
   *   asm = { plane, x, y, z }
   *   · plane 平面内的两个轴(u/v): 给的是**零件局部 2D 坐标原点 (0,0) 在世界里的位置**。
   *     也就是 models.panel(w,h) 画出来那个矩形的左下角。
   *   · 法向轴(n): 给的是板厚区间的**低面**(即 at - t/2, 不是中心面)。
   *
   * 为什么必须是"局部原点"而不是"包围盒最小角":
   *   出榫的板其 bbox 会超出矩形(榫头伸到 x0 = -t), 而“榫头伸多少”是逐边不对称的。
   *   让生产者报"矩形角"无需关心榫头; 包围盒偏移由这里统一加上。
   *   旧版直接拿 m.x 当起点、却用含榫的 b.w 当长度 -> 整块板偏一个板厚。
   * ============================================================ */
  var ASM_MAP = {
    XY: { u: 'x', v: 'y', n: 'z' },   // 水平板: 厚度沿 z
    YZ: { u: 'y', v: 'z', n: 'x' },   // 左右立板: 厚度沿 x
    XZ: { u: 'x', v: 'z', n: 'y' }    // 前后立板: 厚度沿 y
  };
  function anum(v) { v = parseFloat(v); return isFinite(v) ? v : 0; }

  function boxesFrom(parts, dims) {
    var out = [];
    (parts || []).forEach(function (p) {
      var b = p.bbox(), t = p.thickness;
      var m = (p.meta && p.meta.asm) || {};
      var plane = ASM_MAP[m.plane] ? m.plane : 'XY';
      var M = ASM_MAP[plane];
      var pos = { x: 0, y: 0, z: 0 }, size = { x: 0, y: 0, z: 0 }, org = { x: 0, y: 0, z: 0 };
      /* 平面内两轴: 局部原点 + 包围盒局部偏移(含榫头的负偏移) */
      pos[M.u] = anum(m[M.u]) + b.x0;
      pos[M.v] = anum(m[M.v]) + b.y0;
      pos[M.n] = anum(m[M.n]);
      size[M.u] = b.w; size[M.v] = b.h; size[M.n] = t;
      org[M.u] = anum(m[M.u]); org[M.v] = anum(m[M.v]); org[M.n] = anum(m[M.n]);
      out.push({
        name: p.name, pos: pos, size: size, part: p,
        plane: plane, origin: org
      });
    });
    return out;
  }

  /* 整个装配体的世界包围盒。
   * 这是验证"3D 没错位"最硬的判据: 它必须等于标称 W/D/H。 */
  function asmBBox(boxes) {
    if (!boxes || !boxes.length) return null;
    var r = {
      x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity
    };
    boxes.forEach(function (b) {
      r.x0 = Math.min(r.x0, b.pos.x); r.x1 = Math.max(r.x1, b.pos.x + b.size.x);
      r.y0 = Math.min(r.y0, b.pos.y); r.y1 = Math.max(r.y1, b.pos.y + b.size.y);
      r.z0 = Math.min(r.z0, b.pos.z); r.z1 = Math.max(r.z1, b.pos.z + b.size.z);
    });
    r.w = r.x1 - r.x0; r.d = r.y1 - r.y0; r.h = r.z1 - r.z0;
    return r;
  }

  /* 盒体的 6 个面: 顶点序号 + 世界法向。
   * 顶点序按 verts() 的约定: 0..3 = z-, 4..7 = z+ */
  var BOX_FACES = [
    { q: [0, 3, 2, 1], n: { x: 0, y: 0, z: -1 }, key: 'z-' },
    { q: [4, 5, 6, 7], n: { x: 0, y: 0, z: 1 }, key: 'z+' },
    { q: [0, 1, 5, 4], n: { x: 0, y: -1, z: 0 }, key: 'y-' },
    { q: [3, 7, 6, 2], n: { x: 0, y: 1, z: 0 }, key: 'y+' },
    { q: [0, 4, 7, 3], n: { x: -1, y: 0, z: 0 }, key: 'x-' },
    { q: [1, 2, 6, 5], n: { x: 1, y: 0, z: 0 }, key: 'x+' }
  ];

  /* 一块板在世界里的"实体"表示。
   * 旧版把每块板画成 6 面的长方体 —— 于是**榫头、榫眼、指接齿全看不见**,
   * 3D 页只能看出"有几块板大概怎么摆", 看不出它们是怎么咬合的。
   *
   * 这里改成沿板厚方向**挤出零件真实轮廓**(含孔), 得到:
   *   - 2 个端面(带孔, evenodd 填充)
   *   - 外轮廓每段边一个侧壁四边形
   *   - 每个孔的每段边一个内壁四边形
   * 于是指接齿的凹凸、榫眼的洞在 3D 里是真的能看到的。
   *
   * 局部 2D -> 世界的映射(与 boxesFrom 的 pos/size 严格一致):
   *   XY: (x,y) -> (X,Y), 厚度沿 z      YZ: (x,y) -> (Y,Z), 厚度沿 x
   *   XZ: (x,y) -> (X,Z), 厚度沿 y
   */
  var PRISM_MAP = ASM_MAP;   /* 必须与 boxesFrom 同一张表: 分开写过一次, 改一处就串轴 */

  function prismOf(bx, delta) {
    var p = bx.part;
    if (!p || !p.outer || p.outer.length < 3) return null;
    var plane = (p.meta && p.meta.asm && p.meta.asm.plane) || 'XY';
    var M = PRISM_MAP[plane] || PRISM_MAP.XY;
    var b = p.bbox();
    var t = p.thickness;
    /* 厚度轴的起点直接取 boxesFrom 算好的 pos, 保证与盒模型对齐 */
    var n0 = bx.pos[M.n] + (delta ? delta[M.n] : 0);
    var u0 = bx.pos[M.u] + (delta ? delta[M.u] : 0);
    var v0 = bx.pos[M.v] + (delta ? delta[M.v] : 0);

    /* 局部 2D 点 -> 世界点, k = 0|1 选厚度的哪一端 */
    function W(q, k) {
      var o = { x: 0, y: 0, z: 0 };
      o[M.u] = u0 + (q.x - b.x0);
      o[M.v] = v0 + (q.y - b.y0);
      o[M.n] = n0 + (k ? t : 0);
      return o;
    }
    /* 局部 2D 法向 -> 世界法向 */
    function WN(nx, ny) {
      var o = { x: 0, y: 0, z: 0 };
      o[M.u] = nx; o[M.v] = ny; o[M.n] = 0;
      return o;
    }
    var nAxis = { x: 0, y: 0, z: 0 }; nAxis[M.n] = 1;
    var nAxisNeg = { x: 0, y: 0, z: 0 }; nAxisNeg[M.n] = -1;

    var outer = G.flatten(p.outer, 0.35);
    var holes = (p.holes || []).map(function (h) { return G.flatten(h, 0.35); });
    var faces = [];

    /* 两个端面: 带孔, 用 evenodd */
    faces.push({
      rings: [outer.map(function (q) { return W(q, 1); })]
        .concat(holes.map(function (h) { return h.map(function (q) { return W(q, 1); }); })),
      n: nAxis, evenodd: true, cap: true
    });
    faces.push({
      rings: [outer.slice().reverse().map(function (q) { return W(q, 0); })]
        .concat(holes.map(function (h) { return h.slice().reverse().map(function (q) { return W(q, 0); }); })),
      n: nAxisNeg, evenodd: true, cap: true
    });

    /* 侧壁: 每段边一个四边形。外轮廓 CCW -> 外法向 = (dy,-dx);
     * 孔是 CW, 同一公式自动给出"朝向孔内"的墙面法向, 正好是可见的那面。 */
    function walls(ring) {
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i], c2 = ring[(i + 1) % ring.length];
        var dx = c2.x - a.x, dy = c2.y - a.y;
        var L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        faces.push({
          rings: [[W(a, 0), W(c2, 0), W(c2, 1), W(a, 1)]],
          n: WN(dy / L, -dx / L)
        });
      }
    }
    walls(outer);
    holes.forEach(walls);
    return faces;
  }

  function drawAssembly(cv, boxes, opts) {
    opts = opts || {};
    var c = fitCanvas(cv), g = c.g;
    g.clearRect(0, 0, c.w, c.h);
    if (!boxes || !boxes.length) {
      if (opts.emptyText) {
        g.fillStyle = '#6b6152'; g.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(opts.emptyText, c.w / 2, c.h / 2);
      }
      return null;
    }
    var ang = opts.ang === undefined ? 30 : opts.ang;
    var tilt = opts.tilt === undefined ? 0.55 : opts.tilt;
    var ex = opts.explode || 0;
    var cm = D3.cam(ang, tilt);
    /* solid=true(默认): 挤出零件真实轮廓, 看得见榫卯;
     * solid=false: 退化成长方体(零件数极多时更快) */
    var solid = opts.solid !== false;

    /* 爆炸位移: 沿"整体中心 -> 该板中心"方向外推 */
    var C = { x: 0, y: 0, z: 0 };
    boxes.forEach(function (b) {
      C.x += (b.pos.x + b.size.x / 2) / boxes.length;
      C.y += (b.pos.y + b.size.y / 2) / boxes.length;
      C.z += (b.pos.z + b.size.z / 2) / boxes.length;
    });
    function deltaOf(bx) {
      if (!ex) return { x: 0, y: 0, z: 0 };
      return {
        x: (bx.pos.x + bx.size.x / 2 - C.x) * ex,
        y: (bx.pos.y + bx.size.y / 2 - C.y) * ex,
        z: (bx.pos.z + bx.size.z / 2 - C.z) * ex
      };
    }

    /* 收集所有面(世界坐标) */
    var items = [], pts = [];
    boxes.forEach(function (bx, bi) {
      var d = deltaOf(bx);
      var faces = solid ? prismOf(bx, d) : null;
      if (!faces) {
        /* 退化盒体 */
        var o = { x: bx.pos.x + d.x, y: bx.pos.y + d.y, z: bx.pos.z + d.z };
        var vs = [
          { x: o.x, y: o.y, z: o.z }, { x: o.x + bx.size.x, y: o.y, z: o.z },
          { x: o.x + bx.size.x, y: o.y + bx.size.y, z: o.z }, { x: o.x, y: o.y + bx.size.y, z: o.z },
          { x: o.x, y: o.y, z: o.z + bx.size.z }, { x: o.x + bx.size.x, y: o.y, z: o.z + bx.size.z },
          { x: o.x + bx.size.x, y: o.y + bx.size.y, z: o.z + bx.size.z }, { x: o.x, y: o.y + bx.size.y, z: o.z + bx.size.z }
        ];
        faces = BOX_FACES.map(function (F) {
          return { rings: [F.q.map(function (i) { return vs[i]; })], n: F.n, cap: F.key === 'z+' || F.key === 'z-' };
        });
      }
      faces.forEach(function (F) {
        F.box = bx; F.idx = bi;
        F.rings.forEach(function (r) { r.forEach(function (v) { pts.push(D3.project(v, cm)); }); });
        items.push(F);
      });
    });

    var bb = G.bboxOf(pts);
    var pad = 40;
    var s = Math.min((c.w - pad * 2) / Math.max(1, bb.w), (c.h - pad * 2) / Math.max(1, bb.h)) * (opts.zoom || 1);
    var ox = (c.w - bb.w * s) / 2 - bb.x0 * s + (opts.panX || 0);
    var oy = (c.h - bb.h * s) / 2 - bb.y0 * s + (opts.panY || 0);
    var T = function (v) { var q = D3.project(v, cm); return { x: ox + q.x * s, y: oy + q.y * s }; };

    /* 地面阴影: 给一个"落在地上"的暗影, 立体感立刻就出来了。
     * 只在没爆炸且确实俯视时画(仰视看不到地面)。 */
    if (opts.ground !== false && !ex && tilt > 0.12) {
      var gz = Infinity, gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
      boxes.forEach(function (bx) {
        gz = Math.min(gz, bx.pos.z);
        gx0 = Math.min(gx0, bx.pos.x); gx1 = Math.max(gx1, bx.pos.x + bx.size.x);
        gy0 = Math.min(gy0, bx.pos.y); gy1 = Math.max(gy1, bx.pos.y + bx.size.y);
      });
      var sh = 0.05 * Math.max(gx1 - gx0, gy1 - gy0);
      var quad = [
        T({ x: gx0 - sh, y: gy0 - sh, z: gz }), T({ x: gx1 + sh, y: gy0 - sh, z: gz }),
        T({ x: gx1 + sh, y: gy1 + sh, z: gz }), T({ x: gx0 - sh, y: gy1 + sh, z: gz })
      ];
      g.beginPath();
      g.moveTo(quad[0].x, quad[0].y);
      for (var qi = 1; qi < 4; qi++) g.lineTo(quad[qi].x, quad[qi].y);
      g.closePath();
      g.fillStyle = 'rgba(120,100,70,.11)';
      g.fill();
    }

    /* 方向光(世界坐标) + 环境光。用面法向点乘光向算明暗, 所以转视角时
     * 同一物理面的亮度会跟着变 —— 这才是立体感的来源。 */
    var LIGHT = (function () {
      var l = opts.light || { x: -0.42, y: -0.62, z: 0.66 };
      var m = Math.sqrt(l.x * l.x + l.y * l.y + l.z * l.z) || 1;
      return { x: l.x / m, y: l.y / m, z: l.z / m };
    })();
    var AMB = opts.ambient === undefined ? 0.5 : opts.ambient;
    var base = opts.color || [201, 161, 108];
    var selCol = opts.selColor || [214, 142, 46];
    var selName = opts.selected;

    /* 背面剔除 + 逐面深度排序。
     * 关键: 排序键必须是"沿视线的深度", 而不是 x+y+z —— 后者与视角无关,
     * 绕过 180 度后前后关系会整个反过来(远处的板画在近处板上面)。
     * 用面上所有顶点的**最近点**当键, 对薄板侧壁比用中心更稳。 */
    var vis = [];
    items.forEach(function (F) {
      var dv = F.n.x * cm.fwd.x + F.n.y * cm.fwd.y + F.n.z * cm.fwd.z;
      if (dv >= -1e-9) return;                     // 背对相机
      var poly = F.rings.map(function (r) { return r.map(T); });
      var dmin = Infinity, dsum = 0, nv = 0;
      F.rings.forEach(function (r) {
        r.forEach(function (v) {
          var dd = D3.depth(v, cm);
          if (dd < dmin) dmin = dd;
          dsum += dd; nv++;
        });
      });
      vis.push({ F: F, poly: poly, dmin: dmin, davg: dsum / Math.max(1, nv) });
    });
    /* 远的先画。同深度时端面压侧壁(端面才是"看得见板面"的那层) */
    vis.sort(function (A, B) {
      var d = B.davg - A.davg;
      if (Math.abs(d) > 1e-6) return d;
      return (A.F.cap ? 1 : 0) - (B.F.cap ? 1 : 0);
    });

    var hits = [];
    vis.forEach(function (V) {
      var F = V.F;
      var isSel = selName !== undefined && selName !== null &&
        (F.box.name === selName || (F.box.part && F.box.part.name === selName));
      var col = isSel ? selCol : base;
      /* 每块板一点亮度扰动, 相邻同向板才分得开(否则整柜糊成一片) */
      var jitter = 1 + ((F.idx % 5) - 2) * 0.03;
      var nd = F.n.x * LIGHT.x + F.n.y * LIGHT.y + F.n.z * LIGHT.z;
      var shade = (AMB + (1 - AMB) * Math.max(0, nd)) * jitter;
      g.beginPath();
      V.poly.forEach(function (r) {
        g.moveTo(r[0].x, r[0].y);
        for (var i = 1; i < r.length; i++) g.lineTo(r[i].x, r[i].y);
        g.closePath();
      });
      g.fillStyle = 'rgb(' + Math.round(G.clamp(col[0] * shade, 0, 255)) + ',' +
        Math.round(G.clamp(col[1] * shade, 0, 255)) + ',' +
        Math.round(G.clamp(col[2] * shade, 0, 255)) + ')';
      if (F.evenodd) g.fill('evenodd'); else g.fill();
      /* 只给端面描边: 侧壁太多, 全描边会糊成黑网 */
      if (F.cap || !solid) {
        g.strokeStyle = isSel ? 'rgba(120,70,10,.9)' : 'rgba(96,74,44,.45)';
        g.lineWidth = isSel ? 1.5 : 0.9;
        g.stroke();
      }
      hits.push({ box: F.box, part: F.box.part, poly: V.poly, dmin: V.dmin });
    });

    return {
      scale: s, ox: ox, oy: oy, cam: cm, faces: vis.length,
      project: function (v) { return T(v); },
      /* 命中测试: 从最靠前的面往后找 */
      hit: function (px, py) {
        var best = null;
        hits.forEach(function (h) {
          var inside = false;
          h.poly.forEach(function (r) {
            if (G.pointInPoly({ x: px, y: py }, r)) inside = !inside;
          });
          if (!inside) return;
          if (!best || h.dmin < best.dmin) best = h;
        });
        return best ? (best.part || best.box) : null;
      }
    };
  }

  /* ---------------- 图片模式: 原图 / 掩膜 / 轮廓 叠加预览 ----------------
   * 让用户能"看见"阈值到底切出了什么形状, 是图片自动生成里最关键的一块反馈。
   * imgData: 源 ImageData(可空)   mask: {mask,w,h}(可空)   parts: 已生成零件(可空)
   * opts.mode: 'overlay'(默认, 原图+半透明掩膜) | 'mask'(纯黑白) | 'image'(仅原图)
   */
  function drawMaskPreview(cv, imgData, mask, opts) {
    opts = opts || {};
    var c = fitCanvas(cv), g = c.g;
    g.clearRect(0, 0, c.w, c.h);
    g.fillStyle = '#f7f3ea'; g.fillRect(0, 0, c.w, c.h);
    var mode = opts.mode || 'overlay';
    var IW = imgData ? imgData.width : (mask ? mask.w : 0);
    var IH = imgData ? imgData.height : (mask ? mask.h : 0);
    if (!IW || !IH) {
      g.fillStyle = '#6b6152'; g.font = '13px "Segoe UI", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(opts.emptyText || '拖入 / 选择 一张图片', c.w / 2, c.h / 2);
      return null;
    }
    var pad = 14;
    var s = Math.min((c.w - pad * 2) / IW, (c.h - pad * 2) / IH);
    var ox = (c.w - IW * s) / 2, oy = (c.h - IH * s) / 2;

    // 棋盘底(看清透明区)
    var cell = 8;
    for (var yy = 0; yy < Math.ceil(IH * s / cell); yy++) {
      for (var xx = 0; xx < Math.ceil(IW * s / cell); xx++) {
        g.fillStyle = ((xx + yy) & 1) ? '#eae3d5' : '#f2ece0';
        g.fillRect(ox + xx * cell, oy + yy * cell,
          Math.min(cell, IW * s - xx * cell), Math.min(cell, IH * s - yy * cell));
      }
    }

    // 把 imgData / mask 画到离屏 canvas 再缩放贴上
    var off = global.document.createElement('canvas');
    off.width = IW; off.height = IH;
    var og = off.getContext('2d');
    if (mode !== 'mask' && imgData) {
      og.putImageData(imgData, 0, 0);
    } else if (mask) {
      var md = og.createImageData(mask.w, mask.h);
      for (var i = 0; i < mask.w * mask.h; i++) {
        var v = mask.mask[i] ? 30 : 245;
        md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = v;
        md.data[i * 4 + 3] = 255;
      }
      og.putImageData(md, 0, 0);
    }
    g.imageSmoothingEnabled = s < 1;
    g.drawImage(off, ox, oy, IW * s, IH * s);

    // 掩膜半透明叠加
    if (mode === 'overlay' && mask && mask.w === IW && mask.h === IH) {
      var ov = global.document.createElement('canvas');
      ov.width = IW; ov.height = IH;
      var vg = ov.getContext('2d');
      var vd = vg.createImageData(IW, IH);
      for (var k = 0; k < IW * IH; k++) {
        if (!mask.mask[k]) continue;
        vd.data[k * 4] = 78; vd.data[k * 4 + 1] = 161; vd.data[k * 4 + 2] = 255;
        vd.data[k * 4 + 3] = 110;
      }
      vg.putImageData(vd, 0, 0);
      g.drawImage(ov, ox, oy, IW * s, IH * s);
    }

    /* 描摹结果轮廓叠加。
     * 零件坐标是 mm 且已脱离像素坐标系, 所以不做"反算", 而是把零件包围盒
     * 直接映射进调用方给出的像素矩形 traceRect(通常就是掩膜的像素 bbox)。
     * 这样单个形状能严格对齐, 多个形状时调用方自行决定是否叠加。 */
    if (opts.parts && opts.parts.length && opts.traceRect) {
      var tr = opts.traceRect;
      var trW = tr.x1 - tr.x0, trH = tr.y1 - tr.y0;
      g.lineWidth = 1.4; g.strokeStyle = '#1f8a63';
      opts.parts.forEach(function (p) {
        var b = p.bbox();
        if (b.w <= 0 || b.h <= 0) return;
        var kx = trW / b.w * s, ky = trH / b.h * s;
        var T = function (q) {
          return {
            x: ox + tr.x0 * s + (q.x - b.x0) * kx,
            y: oy + tr.y0 * s + (b.y1 - q.y) * ky      // 图像 y 向下, 零件 y 向上
          };
        };
        g.beginPath();
        pathLoop(g, p.outer, T);
        p.holes.forEach(function (h) { pathLoop(g, h, T); });
        g.stroke();
      });
    }

    // 边框 + 尺寸标注
    g.strokeStyle = '#c9bda3'; g.lineWidth = 1;
    g.strokeRect(ox + .5, oy + .5, IW * s - 1, IH * s - 1);
    g.fillStyle = '#6b6152'; g.font = '11px "Segoe UI", sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    var lab = IW + ' × ' + IH + ' px';
    if (mask && mask.threshold !== undefined && mask.threshold >= 0) lab += '   阈值 ' + mask.threshold;
    if (opts.label) lab += '   ' + opts.label;
    g.fillText(lab, 8, 8);
    return { scale: s, ox: ox, oy: oy };
  }

  /* ============================================================
   * 板位三视图（自定义模式的"所见即所得"）
   * 把每块板在正视(XZ)/俯视(XY)/侧视(YZ)三个方向投影成一条带厚度的矩形。
   * 这样用户不必想象 3D，也不必读坐标：看图就知道板在哪。
   *
   * panels: [{id,name,plane,at,u0,u1,v0,v1}]  (Custom 的板位表)
   * 返回 {views:[{key,label,ox,oy,scale,rects:[{panel,x,y,w,h}]}], hit(px,py)}
   * ============================================================ */
  var PLAN_AXIS = {
    XY: { n: 'z', u: 'x', v: 'y' },
    YZ: { n: 'x', u: 'y', v: 'z' },
    XZ: { n: 'y', u: 'x', v: 'z' }
  };
  /* 一块板在世界坐标里的 [x0,x1],[y0,y1],[z0,z1] */
  function panelBox(p, t) {
    var A = PLAN_AXIS[p.plane];
    if (!A) return null;
    var b = { x: [0, 0], y: [0, 0], z: [0, 0] };
    b[A.n] = [p.at - t / 2, p.at + t / 2];
    b[A.u] = [Math.min(p.u0, p.u1), Math.max(p.u0, p.u1)];
    b[A.v] = [Math.min(p.v0, p.v1), Math.max(p.v0, p.v1)];
    return b;
  }
  var VIEWS = [
    { key: 'front', label: '\u6b63\u89c6 (X-Z)', h: 'x', v: 'z', hl: '\u5bbd W \u2192', vl: '\u9ad8 H \u2191' },
    { key: 'top', label: '\u4fef\u89c6 (X-Y)', h: 'x', v: 'y', hl: '\u5bbd W \u2192', vl: '\u6df1 D \u2191' },
    { key: 'side', label: '\u4fa7\u89c6 (Y-Z)', h: 'y', v: 'z', hl: '\u6df1 D \u2192', vl: '\u9ad8 H \u2191' }
  ];
  var AXIS_LABEL = { x: '\u5de6\u53f3 X', y: '\u524d\u540e Y', z: '\u4e0a\u4e0b Z' };

  function drawPlan(cv, panels, opts) {
    opts = opts || {};
    var c = fitCanvas(cv), g = c.g;
    g.clearRect(0, 0, c.w, c.h);
    var t = opts.thickness || 15;
    var boxes = [];
    (panels || []).forEach(function (p) {
      var b = panelBox(p, t);
      if (b) boxes.push({ panel: p, b: b });
    });
    if (!boxes.length) {
      g.fillStyle = '#6b6152';
      g.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(opts.emptyText || '\u8fd8\u6ca1\u6709\u677f\u4f4d', c.w / 2, c.h / 2);
      return null;
    }
    /* \u9009\u4e2d\u96c6: \u65e2\u63a5\u53d7\u5355\u4e2a id, \u4e5f\u63a5\u53d7 id \u6570\u7ec4(\u591a\u9009) */
    var selSet = {}, selN = 0, selFirst = null;
    (function () {
      var raw = opts.selected;
      var arr = (raw === undefined || raw === null) ? [] : (Object.prototype.toString.call(raw) === '[object Array]' ? raw : [raw]);
      arr.forEach(function (id) {
        if (id === undefined || id === null || selSet[id]) return;
        selSet[id] = 1; selN++;
        if (selFirst === null) selFirst = id;
      });
    })();
    var hoverId = (opts.hover === undefined || opts.hover === null) ? null : opts.hover;
    // \u4e16\u754c\u5305\u56f4\u76d2
    var ext = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    boxes.forEach(function (o) {
      ['x', 'y', 'z'].forEach(function (k) {
        ext[k][0] = Math.min(ext[k][0], o.b[k][0]);
        ext[k][1] = Math.max(ext[k][1], o.b[k][1]);
      });
    });
    var pad = 30, lab = 20, gap = 14;
    var cols = c.w >= 640 ? 3 : 1;
    var rows = Math.ceil(3 / cols);
    var cw = (c.w - gap * (cols + 1)) / cols;
    var chh = (c.h - gap * (rows + 1)) / rows;
    var out = [];
    var guides = opts.guides || [];
    VIEWS.forEach(function (V, vi) {
      var gx = gap + (vi % cols) * (cw + gap);
      var gy = gap + Math.floor(vi / cols) * (chh + gap);
      var W = Math.max(1, ext[V.h][1] - ext[V.h][0]);
      var H = Math.max(1, ext[V.v][1] - ext[V.v][0]);
      var s = Math.min((cw - pad * 2) / W, (chh - pad - lab * 2) / H) * (opts.zoom || 1);
      var ox = gx + (cw - W * s) / 2 - ext[V.h][0] * s;
      var oy = gy + lab + (chh - lab - H * s) / 2 + ext[V.v][1] * s;
      var T = function (hh, vv) { return { x: ox + hh * s, y: oy - vv * s }; };
      // \u89c6\u56fe\u6846
      g.save();
      g.fillStyle = '#fffdf8';
      g.fillRect(gx, gy, cw, chh);
      g.strokeStyle = '#ddd3bf'; g.lineWidth = 1;
      g.strokeRect(gx + .5, gy + .5, cw - 1, chh - 1);
      g.beginPath();
      g.rect(gx + 1, gy + 1, cw - 2, chh - 2);
      g.clip();
      g.fillStyle = '#6f6455'; g.font = '600 11px "Segoe UI", sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillText(V.label, gx + 7, gy + 5);
      g.textAlign = 'right';
      g.fillText(Math.round(W) + ' \u00d7 ' + Math.round(H) + 'mm', gx + cw - 7, gy + 5);
      var rects = [];
      boxes.forEach(function (o) {
        var a = T(o.b[V.h][0], o.b[V.v][1]);
        var b2 = T(o.b[V.h][1], o.b[V.v][0]);
        var rx = Math.min(a.x, b2.x), ry = Math.min(a.y, b2.y);
        var rw = Math.max(1, Math.abs(b2.x - a.x)), rh = Math.max(1, Math.abs(b2.y - a.y));
        var on = !!selSet[o.panel.id];
        var hov = !on && hoverId !== null && o.panel.id === hoverId;
        // \u677f\u7684\u6cd5\u5411\u6b63\u5bf9\u8be5\u89c6\u56fe => \u663e\u793a\u4e3a"\u9762"(\u6d45), \u5426\u5219\u663e\u793a\u7684\u662f"\u8fb9"(\u5b9e\u5fc3\u6df1)
        var A = PLAN_AXIS[o.panel.plane];
        var faceOn = (A.n !== V.h && A.n !== V.v);
        g.fillStyle = on ? 'rgba(217,138,31,.42)'
          : (hov ? 'rgba(217,138,31,.20)' : (faceOn ? 'rgba(47,107,176,.14)' : 'rgba(47,107,176,.42)'));
        g.fillRect(rx, ry, rw, rh);
        g.strokeStyle = on ? '#d98a1f' : (hov ? '#c07d1c' : '#2f6bb0');
        g.lineWidth = on ? 1.8 : (hov ? 1.5 : 1);
        g.strokeRect(rx + .5, ry + .5, Math.max(1, rw - 1), Math.max(1, rh - 1));
        /* \u9009\u4e2d\u677f\u753b\u56db\u4e2a\u62d6\u62fd\u63e1\u70b9(\u53ea\u662f\u63d0\u793a"\u8fd9\u4e1c\u897f\u53ef\u4ee5\u62d6"), \u62d6\u62fd\u672c\u8eab\u6574\u5757\u90fd\u80fd\u62d3 */
        if (on && rw > 8 && rh > 8) {
          g.fillStyle = '#d98a1f';
          [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].forEach(function (q) {
            g.fillRect(q[0] - 2, q[1] - 2, 4, 4);
          });
        }
        rects.push({ panel: o.panel, x: rx, y: ry, w: rw, h: rh });
      });
      /* \u5438\u9644\u53c2\u8003\u7ebf: \u53ea\u753b\u5728\u8be5\u8f74\u5728\u672c\u89c6\u56fe\u91cc\u53ef\u89c1\u7684\u60c5\u51b5 */
      guides.forEach(function (gd) {
        var horiz = null;
        if (gd.axis === V.h) horiz = false;        // \u6cbf\u6c34\u5e73\u8f74 -> \u4e00\u6761\u7ad6\u7ebf
        else if (gd.axis === V.v) horiz = true;    // \u6cbf\u7ad6\u8f74   -> \u4e00\u6761\u6a2a\u7ebf
        else return;
        g.save();
        g.strokeStyle = gd.kind === 'center' || gd.kind === 'bounds' ? '#26805e' : '#d98a1f';
        g.lineWidth = 1;
        g.setLineDash([5, 4]);
        g.beginPath();
        if (horiz) {
          var yy = T(0, gd.v).y;
          g.moveTo(gx + 1, yy); g.lineTo(gx + cw - 1, yy);
        } else {
          var xx = T(gd.v, 0).x;
          g.moveTo(xx, gy + 1); g.lineTo(xx, gy + chh - 1);
        }
        g.stroke();
        g.restore();
        if (gd.label) {
          g.font = '10px "Segoe UI", sans-serif';
          g.fillStyle = gd.kind === 'center' || gd.kind === 'bounds' ? '#1a6647' : '#a5620c';
          if (horiz) {
            g.textAlign = 'left'; g.textBaseline = 'bottom';
            g.fillText(gd.label, gx + 8, T(0, gd.v).y - 2);
          } else {
            g.textAlign = 'left'; g.textBaseline = 'top';
            g.fillText(gd.label, Math.min(T(gd.v, 0).x + 3, gx + cw - 90), gy + chh - 30);
          }
        }
      });
      // \u9009\u4e2d\u677f\u7684\u540d\u5b57(\u5355\u9009\u65f6\u624d\u6807, \u591a\u9009\u4f1a\u7cca)
      if (selN === 1) {
        var hit = rects.filter(function (r) { return !!selSet[r.panel.id]; })[0];
        if (hit) {
          g.fillStyle = '#a5620c'; g.font = '600 11px "Segoe UI", sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'bottom';
          g.fillText(hit.panel.name, hit.x + hit.w / 2, Math.max(gy + 20, hit.y - 3));
        }
      }
      g.fillStyle = '#8a7e6c'; g.font = '10px "Segoe UI", sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText(V.hl + '   ' + V.vl, gx + 7, gy + chh - 5);
      g.restore();
      out.push({
        key: V.key, label: V.label, ox: ox, oy: oy, scale: s, rects: rects,
        h: V.h, v: V.v, gx: gx, gy: gy, cw: cw, ch: chh,
        /* \u5c4f\u5e55 -> \u4e16\u754c(\u53cd\u53d8\u6362): T \u7684\u9006 */
        toWorld: function (px, py) { return { h: (px - ox) / s, v: (oy - py) / s }; },
        toScreen: function (hh, vv) { return T(hh, vv); }
      });
    });
    function viewAt(px, py) {
      for (var i = 0; i < out.length; i++) {
        var V = out[i];
        if (px >= V.gx && px <= V.gx + V.cw && py >= V.gy && py <= V.gy + V.ch) return V;
      }
      return null;
    }
    return {
      views: out,
      viewAt: viewAt,
      /* \u547d\u4e2d\u6d4b\u8bd5: \u8fd4\u56de\u88ab\u70b9\u5230\u7684\u677f(\u53d6\u9762\u79ef\u6700\u5c0f\u8005, \u4fbf\u4e8e\u9009\u4e2d\u88ab\u538b\u4f4f\u7684\u5c0f\u677f) */
      hit: function (px, py) {
        var best = null;
        out.forEach(function (V) {
          V.rects.forEach(function (r) {
            if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
              if (!best || r.w * r.h < best.w * best.h) best = r;
            }
          });
        });
        return best ? best.panel : null;
      },
      /* \u62d6\u62fd\u7528: \u540c\u65f6\u544a\u8bc9\u8c03\u7528\u65b9"\u70b9\u5230\u4e86\u54ea\u5757\u677f"\u4e0e"\u5728\u54ea\u4e2a\u89c6\u56fe\u91cc" */
      pick: function (px, py) {
        var V = viewAt(px, py);
        if (!V) return null;
        var best = null;
        V.rects.forEach(function (r) {
          if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
            if (!best || r.w * r.h < best.w * best.h) best = r;
          }
        });
        return { view: V, panel: best ? best.panel : null };
      }
    };
  }

  global.Render = {
    fitCanvas: fitCanvas, pathLoop: pathLoop,
    drawNest: drawNest, drawParts: drawParts,
    drawAssembly: drawAssembly, boxesFrom: boxesFrom, asmBBox: asmBBox, ASM_MAP: ASM_MAP,
    iso: iso, D3: D3,
    drawMaskPreview: drawMaskPreview, drawPlan: drawPlan, panelBox: panelBox, PLAN_VIEWS: VIEWS, AXIS_LABEL: AXIS_LABEL
  };
})(typeof window !== 'undefined' ? window : this);
