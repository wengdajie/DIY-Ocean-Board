/* ============================================================
 * custom.js - 自定义结构生成器
 *
 * 用一份"声明式配方"描述任意板式家具，自动求解榫卯:
 *   {
 *     W, D, H, thickness, fit,
 *     panels: [ {id, plane:'XY'|'YZ'|'XZ', at:<mm>, from:, to:, name} ],
 *     joints: 'auto'  // 自动: 相交的两块板 -> 生成通榫/搭接
 *   }
 *
 * 求解思路: 每块板是三维空间里的一个矩形薄片(轴对齐)。
 *  - 两片正交且相交 => 在交线上生成 通榫(公件出榫/母件开眼) 或 半槽搭接
 *  - 谁出榫由 role 决定: 'tenon' 出榫, 'mortise' 开眼, 'lap' 各切一半
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G, J = global.J, Part = global.Part;
  var F = global.Feat;

  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }

  /* 板片定义: plane 决定法向
   *  XY: 水平板(法向 z), 厚度沿 z; 平面内 u=x, v=y
   *  YZ: 竖直侧板(法向 x), 厚度沿 x; 平面内 u=y(深), v=z(高)
   *  XZ: 竖直前后板(法向 y), 厚度沿 y; 平面内 u=x(宽), v=z(高)
   */
  var AXIS = {
    XY: { n: 'z', u: 'x', v: 'y' },
    YZ: { n: 'x', u: 'y', v: 'z' },
    XZ: { n: 'y', u: 'x', v: 'z' }
  };

  // 把板片转成三维盒(含厚度), at = 板中心面在法向上的坐标
  function toBox(pl, t) {
    var A = AXIS[pl.plane];
    var b = {};
    b[A.n + '0'] = pl.at - t / 2;
    b[A.n + '1'] = pl.at + t / 2;
    b[A.u + '0'] = pl.u0; b[A.u + '1'] = pl.u1;
    b[A.v + '0'] = pl.v0; b[A.v + '1'] = pl.v1;
    return b;
  }
  function span(b, ax) { return [b[ax + '0'], b[ax + '1']]; }
  function overlap(a, b) {
    var lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
    return hi > lo + 1e-9 ? [lo, hi] : null;
  }

  /* 相交或相接: 允许"仅贴合"(对接)。
   * 板式家具最常见的接合恰恰是对接 —— 层板端面顶在侧板内表面上，
   * 两个盒体在该法向上只相切(如 x: [0,15] 与 [15,585])，
   * 用严格 overlap 会判为不相交。故此处用带公差的"接触"判据。 */
  function touch(a, b, tol) {
    var lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
    return (hi - lo) > -tol;          // >0 为真重叠, ≈0 为贴合
  }

  /* 求两块正交板的交线区间
   * 返回 {axis, range, contact} 或 null
   *   contact: 'cross'   两板互穿(十字搭接)
   *            'butt-a'  a 的端面顶在 b 上 (a 出榫, b 开眼)
   *            'butt-b'  b 的端面顶在 a 上
   */
  function intersect(pa, pb, t) {
    if (pa.plane === pb.plane) return null;
    var Aa = AXIS[pa.plane], Ab = AXIS[pb.plane];
    var ba = toBox(pa, t), bb = toBox(pb, t);
    var axes = ['x', 'y', 'z'];
    var line = axes.filter(function (x) { return x !== Aa.n && x !== Ab.n; })[0];
    // 交线方向上必须有实际重叠(否则错开, 根本碰不到)
    var ov = overlap(span(ba, line), span(bb, line));
    if (!ov) return null;
    var tol = Math.max(1e-6, t * 0.02);
    // 两个法向上至少要"接触"
    if (!touch(span(ba, Ab.n), span(bb, Ab.n), tol)) return null;
    if (!touch(span(ba, Aa.n), span(bb, Aa.n), tol)) return null;

    // 判定接触形式: b 的板厚是否落在 a 的跨度内部(真穿过)
    var aAtB = span(ba, Ab.n), bThick = span(bb, Ab.n);
    var bAtA = span(bb, Aa.n), aThick = span(ba, Aa.n);
    var bThroughA = bThick[0] > aAtB[0] + tol && bThick[1] < aAtB[1] - tol;
    var aThroughB = aThick[0] > bAtA[0] + tol && aThick[1] < bAtA[1] - tol;
    var contact;
    if (aThroughB && bThroughA) contact = 'cross';
    else if (aThroughB) contact = 'butt-b';   // b 穿不过 a => b 顶在 a 上... 见下
    else if (bThroughA) contact = 'butt-a';
    else contact = 'corner';
    return { axis: line, range: ov, contact: contact, aNormal: Aa.n, bNormal: Ab.n };
  }

  /* 把三维位置映射到某块板的 2D 画布坐标
   * 画布: x = (u - u0), y = (v - v0)
   */
  function toCanvas(pl, pos3) {
    var A = AXIS[pl.plane];
    return { x: pos3[A.u] - pl.u0, y: pos3[A.v] - pl.v0 };
  }

  /* ============================================================
   * 主生成器
   * ============================================================ */
  function build(cfg) {
    var t = num(cfg.thickness, 15);
    var fit = num(cfg.fit, 0.2);
    var relief = num(cfg.relief, 0), rtype = cfg.reliefType || 'none';
    var ropts = (cfg && cfg.earLen !== undefined) ? { earLen: num(cfg.earLen, 2) } : {};
    var tenonCount = Math.max(1, Math.round(num(cfg.tenonCount, 3)));
    var warn = [], parts = [], i, j;

    /* 【自定义模式也必须听 jointStyle】
     * 上一版这里硬编码 style:'finger', 于是用户在配方/板位表里
     * 无论选什么接合方式都只能得到指接 —— 而 UI 上那个下拉框
     * 看着是生效的。现在走与家具模型**完全相同**的 Models.styleSet。 */
    var MD = global.Models;
    var ss = MD.styleSet(
      { jointStyle: cfg.jointStyle, thickness: t, dovetailAngle: cfg.dovetailAngle,
        tipRadius: cfg.tipRadius, rootRadius: cfg.rootRadius, chamfer: cfg.chamfer,
        wedgeExt: cfg.wedgeExt, wedgeSlotW: cfg.wedgeSlotW, wedgeTaper: cfg.wedgeTaper,
        snapLip: cfg.snapLip, snapBarb: cfg.snapBarb, snapSlit: cfg.snapSlit,
        grooveDepth: cfg.grooveDepth, dowelDia: cfg.dowelDia, dowelCount: cfg.dowelCount,
        biscuitWide: cfg.biscuitWide, biscuitLen: cfg.biscuitLen },
      fit, t, warn);
    /* 十字搭接口径与 jointStyle 无关(搭接没有榫头), 单独一张表。 */
    var lapStyle = (J.LAP_BY_KEY && J.LAP_BY_KEY[cfg.lapStyle]) ? cfg.lapStyle : 'plain';
    if (cfg.lapStyle && cfg.lapStyle !== lapStyle) {
      warn.push({ level: 'warn', text: '未知搭接口径「' + cfg.lapStyle + '」，已按平口半槽处理' });
    }
    var rl = { r: relief, type: rtype, opts: ropts };
    var rctx = {};

    var panels = (cfg.panels || []).map(function (p, idx) {
      return {
        id: p.id || ('P' + (idx + 1)),
        name: p.name || ('板' + (idx + 1)),
        plane: p.plane,
        at: num(p.at, 0),
        u0: num(p.u0, 0), u1: num(p.u1, 0),
        v0: num(p.v0, 0), v1: num(p.v1, 0),
        role: p.role || 'auto',
        qty: Math.max(1, Math.round(num(p.qty, 1))),
        grain: (p.grain === 'long' || p.grain === 'cross') ? p.grain : 'any',
        /* 板级加工特征(与清单模式同构, 复用 features.js) */
        corners: p.corners || null,
        pegboard: p.pegboard || null,
        featHoles: p.holes || null,
        pockets: p.pockets || null,
        userNote: p.note || '',
        edges: { bottom: [], right: [], top: [], left: [] },
        holes: [],
        notes: [],
        /* 样式专属附加特征的待办清单。为何不当场生成:
         * styleExtras 需要该边在**最终零件局部坐标**里的 frame,
         * 而求交阶段还没开始拼轮廓。先存起来, 生成时统一刷。 */
        styleJobs: []
      };
    }).filter(function (p) {
      if (!AXIS[p.plane]) { warn.push({ level: 'error', text: p.name + ': 未知平面 ' + p.plane }); return false; }
      if (p.u1 - p.u0 < t || p.v1 - p.v0 < t) {
        warn.push({ level: 'warn', text: p.name + ' 尺寸过小，已跳过' });
        return false;
      }
      return true;
    });

    if (panels.length < 2) {
      return { parts: [], warnings: warn.concat([{ level: 'error', text: '至少需要 2 块板' }]), info: {} };
    }

    /* ---- 逐对求交并分配榫卯 ---- */
    var jointCount = 0, lapCount = 0;
    for (i = 0; i < panels.length; i++) {
      for (j = i + 1; j < panels.length; j++) {
        var pa = panels[i], pb = panels[j];
        var it = intersect(pa, pb, t);
        if (!it) continue;

        /* 接合分配:
         *  cross   两板互穿      -> 十字半槽搭接
         *  butt-a  a 穿过 b 的跨度(即 b 的端面顶在 a 上) -> b 出榫、a 开眼
         *  butt-b  反之
         *  corner  端对端角接    -> 让"较长"的一方出榫
         */
        if (it.contact === 'cross') {
          /* pa 从交线轴低端切入, pb 从高端切入 -> 相反侧, 能对插 */
          /* 【勾齿方向必须相反】两片同向勾的话, 插到底后无论往哪边推
           * 都有一个勾在挡路 -> 永远锁不上。 */
          var okA = addLap(pa, pb, it, t, fit, false, lapStyle, -1);
          var okB = addLap(pb, pa, it, t, fit, true, lapStyle, +1);
          if (okA && okB) lapCount++;
          else {
            warn.push({
              level: 'warn',
              text: pa.name + ' 与 ' + pb.name + ' 互穿但半槽开不出来（重叠太短或位置贴边），该处未生成接合'
            });
          }
        } else if (it.contact === 'butt-a') {
          addTenon(pb, pa, it, t, fit, tenonCount, ss);
          jointCount++;
        } else if (it.contact === 'butt-b') {
          addTenon(pa, pb, it, t, fit, tenonCount, ss);
          jointCount++;
        } else {
          /* corner: 用几何判据定角色(详见 cornerRoles 的注释);
           * 判不出时才回退到"面积小的出榫"。 */
          var rr = cornerRoles(pa, pb, t);
          if (rr) {
            addTenon(rr.child, rr.host, it, t, fit, tenonCount, ss);
          } else {
            var la = (pa.u1 - pa.u0) * (pa.v1 - pa.v0);
            var lb = (pb.u1 - pb.u0) * (pb.v1 - pb.v0);
            if (lb <= la) addTenon(pb, pa, it, t, fit, tenonCount, ss);
            else addTenon(pa, pb, it, t, fit, tenonCount, ss);
          }
          jointCount++;
        }
      }
    }

    /* ---- 生成零件 ---- */
    var featHoles = 0, featPockets = 0, pegHoles = 0;
    panels.forEach(function (pl) {
      var w = pl.u1 - pl.u0, h = pl.v1 - pl.v0;
      /* 每条边: 按 u 排序拼接。段间重叠必生成自交轮廓, 只能丢弃冲突段。
       * 典型触发: 竖隔板的"背面"这条边同时要 (a) 出榫扎进背板,
       * (b) 给几块贯通层板让出搭接缺口 —— 同一条边被两种接合抢用。
       * 这是真实的过约束, 报错并降级成"能切出来的合法零件"比直接出废图好。 */
      var eg = {}, EDGE_CN = { bottom: '下', right: '右(后)', top: '上', left: '左(前)' };
      ['bottom', 'right', 'top', 'left'].forEach(function (k) {
        var segs = pl.edges[k];
        if (!segs.length) { eg[k] = null; return; }
        if (!F) { eg[k] = [].concat.apply([], segs); return; }
        var rv = F.resolveEdge(segs);
        if (rv.dropped.length) {
          /* 同一条边被多处接合抢用。这是**设计上的过约束**, 不是几何错误:
           * 降级后的零件轮廓仍然合法、仍然能切出来, 只是被放弃的那几处
           * 变成"靠自攻螺丝/木销固定"而非榫接。所以报 warn 而不是 error,
           * 并点名是哪几处接合被放弃, 用户才知道该改哪块板。 */
          var lost = (rv.droppedProfs || []).map(function (q) { return q.src; })
            .filter(function (q) { return !!q; });
          var keptSrc = (rv.keptProfs || []).map(function (q) { return q.src; })
            .filter(function (q) { return !!q; });
          warn.push({
            level: 'warn',
            text: pl.name + ' 的' + EDGE_CN[k] + '边同时要承担 ' + (rv.kept + rv.dropped.length) +
              ' 处接合，几何上无法共存，已保留 ' +
              (keptSrc.length ? '【' + keptSrc.join('、') + '】' : rv.kept + ' 处') +
              '，放弃 ' + (lost.length ? '【' + lost.join('、') + '】' : rv.dropped.length + ' 处') +
              '。放弃处请改用木销或自攻螺丝固定；若想全部走榫接，' +
              '把贯通板改成只跨一格（缩进格内），或让该侧背板改成嵌槽（板位表里把背板 at 往内挪）'
          });
        }
        eg[k] = rv.prof;
      });
      /* 四角处理不能吃掉榫齿, 否则轮廓错乱 */
      var loop;
      if (pl.corners && F) {
        var clash = F.cornerClash(w, h, { edges: eg, corners: pl.corners });
        if (clash.length) {
          warn.push({ level: 'error', text: pl.name + ': 四角处理与榫齿冲突（' + clash.join('、') + '），该板已忽略四角处理' });
          loop = global.Models.panel(w, h, eg);
        } else {
          loop = F.panelOutline(w, h, { edges: eg, corners: pl.corners });
        }
      } else {
        loop = global.Models.panel(w, h, eg);
      }
      var pt = new Part(pl.name, t);
      pt.setOuter(relief > 0 ? J.applyRelief(loop, relief, rtype, ropts) : loop);
      pt.qty = pl.qty;
      /* 板位表的 W/D/H 是标准成品世界尺寸，不是榫头外包络。 */
      pt.meta.nominalSize = { w: w, h: h };
      pt.meta.grain = pl.grain;
      /* 榫眼可能落进"搭接缺口"里 —— 那块料已经被切掉了, 孔开在空气上。
       * 典型触发: 用户加了一块贯通整宽的层板(与竖隔板互穿 -> 搭接),
       * 而同高度上原本还有一块顶在竖隔板上的层板(-> 榫眼)。
       * 直接生成会得到"孔越出板边"的非法零件; 这里主动剔除并给出可操作提示,
       * 告诉用户是哪两块板打架, 而不是丢一句几何错误。 */
      var outFlat = G.flatten(pt.outer, 0.1);
      pl.holes.forEach(function (hl) {
        var hf = G.flatten(hl, 0.1);
        if (!hf.every(function (q) { return G.pointInPoly(q, outFlat); })) {
          warn.push({
            level: 'error',
            text: pl.name + ': 有一处榫眼落在搭接缺口内（该处材料已被切掉），已剔除。' +
              '通常是"贯通板"与"对接板"在同一位置打架，请把其中一块挪开或改成不贯通'
          });
          return;
        }
        pt.addHole(relief > 0 ? J.applyRelief(hl, relief, rtype, ropts) : hl);
      });
      /* 板级加工特征 */
      if (F && pl.pegboard && num(pl.pegboard.dia, 0) > 0) {
        var pb = F.pegboard(w, h, pl.pegboard);
        pb.warnings.forEach(function (m) { warn.push({ level: m.level, text: pl.name + ': ' + m.text }); });
        pb.holes.forEach(function (l) { pt.addHole(relief > 0 ? J.applyRelief(l, relief, rtype, ropts) : l); });
        pegHoles += pb.count;
        if (pb.count) pl.notes.push('洞洞板 ' + pb.rows + '×' + pb.cols + '/' + pb.count + '孔');
      }
      if (F && pl.featHoles && pl.featHoles.length) {
        var hs = F.holesFromSpec(pl.featHoles, w, h, { minEdge: Math.max(3, t * 0.5) });
        hs.warnings.forEach(function (m) { warn.push({ level: m.level, text: pl.name + ': ' + m.text }); });
        hs.holes.forEach(function (l) { pt.addHole(relief > 0 ? J.applyRelief(l, relief, rtype, ropts) : l); });
        featHoles += hs.holes.length;
      }
      if (F && pl.pockets && pl.pockets.length) {
        pl.pockets.forEach(function (pk, i) {
          var a = F.anchor(w, h, pk.ref);
          var pw = num(pk.w, 0), ph = num(pk.h, 0), dp = num(pk.depth, 0);
          if (!(pw > 0) || !(ph > 0) || !(dp > 0)) {
            warn.push({ level: 'warn', text: pl.name + ' 铣槽#' + (i + 1) + ': 尺寸/深度无效，已跳过' });
            return;
          }
          if (dp >= t) {
            warn.push({ level: 'error', text: pl.name + ' 铣槽#' + (i + 1) + ': 深度 ' + dp + 'mm ≥ 板厚，那是切透，已跳过' });
            return;
          }
          pt.addPocket(F.rectHole(a.x + num(pk.x, 0), a.y + num(pk.y, 0), pw, ph, num(pk.r, 0)), dp);
          featPockets++;
        });
      }
      /* ---- 样式专属附加特征(销孔/饼干槽/楔口/停止嵌槽) ----
       *
       * 这一段不能省: dowel/biscuit/tongue 三种样式的轮廓与直榫几乎一模一样
       * (或干脆没有榫头), 真正实现接合的全是这些孔/槽。不刷的话
       * "选了木销对接, 图纸上一个孔都没有"。
       *
       * 坐标对齐: side='host' 存的 frame 已经是母件局部坐标;
       * side='tab' 存的是逻辑边, 要先按 putEdgeProfile 的**同一套规则**
       * 换算出边名与是否需要镜像 —— 否则孔会落在对称的反面。 */
      var MD2 = global.Models, sNotes = [];
      (pl.styleJobs || []).forEach(function (jb) {
        /* jb.frame 已经是该零件局部坐标里、**只跨重叠区**的子 frame,
         * jb.spans.L 也等于重叠长度 -> styleExtras 直接用就对齐了。 */
        var ex = J.styleExtras(jb.style, jb.spans, jb.frame, t, jb.side, jb.o);
        ex.holes.forEach(function (l) {
          /* 让位后的过切圆往材料侧长, 可能捐出板外 -> 用同一道护栏。 */
          MD2.addHoleRelieved(pt, l, rl, rctx);
        });
        pt.addPockets(ex.pockets);
        pt.addMarks(ex.marks);
        ex.notes.forEach(function (n) { if (sNotes.indexOf(n) < 0) sNotes.push(n); });
        if (ex.extraParts.length) {
          if (!pt.meta.extraParts) pt.meta.extraParts = [];
          ex.extraParts.forEach(function (q) { pt.meta.extraParts.push(q); });
        }
      });
      if (sNotes.length) pt.meta.styleNotes = sNotes;

      if (pl.userNote) pl.notes.unshift(pl.userNote);
      pt.meta.note = pl.notes.concat(sNotes).join('; ') || pl.plane + ' 板';
      pt.meta.asm = { plane: pl.plane, x: 0, y: 0, z: 0 };
      var A = AXIS[pl.plane];
      /* 第 6 轮统一语义(详见 render.boxesFrom 头部):
       *   法向轴   = 板厚区间的**低面** = at - t/2  (三个平面一致, 不再特例 XZ)
       *   平面内两轴 = 零件局部 2D 坐标原点 = (u0, v0)
       * 旧版 XZ 传中心面、其余传低面, 两套语义混用 -> 前后板偏半个板厚。 */
      pt.meta.asm[A.n] = pl.at - t / 2;
      pt.meta.asm[A.u] = pl.u0;
      pt.meta.asm[A.v] = pl.v0;
      pt.meta.panelId = pl.id;
      parts.push(pt);
    });

    /* 楔子等独立小件必须**真的进料单和排样** ——
     * 少切一片楔子, 整套接合就锁不住。 */
    var extras = global.Models.collectExtras(parts, t);
    extras.forEach(function (q) { parts.push(q); });
    global.Models.reliefWarn(rctx, rl, warn);

    return {
      parts: parts,
      warnings: warn.concat(validate(panels, t)),
      info: {
        mode: '自定义',
        panels: panels.length,
        tenonJoints: jointCount,
        lapJoints: lapCount,
        featHoles: featHoles + pegHoles,
        featPockets: featPockets,
        /* 报出最终真用的样式(可能已降级), 测试与 UI 都靠它。 */
        jointStyle: ss.want,
        cornerStyle: ss.corner.style,
        midStyle: ss.mid.style,
        lapStyle: lapStyle,
        grow: ss.grow,
        extraParts: extras.length
      }
    };
  }

  /* ============================================================
   * 结构合法性校验（生成前就告诉用户哪儿不对）
   * 慧切主打"零 CAD"，前提是错误必须当场看得见，而不是切废了才知道。
   *   1) 同平面同标高的两块板互相压叠 -> 重复下料
   *   2) 悬空板: 与任何其它板都不接触 -> 装不上去
   *   3) 板厚方向互穿但两块都是"半槽搭接"以外的情形已由 build 处理，
   *      这里只报告"完全被另一块板包住"的退化情形
   * ============================================================ */
  function validate(panels, t) {
    var out = [], i, j;
    var seg = function (a, b) { return Math.max(a[0], b[0]) < Math.min(a[1], b[1]) - 1e-6; };
    for (i = 0; i < panels.length; i++) {
      var pa = panels[i], touched = 0;
      for (j = 0; j < panels.length; j++) {
        if (i === j) continue;
        var pb = panels[j];
        if (pa.plane === pb.plane) {
          // 同平面: 标高相近 + uv 区间重叠 => 压叠
          if (Math.abs(pa.at - pb.at) < t - 1e-6 &&
              seg([pa.u0, pa.u1], [pb.u0, pb.u1]) && seg([pa.v0, pa.v1], [pb.v0, pb.v1])) {
            if (i < j) {
              out.push({
                level: 'warn',
                text: pa.name + ' 与 ' + pb.name + ' 同平面重叠（标高相差 ' +
                  G.round(Math.abs(pa.at - pb.at), 1) + 'mm < 板厚），会重复下料'
              });
            }
          }
          continue;
        }
        if (intersect(pa, pb, t)) touched++;
      }
      if (!touched) {
        out.push({ level: 'warn', text: pa.name + ' 与其它板都不接触（悬空），装配时无处固定' });
      }
    }
    return out;
  }

  /* ---------------- 榫卯落位 ----------------
   * child 出榫；host 视接触位置分两种:
   *   a) 中部接合 -> host 面上开"通榫眼"(孔)
   *   b) 角部接合 -> child 的端面与 host 的板边齐平，此时开孔会跨过板边(非法)，
   *      必须改成"互补指接": 两块板在该边各出一组榫齿，phase 0/1 交错咬合。
   * 这正是箱体四角的做法。
   */
  /* 角接时"谁出榫 / 谁让位"必须用几何判据, 不能拍面积。
   *
   * 【第 6 轮修的真实 BUG】旧版写 `lb <= la ? child=b : child=a`(面积小的出榫)。
   * 洞洞板挂墙组里: 洞洞板 870x900 比包边 320x900 大, 于是包边被当成出榫件,
   * 往 y 方向长出 15mm 榫头 -> 柜体深度从 320 变 335, 且榫头扎在空气里。
   *
   * 正确的判据是看**矩形绘制尺寸的含义**:
   *   · 若 P 沿 O 的法向的跨度止在 O 的**内表面**(即 P 停在 O 外面, 没进去),
   *     说明 P 的矩形是"肩距" -> P 应该向外出榫穿过 O, 刚好齐平。
   *   · 若 P 的跨度直接到达 O 的**外表面**, 说明 P 的矩形已是成品外形
   *     -> P 应该向内让位(fingerRecessProfile), 再往外长就胖出一个板厚。
   *
   * 返回 {child, host} 或 null(判不出时由调用方回退到面积启发式)。
   */
  function cornerRoles(pa, pb, t) {
    var Aa = AXIS[pa.plane], Ab = AXIS[pb.plane];
    var ba = toBox(pa, t), bb = toBox(pb, t);
    var tol = Math.max(1e-6, t * 0.05);
    /* P 沿 axis 的跨度是否抵在 O 的内表面 */
    function isShoulder(bP, bO, axis) {
      var p0 = bP[axis + '0'], p1 = bP[axis + '1'];
      var o0 = bO[axis + '0'], o1 = bO[axis + '1'];
      return Math.abs(p0 - o1) < tol || Math.abs(p1 - o0) < tol;
    }
    /* P 沿 axis 的跨度是否直接齐到 O 的外表面 */
    function isFlush(bP, bO, axis) {
      var p0 = bP[axis + '0'], p1 = bP[axis + '1'];
      var o0 = bO[axis + '0'], o1 = bO[axis + '1'];
      return Math.abs(p0 - o0) < tol || Math.abs(p1 - o1) < tol;
    }
    var aSh = isShoulder(ba, bb, Ab.n), aFl = isFlush(ba, bb, Ab.n);
    var bSh = isShoulder(bb, ba, Aa.n), bFl = isFlush(bb, ba, Aa.n);
    /* 最干净的情形: 一方肩距、另一方齐平 */
    if (aSh && !aFl && bFl && !bSh) return { child: pa, host: pb, why: 'shoulder-flush' };
    if (bSh && !bFl && aFl && !aSh) return { child: pb, host: pa, why: 'shoulder-flush' };
    /* 只有一方是肩距 */
    if (aSh && !bSh) return { child: pa, host: pb, why: 'shoulder-only' };
    if (bSh && !aSh) return { child: pb, host: pa, why: 'shoulder-only' };
    return null;
  }

  function addTenon(child, host, it, t, fit, n, ss) {
    var Ac = AXIS[child.plane], Ah = AXIS[host.plane];
    var m = (n % 2 ? n : n + 1);
    /* 没传 ss 时退回纯指接(旧行为), 保证直接调 addTenon 的调用方不破。 */
    var oc = (ss && ss.corner) || { fit: fit, style: 'finger' };
    var om = (ss && ss.mid) || { fit: fit, style: 'finger' };

    // --- child 侧: 交线沿 child 的哪个轴 ---
    var cLineIsU = (it.axis === Ac.u);
    var cBase = cLineIsU ? child.u0 : child.v0;
    var cLen = cLineIsU ? (child.u1 - child.u0) : (child.v1 - child.v0);
    var cLo = it.range[0] - cBase, cHi = it.range[1] - cBase;
    if (cHi - cLo < t) return false;
    // child 的另一轴上, host 靠近哪一端
    var cOther = cLineIsU ? [child.v0, child.v1] : [child.u0, child.u1];
    var cNearLo = Math.abs(host.at - cOther[0]) <= Math.abs(host.at - cOther[1]);

    // --- host 侧 ---
    var hLineIsU = (it.axis === Ah.u);
    var hBase = hLineIsU ? host.u0 : host.v0;
    var hLen = hLineIsU ? (host.u1 - host.u0) : (host.v1 - host.v0);
    var hLo = it.range[0] - hBase, hHi = it.range[1] - hBase;
    // child 在 host 非交线轴上的位置(host 画布坐标)
    var hOther = hLineIsU ? [host.v0, host.v1] : [host.u0, host.u1];
    var otherLocal = child.at - hOther[0];
    var otherExtent = hOther[1] - hOther[0];

    // 榫眼是否会跨过 host 板边 -> 角接
    var tol = t * 0.5 + fit;
    var isCorner = (otherLocal - (t + fit) / 2 < tol * 0.02) || (otherLocal + (t + fit) / 2 > otherExtent - tol * 0.02);

    if (isCorner) {
      /* 角接: 同一段长度上做互补指接, 双方共用 m 与区间, phase 互补。
       *
       * 【第 6 轮修的真实干涉 BUG】旧版两块板都用 tabProfile 往外长榫:
       *   1) child 的矩形是**肩距**(端面停在 host 表面), 往外长 t 正好齐平 -> 对;
       *   2) host 的角部就是它自己的**外边界**, 再往外长就胖出一个板厚,
       *      而且两套榫头抢同一个角部方块(真实干涉, 切出来装不上)。
       * 实测: 标称 900 高的格柜, 3D 装配包围盒是 z[-15,915]。
       * 正解: host 改用"内缩式"(把 gap 段往内挖 t, 榫头与板边齐平)。 */
      var segLen = Math.min(cHi - cLo, hHi - hLo);
      if (segLen < t * 2) return false;
      /* 【phase 必须这么选】child 拿 phase=1(两端是空、榫齿全在中间),
       * host 拿 phase=0(两端是实料、要挖的 gap 全在中间)。
       *
       * 不能反过来: 若 host 的 gap 落在 u=0, 内缩轮廓会从板角往里切,
       * 而那条线与相邻边**共线重叠** -> "外轮廓自交"(实测 13 个零件全炸)。
       * 同理 child 的榫齿也不能贴角, 否则两个方向的榫齿在角上碰头。
       * m 加 2 是为了补回齿数(phase=1 比 phase=0 少一个齿)。 */
      var mm = m + 2;
      var spC = J.spansFor(segLen, { t: t, m: mm, phase: 1 });
      var spH = J.spansFor(segLen, { t: t, m: mm, phase: 0 });
      /* 【phase 不能反】child 拿 phase=1(两端是空、榫齿全在中间),
       * host 拿 phase=0 的内缩轮廓。反了的话 host 的内缩轮廓会从板角
       * 往里切、与相邻边共线 -> 外轮廓自交。
       *
       * 角接处走 ss.corner: 它已经把楔钉/卡扣/嵌槽/燕尾降级成直榫了
       * (四角互补咬合没有通孔, 详见 J.STYLES 的能力矩阵)。 */
      var pc = J.profileFor(oc.style, shiftSpans(spC, cLo, cLen), t,
        Object.assign({}, oc, { maxBack: (cLineIsU ? (child.v1 - child.v0) : (child.u1 - child.u0)) * 0.35 }));
      putEdgeProfile(child, cLineIsU, cNearLo, cLen, pc, '角接' + host.name);
      var hNearLo = otherLocal - (t + fit) / 2 < otherExtent / 2;
      /* spH 的 gaps == spC 的 tabs, 于是 host 挖掉的正好是 child 榫头要占的位置。 */
      putEdgeProfile(host, hLineIsU, hNearLo, hLen,
        J.fingerRecessProfile(shiftSpans(spH, hLo, hLen), t, { fit: fit }), '角接' + child.name);
      child.notes.push('角接指榫↔' + host.name + '(本件出榫)');
      host.notes.push('角接指榫↔' + child.name + '(本件内缩让位)');
      return true;
    }

    /* 中部接合: child 出榫, host 开通榫眼 */
    var spans = J.spansFor(cHi - cLo, {
      t: t, m: m, phase: 0,
      inset: Math.max(t, (cHi - cLo) * 0.08)
    });
    /* 中部接合走 ss.mid: 楔钉/卡扣/嵌槽在这里都是合法的
     * (母件有通榫眼可以穿过去)。 */
    var spanC = shiftSpans(spans, cLo, cLen);
    var perp = (cLineIsU ? (child.v1 - child.v0) : (child.u1 - child.u0));
    var pm = J.profileFor(om.style, spanC, t, Object.assign({}, om, { maxBack: perp * 0.35 }));
    putEdgeProfile(child, cLineIsU, cNearLo, cLen, pm, '出榫→' + host.name);
    child.notes.push((MD_LABEL(om.style)) + '→' + host.name);
    /* ---- 样式专属附加特征: frame 必须只跨"重叠区" ----
     *
     * 【第 9 轮修的真实"槽/孔铺满整块板"缺陷】
     * shiftSpans(sp, off, L) 把 L 设成**整条边的长度**(只把 tabs 平移了),
     * 而 styleExtras 内部用 spans.L 决定嵌槽/饼干槽的铺设范围 ->
     * 于是槽沿整条边铺满, 而不是只在两板真正相交的那一段。
     *
     * 在 grid 这种正交矩阵里重叠区恰好就是整条边, 所以看不出问题;
     * 但 L 形转角柜的"转角公用立板"(700 宽)同时当两个臂的母件,
     * 实测(t=15): 嵌槽被铺成 y[5.25, 694.75] —— 几乎整块板,
     * 跨过了搭接缺口 -> 4 条"铣槽越出板边"; 且两个臂的槽彼此重叠。
     * 饼干槽同理: 5 个槽均分到整条边上, 最后一个落在板外。
     * 6 板厚 × 2 样式 = 12 组参数静默出废图。
     *
     * 正解: 拿**未平移的** spans(L = 重叠长度) + 一个起点落在重叠区
     * 开头的子 frame。镜像边(top/left)还要同步镜像 spans,
     * 否则特征会落在对称的反面。 */
    var midLen = cHi - cLo;
    var cw = child.u1 - child.u0, ch = child.v1 - child.v0;
    var cKey = cLineIsU ? (cNearLo ? 'bottom' : 'top') : (cNearLo ? 'left' : 'right');
    var cMir = (cLineIsU && !cNearLo) || (!cLineIsU && cNearLo);
    var cF0 = global.Models.edgeFrame(cw, ch, cKey);
    var cStart = cMir ? (cLen - cHi) : cLo;
    child.styleJobs.push({
      side: 'tab', style: om.style, o: om,
      spans: cMir ? global.Models.mirrorSpans(spans, midLen) : spans,
      frame: G.frame(cF0.at(cStart, 0), cF0.at(cStart + midLen, 0))
    });

    var f;
    if (hLineIsU) f = G.frame(G.P(0, otherLocal), G.P(hLen, otherLocal));
    else f = G.frame(G.P(otherLocal, 0), G.P(otherLocal, hLen));
    var spanH = shiftSpans(spans, hLo, hLen);
    /* 母件侧的子 frame: 只跨 [hLo, hHi] 这一段(与子件重叠区等长)。 */
    var fSubH = hLineIsU
      ? G.frame(G.P(hLo, otherLocal), G.P(hLo + midLen, otherLocal))
      : G.frame(G.P(otherLocal, hLo), G.P(otherLocal, hLo + midLen));
    /* 【平对接类与舌槽类不得开榫眼】它们根本没有榫头,
     * 开了就是在母件上白挖一排方孔, 强度反而更差。 */
    var flat = J.isFlatStyle(om.style) || om.style === 'tongue';
    if (!flat) {
      J.mortisesFromSpans(spanH, f, t, om).forEach(function (hl) { host.holes.push(hl); });
      host.notes.push('榫眼←' + child.name);
    }
    host.styleJobs.push({ side: 'host', style: om.style, o: om, spans: spans, frame: fSubH });
    return true;
  }

  /* 把 profile 放到板的正确边上。
   * panel() 约定各边的 u 走向: bottom +x / right +y / top -x / left -y
   * 因此 top 与 left 需要把 u 镜像。
   *
   * ！关键: 每条边保存的是**段的列表**, 不是拍平的点列。
   * 曾经的 bug —— 直接 concat: 一条边上有多处接合时, 段的顺序取决于
   * 板对枚举顺序 (i<j), 而不是 u 从小到大。镜像边(top/left)几乎必然逆序,
   * 于是轮廓折回自己 -> "外轮廓自交"。L 形转角柜的公用立板正是这样炸的。
   * 现在统一在生成阶段按 u 排序(F.mergeEdge)并检测重叠(F.edgeConflict)。 */
  function putEdgeProfile(pl, lineIsU, nearLo, L, prof, src) {
    if (!prof || !prof.length) return;
    var p2;
    if (lineIsU) {
      p2 = nearLo ? prof : mirrorProf(prof, L);
      if (src) p2.src = src;
      if (nearLo) pl.edges.bottom.push(p2);
      else pl.edges.top.push(p2);
    } else {
      p2 = nearLo ? mirrorProf(prof, L) : prof;
      if (src) p2.src = src;
      if (nearLo) pl.edges.left.push(p2);
      else pl.edges.right.push(p2);
    }
  }

  /* 十字搭接: 在 pl 上开半槽
   *
   * 两块正交板互穿, 各切掉一半厚度方向上的料, 插成井字。
   * 关键是把"槽的长轴"和"槽的定位轴"对上, 曾经写反过:
   *   pl 与 other 正交 => other 的法向必然是 pl 的 u 或 v 之一(不可能是 pl 的法向),
   *   交线方向 = 剩下的那个轴。
   *   · 交线沿 pl 的 u  => other 法向 = pl 的 v
   *       槽长轴 = u  -> 从 u 的某一端(left / right 边)切入
   *       槽位置 = other.at 换算到 pl 的 v
   *   · 交线沿 pl 的 v  => 槽长轴 = v, 从 bottom / top 边切入, 位置沿 u
   *
   * ！！最关键的一点(曾经错过, 而且"零件全部合法"根本查不出来):
   * **两块板的半槽必须从相反的物理侧切入**, 否则两片卡不到一起 —— 就像两张
   * 都从上边开缝的卡片, 永远插不成十字。而"开口在哪一侧"是**世界坐标**概念,
   * 不能用局部的 left/right/bottom/top 来判断: 两块板平面不同, 局部的
   * "right" 与 "top" 有可能指向同一个世界方向(YZ 板的 right 和 XY 板的 top
   * 都是 y=max), 于是两个半槽同侧, 装不上。
   * 正解: 沿**交线轴**统一定向 —— openHigh=false 的板从该轴低端切入,
   * openHigh=true 的板从高端切入; 再各自换算到局部边。
   * 槽深取到重叠区间的中点, 两段深度之和恰好等于重叠长度, 插到底刚好齐平。
   */
  function addLap(pl, other, it, t, fit, openHigh, lapStyle, hookDir) {
    var A = AXIS[pl.plane];
    var lineIsU = (it.axis === A.u);
    var mid = (it.range[0] + it.range[1]) / 2;      // 沿交线轴的分界点(世界坐标)
    if (lineIsU) {
      var lo = pl.u0, hi = pl.u1;                   // 槽长轴 = u
      var pos = other.at - pl.v0;                   // 槽位置沿 v
      var Lv = pl.v1 - pl.v0;
      var depth = openHigh ? (hi - mid) : (mid - lo);
      if (pos < t / 2 || pos > Lv - t / 2) return false;   // 贴边的"搭接"没有意义
      if (depth < t) return false;
      // u 高端 = right 边(x=w); u 低端 = left 边(x=0, 走向 -v 需镜像位置)
      var pfA = LAPP(lapStyle, openHigh ? pos : (Lv - pos), t, depth, fit, hookDir);
      pfA.src = '搭接↔' + other.name;
      if (openHigh) pl.edges.right.push(pfA); else pl.edges.left.push(pfA);
    } else {
      var lo2 = pl.v0, hi2 = pl.v1;                 // 槽长轴 = v
      var pos2 = other.at - pl.u0;                  // 槽位置沿 u
      var Lu = pl.u1 - pl.u0;
      var depth2 = openHigh ? (hi2 - mid) : (mid - lo2);
      if (pos2 < t / 2 || pos2 > Lu - t / 2) return false;
      if (depth2 < t) return false;
      // v 高端 = top 边(y=h, 走向 -u 需镜像位置); v 低端 = bottom 边(y=0)
      var pfB = LAPP(lapStyle, openHigh ? (Lu - pos2) : pos2, t, depth2, fit, hookDir);
      pfB.src = '搭接↔' + other.name;
      if (openHigh) pl.edges.top.push(pfB); else pl.edges.bottom.push(pfB);
    }
    pl.notes.push((lapStyle === 'hook' ? '勾齿搭接↔' : '平口搭接↔') + other.name +
      (openHigh ? '(从后/上切入)' : '(从前/下切入)'));
    return true;
  }
  /* 搭接缺口轮廓: 平口 or 勾齿。勾齿需要槽足够深(至少 2t),
   * 否则勾本身就把槽底吃穿了。 */
  function LAPP(lapStyle, uCenter, t, depth, fit, hookDir) {
    if (lapStyle === 'hook' && depth >= t * 2) {
      return J.hookLapProfile(uCenter, t, depth, { fit: fit, hookDir: hookDir >= 0 ? 1 : -1 });
    }
    return J.lapNotchProfile(uCenter, t, depth, { fit: fit });
  }

  /* 样式的中文短名(给零件备注用)。不得傅底成"出榫" ——
   * 那会让用户以为自己选的样式没生效。 */
  function MD_LABEL(style) {
    var st = J.STYLE_BY_KEY && J.STYLE_BY_KEY[style];
    return st ? st.label : style;
  }

  function shiftSpans(sp, off, L) {
    var o = { m: sp.m, seg: sp.seg, L: L, inset: sp.inset };
    o.tabs = sp.tabs.map(function (g) { return [g[0] + off, g[1] + off]; });
    o.gaps = sp.gaps.map(function (g) { return [g[0] + off, g[1] + off]; });
    return o;
  }
  /* 把 profile 沿 u 方向镜像(给 top / left 这两条反向边用)。
   *
   * 【第 9 轮修的真实缺陷: 弧段 bulge 归属的顶点错一位】
   * 环的存储约定是「b 挂在弧的**起点**上」—— loop[i].b 描述的是
   * loop[i] -> loop[i+1] 这一段。锼像+反向后遍历方向变了,
   * 原来的「起点」变成了「终点」, 所以 b 必须**往后挪一个顶点**;
   * 同时锼像会翻转手征, 反向又翻一次 -> 两次抵消, 所以符号**不变**。
   * 旧版则反了: 把 b 留在原位 + 取负。
   *
   * 实测(bench t=15 / fillet / 1200x350x450): 板腿上边的榫头根部倒圆
   * 本应向内凹(削掉榫头自己的料), 锼像后变成弧心跑到外侧 ->
   * 轮廓在 v 方向向内凹进去 5mm(y 从 435 凹到 414.8),
   * 把本该是材料的区域挖成了空; 于是同位置的榫眼
   * (y[396.62, 420.05]) 落在空气上 -> 报"榫眼落在搭接缺口内"并被剔除,
   * 板腿少一个榫眼、坐面却照样出两个榫头 -> 装不上。
   * 仅影响带弧的样式(round / fillet / dovetail / puzzle 等),
   * 纯直线的 finger 永远正常 —— 所以单测 finger 发现不了。 */
  function mirrorProf(prof, L) {
    var n = prof.length, out = [], i;
    for (i = n - 1; i >= 0; i--) {
      /* 新段的起点是 prof[i], 终点是 prof[i-1];
       * 这一段在原环里就是 prof[i-1] -> prof[i], 弧存在 prof[i-1].b。 */
      var src = prof[i - 1];
      out.push({ u: L - prof[i].u, v: prof[i].v, b: (src && src.b) ? src.b : undefined });
    }
    /* profile 是**开放折线**而非闭环: 最后一个点后面没有段,
     * 不能带 b(否则会把弧接到相邻边的第一个点上去)。 */
    if (out.length) out[out.length - 1].b = undefined;
    return out;
  }

  /* ============================================================
   * 便捷配方: 由"隔板布局"生成自定义柜
   *  用一串竖隔板 x 坐标 + 每一列的层板数，生成不规则格柜
   * ============================================================ */
  /* 只产出板位表(不求解), 供 UI 把"配方"展开成可手工编辑的 panels */
  function shelfPanels(p) {
    var t = num(p.thickness, 15);
    var W = num(p.width, 900), D = num(p.depth, 320), H = num(p.height, 900);
    var dividers = (p.dividers || []).slice().sort(function (a, b) { return a - b; });
    var shelvesPerBay = p.shelvesPerBay || [];
    var panels = [];
    // 外框
    panels.push({ id: 'L', name: '左侧板', plane: 'YZ', at: t / 2, u0: 0, u1: D, v0: 0, v1: H });
    panels.push({ id: 'R', name: '右侧板', plane: 'YZ', at: W - t / 2, u0: 0, u1: D, v0: 0, v1: H });
    panels.push({ id: 'B', name: '底板', plane: 'XY', at: t / 2, u0: t, u1: W - t, v0: 0, v1: D });
    panels.push({ id: 'T', name: '顶板', plane: 'XY', at: H - t / 2, u0: t, u1: W - t, v0: 0, v1: D });
    // 竖隔板
    dividers.forEach(function (x, i) {
      panels.push({ id: 'D' + i, name: '竖隔板' + (i + 1), plane: 'YZ', at: x, u0: 0, u1: D, v0: t, v1: H - t });
    });
    // 每列层板
    var bounds = [t].concat(dividers).concat([W - t]);
    for (var b = 0; b < bounds.length - 1; b++) {
      var x0 = bounds[b], x1 = bounds[b + 1];
      var nsh = shelvesPerBay[b] === undefined ? num(p.shelves, 2) : shelvesPerBay[b];
      for (var k = 1; k <= nsh; k++) {
        var z = t + (H - 2 * t) * k / (nsh + 1);
        panels.push({
          id: 'S' + b + '_' + k, name: '层板' + (b + 1) + '-' + k,
          plane: 'XY', at: z, u0: x0, u1: x1, v0: 0, v1: D - num(p.setback, 0)
        });
      }
    }
    return panels;
  }

  /* 接合参数的透传。
   * 【为何不再逐个列举字段】旧版这两个包装函数只括了
   * thickness/fit/relief/reliefType/tenonCount 五个字段, 于是 jointStyle 及
   * 全部样式专属参数**在这里静默丢失** —— 即使 app.js 一路传下来,
   * 配方模式永远只能得到指接, 而下拉框看着是生效的。
   * 现在把整组透传, 只覆盖 panels。 */
  var PASS_KEYS = ['fit', 'relief', 'reliefType', 'earLen', 'tenonCount', 'jointStyle', 'lapStyle',
    'dovetailAngle', 'fingerW', 'tipRadius', 'rootRadius', 'chamfer',
    'wedgeExt', 'wedgeSlotW', 'wedgeTaper', 'snapLip', 'snapBarb', 'snapSlit',
    'grooveDepth', 'dowelDia', 'dowelCount', 'biscuitWide', 'biscuitLen', 'tongueInset'];
  function passCfg(p, panels) {
    var c = { thickness: num(p.thickness, 15), fit: num(p.fit, 0.2), panels: panels };
    PASS_KEYS.forEach(function (k) { if (p[k] !== undefined) c[k] = p[k]; });
    c.relief = num(p.relief, 0);
    c.tenonCount = num(p.tenonCount, 3);
    return c;
  }

  function shelfUnit(p) {
    return build(passCfg(p, shelfPanels(p)));
  }

  /* ============================================================
   * 配方库: 一键生成常用结构的板位表
   * 每个配方 = {label, hint, fields:[参数定义], panels(p)->板位表}
   * UI 直接按 fields 渲染表单, 不需要用户理解坐标系。
   * ============================================================ */
  function frameOf(t, W, D, H) {
    return [
      { id: 'L', name: '左侧板', plane: 'YZ', at: t / 2, u0: 0, u1: D, v0: 0, v1: H, grain: 'cross' },
      { id: 'R', name: '右侧板', plane: 'YZ', at: W - t / 2, u0: 0, u1: D, v0: 0, v1: H, grain: 'cross' },
      { id: 'B', name: '底板', plane: 'XY', at: t / 2, u0: t, u1: W - t, v0: 0, v1: D, grain: 'long' },
      { id: 'T', name: '顶板', plane: 'XY', at: H - t / 2, u0: t, u1: W - t, v0: 0, v1: D, grain: 'long' }
    ];
  }

  /* 【有背板时层板必须变浅】
   *
   * 背板嵌在距后沿 t/2 处, 它与两片侧板是**角接** ——
   * 于是侧板的后沿会被挖出一排内缩让位缺口。
   * 层板若仍画成整深 D, 它与侧板的接合线就会一直延伸到那些缺口里,
   * 嵌槽/饼干槽铣到半路料已经没了 -> "铣槽越出板边"。
   *
   * 实测(nightstand t=15 / 450x400x550 / 嵌槽): 侧板上两条嵌槽铺到
   * u=394.75, 而背板的角接缺口就在 u>385 -> 每片侧板 2 条非法槽。
   * 6 板厚 × 2 尺寸 × 2 样式 = 23 组静默出废图。
   * 对比组: 同尺寸 shoerack(默认无背板) partErr=0 —— 坐实了是背板引起的。
   *
   * Models.box() 一直是这么做的(shelfDepth = D - backGap - t - setback),
   * 配方这边必须用**同一条规则**, 否则两套入口行为不一致。
   * 额外再退 2mm: 让层板不要恰恰顶在背板上(装配容错)。 */
  function innerDepth(t, D, backStyle) {
    if (backStyle !== 'tenon') return D;
    return Math.max(t * 2, D - t - 2);
  }

  var RECIPES = {
    /* --- 1) 不规则格柜(原 shelfUnit) --- */
    grid: {
      label: '不规则格柜',
      group: '柜架',
      dims: { width: 900, depth: 320, height: 900, thickness: 15 },
      hint: '一串竖隔板把柜子分成若干列，每列可以有不同的层板数。',
      fields: [
        { id: 'dividers', label: '竖隔板位置', type: 'nums', value: '300,600', unit: 'mm', hint: '从左外沿起算的 x 坐标，逗号分隔；留空 = 不分列' },
        { id: 'shelvesPerBay', label: '各列层板数', type: 'nums', value: '2,1,3', hint: '从左到右；个数不足时用最后一个值补齐' },
        { id: 'setback', label: '层板后缩', type: 'number', value: 0, step: 5, min: 0, unit: 'mm' }
      ],
      panels: function (p) { return shelfPanels(p); }
    },

    /* --- 2) 阶梯柜: 各列高度递减 --- */
    stair: {
      label: '阶梯柜 / 斜置物架',
      group: '置物架',
      dims: { width: 900, depth: 320, height: 900, thickness: 15 },
      hint: '每一列的高度依次递减，做成楼梯形，常用于楼梯下方或电视柜旁。',
      fields: [
        { id: 'bays', label: '列数', type: 'number', value: 4, min: 2, max: 10, step: 1 },
        { id: 'stepDrop', label: '每级降低', type: 'number', value: 160, step: 10, min: 40, unit: 'mm' },
        { id: 'shelvesPerBay', label: '各列层板数', type: 'nums', value: '1,1,1,1' }
      ],
      panels: function (p) {
        var t = num(p.thickness, 15);
        var W = num(p.width, 900), D = num(p.depth, 320), H = num(p.height, 900);
        var n = Math.max(2, Math.round(num(p.bays, 4)));
        var drop = num(p.stepDrop, 160);
        var spb = p.shelvesPerBay || [];
        var bw = W / n;
        var panels = [];
        panels.push({ id: 'B', name: '底板', plane: 'XY', at: t / 2, u0: 0, u1: W, v0: 0, v1: D, grain: 'long' });
        var i, k;
        for (i = 0; i <= n; i++) {
          // 第 i 块竖板的高度 = 相邻两列的较高者
          var hL = i > 0 ? H - drop * (i - 1) : -Infinity;
          var hR = i < n ? H - drop * i : -Infinity;
          var hh = Math.max(hL, hR);
          if (hh < t * 3) continue;
          var at = i === 0 ? t / 2 : (i === n ? W - t / 2 : i * bw);
          panels.push({
            id: 'V' + i, name: i === 0 ? '左侧板' : (i === n ? '右侧板' : '竖隔板' + i),
            plane: 'YZ', at: at, u0: 0, u1: D, v0: t, v1: hh, grain: 'cross'
          });
        }
        for (i = 0; i < n; i++) {
          var top = H - drop * i;
          if (top < t * 3) continue;
          var x0 = i === 0 ? t : i * bw;
          var x1 = i === n - 1 ? W - t : (i + 1) * bw;
          // 该列的顶板
          panels.push({
            id: 'T' + i, name: '第' + (i + 1) + '级顶板', plane: 'XY', at: top - t / 2,
            u0: x0, u1: x1, v0: 0, v1: D, grain: 'long'
          });
          var ns = spb[i] === undefined ? num(p.shelves, 1) : Math.max(0, Math.round(spb[i]));
          for (k = 1; k <= ns; k++) {
            panels.push({
              id: 'S' + i + '_' + k, name: '层板' + (i + 1) + '-' + k, plane: 'XY',
              at: t + (top - 2 * t) * k / (ns + 1),
              u0: x0, u1: x1, v0: 0, v1: D - num(p.setback, 0), grain: 'long'
            });
          }
        }
        return panels;
      }
    },

    /* --- 3) L 形转角柜 --- */
    corner: {
      label: 'L 形转角柜',
      group: '柜架',
      dims: { width: 900, depth: 320, height: 900, thickness: 15 },
      hint: '两段柜体在角上拼成 L 形，公共立板由两段共用，转角处不浪费。',
      fields: [
        { id: 'legX', label: 'X 向臂长', type: 'number', value: 900, step: 20, min: 200, unit: 'mm' },
        { id: 'legY', label: 'Y 向臂长', type: 'number', value: 700, step: 20, min: 200, unit: 'mm' },
        { id: 'shelves', label: '每臂层板数', type: 'number', value: 2, min: 0, max: 8, step: 1 }
      ],
      panels: function (p) {
        var t = num(p.thickness, 15);
        var D = num(p.depth, 320), H = num(p.height, 900);
        var LX = Math.max(D + 2 * t, num(p.legX, 900));
        var LY = Math.max(D + 2 * t, num(p.legY, 700));
        var ns = Math.max(0, Math.round(num(p.shelves, 2)));
        var panels = [], k;
        /* X 臂: 沿 x 展开, 深度 D 落在 y ∈ [0, D] */
        panels.push({ id: 'XL', name: 'X臂左立板', plane: 'YZ', at: t / 2, u0: 0, u1: D, v0: 0, v1: H, grain: 'cross' });
        panels.push({ id: 'XR', name: '转角公用立板', plane: 'YZ', at: LX - t / 2, u0: 0, u1: LY, v0: 0, v1: H, grain: 'cross' });
        panels.push({ id: 'XB', name: 'X臂底板', plane: 'XY', at: t / 2, u0: t, u1: LX - t, v0: 0, v1: D, grain: 'long' });
        panels.push({ id: 'XT', name: 'X臂顶板', plane: 'XY', at: H - t / 2, u0: t, u1: LX - t, v0: 0, v1: D, grain: 'long' });
        for (k = 1; k <= ns; k++) {
          panels.push({
            id: 'XS' + k, name: 'X臂层板' + k, plane: 'XY', at: t + (H - 2 * t) * k / (ns + 1),
            u0: t, u1: LX - t, v0: 0, v1: D - num(p.setback, 0), grain: 'long'
          });
        }
        /* Y 臂: 沿 y 展开, 深度落在 x ∈ [LX, LX + D] */
        panels.push({ id: 'YF', name: 'Y臂外立板', plane: 'XZ', at: D + t / 2, u0: LX, u1: LX + D, v0: 0, v1: H, grain: 'cross' });
        panels.push({ id: 'YB', name: 'Y臂端立板', plane: 'XZ', at: LY - t / 2, u0: LX, u1: LX + D, v0: 0, v1: H, grain: 'cross' });
        panels.push({ id: 'YBt', name: 'Y臂底板', plane: 'XY', at: t / 2, u0: LX, u1: LX + D, v0: D + t, v1: LY - t, grain: 'long' });
        panels.push({ id: 'YTp', name: 'Y臂顶板', plane: 'XY', at: H - t / 2, u0: LX, u1: LX + D, v0: D + t, v1: LY - t, grain: 'long' });
        for (k = 1; k <= ns; k++) {
          panels.push({
            id: 'YS' + k, name: 'Y臂层板' + k, plane: 'XY', at: t + (H - 2 * t) * k / (ns + 1),
            u0: LX, u1: LX + D, v0: D + t, v1: LY - t, grain: 'long'
          });
        }
        return panels;
      }
    },

    /* --- 4) 洞洞板挂墙组合 --- */
    pegwall: {
      label: '洞洞板挂墙组',
      group: '置物架',
      dims: { width: 900, depth: 200, height: 700, thickness: 15 },
      hint: '一块带阵列圆孔的洞洞板 + 两侧包边立板，挂墙收纳。',
      fields: [
        { id: 'pegDia', label: '孔径', type: 'number', value: 12, step: 1, min: 3, unit: 'mm' },
        { id: 'pegPitch', label: '孔距', type: 'number', value: 40, step: 5, min: 8, unit: 'mm' },
        { id: 'pegMargin', label: '孔区留边', type: 'number', value: 40, step: 5, min: 5, unit: 'mm' },
        { id: 'pegStagger', label: '错排(蜂窝)', type: 'check', value: false }
      ],
      panels: function (p) {
        var t = num(p.thickness, 15);
        var W = num(p.width, 900), D = num(p.depth, 200), H = num(p.height, 700);
        var peg = {
          dia: num(p.pegDia, 12), pitch: num(p.pegPitch, 40),
          margin: num(p.pegMargin, 40), stagger: !!p.pegStagger
        };
        return [
          { id: 'PB', name: '洞洞板', plane: 'XZ', at: D - t / 2, u0: t, u1: W - t, v0: 0, v1: H, grain: 'long', pegboard: peg, note: '阵列圆孔，配圆棒挂钩' },
          { id: 'L', name: '左包边', plane: 'YZ', at: t / 2, u0: 0, u1: D, v0: 0, v1: H, grain: 'cross' },
          { id: 'R', name: '右包边', plane: 'YZ', at: W - t / 2, u0: 0, u1: D, v0: 0, v1: H, grain: 'cross' },
          { id: 'B', name: '底托板', plane: 'XY', at: t / 2, u0: t, u1: W - t, v0: 0, v1: D - t, grain: 'long' },
          { id: 'T', name: '顶压板', plane: 'XY', at: H - t / 2, u0: t, u1: W - t, v0: 0, v1: D - t, grain: 'long' }
        ];
      }
    },

    /* --- 5) 井字酒格 --- */
    winerack: {
      label: '井字酒格',
      group: '酒格',
      dims: { width: 600, depth: 300, height: 400, thickness: 15 },
      hint: '横竖隔板互相半槽搭接，插成井字格；不需要任何五金。',
      fields: [
        { id: 'cols', label: '竖隔板数', type: 'number', value: 3, min: 1, max: 12, step: 1 },
        { id: 'rows', label: '横隔板数', type: 'number', value: 2, min: 1, max: 12, step: 1 }
      ],
      panels: function (p) {
        var t = num(p.thickness, 15);
        var W = num(p.width, 600), D = num(p.depth, 300), H = num(p.height, 400);
        var cols = Math.max(1, Math.round(num(p.cols, 3)));
        var rows = Math.max(1, Math.round(num(p.rows, 2)));
        var panels = frameOf(t, W, D, H), i;
        for (i = 1; i <= cols; i++) {
          panels.push({
            id: 'V' + i, name: '竖隔板' + i, plane: 'YZ', at: W * i / (cols + 1),
            u0: 0, u1: D, v0: t, v1: H - t, grain: 'cross'
          });
        }
        for (i = 1; i <= rows; i++) {
          panels.push({
            id: 'Hh' + i, name: '横隔板' + i, plane: 'XY', at: t + (H - 2 * t) * i / (rows + 1),
            u0: t, u1: W - t, v0: 0, v1: D, grain: 'long'
          });
        }
        return panels;
      }
    },

    /* --- 6) 开放置物架(无侧板, 靠横撑) --- */
    ladder: {
      label: '梯形置物架',
      group: '置物架',
      dims: { width: 800, depth: 300, height: 1600, thickness: 15 },
      hint: '两片侧板 + 若干层板，前后不封，层板全宽通榫，最省料。',
      fields: [
        { id: 'shelves', label: '层板数', type: 'number', value: 4, min: 1, max: 12, step: 1 },
        { id: 'setback', label: '层板后缩', type: 'number', value: 0, step: 5, min: 0, unit: 'mm' },
        { id: 'footHeight', label: '底部离地', type: 'number', value: 0, step: 10, min: 0, unit: 'mm' }
      ],
      panels: function (p) {
        var t = num(p.thickness, 15);
        var W = num(p.width, 800), D = num(p.depth, 300), H = num(p.height, 1600);
        var ns = Math.max(1, Math.round(num(p.shelves, 4)));
        var foot = num(p.footHeight, 0);
        var panels = [
          { id: 'L', name: '左侧板', plane: 'YZ', at: t / 2, u0: 0, u1: D, v0: 0, v1: H, grain: 'cross' },
          { id: 'R', name: '右侧板', plane: 'YZ', at: W - t / 2, u0: 0, u1: D, v0: 0, v1: H, grain: 'cross' }
        ];
        var lo = foot + t / 2, hi = H;
        for (var k = 0; k < ns; k++) {
          var z = ns === 1 ? (lo + hi) / 2 : lo + (hi - lo - t) * k / (ns - 1) + t / 2;
          panels.push({
            id: 'S' + k, name: k === 0 ? '底层板' : (k === ns - 1 ? '顶层板' : '层板' + k),
            plane: 'XY', at: Math.min(z, H - t / 2),
            u0: t, u1: W - t, v0: 0, v1: D - num(p.setback, 0), grain: 'long'
          });
        }
        return panels;
      }
    },

    /* ============================================================
     * 下面是原来的"家具类型"。
     *
     * 【为何用 build 而不是 panels】
     * 配方的常规做法是产出一张**板位表**, 再由 Custom.build 逐对求交、
     * 自动分配榫卐。但这五种家具里有一些结构**板位求交表达不了**:
     *   · 桌/凳的腿架是一块带镂空的异形板(不是矩形);
     *   · 抽屉盒四角是互补咬合(双方都出榫), 求交只能得出"一方出榫一方开眼";
     *   · 箱体的 dowel/biscuit 需要"盖板压侧板"的另一套下料尺寸。
     * 硬把它们改写成板位表会丢掩这些结构。所以配方多一个可选的
     * build(p) 分支: 直出 parts。两种配方在 UI 上完全同构,
     * 区别只在于 build 型能不能"转为板位表继续改"(recipeExpandable)。
     * ============================================================ */

    box: {
      label: '箱体柜 / 收纳箱',
      group: '家具',
      hint: '四面封闭的箱体，可加固定层板与通榫背板。最通用的基础结构。',
      dims: { width: 600, depth: 320, height: 720, thickness: 15 },
      fields: [
        { id: 'shelves', label: '固定层板数', type: 'number', value: 2, min: 0, max: 12, step: 1 },
        { id: 'withTop', label: '带顶板', type: 'check', value: true },
        { id: 'backStyle', label: '背板', type: 'select', value: 'tenon',
          options: [['tenon', '通榫背板'], ['none', '无背板']] },
        { id: 'backInset', label: '背板内缩', type: 'number', value: 15, step: 1, min: 0, unit: 'mm' }
      ],
      build: function (p) { return global.Models.box(p); }
    },

    bookshelf: {
      label: '书架 / 开放架',
      group: '家具',
      hint: '两片立板 + 多层层板，前后不封；层板全宽通榫，最省料。',
      dims: { width: 800, depth: 280, height: 1800, thickness: 18 },
      fields: [
        { id: 'shelves', label: '层板数', type: 'number', value: 4, min: 1, max: 12, step: 1 },
        { id: 'backStyle', label: '背板', type: 'select', value: 'none',
          options: [['none', '无背板'], ['tenon', '通榫背板']] }
      ],
      build: function (p) { return global.Models.bookshelf(p); }
    },

    drawer: {
      label: '抽屉盒',
      group: '家具',
      hint: '四面围边 + 下沉底板。四角互补咬合，抽拉方向抳得住力。',
      dims: { width: 400, depth: 300, height: 120, thickness: 12 },
      fields: [
        { id: 'bottomInset', label: '底板离下沿', type: 'number', value: 15, step: 1, min: 5, unit: 'mm' }
      ],
      build: function (p) { return global.Models.drawer(p); }
    },

    lattice: {
      label: '格架 / 酒格（半槽搭接）',
      group: '酒格',
      hint: '横竖隔板互相半槽搭接插成井字，外加一圈外框。口径用上面的「十字搭接口径」选。',
      dims: { width: 600, depth: 300, height: 400, thickness: 12 },
      fields: [
        { id: 'cols', label: '竖隔板数', type: 'number', value: 3, min: 1, max: 20, step: 1 },
        { id: 'rows', label: '横隔板数', type: 'number', value: 2, min: 1, max: 20, step: 1 }
      ],
      build: function (p) { return global.Models.lattice(p); }
    },

    table: {
      label: '桌 / 凳（腿架式）',
      group: '家具',
      hint: '台面 + 两片镂空腿架 + 横撑。腿架是异形板，不能转成板位表。',
      dims: { width: 1200, depth: 600, height: 740, thickness: 18 },
      fields: [
        { id: 'apronHeight', label: '望板高', type: 'number', value: 90, step: 5, min: 30, unit: 'mm' },
        { id: 'legWidth', label: '腿宽', type: 'number', value: 90, step: 5, min: 40, unit: 'mm' },
        { id: 'legInset', label: '腿架内缩', type: 'number', value: 80, step: 5, min: 0, unit: 'mm' },
        { id: 'railHeight', label: '横撑高', type: 'number', value: 120, step: 5, min: 40, unit: 'mm' },
        { id: 'legSetback', label: '榫内缩', type: 'number', value: 40, step: 5, min: 10, unit: 'mm' }
      ],
      build: function (p) { return global.Models.table(p); }
    },

    /* ---------- 新增的板位型配方(都能转成板位表继续改) ---------- */

    cube: {
      label: '方格书架（n×m 格）',
      group: '柜架',
      hint: '均匀的 n 列 × m 行方格，竖隔板通高、层板分段，很稳。',
      dims: { width: 900, depth: 320, height: 900, thickness: 18 },
      fields: [
        { id: 'cols', label: '列数', type: 'number', value: 3, min: 1, max: 8, step: 1 },
        { id: 'rows', label: '行数', type: 'number', value: 3, min: 1, max: 8, step: 1 }
      ],
      panels: function (p) {
        var t = num(p.thickness, 18);
        var W = num(p.width, 900), D = num(p.depth, 320), H = num(p.height, 900);
        var cols = Math.max(1, Math.round(num(p.cols, 3)));
        var rows = Math.max(1, Math.round(num(p.rows, 3)));
        var panels = frameOf(t, W, D, H), i, k;
        /* 竖隔板通高(夹在顶底板之间) */
        for (i = 1; i < cols; i++) {
          panels.push({
            id: 'V' + i, name: '竖隔板' + i, plane: 'YZ',
            at: t + (W - 2 * t) * i / cols, u0: 0, u1: D, v0: t, v1: H - t, grain: 'cross'
          });
        }
        /* 层板逐格分段: 不能画整宽 —— 那会与竖隔板互空变成搭接,
         * 而方格书架的层板应该是顶在竖隔板上的(出榫)。 */
        for (k = 1; k < rows; k++) {
          var z = t + (H - 2 * t) * k / rows;
          for (i = 0; i < cols; i++) {
            var x0 = t + (W - 2 * t) * i / cols + (i === 0 ? 0 : t / 2);
            var x1 = t + (W - 2 * t) * (i + 1) / cols - (i === cols - 1 ? 0 : t / 2);
            panels.push({
              id: 'S' + k + '_' + i, name: '层板' + k + '-' + (i + 1), plane: 'XY',
              at: z, u0: x0, u1: x1, v0: 0, v1: D, grain: 'long'
            });
          }
        }
        return panels;
      }
    },

    tvstand: {
      label: '电视柜 / 低柜',
      group: '柜架',
      hint: '宽而低，两侧带层板、中间留一个大开放格放音箱。',
      dims: { width: 1400, depth: 400, height: 450, thickness: 18 },
      fields: [
        { id: 'openRatio', label: '中间开放格占比', type: 'number', value: 40, step: 5, min: 15, max: 70, unit: '%' },
        { id: 'sideShelves', label: '两侧层板数', type: 'number', value: 1, min: 0, max: 4, step: 1 },
        { id: 'backStyle', label: '背板', type: 'select', value: 'none',
          options: [['none', '无背板'], ['tenon', '通榫背板']] }
      ],
      panels: function (p) {
        var t = num(p.thickness, 18);
        var W = num(p.width, 1400), D = num(p.depth, 400), H = num(p.height, 450);
        var ratio = G.clamp(num(p.openRatio, 40), 15, 70) / 100;
        var ns = Math.max(0, Math.round(num(p.sideShelves, 1)));
        var panels = frameOf(t, W, D, H);
        /* 两块竖隔板把中间圈出一个 openRatio 宽的开放格 */
        var inner = W - 2 * t;
        var openW = inner * ratio;
        var xL = t + (inner - openW) / 2, xR = W - t - (inner - openW) / 2;
        panels.push({ id: 'VL', name: '左竖隔板', plane: 'YZ', at: xL, u0: 0, u1: D, v0: t, v1: H - t, grain: 'cross' });
        panels.push({ id: 'VR', name: '右竖隔板', plane: 'YZ', at: xR, u0: 0, u1: D, v0: t, v1: H - t, grain: 'cross' });
        /* 两侧层板: 只占侧格, 不跨过开放格 */
        var k, i;
        var IDt = innerDepth(t, D, p.backStyle);
        for (k = 1; k <= ns; k++) {
          var z = t + (H - 2 * t) * k / (ns + 1);
          panels.push({ id: 'SL' + k, name: '左层板' + k, plane: 'XY', at: z,
            u0: t, u1: xL - t / 2, v0: 0, v1: IDt, grain: 'long' });
          panels.push({ id: 'SR' + k, name: '右层板' + k, plane: 'XY', at: z,
            u0: xR + t / 2, u1: W - t, v0: 0, v1: IDt, grain: 'long' });
        }
        if (p.backStyle === 'tenon') {
          panels.push({ id: 'BK', name: '背板', plane: 'XZ', at: D - t / 2,
            u0: t, u1: W - t, v0: t, v1: H - t, grain: 'long' });
        }
        return panels;
      }
    },

    shoerack: {
      label: '鞋架 / 多层开放架',
      group: '柜架',
      hint: '四面框 + 多层均分层板，可选背板。层高均匀，好数好装。',
      dims: { width: 800, depth: 320, height: 900, thickness: 15 },
      fields: [
        { id: 'tiers', label: '层板数', type: 'number', value: 4, min: 1, max: 12, step: 1 },
        { id: 'setback', label: '层板后缩', type: 'number', value: 0, step: 5, min: 0, unit: 'mm' },
        { id: 'backStyle', label: '背板', type: 'select', value: 'none',
          options: [['none', '无背板'], ['tenon', '通榫背板']] }
      ],
      panels: function (p) {
        var t = num(p.thickness, 15);
        var W = num(p.width, 800), D = num(p.depth, 320), H = num(p.height, 900);
        var ns = Math.max(1, Math.round(num(p.tiers, 4)));
        var sb = num(p.setback, 0);
        var panels = frameOf(t, W, D, H), k;
        /* 同理: 开了背板就得让层板变浅。默认无背板时这里不影响任何东西,
         * 但用户一把背板改成"通榫"就会中招 —— 必须提前处理。 */
        var ID = Math.min(innerDepth(t, D, p.backStyle), D - sb);
        for (k = 1; k <= ns; k++) {
          panels.push({
            id: 'S' + k, name: '层板' + k, plane: 'XY',
            at: t + (H - 2 * t) * k / (ns + 1),
            u0: t, u1: W - t, v0: 0, v1: ID, grain: 'long'
          });
        }
        if (p.backStyle === 'tenon') {
          panels.push({ id: 'BK', name: '背板', plane: 'XZ', at: D - t / 2,
            u0: t, u1: W - t, v0: t, v1: H - t, grain: 'long' });
        }
        return panels;
      }
    },

    nightstand: {
      label: '床头柜 / 小方柜',
      group: '柜架',
      hint: '小箱体 + 一层隔板 + 背板，上面留空可放抽屉（抽屉盒另选一个配方单独生成）。',
      dims: { width: 450, depth: 400, height: 550, thickness: 15 },
      fields: [
        { id: 'shelves', label: '隔板数', type: 'number', value: 1, min: 0, max: 4, step: 1 },
        { id: 'drawerH', label: '顶部抽屉位高', type: 'number', value: 140, step: 10, min: 0, unit: 'mm',
          hint: '在顶板下方预留这么高的一格放抽屉；填 0 = 不预留' },
        { id: 'backStyle', label: '背板', type: 'select', value: 'tenon',
          options: [['tenon', '通榫背板'], ['none', '无背板']] }
      ],
      panels: function (p) {
        var t = num(p.thickness, 15);
        var W = num(p.width, 450), D = num(p.depth, 400), H = num(p.height, 550);
        var ns = Math.max(0, Math.round(num(p.shelves, 1)));
        var dh = Math.max(0, num(p.drawerH, 0));
        var panels = frameOf(t, W, D, H), k;
        /* 有背板时内部水平板必须变浅, 避开背板在侧板上挖出的角接缺口 */
        var ID = innerDepth(t, D, p.backStyle);
        /* 顶板下预留抽屉位 -> 多一块分隔板。
         * 要抵住不得超过内高: 抽屉位比柜子还高就没意义了。 */
        var innerLo = t, innerHi = H - t;
        var divZ = null;
        if (dh > 0 && dh < (innerHi - innerLo) - t * 2) {
          divZ = innerHi - dh - t / 2;
          panels.push({ id: 'DV', name: '抽屉位隔板', plane: 'XY', at: divZ,
            u0: t, u1: W - t, v0: 0, v1: ID, grain: 'long' });
          innerHi = divZ - t / 2;
        }
        for (k = 1; k <= ns; k++) {
          panels.push({
            id: 'S' + k, name: '隔板' + k, plane: 'XY',
            at: innerLo + (innerHi - innerLo) * k / (ns + 1),
            u0: t, u1: W - t, v0: 0, v1: ID, grain: 'long'
          });
        }
        if (p.backStyle === 'tenon') {
          panels.push({ id: 'BK', name: '背板', plane: 'XZ', at: D - t / 2,
            u0: t, u1: W - t, v0: t, v1: H - t, grain: 'long' });
        }
        return panels;
      }
    },

    bench: {
      label: '长凳 / 坐凳（板腿式）',
      group: '家具',
      hint: '坐面 + 两片板腿 + 坐面下一道横撑。全矩形下料，比腿架式桌好切得多。',
      dims: { width: 1200, depth: 350, height: 450, thickness: 18 },
      fields: [
        { id: 'legInset', label: '腿内缩', type: 'number', value: 120, step: 10, min: 0, unit: 'mm' },
        { id: 'railHeight', label: '横撑高', type: 'number', value: 100, step: 10, min: 30, unit: 'mm' },
        { id: 'railInset', label: '横撑离坐面', type: 'number', value: 0, step: 10, min: 0, unit: 'mm' }
      ],
      panels: function (p) {
        var t = num(p.thickness, 18);
        var W = num(p.width, 1200), D = num(p.depth, 350), H = num(p.height, 450);
        /* 腿必须真的在坐面下面: 内缩太大会把两腿撞到一起。
         * 夹到最多 (W - 4t)/2, 保证两腿之间至少还有 2t 的距离。 */
        var ins = G.clamp(num(p.legInset, 120), 0, Math.max(0, (W - 4 * t) / 2));
        var rh = num(p.railHeight, 100);
        var rIns = Math.max(0, num(p.railInset, 0));
        var seatZ = H - t / 2;
        var panels = [
          { id: 'ST', name: '坐面', plane: 'XY', at: seatZ, u0: 0, u1: W, v0: 0, v1: D, grain: 'long' },
          { id: 'LL', name: '左板腿', plane: 'YZ', at: ins + t / 2, u0: 0, u1: D, v0: 0, v1: H - t, grain: 'cross' },
          { id: 'LR', name: '右板腿', plane: 'YZ', at: W - ins - t / 2, u0: 0, u1: D, v0: 0, v1: H - t, grain: 'cross' }
        ];
        /* 横撑: 顶面贴在坐面下(或再往下 rIns), 两端顶在板腿内侧。
         * 高度要夹住: 横撑比腿还高就戴到地上了。 */
        var railTop = H - t - rIns;
        var rhFit = Math.min(rh, Math.max(0, railTop - t));
        if (rhFit >= t) {
          panels.push({
            id: 'RA', name: '横撑', plane: 'XZ', at: D / 2,
            u0: ins + t, u1: W - ins - t, v0: railTop - rhFit, v1: railTop, grain: 'long'
          });
        }
        return panels;
      }
    }
  };

  /* 逗号串 -> 数字数组。UI 里 nums 字段是文本框, 但库不该依赖"调用方已经解析好":
   * JSON 导入 / 外部脚本 / 测试都可能直接塞字符串, 以前会崩在 .slice().sort() 上。 */
  function parseNums(v) {
    if (Array.isArray(v)) {
      return v.map(function (q) { return parseFloat(q); }).filter(function (q) { return isFinite(q); });
    }
    if (v === undefined || v === null || v === '') return [];
    return String(v).replace(/，/g, ',').split(/[,\s]+/)
      .map(function (q) { return parseFloat(q); })
      .filter(function (q) { return isFinite(q); });
  }
  /* 按配方的 fields 声明把参数规范化, 顺带补上缺省值 */
  function normParams(rc, p) {
    var out = {}, k;
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
    ((rc && rc.fields) || []).forEach(function (f) {
      var v = out[f.id];
      if (f.type === 'nums') out[f.id] = parseNums(v === undefined ? f.value : v);
      else if (f.type === 'check') out[f.id] = (v === undefined) ? !!f.value : !!v;
      /* select 是家具类型并入配方后新出现的字段类型(背板: 通榫/无)。
       * 不单独处理的话会掉进最后那条 num() -> 'tenon' 变 NaN->0,
       * 于是背板选项永远失效。同时校验取值合法性。 */
      else if (f.type === 'select') {
        var keys = (f.options || []).map(function (o) { return o[0]; });
        out[f.id] = (keys.indexOf(v) >= 0) ? v : f.value;
      }
      else out[f.id] = num(v, num(f.value, 0));
    });
    return out;
  }

  /* ============================================================
   * 板位 <-> 世界尺寸盒 的互转（给 UI 用的"人话"坐标）
   *
   * 内部表示 {plane, at, u0,u1, v0,v1} 对求解器最方便, 但对用户极不友好:
   * "at 是法向坐标"、"u/v 是平面内轴"要先理解坐标系才能填。
   *
   * 对外统一暴露**同一组列**, 与朝向无关:
   *   位置 = 左起 X / 前起 Y / 离地 Z   (板的最小角在世界里的坐标)
   *   尺寸 = 宽 W / 深 D / 高 H         (板的世界包围盒边长)
   * 其中恰有一个尺寸 = 板厚(由朝向决定), UI 上置灰只读。
   * 这样"离地高度""左右位移"都是字面意思, 不用换算。
   * ============================================================ */
  var THICK_AXIS = { XY: 'z', YZ: 'x', XZ: 'y' };
  var BOX_KEYS = { x: ['x', 'w'], y: ['y', 'd'], z: ['z', 'h'] };

  /* 板厚落在哪个世界轴上 */
  function thickAxis(plane) { return THICK_AXIS[plane] || 'z'; }

  /* {plane,at,u0,u1,v0,v1} -> {x,y,z,w,d,h}  (x/y/z = 最小角, w/d/h = 边长) */
  function panelBox(p, t) {
    var A = AXIS[p.plane];
    if (!A) return null;
    t = num(t, 15);
    var lo = {}, len = {};
    lo[A.n] = num(p.at, 0) - t / 2; len[A.n] = t;
    lo[A.u] = Math.min(num(p.u0, 0), num(p.u1, 0)); len[A.u] = Math.abs(num(p.u1, 0) - num(p.u0, 0));
    lo[A.v] = Math.min(num(p.v0, 0), num(p.v1, 0)); len[A.v] = Math.abs(num(p.v1, 0) - num(p.v0, 0));
    return {
      x: lo.x, y: lo.y, z: lo.z,
      w: len.x, d: len.y, h: len.z
    };
  }

  /* {x,y,z,w,d,h} + plane -> 写回 {at,u0,u1,v0,v1}
   * 厚度轴上的长度**忽略**(恒等于板厚), 只用它的起点定 at。 */
  function setPanelBox(p, box, t) {
    var A = AXIS[p.plane];
    if (!A) return p;
    t = num(t, 15);
    var lo = { x: num(box.x, 0), y: num(box.y, 0), z: num(box.z, 0) };
    var len = { x: num(box.w, 0), y: num(box.d, 0), z: num(box.h, 0) };
    p.at = lo[A.n] + t / 2;
    p.u0 = lo[A.u];
    p.u1 = lo[A.u] + Math.max(0, len[A.u]);
    p.v0 = lo[A.v];
    p.v1 = lo[A.v] + Math.max(0, len[A.v]);
    return p;
  }

  /* 改朝向时保持"世界盒"尽量不变: 先读盒, 换 plane, 再写回。
   * 直接改 plane 会让 at/u/v 的含义整个跳轴, 板会瞬移到莫名的位置。 */
  function setPanelPlane(p, plane, t) {
    if (!AXIS[plane]) return p;
    var box = panelBox(p, t);
    p.plane = plane;
    /* 新的厚度轴上, 长度要塌成板厚: 以原盒中心为准, 免得板整体偏移半个厚度 */
    var ax = thickAxis(plane);
    var kk = BOX_KEYS[ax];
    var cen = box[kk[0]] + box[kk[1]] / 2;
    box[kk[0]] = cen - num(t, 15) / 2;
    box[kk[1]] = num(t, 15);
    return setPanelBox(p, box, t);
  }

  /* 六个统一字段的元信息, UI 直接照着渲染表头/输入框 */
  var BOX_FIELDS = [
    { id: 'x', group: 'pos', label: '左起 X', hint: '板的左边缘到柜体最左的距离' },
    { id: 'y', group: 'pos', label: '前起 Y', hint: '板的前边缘到柜体最前的距离' },
    { id: 'z', group: 'pos', label: '离地 Z', hint: '板的下边缘离地高度' },
    { id: 'w', group: 'size', label: '宽 W', axis: 'x', hint: '左右方向的长度' },
    { id: 'd', group: 'size', label: '深 D', axis: 'y', hint: '前后方向的长度' },
    { id: 'h', group: 'size', label: '高 H', axis: 'z', hint: '上下方向的长度' }
  ];
  /* 该字段在当前朝向下是否= 板厚(只读) */
  function isThickField(fid, plane) {
    var ax = thickAxis(plane);
    return (fid === 'w' && ax === 'x') || (fid === 'd' && ax === 'y') || (fid === 'h' && ax === 'z');
  }

  /* ============================================================
   * 板位拖拽的"吸附对齐"引擎（三视图里拖板时用）
   *
   * 手拖鼠标永远差几毫米, 而家具的板位几乎全是"要么齐平、要么贴合、要么居中"。
   * 差 0.7mm 的层板在图上看不出来, 但求解器会认为它和侧板**不相交**, 榫卯直接丢掉。
   * 所以拖拽必须吸附, 而且吸附结果要能解释给用户("贴住了左侧板的内表面")。
   *
   * 纯函数, 不碰 DOM, 便于单测。
   * ============================================================ */

  /* 一根候选吸附线: {v: 世界坐标, kind, label} */
  function snapLinesFor(panels, moving, axis, t) {
    var out = [];
    var seen = {};
    function push(v, kind, label) {
      if (!isFinite(v)) return;
      var k = kind + '@' + Math.round(v * 100);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ v: v, kind: kind, label: label });
    }
    var boxes = [];
    panels.forEach(function (p) {
      if (moving && p.id === moving.id) return;
      var b = panelBox(p, t);
      if (b) boxes.push({ p: p, b: b });
    });
    var K = BOX_KEYS[axis];            // ['x','w'] 之类
    if (!K) return out;
    boxes.forEach(function (o) {
      var lo = o.b[K[0]], hi = lo + o.b[K[1]];
      push(lo, 'edge', o.p.name + ' 的近侧面');
      push(hi, 'edge', o.p.name + ' 的远侧面');
      push((lo + hi) / 2, 'center', o.p.name + ' 的中线');
    });
    /* 整体包围盒的两端与中线: "和柜子外沿齐平" / "整体居中" 是最常用的两个意图 */
    if (boxes.length) {
      var g0 = Infinity, g1 = -Infinity;
      boxes.forEach(function (o) {
        g0 = Math.min(g0, o.b[K[0]]);
        g1 = Math.max(g1, o.b[K[0]] + o.b[K[1]]);
      });
      push(g0, 'bounds', '整体最小端');
      push(g1, 'bounds', '整体最大端');
      push((g0 + g1) / 2, 'bounds', '整体中线');
    }
    push(0, 'origin', '原点');
    return out;
  }

  /* 把 moving 在 axis 上的位置吸附到最近的候选线。
   * 同时考虑板的三个特征位置: 近端 / 远端 / 中线 —— 任一个贴上就算吸附,
   * 这样"把层板顶到侧板内表面"和"把层板与另一块层板对中"都能一次搞定。
   *
   * 返回 {v: 吸附后的近端坐标, snapped: bool, gap: 实际移动量, line, via, label}
   */
  function snapAxis(panels, moving, axis, want, t, tol) {
    var K = BOX_KEYS[axis];
    var box = panelBox(moving, t);
    if (!K || !box) return { v: want, snapped: false };
    var len = box[K[1]];
    tol = (tol === undefined) ? 6 : tol;
    var lines = snapLinesFor(panels, moving, axis, t);
    /* 板上的三个"吸附把手": 相对近端的偏移 */
    var handles = [
      { off: 0, via: 'lo', name: '近端' },
      { off: len, via: 'hi', name: '远端' },
      { off: len / 2, via: 'mid', name: '中线' }
    ];
    /* 为什么不能"谁近谁赢": 开口 570 里放一块 569 宽的板, 拖到 x=15.7 时
     * "与整体中线对中"(差 0.2) 比 "贴住右侧板内表面"(差 0.3) 更近,
     * 于是吸到中线 —— 结果两边各留 0.5mm 缝, 求解器判定不相交, 榟卯全丢。
     * 而用户拖到那里的真实意图几乎必然是"顶到侧板"。
     * 所以给 edge(实体表面) 一个结构性优势: 按 tol 的比例给其余类别加罚分。 */
    var PEN = { edge: 0, center: 0.18, bounds: 0.28, origin: 0.35 };
    var RANK = { edge: 0, center: 1, bounds: 2, origin: 3 };
    var HORDER = { lo: 0, hi: 1, mid: 2 };
    var best = null;
    lines.forEach(function (L) {
      handles.forEach(function (H) {
        var cand = L.v - H.off;               // 让该把手落在 L 上时, 近端应在哪
        var d = Math.abs(cand - want);
        if (d > tol) return;
        var score = d + tol * PEN[L.kind];
        var rank = RANK[L.kind];
        /* 完全平手时再比 rank, 最后比把手顺序(近端>远端>中线), 保证结果确定 */
        if (!best || score < best.score - 1e-9 ||
          (Math.abs(score - best.score) < 1e-9 &&
            (rank < best.rank ||
              (rank === best.rank && HORDER[H.via] < HORDER[best.via])))) {
          best = { d: d, score: score, v: cand, line: L, via: H.via, rank: rank, hname: H.name };
        }
      });
    });
    if (!best) return { v: want, snapped: false };
    return {
      v: best.v, snapped: true, gap: best.v - want,
      line: best.line.v, kind: best.line.kind, via: best.via,
      label: '板的' + best.hname + ' 贴 ' + best.line.label
    };
  }

  /* 把一块板移动到新的世界位置(只改位置, 尺寸不变), 带吸附。
   * axes: 要动的轴, 例如 ['x','z'](正视图里拖) */
  function movePanel(panels, moving, target, axes, t, opts) {
    opts = opts || {};
    var box = panelBox(moving, t);
    if (!box) return { snaps: [] };
    var snaps = [];
    (axes || ['x', 'y', 'z']).forEach(function (ax) {
      var K = BOX_KEYS[ax];
      var want = target[K[0]];
      if (want === undefined || !isFinite(want)) return;
      var r = opts.snap === false
        ? { v: want, snapped: false }
        : snapAxis(panels, moving, ax, want, t, opts.tol);
      box[K[0]] = r.v;
      if (r.snapped) snaps.push({ axis: ax, line: r.line, kind: r.kind, via: r.via, label: r.label });
    });
    setPanelBox(moving, box, t);
    return { snaps: snaps, box: box };
  }

  /* ============================================================
   * 对齐 / 分布（多选板位时用）
   *
   * 为什么必须有: 手拖只能保证"看起来齐", 求解器要的是"数值上齐"。
   * 一排层板差 0.3mm, 图上完全看不出, 但导出的板件尺寸就是不一样,
   * 切出来装不上。对齐是把"看起来对"变成"算出来对"的唯一手段。
   * ============================================================ */
  var ALIGN_MODES = [
    { key: 'xmin', axis: 'x', at: 'min', label: '左对齐', hint: '所有选中板的左边缘对到最左' },
    { key: 'xmid', axis: 'x', at: 'mid', label: '左右居中', hint: '所有选中板在左右方向对中' },
    { key: 'xmax', axis: 'x', at: 'max', label: '右对齐', hint: '所有选中板的右边缘对到最右' },
    { key: 'ymin', axis: 'y', at: 'min', label: '前对齐', hint: '所有选中板的前边缘对到最前' },
    { key: 'ymid', axis: 'y', at: 'mid', label: '前后居中', hint: '所有选中板在前后方向对中' },
    { key: 'ymax', axis: 'y', at: 'max', label: '后对齐', hint: '所有选中板的后边缘对到最后' },
    { key: 'zmin', axis: 'z', at: 'min', label: '底对齐', hint: '所有选中板的下边缘对到最低' },
    { key: 'zmid', axis: 'z', at: 'mid', label: '上下居中', hint: '所有选中板在上下方向对中' },
    { key: 'zmax', axis: 'z', at: 'max', label: '顶对齐', hint: '所有选中板的上边缘对到最高' }
  ];
  var ALIGN_BY_KEY = {};
  ALIGN_MODES.forEach(function (m) { ALIGN_BY_KEY[m.key] = m; });

  /* 取出 ids 对应的板 + 世界盒, 按 axis 的近端升序 */
  function pickBoxes(panels, ids, axis, t) {
    var want = {};
    (ids || []).forEach(function (id) { want[id] = 1; });
    var K = BOX_KEYS[axis] || BOX_KEYS.x;
    var out = [];
    (panels || []).forEach(function (p) {
      if (!want[p.id]) return;
      var b = panelBox(p, t);
      if (!b) return;
      out.push({ p: p, b: b, lo: b[K[0]], len: b[K[1]] });
    });
    out.sort(function (a, b) { return a.lo - b.lo; });
    return out;
  }

  /* 边对齐 / 居中。返回 {mode, axis, target, moved:[{id,from,to,delta}]} */
  function alignPanels(panels, ids, modeKey, t) {
    var M = ALIGN_BY_KEY[modeKey];
    if (!M) return { moved: [], error: '未知的对齐方式 "' + modeKey + '"' };
    var K = BOX_KEYS[M.axis];
    var items = pickBoxes(panels, ids, M.axis, t);
    if (items.length < 2) return { moved: [], mode: modeKey, axis: M.axis, error: '至少选中两块板才能对齐' };
    var g0 = Infinity, g1 = -Infinity;
    items.forEach(function (o) {
      g0 = Math.min(g0, o.lo);
      g1 = Math.max(g1, o.lo + o.len);
    });
    var target = M.at === 'min' ? g0 : (M.at === 'max' ? g1 : (g0 + g1) / 2);
    var moved = [];
    items.forEach(function (o) {
      /* min: 近端贴 target;  max: 远端贴 target;  mid: 中线贴 target */
      var lo = M.at === 'min' ? target : (M.at === 'max' ? target - o.len : target - o.len / 2);
      if (Math.abs(lo - o.lo) < 1e-9) return;
      var b = o.b;
      b[K[0]] = lo;
      setPanelBox(o.p, b, t);
      moved.push({ id: o.p.id, name: o.p.name, from: o.lo, to: lo, delta: lo - o.lo });
    });
    return { moved: moved, mode: modeKey, axis: M.axis, target: target, label: M.label };
  }

  /* 等间距分布（"间隔对齐"）。
   * mode 'gap'(默认) = 相邻板之间的**净空**相等 —— 一排层板的层高一致, 这才是家具要的;
   * mode 'center'    = 板的**中线**等距 —— 打孔阵列、格栅条常用。
   * 首末两块不动(它们定义了总跨度), 中间的重排。
   * 返回 {axis, mode, gap, moved:[...]} */
  function distributePanels(panels, ids, axis, t, opts) {
    opts = opts || {};
    var K = BOX_KEYS[axis];
    if (!K) return { moved: [], error: '未知的轴 "' + axis + '"' };
    var items = pickBoxes(panels, ids, axis, t);
    if (items.length < 3) return { moved: [], axis: axis, error: '至少选中三块板才能等间距分布' };
    var mode = opts.mode === 'center' ? 'center' : 'gap';
    var n = items.length;
    var first = items[0], last = items[n - 1];
    var moved = [];
    var gap = 0;
    function place(o, lo) {
      if (Math.abs(lo - o.lo) < 1e-9) return;
      var b = o.b;
      b[K[0]] = lo;
      setPanelBox(o.p, b, t);
      moved.push({ id: o.p.id, name: o.p.name, from: o.lo, to: lo, delta: lo - o.lo });
    }
    if (mode === 'center') {
      var c0 = first.lo + first.len / 2, c1 = last.lo + last.len / 2;
      gap = (c1 - c0) / (n - 1);
      for (var i = 1; i < n - 1; i++) place(items[i], c0 + gap * i - items[i].len / 2);
    } else {
      var span = (last.lo + last.len) - first.lo;
      var sumLen = 0;
      items.forEach(function (o) { sumLen += o.len; });
      gap = (span - sumLen) / (n - 1);
      var cur = first.lo + first.len;
      for (var j = 1; j < n - 1; j++) {
        cur += gap;
        place(items[j], cur);
        cur += items[j].len;
      }
    }
    return { moved: moved, axis: axis, mode: mode, gap: gap };
  }

  /* 选中若干板的世界包围盒(给 UI 显示"选集跨度") */
  function selectionExtent(panels, ids, t) {
    var want = {};
    (ids || []).forEach(function (id) { want[id] = 1; });
    var ext = null, n = 0;
    (panels || []).forEach(function (p) {
      if (!want[p.id]) return;
      var b = panelBox(p, t);
      if (!b) return;
      n++;
      if (!ext) ext = { x: [b.x, b.x + b.w], y: [b.y, b.y + b.d], z: [b.z, b.z + b.h] };
      else {
        ext.x[0] = Math.min(ext.x[0], b.x); ext.x[1] = Math.max(ext.x[1], b.x + b.w);
        ext.y[0] = Math.min(ext.y[0], b.y); ext.y[1] = Math.max(ext.y[1], b.y + b.d);
        ext.z[0] = Math.min(ext.z[0], b.z); ext.z[1] = Math.max(ext.z[1], b.z + b.h);
      }
    });
    return n ? { count: n, ext: ext } : null;
  }

  /* 该配方能不能"转为板位表继续改"。
   * build 型配方(原家具类型)直接手工构造 Part, 不经过板位求交,
   * 而它们的异形板(腿架镂空)/互补咬合四角**板位表表达不了** ——
   * 强行展开只会得到一堆矩形, 丢掩真正的结构。UI 据此置灰那个按钮。 */
  function recipeExpandable(key) {
    var rc = RECIPES[key];
    return !!(rc && typeof rc.panels === 'function');
  }
  /* 配方自带的推荐整体尺寸(没声明就返回 null)。
   * 原来这些值在 app.js 的 DEFAULTS 里, 家具类型并入配方后必须跟着过来,
   * 否则选"桌/凳"会拿到 900x320x900 这种不像桌子的尺寸。 */
  function recipeDims(key) {
    var rc = RECIPES[key];
    return (rc && rc.dims) ? rc.dims : null;
  }

  function recipePanels(key, p) {
    var rc = RECIPES[key];
    if (!rc) return [];                       // 未知配方: 不要悄悄退化成格柜
    if (!rc.panels) return [];                // build 型配方没有板位表
    return rc.panels(normParams(rc, p || {}));
  }
  function recipeUnit(key, p) {
    p = p || {};
    var rc = RECIPES[key];
    if (!rc) {
      return {
        parts: [], info: {},
        warnings: [{ level: 'error', text: '未知的结构配方 "' + key + '"，可选：' + Object.keys(RECIPES).join(' / ') }]
      };
    }
    /* build 型: 直出 parts。参数要先过 normParams —— 家具模型里很多
     * `p.withTop !== false` 这种写法, 不补默认值的话 undefined 会被当成 true, 不可靠。 */
    if (rc.build) {
      var q = normParams(rc, p);
      var r = rc.build(q);
      r.info = r.info || {};
      r.info.recipe = key;
      r.info.recipeLabel = rc.label;
      r.info.expandable = false;
      return r;
    }
    var out = build(passCfg(p, recipePanels(key, p)));
    out.info = out.info || {};
    out.info.recipe = key;
    out.info.recipeLabel = rc.label;
    out.info.expandable = true;
    return out;
  }
  function recipeList() {
    return Object.keys(RECIPES).map(function (k) {
      return {
        key: k, label: RECIPES[k].label, hint: RECIPES[k].hint,
        fields: RECIPES[k].fields, group: RECIPES[k].group || '柜架',
        dims: RECIPES[k].dims || null,
        expandable: typeof RECIPES[k].panels === 'function'
      };
    });
  }

  /* 配方分类清单(按 RECIPES 声明顺序去重)。
   * UI 的分类筛选 chip 直接用这个 —— 而不是在 app.js 里再写一份硬编码名单,
   * 否则新增一个分类就得改两处, 很容易只改一边。 */
  function recipeGroups() {
    var seen = {}, out = [];
    Object.keys(RECIPES).forEach(function (k) {
      var g = RECIPES[k].group || '其他';
      if (!seen[g]) { seen[g] = 1; out.push(g); }
    });
    return out;
  }

  global.Custom = {
    build: build, shelfUnit: shelfUnit, shelfPanels: shelfPanels, validate: validate,
    RECIPES: RECIPES, recipePanels: recipePanels, recipeUnit: recipeUnit, recipeList: recipeList,
    recipeGroups: recipeGroups,
    normParams: normParams, parseNums: parseNums,
    panelBox: panelBox, setPanelBox: setPanelBox, setPanelPlane: setPanelPlane,
    thickAxis: thickAxis, isThickField: isThickField, BOX_FIELDS: BOX_FIELDS,
    snapLinesFor: snapLinesFor, snapAxis: snapAxis, movePanel: movePanel,
    alignPanels: alignPanels, distributePanels: distributePanels,
    selectionExtent: selectionExtent, ALIGN_MODES: ALIGN_MODES, BOX_KEYS: BOX_KEYS,
    AXIS: AXIS, toBox: toBox, intersect: intersect, toCanvas: toCanvas, touch: touch,
    recipeExpandable: recipeExpandable, recipeDims: recipeDims
  };
})(typeof window !== 'undefined' ? window : this);
