/* ============================================================
 * part.js - 零件模型 + DXF / SVG / CSV 导出
 * 零件 = { id, name, w, h, thickness, outer(CCW), holes[CW],
 *          pockets[{loop(CW), depth}], marks[], meta }
 *
 * pockets = 定深铣槽(不切透), 导出到独立图层 POCKET, 机床按 depth 下刀。
 * meta.grain = 'long' | 'cross' | 'any' : 纹理方向, 排样时约束能否旋转 90 度
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G;

  function Part(name, thickness) {
    this.id = Part._n = (Part._n || 0) + 1;
    this.name = name || ('part' + this.id);
    this.thickness = thickness || 12;
    this.outer = null;
    this.holes = [];
    this.pockets = [];      // 定深铣槽: {loop(CW), depth, note}
    this.marks = [];        // 仅标注/雕刻，不切割: {type:'text'|'line'|'circle', ...}
    this.meta = {};
    this.qty = 1;
  }
  Part.prototype.setOuter = function (loop) { this.outer = G.ensureOrient(G.cleanLoop(loop), true); return this; };
  Part.prototype.addHole = function (loop) { if (loop) this.holes.push(G.ensureOrient(G.cleanLoop(loop), false)); return this; };
  Part.prototype.addHoles = function (arr) { (arr || []).forEach(this.addHole, this); return this; };
  /* 定深铣槽: depth 必须 < 板厚, 否则等于切透(应改用 addHole) */
  Part.prototype.addPocket = function (loop, depth, note) {
    if (!loop) return this;
    this.pockets.push({
      loop: G.ensureOrient(G.cleanLoop(loop), false),
      depth: depth, note: note || ''
    });
    return this;
  };
  Part.prototype.addPockets = function (arr) {
    (arr || []).forEach(function (p) { this.addPocket(p.loop, p.depth, p.note); }, this);
    return this;
  };
  Part.prototype.addText = function (x, y, s, size, rot) {
    this.marks.push({ type: 'text', x: x, y: y, s: String(s), size: size || 8, rot: rot || 0 });
    return this;
  };
  /* 只标注、不切割的圆(钻孔标记)。
   * 为什么需要它: 木销/饼干榫的**端面**孔槽, 激光和平板 CNC 都做不出来
   * (刀轴垂直于板面, 够不到板的侧边)。以前这类特征干脆没生成 ->
   * 用户选了"木销对接", 图纸上一个孔都看不到, 以为程序没反应。
   * 现在画进 MARK 层并在料单里注明"需侧向钻孔", 师傅拿夹具打。 */
  Part.prototype.addCircleMark = function (x, y, d, note) {
    this.marks.push({ type: 'circle', x: x, y: y, d: d, note: note || '' });
    return this;
  };
  Part.prototype.addMarks = function (arr) {
    (arr || []).forEach(function (m) {
      if (!m) return;
      if (m.type === 'circle') this.addCircleMark(m.x, m.y, m.d, m.note);
      else if (m.type === 'text') this.addText(m.x, m.y, m.s, m.size, m.rot);
    }, this);
    return this;
  };
  Part.prototype.markCount = function (type) {
    return this.marks.filter(function (m) { return !type || m.type === type; }).length;
  };
  Part.prototype.bbox = function () {
    return this.outer ? G.loopBBox(this.outer) : { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
  };
  Part.prototype.area = function () {
    var a = this.outer ? G.loopArea(this.outer) : 0;
    this.holes.forEach(function (h) { a += G.loopArea(h); });   // 孔为负
    return a;
  };
  Part.prototype.cutLength = function () {
    var L = this.outer ? G.loopLength(this.outer) : 0;
    this.holes.forEach(function (h) { L += G.loopLength(h); });
    this.pockets.forEach(function (p) { L += G.loopLength(p.loop); });
    return L;
  };
  Part.prototype.loops = function () {
    return (this.outer ? [this.outer] : []).concat(this.holes);
  };
  Part.prototype.pocketLoops = function () {
    return this.pockets.map(function (p) { return p.loop; });
  };
  // 应用刀具补偿：外扩/内缩 kerf/2
  Part.prototype.compensated = function (kerf) {
    if (!kerf) return this.loops();
    var d = kerf / 2;
    return this.loops().map(function (l) { return G.offsetLoop(l, d); });
  };
  Part.prototype.transformed = function (xf) {
    var p = new Part(this.name, this.thickness);
    p.id = this.id; p.qty = this.qty; p.meta = this.meta;
    p.outer = this.outer ? G.xform(this.outer, xf) : null;
    p.holes = this.holes.map(function (h) { return G.xform(h, xf); });
    p.pockets = this.pockets.map(function (q) {
      return { loop: G.xform(q.loop, xf), depth: q.depth, note: q.note };
    });
    var c = Math.cos((xf.rot || 0) * G.D2R), s = Math.sin((xf.rot || 0) * G.D2R);
    p.marks = this.marks.map(function (m) {
      var x = xf.mx ? -m.x : m.x;
      return {
        /* d/note 必须一起搬 —— 漏了 d 的话圆标记变成 d=undefined,
         * DXF 里就是半径 NaN, CAD 打开直接报错。 */
        type: m.type, s: m.s, size: m.size, d: m.d, note: m.note,
        x: x * c - m.y * s + (xf.tx || 0),
        y: x * s + m.y * c + (xf.ty || 0),
        rot: (m.rot || 0) + (xf.rot || 0)
      };
    });
    return p;
  };
  // 自检
  Part.prototype.validate = function () {
    var out = [], self = this;
    if (!this.outer || this.outer.length < 3) { out.push({ level: 'error', text: this.name + ': 外轮廓无效' }); return out; }
    if (G.loopArea(this.outer) <= 0) out.push({ level: 'error', text: this.name + ': 外轮廓方向错误' });
    var op = G.flatten(this.outer, 0.1);
    if (G.selfIntersects(op)) out.push({ level: 'error', text: this.name + ': 外轮廓自交' });
    this.holes.forEach(function (h, i) {
      if (G.loopArea(h) >= 0) out.push({ level: 'error', text: self.name + ': 孔#' + (i + 1) + ' 方向错误(应为 CW)' });
      var hp = G.flatten(h, 0.1);
      if (G.selfIntersects(hp)) out.push({ level: 'error', text: self.name + ': 孔#' + (i + 1) + ' 自交' });
      // 孔必须完全落在外轮廓内
      var inside = hp.every(function (q) { return G.pointInPoly(q, op); });
      if (!inside) out.push({ level: 'error', text: self.name + ': 孔#' + (i + 1) + ' 越出板边' });
      // 孔之间不得重叠
      for (var j = 0; j < i; j++) {
        if (G.polysOverlap(hp, G.flatten(self.holes[j], 0.1))) {
          out.push({ level: 'warn', text: self.name + ': 孔#' + (i + 1) + ' 与孔#' + (j + 1) + ' 重叠' });
          break;
        }
      }
    });
    /* 定深铣槽: 方向必须 CW、深度必须在 (0, 板厚) 内、必须落在板内。
     * depth >= 板厚 就是切透了, 那属于 hole —— 混淆会让机床直接把零件切成两半。 */
    this.pockets.forEach(function (pk, i) {
      var tag = self.name + ': 铣槽#' + (i + 1);
      if (!(pk.depth > 0)) out.push({ level: 'error', text: tag + ' 深度必须 > 0' });
      else if (pk.depth >= self.thickness - 1e-9) {
        out.push({ level: 'error', text: tag + ' 深度 ' + G.round(pk.depth, 2) + 'mm 不小于板厚 ' + self.thickness + 'mm（等于切透，应改为通孔）' });
      } else if (pk.depth > self.thickness * 0.75) {
        out.push({ level: 'warn', text: tag + ' 深度 ' + G.round(pk.depth, 2) + 'mm 超过板厚 3/4，剩余料太薄易穿' });
      }
      if (G.loopArea(pk.loop) >= 0) out.push({ level: 'error', text: tag + ' 方向错误(应为 CW)' });
      var pp = G.flatten(pk.loop, 0.1);
      if (G.selfIntersects(pp)) out.push({ level: 'error', text: tag + ' 轮廓自交' });
      if (!pp.every(function (q) { return G.pointInPoly(q, op); })) {
        out.push({ level: 'error', text: tag + ' 越出板边' });
      }
      // 铣槽压在通孔上 = 那块料已经没了, 白走刀
      for (var j = 0; j < self.holes.length; j++) {
        if (G.polysOverlap(pp, G.flatten(self.holes[j], 0.1))) {
          out.push({ level: 'warn', text: tag + ' 与孔#' + (j + 1) + ' 重叠' });
          break;
        }
      }
    });
    return out;
  };

  /* ---------------- DXF (R12, 最大兼容) ---------------- */
  function dxfHeader(bb) {
    return [
      '999', 'ocean-board CAD generator',
      '0', 'SECTION', '2', 'HEADER',
      '9', '$ACADVER', '1', 'AC1009',
      '9', '$INSUNITS', '70', '4',
      '9', '$MEASUREMENT', '70', '1',
      '9', '$EXTMIN', '10', f(bb.x0), '20', f(bb.y0), '30', '0.0',
      '9', '$EXTMAX', '10', f(bb.x1), '20', f(bb.y1), '30', '0.0',
      '0', 'ENDSEC'
    ];
  }
  function f(v) { return (Math.round(v * 1e4) / 1e4).toFixed(4); }

  function dxfTables(layers) {
    var t = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.length)];
    layers.forEach(function (L) {
      t.push('0', 'LAYER', '2', L.name, '70', '0', '62', String(L.color), '6', 'CONTINUOUS');
    });
    t.push('0', 'ENDTAB', '0', 'ENDSEC');
    return t;
  }

  // 把一个环写成 DXF LWPOLYLINE(R12 用 POLYLINE 更保险, 这里用 POLYLINE+VERTEX 带 bulge)
  function dxfPolyline(loop, layer) {
    var e = ['0', 'POLYLINE', '8', layer, '66', '1', '70', '1', '10', '0.0', '20', '0.0', '30', '0.0'];
    loop.forEach(function (p) {
      e.push('0', 'VERTEX', '8', layer, '10', f(p.x), '20', f(p.y), '30', '0.0');
      if (p.b) e.push('42', f(p.b));
    });
    e.push('0', 'SEQEND', '8', layer);
    return e;
  }
  /* 标注用的圆(MARK 层, 不是要切的轮廓) */
  function dxfCircleMark(m, layer) {
    return ['0', 'CIRCLE', '8', layer, '10', f(m.x), '20', f(m.y), '30', '0.0', '40', f((m.d || 0) / 2)];
  }
  function dxfText(m, layer) {
    return ['0', 'TEXT', '8', layer, '10', f(m.x), '20', f(m.y), '30', '0.0',
      '40', f(m.size), '1', m.s, '50', f(m.rot || 0), '72', '1', '11', f(m.x), '21', f(m.y), '31', '0.0'];
  }

  // parts: [{part, xf}] 或 Part[]; opts: {kerf, layerCut, layerMark, splitArcs}
  function toDXF(items, opts) {
    opts = opts || {};
    var LC = opts.layerCut || 'CUT', LM = opts.layerMark || 'MARK';
    var LP = opts.layerPocket || 'POCKET';
    var bb = null, ents = [], pockEnts = [];
    items.forEach(function (it) {
      var p = it.part ? (it.xf ? it.part.transformed(it.xf) : it.part) : it;
      var loops = opts.kerf ? p.compensated(opts.kerf) : p.loops();
      loops.forEach(function (l) {
        var lp = opts.splitArcs === false ? l : G.splitArcs(l, 90);
        bb = G.bboxUnion(bb, G.loopBBox(lp));
        ents = ents.concat(dxfPolyline(lp, LC));
      });
      /* 定深铣槽单独一层: 槽壁在成品内侧, 不做 kerf 外扩(否则槽会变大),
       * 而是内缩 kerf/2 —— 与孔同理, 让"槽的净宽"达到公称值。 */
      p.pockets.forEach(function (q) {
        var l2 = opts.kerf ? G.offsetLoop(q.loop, opts.kerf / 2) : q.loop;
        var lp2 = opts.splitArcs === false ? l2 : G.splitArcs(l2, 90);
        bb = G.bboxUnion(bb, G.loopBBox(lp2));
        pockEnts = pockEnts.concat(dxfPolyline(lp2, LP));
        if (opts.marks !== false) {
          var pb = G.loopBBox(lp2);
          pockEnts = pockEnts.concat(dxfText({
            x: (pb.x0 + pb.x1) / 2, y: (pb.y0 + pb.y1) / 2,
            s: 'D' + (Math.round(q.depth * 100) / 100), size: Math.max(3, Math.min(8, pb.h * 0.4)), rot: 0
          }, LP));
        }
      });
      p.marks.forEach(function (m) {
        if (opts.marks === false) return;
        if (m.type === 'text') ents = ents.concat(dxfText(m, LM));
        else if (m.type === 'circle' && m.d > 0) ents = ents.concat(dxfCircleMark(m, LM));
      });
    });
    ents = ents.concat(pockEnts);
    bb = bb || { x0: 0, y0: 0, x1: 100, y1: 100 };
    var out = []
      .concat(dxfHeader(bb))
      .concat(dxfTables([{ name: LC, color: 7 }, { name: LM, color: 3 }, { name: LP, color: 5 }]))
      .concat(['0', 'SECTION', '2', 'ENTITIES'])
      .concat(ents)
      .concat(['0', 'ENDSEC', '0', 'EOF']);
    return out.join('\r\n') + '\r\n';
  }

  /* ---------------- SVG ---------------- */
  function loopToPath(loop, tol) {
    var d = '', n = loop.length;
    for (var i = 0; i < n; i++) {
      var p1 = loop[i], p2 = loop[(i + 1) % n];
      if (i === 0) d += 'M' + G.round(p1.x, 3) + ',' + G.round(p1.y, 3);
      if (p1.b) {
        var a = G.arcFromBulge(p1, p2, p1.b);
        if (a) {
          var large = Math.abs(a.sweep) > Math.PI ? 1 : 0;
          var sweepFlag = a.sweep > 0 ? 1 : 0;   // SVG y 轴向下, 稍后整体翻转
          d += 'A' + G.round(a.r, 3) + ',' + G.round(a.r, 3) + ' 0 ' + large + ' ' + sweepFlag +
            ' ' + G.round(p2.x, 3) + ',' + G.round(p2.y, 3);
        } else d += 'L' + G.round(p2.x, 3) + ',' + G.round(p2.y, 3);
      } else {
        d += 'L' + G.round(p2.x, 3) + ',' + G.round(p2.y, 3);
      }
    }
    return d + 'Z';
  }

  function toSVG(items, opts) {
    opts = opts || {};
    var bb = null, body = [];
    var prepared = items.map(function (it) {
      var p = it.part ? (it.xf ? it.part.transformed(it.xf) : it.part) : it;
      var loops = opts.kerf ? p.compensated(opts.kerf) : p.loops();
      loops.forEach(function (l) { bb = G.bboxUnion(bb, G.loopBBox(l)); });
      var pk = p.pockets.map(function (q) {
        return { loop: opts.kerf ? G.offsetLoop(q.loop, opts.kerf / 2) : q.loop, depth: q.depth };
      });
      pk.forEach(function (q) { bb = G.bboxUnion(bb, G.loopBBox(q.loop)); });
      return { p: p, loops: loops, pockets: pk };
    });
    bb = bb || { x0: 0, y0: 0, x1: 100, y1: 100, w: 100, h: 100 };
    var pad = opts.pad === undefined ? 10 : opts.pad;
    var W = bb.x1 - bb.x0 + pad * 2, H = bb.y1 - bb.y0 + pad * 2;
    prepared.forEach(function (o) {
      var d = o.loops.map(function (l) { return loopToPath(l); }).join(' ');
      body.push('<path d="' + d + '" fill="' + (opts.fill || 'none') + '" fill-rule="evenodd" stroke="' +
        (opts.stroke || '#000') + '" stroke-width="' + (opts.strokeWidth || 0.3) + '"/>');
      o.pockets.forEach(function (q) {
        body.push('<path d="' + loopToPath(q.loop) + '" fill="none" stroke="' +
          (opts.pocketColor || '#0a7') + '" stroke-width="' + (opts.strokeWidth || 0.3) +
          '" stroke-dasharray="2,1.2"><title>pocket depth ' + G.round(q.depth, 2) + 'mm</title></path>');
      });
      if (opts.marks !== false) {
        o.p.marks.forEach(function (m) {
          if (m.type === 'circle' && m.d > 0) {
            body.push('<circle cx="' + G.round(m.x, 2) + '" cy="' + G.round(m.y, 2) + '" r="' +
              G.round(m.d / 2, 2) + '" fill="none" stroke="' + (opts.markColor || '#c00') +
              '" stroke-width="' + (opts.strokeWidth || 0.3) + '" stroke-dasharray="1.5,1"><title>' +
              esc(m.note || 'mark') + ' φ' + G.round(m.d, 2) + '</title></circle>');
            return;
          }
          if (m.type !== 'text') return;
          body.push('<text x="' + G.round(m.x, 2) + '" y="' + G.round(m.y, 2) + '" font-size="' + m.size +
            '" text-anchor="middle" dominant-baseline="central" fill="' + (opts.markColor || '#c00') +
            '" transform="scale(1,-1) translate(0,' + G.round(-2 * m.y, 3) + ')">' + esc(m.s) + '</text>');
        });
      }
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + G.round(W, 2) + 'mm" height="' + G.round(H, 2) +
      'mm" viewBox="0 0 ' + G.round(W, 3) + ' ' + G.round(H, 3) + '">\n' +
      '<g transform="translate(' + G.round(pad - bb.x0, 3) + ',' + G.round(H - pad + bb.y0, 3) + ') scale(1,-1)">\n' +
      body.join('\n') + '\n</g>\n</svg>\n';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- CSV 料单 ---------------- */
  function toCSV(parts, opts) {
    opts = opts || {};
    var GRAIN = { long: '横纹(顺长边)', cross: '竖纹(顺短边)', any: '不限' };
    var rows = [['序号', '零件名', '数量', '长(mm)', '宽(mm)', '板厚(mm)', '纹理方向',
      '通孔数', '铣槽数', '面积(m2)', '切割周长(mm)', '备注']];
    parts.forEach(function (p, i) {
      var b = p.bbox();
      rows.push([
        i + 1, p.name, p.qty, G.round(b.w, 1), G.round(b.h, 1), p.thickness,
        GRAIN[p.meta.grain] || GRAIN.any,
        p.holes.length, p.pockets.length,
        G.round(Math.abs(p.area()) / 1e6, 4), G.round(p.cutLength(), 0), p.meta.note || ''
      ]);
    });
    return '\ufeff' + rows.map(function (r) {
      return r.map(function (c) {
        var s = String(c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n') + '\r\n';
  }

  global.Part = Part;
  global.CAD = { toDXF: toDXF, toSVG: toSVG, toCSV: toCSV, loopToPath: loopToPath, esc: esc };
})(typeof window !== 'undefined' ? window : this);
