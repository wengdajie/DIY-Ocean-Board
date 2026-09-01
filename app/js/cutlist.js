/* ============================================================
 * cutlist.js - 清单式零件表生成器（对标慧切 cutlist 的交互模型）
 *
 * 慧切的自定义不是"画 3D 板位"，而是**填表**：一行 = 一块板
 *   名称 / 长 / 宽 / 数量 / 纹理方向 / 工艺（圆孔、矩形孔、腰形孔、
 *   洞洞板阵列、四角切口、边部切口、定深铣槽）
 * 这条路径零门槛：不需要空间想象力，也不需要理解坐标系。
 *
 * Cutlist.build(cfg) -> {parts, warnings, info}
 *   cfg: {
 *     thickness, fit, relief, reliefType,
 *     rows: [{
 *       name, len, wid, qty, grain:'long'|'cross'|'any', thickness?,
 *       corners: {all|bl|br|tr|tl: {type:'notch'|'round'|'chamfer', size}},
 *       pegboard: {dia, pitch, pitchY, margin, stagger, rows, cols, skip},
 *       holes:   [{type:'circle'|'rect'|'slot', x, y, ref, d/w/h/len/r/ang}],
 *       notches: [{edge:'bottom'|'right'|'top'|'left', at, len, depth}],
 *       pockets: [{x, y, w, h, depth, r, ref}],
 *       note
 *     }]
 *   }
 *
 * 坐标: 每块板左下角为原点, x 沿"长", y 沿"宽"。
 *       孔位 ref 可取 bl(默认)/center/br/tl/tr, 便于"距右边 50" 这类描述。
 * 依赖: geom.js, joints.js, part.js, features.js
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G, J = global.J, Part = global.Part, F = global.Feat;

  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }

  /* 边缺口的 u 换算: panel 各边 u 走向 bottom +x / right +y / top -x / left -y。
   * 用户填的 at 一律按"自然视图"理解(下/右边从左/下起算, 上边从左起算, 左边从下起算),
   * 所以 top / left 必须换算到各自的 u 方向, 否则缺口会跑到对面去。 */
  function notchU(edge, at, len, w, h) {
    switch (edge) {
      case 'right': return at;
      case 'top': return w - at - len;
      case 'left': return h - at - len;
      default: return at;              // bottom
    }
  }
  var EDGES = ['bottom', 'right', 'top', 'left'];
  function edgeLen(edge, w, h) { return (edge === 'right' || edge === 'left') ? h : w; }

  function buildRow(row, cfg, idx) {
    var warn = [];
    var t = num(row.thickness, num(cfg.thickness, 15));
    var fit = num(cfg.fit, 0.2);
    var relief = num(cfg.relief, 0), rtype = cfg.reliefType || 'none';
    var ropts = (cfg && cfg.earLen !== undefined) ? { earLen: num(cfg.earLen, 2) } : {};
    var name = (row.name === undefined || row.name === null || row.name === '')
      ? ('零件' + (idx + 1)) : String(row.name);
    var w = num(row.len, 0), h = num(row.wid, 0);
    var qty = Math.max(1, Math.round(num(row.qty, 1)));

    if (!(w > 0) || !(h > 0)) {
      warn.push({ level: 'error', text: name + ': 长/宽必须为正数（当前 ' + row.len + ' × ' + row.wid + '）' });
      return { part: null, warnings: warn };
    }
    if (w < t || h < t) {
      warn.push({ level: 'warn', text: name + ': 尺寸 ' + G.round(w, 1) + '×' + G.round(h, 1) + ' 小于板厚，几乎无法加工' });
    }

    /* ---- 边部切口 ---- */
    var edges = { bottom: [], right: [], top: [], left: [] };
    (row.notches || []).forEach(function (n, i) {
      var e = EDGES.indexOf(n.edge) >= 0 ? n.edge : 'bottom';
      var L = edgeLen(e, w, h);
      var at = num(n.at, 0), ln = num(n.len, 0), dp = num(n.depth, 0);
      var tag = name + ' 切口#' + (i + 1);
      if (!(ln > 0) || !(dp > 0)) { warn.push({ level: 'warn', text: tag + ': 长度/深度必须为正，已跳过' }); return; }
      if (at < -1e-9 || at + ln > L + 1e-9) {
        warn.push({ level: 'error', text: tag + ': 超出 ' + e + ' 边范围（边长 ' + G.round(L, 1) + '，位置 ' + at + '+' + ln + '）' });
        return;
      }
      var across = (e === 'right' || e === 'left') ? w : h;
      if (dp > across * 0.9) {
        warn.push({ level: 'error', text: tag + ': 深度 ' + dp + 'mm 几乎切穿整块板（板宽 ' + G.round(across, 1) + '），已跳过' });
        return;
      }
      edges[e].push(F.notchProfile(notchU(e, at, ln, w, h), ln, dp));
    });
    EDGES.forEach(function (e) {
      if (F.edgeConflict(edges[e])) {
        warn.push({ level: 'error', text: name + ': ' + e + ' 边上的切口互相重叠，会生成非法轮廓' });
        edges[e] = [edges[e][0]];
      }
      edges[e] = F.mergeEdge(edges[e]);
    });

    /* ---- 四角处理 ---- */
    var corners = row.corners || null;
    var clash = F.cornerClash(w, h, { edges: edges, corners: corners });
    if (clash.length) {
      warn.push({ level: 'error', text: name + ': 边部切口与四角处理位置冲突（' + clash.join('、') + '），请把切口往里挪' });
    }
    var outer = F.panelOutline(w, h, { edges: edges, corners: corners });
    if (relief > 0) outer = J.applyRelief(outer, relief, rtype, ropts);

    var part = new Part(name, t);
    part.setOuter(outer);
    part.qty = qty;
    /* 长/宽是用户输入的成品标准尺寸；bbox 可能因榫卯/让位变化，
     * 单独保存标准尺寸供料单与编辑表复用。 */
    part.meta.nominalSize = { w: w, h: h };
    var g = row.grain;
    part.meta.grain = (g === 'long' || g === 'cross') ? g : 'any';

    var notes = [];
    /* ---- 洞洞板阵列 ---- */
    if (row.pegboard && num(row.pegboard.dia, 0) > 0) {
      var pb = F.pegboard(w, h, row.pegboard);
      pb.warnings.forEach(function (m) { warn.push({ level: m.level, text: name + ': ' + m.text }); });
      pb.holes.forEach(function (l) { part.addHole(relief > 0 ? J.applyRelief(l, relief, rtype, ropts) : l); });
      if (pb.count) {
        notes.push('洞洞板 ' + pb.rows + '×' + pb.cols + ' 共 ' + pb.count + ' 孔 · Ø' +
          G.round(pb.dia, 1) + ' 孔距 ' + G.round(pb.pitch, 1));
      }
      part.meta.pegboard = { rows: pb.rows, cols: pb.cols, count: pb.count, dia: pb.dia, pitch: pb.pitch };
    }
    /* ---- 自定义孔 ---- */
    if (row.holes && row.holes.length) {
      var hs = F.holesFromSpec(row.holes, w, h, { minEdge: Math.max(3, t * 0.5) });
      hs.warnings.forEach(function (m) { warn.push({ level: m.level, text: name + ': ' + m.text }); });
      hs.holes.forEach(function (l) { part.addHole(relief > 0 ? J.applyRelief(l, relief, rtype, ropts) : l); });
      if (hs.holes.length) notes.push('自定义孔 ' + hs.holes.length + ' 个');
    }
    /* ---- 定深铣槽 ---- */
    (row.pockets || []).forEach(function (pk, i) {
      var a = F.anchor(w, h, pk.ref);
      var cx = a.x + num(pk.x, 0), cy = a.y + num(pk.y, 0);
      var pw = num(pk.w, 0), ph = num(pk.h, 0), dp = num(pk.depth, 0);
      var tag = name + ' 铣槽#' + (i + 1);
      if (!(pw > 0) || !(ph > 0)) { warn.push({ level: 'warn', text: tag + ': 尺寸必须为正，已跳过' }); return; }
      if (!(dp > 0)) { warn.push({ level: 'warn', text: tag + ': 深度必须为正，已跳过' }); return; }
      if (dp >= t) {
        warn.push({ level: 'error', text: tag + ': 深度 ' + dp + 'mm ≥ 板厚 ' + t + 'mm，那是切透不是铣槽，已跳过' });
        return;
      }
      part.addPocket(F.rectHole(cx, cy, pw, ph, num(pk.r, 0)), dp, tag);
    });
    if (part.pockets.length) notes.push('定深铣槽 ' + part.pockets.length + ' 处');

    if (row.note) notes.unshift(String(row.note));
    part.meta.note = notes.join('; ');
    part.meta.asm = { plane: 'XY', x: 0, y: 0, z: 0 };
    part.meta.source = 'cutlist';
    return { part: part, warnings: warn };
  }

  function build(cfg) {
    cfg = cfg || {};
    var rows = cfg.rows || [];
    var parts = [], warn = [];
    if (!rows.length) {
      return {
        parts: [], info: {},
        warnings: [{ level: 'info', text: '零件清单是空的：点"＋加一行"填入 长 × 宽 × 数量 就能出图' }]
      };
    }
    rows.forEach(function (row, i) {
      if (row && row.off) return;                 // 行被临时停用
      var r = buildRow(row, cfg, i);
      r.warnings.forEach(function (m) { warn.push(m); });
      if (r.part) parts.push(r.part);
    });
    if (!parts.length && !warn.some(function (m) { return m.level === 'error'; })) {
      warn.push({ level: 'warn', text: '清单里没有有效的零件行' });
    }
    var totalQty = 0, holes = 0, pockets = 0, grained = 0;
    parts.forEach(function (p) {
      totalQty += p.qty; holes += p.holes.length * p.qty; pockets += p.pockets.length * p.qty;
      if (p.meta.grain === 'long' || p.meta.grain === 'cross') grained++;
    });
    return {
      parts: parts, warnings: warn,
      info: {
        mode: '零件清单', rows: rows.length, panels: parts.length,
        totalQty: totalQty, holeCount: holes, pocketCount: pockets, grainRows: grained
      }
    };
  }

  /* ============================================================
   * 清单模板（一键填充，避免面对空表格发呆）
   * ============================================================ */
  var TEMPLATES = {
    pegboard: {
      label: '宜家风格洞洞板',
      rows: function (t) {
        return [{
          name: '洞洞板', len: 760, wid: 560, qty: 1, grain: 'long',
          corners: { all: { type: 'round', size: 20 } },
          pegboard: { dia: 12, pitch: 40, margin: 30 },
          note: '孔径 12 / 孔距 40，配 Ø12 圆棒挂钩'
        }];
      }
    },
    shelfSet: {
      label: '墙面层板 3 件套',
      rows: function (t) {
        return [
          { name: '层板', len: 600, wid: 200, qty: 3, grain: 'long', corners: { all: { type: 'round', size: 8 } }, note: '前沿圆角，安全' },
          { name: '三角托', len: 180, wid: 180, qty: 6, grain: 'any', corners: { tr: { type: 'chamfer', size: 170 } }, note: '斜角做成直角三角托' }
        ];
      }
    },
    deskTop: {
      label: '桌面 + 走线孔',
      rows: function (t) {
        return [{
          name: '桌面', len: 1200, wid: 600, qty: 1, grain: 'long',
          corners: { all: { type: 'round', size: 30 } },
          holes: [{ type: 'slot', x: -120, y: -60, ref: 'tr', len: 120, d: 60, ang: 0 }],
          /* ref 必须用 center: 用 bl + x=0 会把槽的一半推到板外(踩过) */
          pockets: [{ x: 0, y: -240, ref: 'center', w: 1100, h: 30, depth: Math.max(3, t * 0.4), r: 15 }],
          note: '右上腰形走线孔 + 底面定深走线槽'
        }];
      }
    },
    drawerFront: {
      label: '抽面 + 指拉槽',
      rows: function (t) {
        return [{
          name: '抽屉面板', len: 400, wid: 160, qty: 2, grain: 'long',
          corners: { all: { type: 'round', size: 6 } },
          pockets: [{ x: 0, y: 0, ref: 'center', w: 200, h: 22, depth: Math.max(3, t * 0.45), r: 11 }],
          note: '免拉手：正面铣一条指拉槽'
        }];
      }
    },
    cornerNotch: {
      label: '四角切口立板',
      rows: function (t) {
        return [{
          name: '立板', len: 500, wid: 400, qty: 2, grain: 'cross',
          corners: { all: { type: 'notch', size: 40 } },
          notches: [{ edge: 'bottom', at: 120, len: 60, depth: 30 }],
          note: '四角让开踢脚线 / 底边缺口过线'
        }];
      }
    }
  };

  function template(key, t) {
    var tp = TEMPLATES[key];
    if (!tp) return null;
    return tp.rows(num(t, 15));
  }
  function templateList() {
    return Object.keys(TEMPLATES).map(function (k) { return { key: k, label: TEMPLATES[k].label }; });
  }

  /* 空白行(UI 新增一行时用) */
  function blankRow(n) {
    return { name: '零件' + (n || 1), len: 600, wid: 300, qty: 1, grain: 'any' };
  }

  global.Cutlist = {
    build: build, buildRow: buildRow, notchU: notchU,
    template: template, templateList: templateList, blankRow: blankRow,
    TEMPLATES: TEMPLATES
  };
})(typeof window !== 'undefined' ? window : this);
