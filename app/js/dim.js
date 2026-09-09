/* ============================================================
 * dim.js - 工程尺寸标注（中性实体层）
 *
 * 为什么需要这一层: 排查时发现 DXF 与 SVG 的实体生成各自独立实现,
 * 加标注要双端各写一遍必然漂移。这里把标注抽象成**中性实体列表**
 * (line / text / poly 三种, 零件局部 mm 坐标, y 向上),
 * Canvas / SVG / DXF 三端各自只写"实体 -> 线条"的薄渲染器。
 *
 * 标注内容:
 *   · 总体尺寸: 宽(W)标在下边外侧, 高(H)标在左边外侧,
 *     带延伸线、尺寸线、实心箭头(工程制图 1:3 比例)
 *   · 孔位: 中心十字线 + 引出线 + "Ø直径" 或 "宽×高" 文字
 *   · 定深铣槽: 引出线 + "宽×高▽深"
 *   · 标题栏: 名称/尺寸/数量/纹理/日期 的右下角图框
 *
 * u = 字高基准单位(mm)。屏幕端由调用方按缩放反算,
 * 使文字保持恒定屏幕字号; 导出端用制图标准 3.5mm。
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G;

  function fmt(v) {
    var r = Math.round(v * 10) / 10;
    return (r % 1 === 0 ? String(r) : r.toFixed(1));
  }

  /* ---------- 零件 -> 标注数据(纯数据, 无几何) ---------- */
  function forPart(part, opts) {
    opts = opts || {};
    var b = part.bbox();
    var d = {
      name: part.name, qty: part.qty || 1, thickness: part.thickness,
      bbox: b, overall: [], holes: [], pockets: [],
      grain: (part.meta && part.meta.grain) || 'any'
    };
    if (b.w > 0) d.overall.push({ axis: 'x', a: b.x0, b: b.x1, at: b.y0, text: fmt(b.w) });
    if (b.h > 0) d.overall.push({ axis: 'y', a: b.y0, b: b.y1, at: b.x0, text: fmt(b.h) });
    var maxN = opts.maxHoleLabels === undefined ? 10 : opts.maxHoleLabels;
    var minD = opts.holeMinDia || 0;
    var n = 0;
    (part.holes || []).forEach(function (h) {
      if (n >= maxN) return;
      var hb = G.loopBBox(h);
      var w = hb.x1 - hb.x0, hh = hb.y1 - hb.y0;
      var isCircle = !!(h.length === 2 && h[0].b && h[1].b);
      if (isCircle && minD && w < minD) return;
      d.holes.push({
        x: (hb.x0 + hb.x1) / 2, y: (hb.y0 + hb.y1) / 2,
        w: w, h: hh, circle: isCircle,
        label: isCircle ? 'Ø' + fmt(w) : fmt(w) + '×' + fmt(hh)
      });
      n++;
    });
    (part.pockets || []).forEach(function (q) {
      var hb = G.loopBBox(q.loop);
      d.pockets.push({
        x: (hb.x0 + hb.x1) / 2, y: (hb.y0 + hb.y1) / 2,
        w: hb.x1 - hb.x0, h: hb.y1 - hb.y0,
        label: fmt(hb.x1 - hb.x0) + '×' + fmt(hb.y1 - hb.y0) + ' ▽' + G.round(q.depth, 1)
      });
    });
    return d;
  }

  /* ---------- 标注数据 -> 中性实体(mm, y 向上) ----------
   * 实体: {type:'line', x1,y1,x2,y2, kind}
   *       {type:'text', x,y,s,size,rot, kind}   rot: 度, y-up CCW
   *       {type:'poly', pts:[{x,y}...], kind}   实心多边形(箭头)
   * kind: 'dim'尺寸线 'ext'延伸线 'leader'引出线 'cross'中心线
   *       'frame'图框 'dimtext'文字
   */
  function entities(d, opts) {
    opts = opts || {};
    var u = opts.u || 4;
    var off = opts.off === undefined ? u * 2.2 : opts.off;
    var gap = u * 0.6;              // 延伸线起点离零件轮廓的空隙
    var E = [];
    function line(x1, y1, x2, y2, k) { E.push({ type: 'line', x1: x1, y1: y1, x2: x2, y2: y2, kind: k || 'dim' }); }
    function text(x, y, s, rot, k) { E.push({ type: 'text', x: x, y: y, s: String(s), size: u, rot: rot || 0, kind: k || 'dimtext' }); }
    function arrow(x, y, ang) {
      /* 实心箭头: 长 u*1.4, 半宽 u*0.42, 尖端在 (x,y) 朝 ang */
      var L = u * 1.4, W2 = u * 0.42;
      var bx = x - Math.cos(ang) * L, by = y - Math.sin(ang) * L;
      var nx = -Math.sin(ang) * W2, ny = Math.cos(ang) * W2;
      E.push({ type: 'poly', pts: [
        { x: x, y: y }, { x: bx + nx, y: by + ny }, { x: bx - nx, y: by - ny }
      ], kind: 'arrow' });
    }

    /* 总体尺寸 */
    d.overall.forEach(function (o) {
      if (o.axis === 'x') {
        var yl = o.at - off;
        line(o.a, o.at - gap, o.a, yl - u * 0.5, 'ext');
        line(o.b, o.at - gap, o.b, yl - u * 0.5, 'ext');
        line(o.a, yl, o.b, yl);
        arrow(o.a, yl, 0); arrow(o.b, yl, Math.PI);
        text((o.a + o.b) / 2, yl - u * 0.5, o.text, 0);
      } else {
        var xl = o.at - off;
        line(o.at - gap, o.a, xl - u * 0.5, o.a, 'ext');
        line(o.at - gap, o.b, xl - u * 0.5, o.b, 'ext');
        line(xl, o.a, xl, o.b);
        arrow(xl, o.a, Math.PI / 2); arrow(xl, o.b, -Math.PI / 2);
        text(xl - u * 0.5, (o.a + o.b) / 2, o.text, 90);
      }
    });

    /* 孔位: 中心十字 + 引出线 + 文字。
     * 引出方向按序号轮换(右上/左上/右下/左下), 避免多孔时叠成一列。 */
    var DIRS = [45, 135, 315, 225];
    d.holes.forEach(function (h, i) {
      var r = Math.max(h.w, h.h) / 2;
      var c = u * 0.9;
      line(h.x - c, h.y, h.x + c, h.y, 'cross');
      line(h.x, h.y - c, h.x, h.y + c, 'cross');
      var a = DIRS[i % 4] * G.D2R;
      var ca = Math.cos(a), sa = Math.sin(a);
      var p0x = h.x + ca * (r + u * 0.3), p0y = h.y + sa * (r + u * 0.3);
      var p1x = h.x + ca * (r + u * 2.4), p1y = h.y + sa * (r + u * 2.4);
      var p2x = p1x + (ca >= 0 ? u * 2.0 : -u * 2.0), p2y = p1y;
      line(p0x, p0y, p1x, p1y, 'leader');
      line(p1x, p1y, p2x, p2y, 'leader');
      arrow(p0x, p0y, Math.atan2(p1y - p0y, p1x - p0x));
      var tx = ca >= 0 ? p2x + u * 0.4 : p2x - u * 0.4;
      text(tx, p2y + u * 0.75, h.label, 0, ca >= 0 ? 'dimtext' : 'dimtextL');
      E[E.length - 1].anchor = ca >= 0 ? 'start' : 'end';
    });

    /* 铣槽: 只标前几个, 引出线向下 */
    d.pockets.slice(0, 4).forEach(function (q, i) {
      var p0y = q.y - Math.max(q.w, q.h) / 2 - u * 0.3;
      var p1y = p0y - u * 2.2 - i * u * 1.6;
      line(q.x, p0y, q.x, p1y, 'leader');
      text(q.x + u * 0.4, p1y - u * 0.2, q.label, 0);
      E[E.length - 1].anchor = 'start';
    });
    return E;
  }

  /* ---------- 标题栏(图框右下角的工程信息块) ----------
   * 返回 {ents, box}: ents 是中性实体, box 是它在 mm 里占的矩形,
   * 调用方据此给零件留白。位置: 零件 bbox 右下方, 与右边线对齐。
   */
  var GRAIN_CN = { long: '横纹', cross: '竖纹', any: '不限' };
  function titleBlock(d, opts) {
    opts = opts || {};
    var u = opts.u || 4;
    var b = d.bbox;
    var W = opts.w || u * 34;                    // 标题栏宽
    var rowH = u * 2.1, rows = 3, H = rowH * rows;
    var x1 = b.x1, x0 = x1 - W;
    var y1 = b.y0 - (opts.off === undefined ? u * 5.4 : opts.off);
    var y0 = y1 - H;
    var E = [];
    function line(xa, ya, xb, yb) { E.push({ type: 'line', x1: xa, y1: ya, x2: xb, y2: yb, kind: 'frame' }); }
    function text(x, y, s, size, bold) {
      E.push({ type: 'text', x: x, y: y, s: String(s), size: size || u * 0.9, rot: 0, kind: 'titletext', anchor: 'start' });
      if (bold) E[E.length - 1].bold = true;
    }
    line(x0, y1, x1, y1); line(x0, y0, x1, y0);
    line(x0, y0, x0, y1); line(x1, y0, x1, y1);
    line(x0, y1 - rowH, x1, y1 - rowH);
    line(x0, y1 - rowH * 2, x1, y1 - rowH * 2);
    var date = new Date();
    var ds = date.getFullYear() + '-' + ('0' + (date.getMonth() + 1)).slice(-2) + '-' + ('0' + date.getDate()).slice(-2);
    text(x0 + u * 0.8, y1 - rowH * 0.5, d.name + (d.qty > 1 ? '  ×' + d.qty : ''), u * 1.05, true);
    text(x0 + u * 0.8, y1 - rowH * 1.5,
      fmt(b.w) + ' × ' + fmt(b.h) + ' × ' + d.thickness + ' mm   ' + (GRAIN_CN[d.grain] || ''));
    text(x0 + u * 0.8, y1 - rowH * 2.5, '海洋板 DIY · 榫卯 CAD    ' + ds);
    return { ents: E, box: { x0: x0, y0: y0, x1: x1, y1: y1, w: W, h: H } };
  }

  /* ---------- 中性实体 -> 各端渲染 ---------- */

  /* Canvas 端: g 画布, T 局部mm->屏幕, 样式可选 */
  function drawEnts(g, T, ents, opt) {
    opt = opt || {};
    var colDim = opt.dim || '#7a5a1e';
    var colText = opt.text || '#5a4a20';
    var colFrame = opt.frame || '#8a7e6c';
    ents.forEach(function (e) {
      if (e.type === 'line') {
        var p1 = T({ x: e.x1, y: e.y1 }), p2 = T({ x: e.x2, y: e.y2 });
        g.strokeStyle = e.kind === 'frame' ? colFrame : (e.kind === 'cross' ? (opt.cross || '#2f8f6a') : colDim);
        g.lineWidth = e.kind === 'frame' ? 1.2 : 1;
        if (e.kind === 'ext' || e.kind === 'cross') g.save(), g.setLineDash([3, 2]);
        g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
        if (e.kind === 'ext' || e.kind === 'cross') g.restore();
      } else if (e.type === 'poly') {
        g.fillStyle = colDim;
        g.beginPath();
        e.pts.forEach(function (q, i) {
          var p = T(q);
          if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        });
        g.closePath(); g.fill();
      } else if (e.type === 'text') {
        var p = T({ x: e.x, y: e.y });
        g.fillStyle = e.kind === 'titletext' ? (opt.titleText || '#3a332a') : colText;
        g.font = (e.bold ? '700 ' : '') + e.size + 'px "Segoe UI", sans-serif';
        g.textAlign = e.anchor === 'end' ? 'right' : (e.anchor === 'start' ? 'left' : 'center');
        g.textBaseline = 'middle';
        /* 局部 y 向上 + rot 为 y-up CCW -> 画布 y 向下, 角度取反 */
        g.save();
        g.translate(p.x, p.y);
        g.rotate(-(e.rot || 0) * G.D2R);
        g.fillText(e.s, 0, 0);
        g.restore();
      }
    });
  }

  /* SVG 片段(在 toSVG 的 y 翻转组内使用, 坐标已是 mm/y-up) */
  function svgEnts(ents, opt) {
    opt = opt || {};
    var col = opt.dim || '#8a5a00', colText = opt.text || '#5a4a20';
    var out = [];
    ents.forEach(function (e) {
      if (e.type === 'line') {
        out.push('<line x1="' + G.round(e.x1, 2) + '" y1="' + G.round(e.y1, 2) +
          '" x2="' + G.round(e.x2, 2) + '" y2="' + G.round(e.y2, 2) +
          '" stroke="' + col + '" stroke-width="' + (e.kind === 'frame' ? 0.5 : 0.3) + '"' +
          (e.kind === 'ext' || e.kind === 'cross' ? ' stroke-dasharray="1.5,1"' : '') + '/>');
      } else if (e.type === 'poly') {
        out.push('<polygon points="' + e.pts.map(function (q) {
          return G.round(q.x, 2) + ',' + G.round(q.y, 2);
        }).join(' ') + '" fill="' + col + '"/>');
      } else if (e.type === 'text') {
        /* 翻转组内: 先平移到点位, 旋转 -rot(y 镜像), 再 scale(1,-1) 恢复字面 */
        var anchor = e.anchor === 'end' ? 'end' : (e.anchor === 'start' ? 'start' : 'middle');
        out.push('<text x="0" y="0" font-size="' + G.round(e.size, 2) + '" text-anchor="' + anchor +
          '" dominant-baseline="central" fill="' + (e.kind === 'titletext' ? '#2a251c' : colText) + '"' +
          (e.bold ? ' font-weight="700"' : '') +
          ' transform="translate(' + G.round(e.x, 2) + ',' + G.round(e.y, 2) + ') rotate(' +
          G.round(-(e.rot || 0), 2) + ') scale(1,-1)">' + escText(e.s) + '</text>');
      }
    });
    return out;
  }
  function escText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* DXF 实体组码(R12: LINE / TEXT / SOLID) */
  function dxfEnts(ents, layer) {
    function f(v) { return (Math.round(v * 1e4) / 1e4).toFixed(4); }
    var out = [];
    ents.forEach(function (e) {
      if (e.type === 'line') {
        out.push('0', 'LINE', '8', layer,
          '10', f(e.x1), '20', f(e.y1), '30', '0.0',
          '11', f(e.x2), '21', f(e.y2), '31', '0.0');
      } else if (e.type === 'poly' && e.pts.length === 3) {
        out.push('0', 'SOLID', '8', layer,
          '10', f(e.pts[0].x), '20', f(e.pts[0].y), '30', '0.0',
          '11', f(e.pts[1].x), '21', f(e.pts[1].y), '31', '0.0',
          '12', f(e.pts[2].x), '22', f(e.pts[2].y), '32', '0.0',
          '13', f(e.pts[2].x), '23', f(e.pts[2].y), '33', '0.0');
      } else if (e.type === 'text') {
        /* R12 TEXT 的对齐: 72=0 左/72=1 中。锚点 end 用 72=2 右 */
        var h = e.anchor === 'end' ? '2' : (e.anchor === 'start' ? '0' : '1');
        var xx = e.x, rot = e.rot || 0;
        out.push('0', 'TEXT', '8', layer,
          '10', f(xx), '20', f(e.y), '30', '0.0',
          '40', f(e.size), '1', String(e.s), '50', f(rot), '72', h, '11', f(xx), '21', f(e.y), '31', '0.0');
      }
    });
    return out;
  }

  global.Dim = {
    forPart: forPart, entities: entities, titleBlock: titleBlock,
    drawEnts: drawEnts, svgEnts: svgEnts, dxfEnts: dxfEnts, fmt: fmt
  };
})(typeof window !== 'undefined' ? window : this);
