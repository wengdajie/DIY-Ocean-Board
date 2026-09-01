/* ============================================================
 * models.js - 参数化家具生成器（榫卯自动生成）
 * 依赖: geom.js, joints.js, part.js
 *
 * 核心思想
 *  - panel(w, h, edges): 按 CCW 顺序 [底, 右, 顶, 左] 一次性构造轮廓，
 *    每条边可挂一个 (u,v) профиль，v>0 = 向外凸(榫头)，v<0 = 切入(槽)
 *  - 配对件共用同一组 spans，用 phase 0/1 保证严格互补
 *  - spansFor 强制 m 为奇数 => 花纹左右对称(回文)，翻面装配也能对上
 *
 * 【meta.asm 语义】(第 6 轮统一, 与 render.boxesFrom 一一对应)
 *   asm = { plane, x, y, z }
 *   · 平面内两轴: 给的是该板**局部 2D 坐标原点 (0,0)** 在世界里的位置,
 *     也就是 panel(w,h) 那个矩形的左下角 —— 不含榫头。
 *   · 法向轴: 给的是板厚区间的**低面**(不是中心面)。
 *   于是 "装配包围盒 == 标称 W x D x H" 就是一条可断言的硬指标。
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G, J = global.J, Part = global.Part;

  /* ---------------- 面板构造器 ----------------
   * edges: {bottom, right, top, left} 每个是 [{u,v,b}] 或 null
   * 边的 u 方向: bottom +x / right +y / top -x / left -y
   */
  function panel(w, h, edges) {
    edges = edges || {};
    var corners = [
      [G.P(0, 0), G.P(w, 0), edges.bottom],
      [G.P(w, 0), G.P(w, h), edges.right],
      [G.P(w, h), G.P(0, h), edges.top],
      [G.P(0, h), G.P(0, 0), edges.left]
    ];
    var pts = [];
    corners.forEach(function (c) {
      pts.push(G.P(c[0].x, c[0].y));
      if (c[2] && c[2].length) {
        var f = G.frame(c[0], c[1]);
        f.map(c[2]).forEach(function (p) { pts.push(p); });
      }
    });
    return G.cleanLoop(pts);
  }

  function mirrorSpans(sp, L) {
    var m = { m: sp.m, seg: sp.seg, L: L === undefined ? sp.L : L, inset: sp.inset };
    var LL = m.L;
    m.tabs = sp.tabs.map(function (g) { return [LL - g[1], LL - g[0]]; }).reverse();
    m.gaps = sp.gaps.map(function (g) { return [LL - g[1], LL - g[0]]; }).reverse();
    return m;
  }
  function isPalindromic(sp) {
    var m = mirrorSpans(sp);
    return JSON.stringify(sp.tabs.map(r)) === JSON.stringify(m.tabs.map(r));
    function r(g) { return [G.round(g[0], 6), G.round(g[1], 6)]; }
  }

  /* ---------------- 通榫: 榫头 + 对应榫眼 ----------------
   * 返回 {tabProfile, mortises(f, opts)}
   */
  function throughTenon(spans, t, o) {
    return {
      prof: J.profileFor(o.style, spans, t, o),
      mortises: function (f, opts) {
        return J.mortisesFromSpans(spans, f, t, opts || o);
      }
    };
  }

  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }

  /* 让位选项(T-bone 耳长等)统一从参数里取一次, 免得每个调用点都漏传。
   * 漏传的后果很隐蔽: UI 上的"耳槽长度"看着改了, 零件却一点没变。 */
  function reliefOpts(p) {
    var o = {};
    if (p && p.earLen !== undefined) o.earLen = num(p.earLen, 2);
    return o;
  }

  /* 各边在 panel(w,h) 局部坐标里的 frame。
   * panel() 内部就是用这四个 frame 去 map profile 的, 这里必须与它**逐字一致**,
   * 否则"轮廓"和"附加特征(楔口/销孔标记)"会落在不同的地方。 */
  var EDGE_FRAME = {
    bottom: function (w, h) { return G.frame(G.P(0, 0), G.P(w, 0)); },
    right: function (w, h) { return G.frame(G.P(w, 0), G.P(w, h)); },
    top: function (w, h) { return G.frame(G.P(w, h), G.P(0, h)); },
    left: function (w, h) { return G.frame(G.P(0, h), G.P(0, 0)); }
  };
  function edgeFrame(w, h, key) { return EDGE_FRAME[key](w, h); }

  /* 接合样式的参数打包。J.profileFor / J.styleExtras 认这一组键, 每种样式各取所需。
   * 集中在一处的好处: 新增样式只要在 joints.js 注册 + 这里加一个默认值。 */
  function jointOpts(p, fit, style) {
    p = p || {};
    return {
      fit: fit,
      style: style,
      dovetailAngle: num(p.dovetailAngle, 11),
      /* round: 榫头顶部倒圆半径; fillet: 榫头根部倒圆半径(防崩) */
      tipRadius: num(p.tipRadius, 0) || undefined,
      rootRadius: num(p.rootRadius, 0) || undefined,
      /* mitre: 肩部梯形倒角量 */
      chamfer: num(p.chamfer, 0) || undefined,
      /* wedge: 通榫穿出量 / 楔口宽 / 斜度 */
      ext: num(p.wedgeExt, 0) || undefined,
      slotW: num(p.wedgeSlotW, 0) || undefined,
      taper: num(p.wedgeTaper, 0) || undefined,
      /* snap: 倒钩外伸量 / 倒钩高 / 弹性缝宽 */
      lip: num(p.snapLip, 0) || undefined,
      barb: num(p.snapBarb, 0) || undefined,
      slit: num(p.snapSlit, 0) || undefined,
      /* tongue: 嵌槽深(定深铣, 不切透) */
      grooveDepth: num(p.grooveDepth, 0) || undefined,
      /* dowel / biscuit: 五金件规格 */
      dia: num(p.dowelDia, 0) || undefined,
      count: num(p.dowelCount, 0) || undefined,
      /* biscuit: 饼干槽宽/长。这两个参数之前根本没打包进来 ——
       * 于是用户没有任何办法选"几号饼干"(#0/#10/#20 尺寸差很多),
       * 只能用 0.28t × 2.5t 这个自动值。 */
      wide: num(p.biscuitWide, 0) || undefined,
      len: num(p.biscuitLen, 0) || undefined,
      /* tongue: 停止槽两端的缩进量(影响"端面看不看到槽") */
      tongueInset: num(p.tongueInset, 0) || undefined,
      /* 多处默认值要用到板厚; 不传的话 tongueInsetOf 会拿 12 当傅底 */
      thickness: num(p.thickness, 12)
    };
  }

  /* 样式本身的可加工性提醒。
   * 这些不是"参数不合法", 而是"这样切出来能用吗" —— 必须在生成时就说,
   * 不能等用户切废了才发现。 */
  function styleWarnings(style, t, warn) {
    var st = J.STYLE_BY_KEY && J.STYLE_BY_KEY[style];
    if (!st) return;                        // 未知样式由 resolveStyle 那边统一报
    if (st.depth) {
      warn.push({
        level: 'warn',
        text: st.label + '：需要**定深铣槽**(不切透)，激光切割机做不到，' +
          '导出时槽在 POCKET 图层、料单里带下刀深度，请确认设备能控深。'
      });
    }
    if (style === 'dowel') {
      warn.push({
        level: 'warn',
        text: '木销对接：母件板面上的销孔能直接切；子件**端面**的销孔需要侧向钻孔，' +
          '图纸里画在 MARK 图层只作定位标记，实际要用木工夹具打。'
      });
    }
    if (st.grow) {
      warn.push({
        level: 'info',
        text: st.label + '：榫头会穿出母件外表面一段（' +
          (style === 'snap' ? '倒钩' : '楔头') + '），装好后想齐平就锯掉。' +
          '排样尺寸已按含穿出段计算。'
      });
    }
    if (style === 'wedge' && t < 9) {
      warn.push({ level: 'warn', text: '楔钉榫在 ' + G.round(t, 1) + 'mm 薄板上楔口太窄，容易撕裂，建议 12mm 以上' });
    }
    if (style === 'snap' && t > 18) {
      warn.push({ level: 'warn', text: '卡扣榫在 ' + G.round(t, 1) + 'mm 厚板上几乎不"弹"，倒钩会直接崩掉，建议 12mm 以下' });
    }
  }

  /* 把用户选的一种样式解析成"两个场合各自真能用的样式"。
   *
   * 为什么必须分场合: 同一件家具里同时存在两类接合 ——
   *   corner  箱体四角: 两块板**互补咬合**, 双方都出榫, 谁也没有通孔;
   *   mid     板中部:   子件端面顶在母件板面上, 母件有通榫眼可以穿过去。
   * 楔钉/卡扣要"穿出去再锁住" -> 只能用于 mid; 燕尾在 90° 处必然干涉 -> 两处都不行。
   * 旧版只有一个 style, 于是选了楔钉榫会在四角处画出无处可楔的穿出段。
   *
   * 降级一律**显式报告**(J.fallbackText 给人话原因), 绝不静默。 */
  function styleSet(p, fit, t, warn) {
    var want = (p && p.jointStyle) || 'finger';
    var rc = J.resolveStyle(want, 'corner');
    var rm = J.resolveStyle(want, 'mid');
    if (rc.fell) warn.push({ level: 'info', text: '【四角】' + J.fallbackText(rc, 'corner') });
    if (rm.fell) warn.push({ level: 'info', text: '【中部】' + J.fallbackText(rm, 'mid') });
    var seen = {};
    [rc.style, rm.style].forEach(function (k) {
      if (seen[k]) return;
      seen[k] = 1;
      styleWarnings(k, t, warn);
    });
    var oc = jointOpts(p, fit, rc.style), om = jointOpts(p, fit, rm.style);
    return {
      want: want,
      corner: oc, mid: om,
      cornerFell: rc.fell, midFell: rm.fell,
      /* 穿出量: 楔钉/卡扣的榫头会伸到公称面之外(有意为之)。
       * 报出来给测试和 UI 用 —— 详见 J.growOf 的说明。 */
      cornerGrow: J.growOf(rc.style, t, oc),
      midGrow: J.growOf(rm.style, t, om),
      /* 包围盒的**单侧**最大外扩量 = 两个场合里较大的那个。
       * 注意不能只看 cornerGrow: box 的四角会把楔钉降级成直榫(grow=0),
       * 而真正撑大包围盒的是**背板/层板**的穿出段(midGrow)。
       * 实测 box t=15 楔钉: 600 -> 627 = 600 + 2*13.5, 13.5 正是 midGrow。 */
      grow: Math.max(J.growOf(rc.style, t, oc), J.growOf(rm.style, t, om))
    };
  }

  /* 让位选项(T-bone 耳长等)统一打包一次, 免得每个调用点都漏传。
   * 漏传的后果很隐蔽: UI 上的"耳槽长度"看着改了, 零件却一点没变。 */
  function reliefOf(p) {
    return {
      r: num(p.relief, 0),
      type: p.reliefType || 'dogbone',
      opts: reliefOpts(p)
    };
  }
  function rel1(loop, rl) {
    return rl.r > 0 ? J.applyRelief(loop, rl.r, rl.type, rl.opts) : loop;
  }

  /* ---------------- 孔的让位: 必须验证"没切到板外" ----------------
   *
   * 【为什么榫眼也要让位】矩形通榫眼的四个内角, 圆刀根本够不到 ——
   * 不让位就会在每个角上留一块残料, 榫头插不到底(或者硬敲把板挤裂)。
   * custom.js 一直是对孔做让位的, models.js 的家具却漏了, 两边行为不一致。
   *
   * 【为什么必须加这道护栏】让位的过切圆是往**材料侧**长的, 而榫眼离板边
   * 往往只有十几毫米。刀一大就会把过切圆捅出板外 -> 零件自检报"孔越出板边",
   * 整张图作废。实测 box(t=15, 背板内缩 15) 配 φ40 的刀: 底板两个孔全部越界。
   *
   * applyRelief 自己只按"孔的边长"分配预算, 它看不到板边在哪 —— 那是
   * 调用方的信息。所以这里做几何验证: 让位后的孔若不再完全落在轮廓内,
   * 就退回名义尺寸并**明确告诉用户刀太大**, 而不是出一张切不了的图。 */
  function addHoleRelieved(part, loop, rl, ctx) {
    if (!(rl.r > 0)) { part.addHole(loop); return true; }
    var out = J.applyRelief(loop, rl.r, rl.type, rl.opts);
    var op = part.outer ? G.flatten(part.outer, 0.15) : null;
    if (op) {
      var hp = G.flatten(out, 0.15);
      var inside = hp.every(function (q) { return G.pointInPoly(q, op); });
      if (!inside) {
        part.addHole(loop);                       // 退回名义尺寸, 图仍然可切
        if (ctx) ctx.overflow = (ctx.overflow || 0) + 1;
        return false;
      }
    }
    part.addHole(out);
    return true;
  }
  /* 把 addHoleRelieved 攒下的越界计数汇成一条**可操作**的警告。
   * 只说"孔越出板边"没用, 用户不知道该动哪个参数 —— 必须点名是刀径。 */
  function reliefWarn(ctx, rl, warn) {
    if (!ctx || !ctx.overflow) return;
    warn.push({
      level: 'warn',
      text: '刀具直径 ' + G.round(rl.r * 2, 2) + 'mm 相对榫眼太大：有 ' + ctx.overflow +
        ' 处榫眼的内角让位会切到板外，已按名义尺寸出图（这些内角会留残料，榫头插不到底）。' +
        '请换更小的刀，或把榫眼往板内挪（加大"背板内缩"/"底板离下沿"）。'
    });
  }

  /* ---------------- 出榫件的统一构造 ----------------
   *
   * 为什么需要它: 有些接合方式**不是**靠外轮廓完成的(木销孔、饼干槽、
   * 楔口、卡扣缝), 只调 profileFor 就收工的话, 选了"木销对接"图纸上
   * 一个孔都没有 —— 那是第 8 轮真实踩到的坑。
   * 这里把"轮廓 + 该样式的附加特征"绑在一起, 任何家具都不可能再漏。
   *
   * edgeSpans: { bottom|right|top|left : spans }  spans 必须已按该边 u 方向给好(镜像已处理)
   * 返回 Part; 附带 part.meta.styleNotes(注释片段) 与 part.meta.extraParts(楔子等独立小件)
   */
  function tabPanel(name, t, w, h, edgeSpans, o, rl, ctx) {
    var eg = {}, notes = [], extras = [];
    var keys = ['bottom', 'right', 'top', 'left'];
    keys.forEach(function (k) {
      var sp = edgeSpans[k];
      if (!sp) return;
      /* 卡扣的弹性缝要往板身里割, 必须知道**垂直方向**的板宽才能夹住,
       * 否则两条对着割的缝会撞在一起 -> 外轮廓自交。 */
      var perp = (k === 'bottom' || k === 'top') ? h : w;
      var oo = Object.assign({}, o, { maxBack: perp * 0.35 });
      eg[k] = J.profileFor(o.style, sp, t, oo);
    });
    var part = new Part(name, t);
    part.setOuter(rel1(panel(w, h, eg), rl));
    part.meta.nominalSize = { w: w, h: h };
    keys.forEach(function (k) {
      var sp = edgeSpans[k];
      if (!sp) return;
      var ex = J.styleExtras(o.style, sp, edgeFrame(w, h, k), t, 'tab', o);
      ex.holes.forEach(function (l) { addHoleRelieved(part, l, rl, ctx); });
      part.addPockets(ex.pockets);
      part.addMarks(ex.marks);
      ex.notes.forEach(function (n) { if (notes.indexOf(n) < 0) notes.push(n); });
      ex.extraParts.forEach(function (q) { extras.push(q); });
    });
    part.meta.styleNotes = notes;
    if (extras.length) part.meta.extraParts = extras;
    return part;
  }

  /* ---------------- 母件一侧的统一处理 ----------------
   * f: 母件上接合线的 frame(v>0 指向子件)
   * 平对接类(木销/饼干)和舌槽类**没有榫头**, 因此不能开榫眼 ——
   * 开了就是在母件上白挖一排方孔, 强度反而更差。 */
  function midHost(part, o, spans, f, t, rl, ctx) {
    var flat = J.isFlatStyle(o.style) || o.style === 'tongue';
    if (!flat) {
      J.mortisesFromSpans(spans, f, t, o).forEach(function (l) { addHoleRelieved(part, l, rl, ctx); });
    }
    var ex = J.styleExtras(o.style, spans, f, t, 'host', o);
    ex.holes.forEach(function (l) { addHoleRelieved(part, l, rl, ctx); });
    part.addPockets(ex.pockets);
    part.addMarks(ex.marks);
    if (!part.meta.styleNotes) part.meta.styleNotes = [];
    ex.notes.forEach(function (n) {
      if (part.meta.styleNotes.indexOf(n) < 0) part.meta.styleNotes.push(n);
    });
    return part;
  }

  /* 把 part.meta.extraParts 里声明的独立小件(楔子)实例化成真 Part。
   * 楔子必须**真的出现在料单和排样里** —— 少切一片楔子, 整套接合就锁不住。
   * 同规格的合并成一个零件、用 qty 记数量, 而不是切一堆同名小件。 */
  function collectExtras(parts, t) {
    var byKey = {}, out = [];
    parts.forEach(function (p) {
      ((p.meta && p.meta.extraParts) || []).forEach(function (q) {
        var b = G.loopBBox(q.loop);
        var key = q.kind + ':' + G.round(b.w, 3) + 'x' + G.round(b.h, 3);
        if (!byKey[key]) {
          var wp = new Part(q.kind === 'wedge' ? '楔子' : q.kind, t);
          wp.setOuter(G.translate(q.loop, -b.x0, -b.y0));
          wp.qty = 0;
          wp.meta.note = '楔钉榫的楔子（敲进楔口抽紧，可反复拆装）';
          wp.meta.grain = 'long';
          wp.meta.isExtra = true;
          byKey[key] = wp;
          out.push(wp);
        }
        byKey[key].qty += (q.count || 1) * (p.qty || 1);
      });
      if (p.meta) delete p.meta.extraParts;
    });
    return out;
  }

  /* 把样式附加说明并进 meta.note, 让料单里看得到"这块板要打 6 个销孔"。 */
  function noteOf(part, base) {
    var ns = (part.meta && part.meta.styleNotes) || [];
    part.meta.note = ns.length ? (base + ' · ' + ns.join('; ')) : base;
    return part;
  }

  /* 样式的中文短名(给零件备注用)。未注册的样式直接回显 key,
   * 不许兜底成"指接" —— 那会掩盖拼错名字的问题。 */
  function labelOf(style) {
    var st = J.STYLE_BY_KEY && J.STYLE_BY_KEY[style];
    return st ? st.label : style;
  }

  /* 十字搭接的缺口轮廓: 平口 or 勾齿。
   * 勾齿的 hookDir 在配对两片上必须**相反**(见 lattice 里的说明)。 */
  function lapProf(lapStyle, uCenter, t, depth, fit, dir) {
    if (lapStyle === 'hook') {
      return J.hookLapProfile(uCenter, t, depth, { fit: fit, hookDir: dir });
    }
    return J.lapNotchProfile(uCenter, t, depth, { fit: fit });
  }

  /* 板面通榫的分格: 两端必须留边(inset)，否则榫眼会开到板边之外。
   * n 为齿数(奇数)，inset 默认取板厚与边长 6% 的较大者。 */
  function tenonSpans(L, t, n, inset) {
    if (inset === undefined) inset = Math.max(t, L * 0.06);
    inset = G.clamp(inset, t * 0.6, Math.max(t * 0.6, L / 4));
    return J.spansFor(L, { t: t, m: n || 3, phase: 0, inset: inset });
  }

  /* ============================================================
   *  1) 箱体柜 / 收纳箱
   * ============================================================ */
  function box(p) {
    var t = num(p.thickness, 12);
    var W = num(p.width, 600), D = num(p.depth, 320), H = num(p.height, 720);
    var fit = num(p.fit, 0.2);
    var rl = reliefOf(p);
    var withTop = p.withTop !== false;
    var backStyle = p.backStyle || 'tenon';   // tenon | none
    var shelves = Math.max(0, Math.round(num(p.shelves, 0)));
    var parts = [], warn = [], ctx = {};
    /* 四角与中部是两类接合, 各自解析可用样式(详见 styleSet 注释)。 */
    var ss = styleSet(p, fit, t, warn);
    var oc = ss.corner, om = ss.mid;

    if (W < 4 * t || H < 4 * t || D < 3 * t) warn.push({ level: 'error', text: '尺寸相对板厚过小' });

    var nTopBot = withTop ? 2 : 1;
    var sideDrawnH = H - nTopBot * t;         // 侧板矩形高(不含榫头)
    /* 【四角有两套完全不同的下料尺寸, 由样式决定】详见 J.needsFaceOverlap 的长注释。
     *   指接类  : 顶底板 W-2t + 榫头各伸 t 补齐; 角部立方体由双方互补填满。
     *   无榫类  : 顶底板画成整个 W(盖在最外面), 侧板夹在中间 ——
     *             侧板端面正对顶底板的**板面**, 销孔/饼干槽/嵌槽才有地方开。
     * 用错的后果不是"不好看"而是"柜子是散的": 端面对端面碰在一条棱上,
     * 平板机床根本加工不了那个接合面, 而包围盒仍是 W×D×H, 断言都抓不到。 */
    var ovl = J.needsFaceOverlap(oc.style);
    var horizDrawnW = ovl ? W : W - 2 * t;    // 顶底板矩形宽(不含榫头)
    var innerW = W - 2 * t;                   // 两块侧板内表面之间的净宽
    var hx0 = ovl ? t : 0;                    // 世界 x=t 在顶底板局部坐标里的 x

    // 角部接合: 沿深度 D 分格; 侧板取 phase0, 顶底板取 phase1
    var spCorner = J.spansFor(D, { t: t, fingerW: num(p.fingerW, 0) || undefined });
    var spSide = J.spansFor(D, { t: t, m: spCorner.m, phase: 0 });
    var spHoriz = J.spansFor(D, { t: t, m: spCorner.m, phase: 1 });
    /* overlap 模式下顶底板不出榫, 而是当"母件"接收侧板的端面接合。
     * 接合线就是侧板的中心面: 世界 x = t/2 与 W - t/2。 */
    var spCornerFull = J.spansFor(D, { t: t, m: spCorner.m, phase: 0, inset: 0 });

    // 背板接合: 沿宽/高分格(数量少一些)。背板恒为内嵌件, 用净宽而不是 horizDrawnW
    var spBackW = tenonSpans(innerW, t, 3);
    var spBackH = tenonSpans(sideDrawnH, t, 3);
    /* 背板中心距后沿。
     * 必须夹住: 背板榫眼宽 = t + fit, 以 backGapFromRear 为中心开在顶/底/侧板上,
     * 若 backInset < (t+fit)/2 榫眼就会跨出板边 -> 零件非法。
     * 真实踩到的坑: UI 里"背板内缩"默认 15mm, 用户把板厚改成 30mm 后
     * box/bookshelf 会报 8 条"孔越出板边" —— 因为 15 < 15.1。
     * 与其报错让用户自己猜, 不如夹到合法值并告知。 */
    var backNeed = (t + fit) / 2 + Math.max(1, t * 0.15);
    var backWant = num(p.backInset, t);
    var backGapFromRear = G.clamp(backWant, backNeed, Math.max(backNeed, D - backNeed));
    if (backStyle === 'tenon' && Math.abs(backGapFromRear - backWant) > 1e-6) {
      warn.push({
        level: 'warn',
        text: '背板内缩 ' + G.round(backWant, 1) + 'mm 对 ' + G.round(t, 1) +
          'mm 板太小(榫眼会开出板边), 已自动改为 ' + G.round(backGapFromRear, 1) + 'mm'
      });
    }

    // 层板通榫: 沿深度取 3 齿
    var shelfDepth = D - backGapFromRear - t - num(p.shelfSetback, 2);
    var spShelf = tenonSpans(shelfDepth, t, 3);

    /* --- 顶/底板: 画成 (W-2t) x D，左右边出榫(phase1) --- */
    function horizPanel(name, isTop) {
      var part;
      if (ovl) {
        /* 整块 W×D, 四边不出榫; 两条侧板接合线上开销孔/饼干槽/嵌槽 */
        part = tabPanel(name, t, horizDrawnW, D, {}, oc, rl, ctx);
        [t / 2, W - t / 2].forEach(function (xc) {
          midHost(part, oc, spCornerFull, G.frame(G.P(xc, 0), G.P(xc, D)), t, rl, ctx);
        });
      } else {
        /* 左边 u 沿 -y => 需镜像(奇数格为回文, 仍显式镜像以求严谨) */
        part = tabPanel(name, t, horizDrawnW, D, {
          right: spHoriz,
          left: mirrorSpans(spHoriz, D)
        }, oc, rl, ctx);
      }
      // 背板接合(横向): 沿 x 分布, 位于 y = backGapFromRear
      if (backStyle === 'tenon') {
        midHost(part, om, spBackW,
          G.frame(G.P(hx0, backGapFromRear), G.P(hx0 + innerW, backGapFromRear)), t, rl, ctx);
      }
      noteOf(part, isTop ? '顶板' : '底板');
      /* 局部原点: 指接时 x=t(左侧板内表面, 榫头自行伸到 0/W); overlap 时 x=0(整块盖住) */
      part.meta.asm = { plane: 'XY', x: ovl ? 0 : t, y: 0, z: isTop ? H - t : 0, dw: horizDrawnW, dd: D };
      part.qty = 1;
      return part;
    }

    /* --- 左右侧板: 画成 D x (H - n*t)，上下边出榫(phase0) --- */
    function sidePanel(name, which) {
      /* overlap 时侧板端面是"子件": 无榫轮廓(profileFor 返回空)但仍要出
       * 端面销孔标记/舌; spCornerFull 的 inset=0 保证它与顶底板上那条线严格对齐。 */
      var cs = ovl ? spCornerFull : spSide;
      var es = { bottom: cs };                        // u = d
      if (withTop) es.top = mirrorSpans(cs, D);       // u = -d
      var part = tabPanel(name, t, D, sideDrawnH, es, oc, rl, ctx);
      // 背板接合(竖向): 位于 x = backGapFromRear, 沿 y 分布
      if (backStyle === 'tenon') {
        midHost(part, om, spBackH, G.frame(G.P(backGapFromRear, 0), G.P(backGapFromRear, sideDrawnH)), t, rl, ctx);
      }
      // 层板接合: 均分高度
      var i;
      for (i = 1; i <= shelves; i++) {
        var yy = sideDrawnH * i / (shelves + 1);
        var x0 = backGapFromRear + t / 2 + num(p.shelfSetback, 2);
        midHost(part, om, spShelf, G.frame(G.P(x0, yy), G.P(x0 + shelfDepth, yy)), t, rl, ctx);
      }
      noteOf(part, name);
      /* 局部 (x,y) -> 世界 (y,z): 原点 y=0(后沿), z=t(底板上表面);
       * 底边榫头伸到 z=0, 顶边榫头伸到 z=H。 */
      part.meta.asm = { plane: 'YZ', x: which === 'L' ? 0 : W - t, y: 0, z: t, dd: D, dh: sideDrawnH };
      return part;
    }

    /* --- 背板: 四周出榫 --- */
    function backPanel() {
      var bw = innerW, bh = sideDrawnH;
      var part = tabPanel('背板', t, bw, bh, {
        bottom: spBackW,
        /* 无顶板时上边不能出榫: 否则 3 个榫头直接扎在空气里,
         * 既不受力也把柜子整体高度推高了一个板厚。 */
        top: withTop ? mirrorSpans(spBackW, bw) : null,
        left: mirrorSpans(spBackH, bh),
        right: spBackH
      }, om, rl, ctx);
      noteOf(part, withTop ? '背板(四边接合)' : '背板(三边接合，上边自由)');
      /* 局部 (x,y) -> 世界 (x,z): 原点 x=t, z=t; 四周榫头自行伸到 0/W/0/H */
      part.meta.asm = { plane: 'XZ', x: t, y: backGapFromRear - t / 2, z: t };
      return part;
    }

    /* --- 层板: 左右出通榫 --- */
    function shelfPanel(i) {
      var sw = W - 2 * t;
      var part = tabPanel('层板' + i, t, sw, shelfDepth, {
        right: spShelf,
        left: mirrorSpans(spShelf, shelfDepth)
      }, om, rl, ctx);
      noteOf(part, '固定层板');
      /* 层板局部 y 对应侧板局部 x, 而侧板局部 x 就是世界 y(从后沿起算),
       * 且侧板上的榫眼从 x0 起开, 所以层板的 y 原点 = x0。
       * 榫眼居中于高度 yy -> 层板中心面在 t+yy, 低面再减 t/2。 */
      var shelfY0 = backGapFromRear + t / 2 + num(p.shelfSetback, 2);
      var shelfZC = t + sideDrawnH * i / (shelves + 1);
      part.meta.asm = { plane: 'XY', x: t, y: shelfY0, z: shelfZC - t / 2 };
      return part;
    }

    parts.push(horizPanel('底板', false));
    if (withTop) parts.push(horizPanel('顶板', true));
    parts.push(sidePanel('左侧板', 'L'));
    parts.push(sidePanel('右侧板', 'R'));
    if (backStyle === 'tenon') parts.push(backPanel());
    for (var i = 1; i <= shelves; i++) parts.push(shelfPanel(i));
    /* 楔子等独立小件必须真的进料单/排样 —— 少切一片就锁不住 */
    collectExtras(parts, t).forEach(function (q) { parts.push(q); });
    reliefWarn(ctx, rl, warn);

    return {
      parts: parts,
      warnings: warn,
      info: {
        outer: [W, D, H],
        inner: [innerW, D - (backStyle === 'tenon' ? backGapFromRear + t / 2 : 0), H - nTopBot * t],
        cornerFingers: spCorner.m,
        fingerWidth: G.round(D / spCorner.m, 1),
        jointStyle: ss.want,
        cornerStyle: oc.style,
        midStyle: om.style,
        cornerBuild: ovl ? 'overlap' : 'interlock',
        /* 装配包围盒 = 标称 + 2*grow。测试据此核对, 不许为迁就穿出量放宽护栏。 */
        grow: G.round(ss.grow, 3),
        /* 【接合计数: 全库统一用 tenonJoints / lapJoints】
         * UI 统计条与测试的"有接合"断言只认这两个键。
         * 家具模型原本一个都不报 -> 家具类型并入配方后,
         * 右侧统计条会在 16 种结构里念 5 种不显示接合数。
         * 四角: 4 处; 背板: withTop 时 4 边否则 3 边; 层板: 每层 2 处。 */
        tenonJoints: 4 + (backStyle === 'tenon' ? (withTop ? 4 : 3) : 0) + shelves * 2,
        lapJoints: 0
      }
    };
  }

  /* ============================================================
   *  2) 书架（开放式，固定层板通榫）
   * ============================================================ */
  function bookshelf(p) {
    var q = Object.assign({}, p, { withTop: true, backStyle: p.backStyle || 'none' });
    q.shelves = Math.max(1, Math.round(num(p.shelves, 3)));
    var r = box(q);
    r.parts.forEach(function (pt) { if (pt.name.indexOf('层板') === 0) pt.meta.note = '固定层板'; });
    return r;
  }

  /* ============================================================
   *  3) 十字搭接格架 / 酒格 (egg-crate cross-lap)
   *     竖隔板从前沿开槽、横隔板从后沿开槽，各切 D/2，对插成网格
   * ============================================================ */
  function latticeImpl(p) {
    var t = num(p.thickness, 12);
    var W = num(p.width, 600), H = num(p.height, 400), D = num(p.depth, 300);
    var nv = Math.max(1, Math.round(num(p.cols, 3)));
    var nh = Math.max(1, Math.round(num(p.rows, 2)));
    var fit = num(p.fit, 0.2);
    var rl = reliefOf(p);
    var warn = [];
    /* 十字搭接没有榫头, 所以它**不吃** jointStyle, 而是单独一个"搭接口径"。
     * 旧版把 jointStyle 拿来当摆设: 用户选了燕尾/楔钉, 格架一点变化都没有。 */
    var lapStyle = (J.LAP_BY_KEY && J.LAP_BY_KEY[p.lapStyle]) ? p.lapStyle : 'plain';
    if (p.lapStyle && p.lapStyle !== lapStyle) {
      warn.push({ level: 'warn', text: '未知搭接方式「' + p.lapStyle + '」，已按平口半槽处理' });
    }
    if (p.jointStyle && p.jointStyle !== 'finger') {
      warn.push({
        level: 'info',
        text: '格架靠**十字半槽搭接**成型，没有榫头，所以「接合方式」在这里不起作用；' +
          '想要更强的自锁请把「搭接方式」改成勾齿半槽。'
      });
    }
    var parts = [], i, j;
    var vX = [], hY = [];
    for (i = 1; i <= nv; i++) vX.push(W * i / (nv + 1));
    for (i = 1; i <= nh; i++) hY.push(H * i / (nh + 1));

    // 竖片 (D x H): 在顶边开 nh... 不, 竖片与每根横片相交一次, 交点在 y = hY[j]
    // 竖片在每个交点开"从顶边切入"的槽不可行(多个槽会连通)。
    // 正解: 竖片在交点开槽方向朝上(切入深 H - y 太长) => 改为: 竖片开槽朝"上", 横片开槽朝"下",
    // 但每片只能被切一次 => 因此格架用 "竖片全部朝上开槽 + 横片全部朝下开槽" 且每片仅 1 个交点方向,
    // 多交点时必须交替: 这是经典 egg-crate, 做法是竖片槽朝上(深 h/2), 横片槽朝下(深 h/2), h = 片宽方向
    // 这里片的"宽度方向"是 D(深度), 所以槽深 = D/2, 开在深度方向的边上。
    var slotDepth = D / 2;
    for (i = 0; i < nv; i++) {
      // 竖片平铺: x = 沿 W? 不 —— 竖片是竖直的隔板, 平面为 (深度 D) x (高度 H)
      // 与横片相交处: 横片位于高度 hY[j], 横片是水平板, 平面 (宽 W) x (深 D)
      // 交线沿深度方向 => 槽必须开在竖片的"深度方向边"上, 长度沿深度, 位置在高度 hY[j]
      // 竖片: 在前边(x=D)? 交线沿 D, 槽应从前沿或后沿切入, 深 D/2
      var edges = { right: [] };   // right = x=D 边, u 沿 +y(高度)
      hY.forEach(function (y) {
        edges.right = edges.right.concat(lapProf(lapStyle, y, t, slotDepth, fit, +1));
      });
      var Lv = panel(D, H, edges);
      var pv = new Part('竖隔板' + (i + 1), t);
      pv.setOuter(rel1(Lv, rl));
      pv.meta.note = '槽自前沿切入 ' + G.round(slotDepth, 1) + 'mm' +
        (lapStyle === 'hook' ? '（勾齿，插到底横推锁住）' : '');
      /* vX[i] 是竖片的**中心面**, asm 要的是低面 -> 减 t/2。
       * 旧版直接传中心面, 整排竖隔板在 3D 里向右偏了半个板厚。 */
      pv.meta.asm = { plane: 'YZ', x: vX[i] - t / 2, y: 0, z: 0 };
      parts.push(pv);
    }
    for (j = 0; j < nh; j++) {
      // 横片: (宽 W) x (深 D); 与竖片交线沿深度 => 槽从后沿(y=0)切入, 深 D/2
      var edgesH = { bottom: [] };  // bottom = y=0 边, u 沿 +x(宽度)
      vX.forEach(function (x) {
        /* 【勾齿方向必须相反】配对的两片取同向 hookDir 就推不拢 ——
         * 两个勾都朝 +u 拐, 插到底后无论朝哪边推都有一个勾在挡路。 */
        edgesH.bottom = edgesH.bottom.concat(lapProf(lapStyle, x, t, slotDepth, fit, -1));
      });
      var Lh = panel(W, D, edgesH);
      var ph = new Part('横隔板' + (j + 1), t);
      ph.setOuter(rel1(Lh, rl));
      ph.meta.note = '槽自后沿切入 ' + G.round(slotDepth, 1) + 'mm' +
        (lapStyle === 'hook' ? '（勾齿，方向与竖片相反）' : '');
      ph.meta.asm = { plane: 'XY', x: 0, y: 0, z: hY[j] - t / 2 };
      parts.push(ph);
    }
    if (slotDepth < t) warn.push({ level: 'warn', text: '搭接槽深小于板厚' });
    if (lapStyle === 'hook' && slotDepth < t * 2) {
      warn.push({ level: 'warn', text: '勾齿要在槽底再拐一个口，槽深 ' + G.round(slotDepth, 1) + 'mm 太浅，勾不住' });
    }
    return {
      parts: parts,
      warnings: warn,
      info: {
        grid: nv + 'x' + nh, cell: [G.round(W / (nv + 1), 1), G.round(H / (nh + 1), 1)],
        slotDepth: slotDepth, lapStyle: lapStyle,
        /* 接合计数必须和自定义/配方走**同一组键名**(tenonJoints/lapJoints):
         * UI 的统计条、测试的"有接合"断言都只认这两个。
         * 格架全靠十字半槽搭接 -> 每个交点一处搭接, 无榫接。 */
        tenonJoints: 0,
        lapJoints: nv * nh
      }
    };
  }

  /* ============================================================
   *  4) 桌 / 凳（腿架 + 通榫 + 十字搭接横撑）
   * ============================================================ */
  function table(p) {
    var t = num(p.thickness, 18);
    var W = num(p.width, 1200), D = num(p.depth, 600), H = num(p.height, 740);
    var fit = num(p.fit, 0.2);
    var rl = reliefOf(p);
    var apron = num(p.apronHeight, 90);      // 顶部望板带高(供台面通榫)
    var legInset = num(p.legInset, 60);      // 台面边缘到腿架**外表面**的距离
    var parts = [], warn = [], ctx = {};
    var legH = H - t;                        // 减去台面厚度
    /* 桌子全是"中部接合"(腿架穿过台面、横撑穿过腿架), 没有箱体四角,
     * 所以楔钉榫/卡扣榫在这里**完全可用** —— 这正是传统榫卯做桌的方式。 */
    var ss = styleSet(p, fit, t, warn);
    var o = ss.mid;

    /* ---- 侧腿架 = 板式"条凳腿"(trestle end) ----
     * 断面是一个 I / H 形: 中间一根竖柱 + 顶部望板带 + 底部脚撑带,
     * 竖柱两侧各挖一个**内部**镂空孔。
     *
     * 为什么不是"中间挖一个大洞":
     *   1) 中间挖洞时洞的底边会与板的底边共线重合 -> 退化轮廓, 切割机会走出废件;
     *   2) 更要命的是横撑要在**深度中央**穿过腿架, 而中间挖洞正好把那块料挖掉了,
     *      横撑的榫头会插进空气里(旧版就是这个 bug, 榫眼落在洞内)。
     * 改成两侧挖空后, 深度中央始终是实料, 横撑可以真正穿过去。
     */
    var postW = num(p.legWidth, 90);                       // 竖柱宽(沿深度)
    var footH = num(p.footHeight, 0) || Math.max(t * 3, postW * 0.9);   // 底部脚撑带高
    var frameInset = num(p.frameInset, 0) || Math.max(t, D * 0.05);     // 镂空离前后沿
    var sideH = legH;
    var spTop = tenonSpans(D, t, 3, num(p.legSetback, 30));
    var railH = num(p.railHeight, 120);

    // 镂空的竖向范围
    var voidY0 = footH, voidY1 = sideH - apron;
    var voidH = voidY1 - voidY0;
    // 镂空的横向范围(竖柱两侧各一块)
    var halfGap = postW / 2;
    var voidW = (D / 2 - halfGap) - frameInset;

    function sideFrame(name, x0) {
      var part = tabPanel(name, t, D, sideH, { top: mirrorSpans(spTop, D) }, o, rl, ctx);
      if (voidW > t && voidH > t) {
        var r = Math.min(20, voidW / 3, voidH / 3);
        [frameInset, D / 2 + halfGap].forEach(function (x0) {
          part.addHole(G.ensureOrient(G.roundRect(x0, voidY0, voidW, voidH, r), false));
        });
      }
      noteOf(part, '腿架(竖柱' + G.round(postW, 0) + ' / 脚撑' + G.round(footH, 0) + ')');
      /* 腿架是立板: 厚度沿 x。台面榫眼开在 legInset+t/2 与 W-legInset-t/2
       * 两个中心面上, 所以腿架低面 = legInset / W-legInset-t。
       * 旧版一个 x 都不给, 两片腿架全叠在 x=0。 */
      part.meta.asm = { plane: 'YZ', x: x0, y: 0, z: 0 };
      return part;
    }
    parts.push(sideFrame('左腿架', legInset));
    parts.push(sideFrame('右腿架', W - legInset - t));

    // 台面: W x D, 两侧开榫眼接收腿架通榫
    var top = new Part('台面', t);
    top.setOuter(G.rect(0, 0, W, D));
    [legInset + t / 2, W - legInset - t / 2].forEach(function (x) {
      midHost(top, o, spTop, G.frame(G.P(x, 0), G.P(x, D)), t, rl, ctx);
    });
    noteOf(top, '台面');
    top.meta.asm = { plane: 'XY', x: 0, y: 0, z: H - t };
    parts.push(top);

    /* ---- 横撑: 两端通榫穿过腿架竖柱 ----
     * 肩距必须等于两块腿架**内表面**的间距 = W - 2*legInset - 2*t,
     * 旧版少减了 2t, 装配时会顶死(长 2 个板厚)。
     */
    var railLen = W - 2 * legInset - 2 * t;

    /* ============================================================
     * 【第 8 轮修的真实"静默出废图"缺陷】
     *
     * 横撑的榫眼开在腿架上, 竖向区间是 [railY0, railY0+railH]。
     * 旧版 railY0 = voidY0 + max(0, (voidH - railH)/2) —— 当 railH > voidH 时
     * max(...) 取 0, railY0 就停在 voidY0, 而**railH 一点没被约束**,
     * 于是榫眼区间可以整段捅出腿架板外。
     *
     * 更糟的是下面那条警告写着"已上下贴边", 可代码里根本没有任何贴边/夹紧动作 ——
     * 提示在骗人, 而零件自检报的是"孔越出板边", 用户完全对不上因果。
     *
     * 实测(默认望板高 90 / 脚撑自动):
     *   table 400x300x120 -> legH=105, footH=81, voidY1=15, voidH=-66,
     *   railH=120, railY0=81, 榫眼到 201 而腿架只有 105 高 -> 每片腿架 2 个废孔。
     *   t 从 9 到 25 共 6 档 x 2 组小尺寸 = 12 组参数全部静默出废图。
     *
     * 正解分两步:
     *   1) voidH <= 0 说明望板 + 脚撑已经吃满整个腿高, 结构上放不下横撑 ——
     *      这是**用户参数矛盾**, 必须报 error 并且不生成横撑(生成也是废件);
     *   2) voidH > 0 时把 railH 夹到 voidH 以内, 再居中。夹了就如实说夹到了多少。
     * ============================================================ */
    var railFit = Math.min(railH, Math.max(0, voidH));
    var railClamped = railFit < railH - 1e-9;
    var hasRail = railFit >= t * 2 && railLen > 0;
    if (voidH <= 0) {
      warn.push({
        level: 'error',
        text: '望板高 ' + G.round(apron, 1) + ' + 脚撑高 ' + G.round(footH, 1) +
          ' 已经占满整个腿高 ' + G.round(sideH, 1) + 'mm，腿架里放不下横撑，已省略横撑。' +
          '请减小"望板高"或加大整体高度 H。'
      });
    } else if (!hasRail) {
      warn.push({
        level: 'error',
        text: '腿架可用镂空高只有 ' + G.round(voidH, 1) + 'mm，装不下横撑（至少需 ' +
          G.round(t * 2, 1) + 'mm），已省略横撑。请减小"望板高"或加大整体高度 H。'
      });
    } else if (railClamped) {
      warn.push({
        level: 'warn',
        text: '横撑高 ' + G.round(railH, 1) + 'mm 超过腿架镂空高 ' + G.round(voidH, 1) +
          'mm，已收窄到 ' + G.round(railFit, 1) + 'mm（否则榫眼会开到腿架板外）'
      });
    }
    var spRail = hasRail ? tenonSpans(railFit, t, 3) : null;
    /* 横撑的竖向位置先算出来: asm 要用到(旧版先给 asm 后算 railY0,
     * 于是 asm 里干脆一个坐标都不给, 横撑在 3D 里贴地且穿到柜外) */
    var railY0 = voidY0 + Math.max(0, (voidH - railFit) / 2);
    if (hasRail) {
      var rail = tabPanel('横撑', t, railLen, railFit, {
        right: spRail,
        left: mirrorSpans(spRail, railFit)
      }, o, rl, ctx);
      noteOf(rail, '横撑(两端通榫, 肩距 ' + G.round(railLen, 1) + ')');
      /* 局部 (x,y) -> 世界 (x,z)。原点 x = 左腿架内表面(legInset+t),
       * 两端通榫各伸 t -> 整体 x 跃到 legInset .. W-legInset。
       * 厚度沿 y 穿过竖柱中心(D/2) -> 低面 D/2 - t/2。 */
      rail.meta.asm = { plane: 'XZ', x: legInset + t, y: D / 2 - t / 2, z: railY0 };
      parts.push(rail);

      // 腿架竖柱上开横撑榫眼: 竖向居中于镂空区间, 深度方向落在竖柱中心
      var rf = G.frame(G.P(D / 2, railY0), G.P(D / 2, railY0 + railFit));
      midHost(parts[0], o, spRail, rf, t, rl, ctx);
      midHost(parts[1], o, spRail, rf, t, rl, ctx);
      noteOf(parts[0], parts[0].meta.note.split(' · ')[0]);
      noteOf(parts[1], parts[1].meta.note.split(' · ')[0]);
    }
    collectExtras(parts, t).forEach(function (q) { parts.push(q); });
    reliefWarn(ctx, rl, warn);

    if (postW < t * 3) warn.push({ level: 'warn', text: '腿宽 ' + postW + ' 偏小，竖柱开榫眼后剩余料不足' });
    if (voidW <= t) warn.push({ level: 'info', text: '腿架未镂空（深度或腿宽不足）' });
    if (railLen <= 0) warn.push({ level: 'error', text: '横撑长度为负：请减小"腿架内缩"' });

    return {
      parts: parts, warnings: warn,
      info: {
        outer: [W, D, H], legH: legH, apron: apron,
        post: postW, foot: G.round(footH, 1), railShoulder: G.round(railLen, 1),
        railHeight: hasRail ? G.round(railFit, 1) : 0, voidHeight: G.round(voidH, 1),
        jointStyle: ss.want, midStyle: o.style,
        grow: G.round(ss.grow, 3),
        /* 两片腿架各穿过台面一处 = 2; 横撑两端各穿过一片腿架 = 2。
         * hasRail 为假时横撑被省略(参数矛盾), 那两处也就不存在。 */
        tenonJoints: 2 + (hasRail ? 2 : 0),
        lapJoints: 0
      }
    };
  }

  /* ============================================================
   *  5) 抽屉盒（四角燕尾/指接 + 底板通榫）
   * ============================================================ */
  function drawer(p) {
    var t = num(p.thickness, 12);
    var W = num(p.width, 400), D = num(p.depth, 300), H = num(p.height, 120);
    var fit = num(p.fit, 0.15);
    var rl = reliefOf(p);
    /* 旧版这里写死 `jointStyle === 'dovetail' ? 'dovetail' : 'finger'`,
     * 于是抽屉永远只有两种样式可选, 圆头/圆角/斜肩/楔钉全被吞掉。
     * 现在与其它家具一致走 jointOpts + profileFor。 */
    var parts = [], warn = [], ctx = {};
    var ss = styleSet(p, fit, t, warn);
    var oc = ss.corner, om = ss.mid;
    var spH = J.spansFor(H, { t: t, fingerW: num(p.fingerW, 0) || undefined });
    var sp0 = J.spansFor(H, { t: t, m: spH.m, phase: 0 });
    var sp1 = J.spansFor(H, { t: t, m: spH.m, phase: 1 });

    /* 【第 6 轮修的真实尺寸 BUG】
     * 旧版前/后板画成 (W-2t), 左/右板却画成整个 D。
     * 两边各出一个板厚的通榫 -> 抽屉实际进深 = D + 2t。
     * 抽屉是塑死在柜体里的零件, 多出 2 个板厚直接塞不进去。
     * 正解: 两对板都画成"肩距"(内部净尺), 榫头各伸 t 后刚好齐到外轮廓。 */
    var fbW = W - 2 * t;                 // 前/后板矩形宽(不含榫头)
    var lrD = D - 2 * t;                 // 左/右板矩形宽(不含榫头)
    if (fbW < 2 * t || lrD < 2 * t) {
      warn.push({ level: 'error', text: '抽屉宽/深相对板厚过小（肩距 ' + G.round(fbW, 1) + '×' + G.round(lrD, 1) + '）' });
    }

    /* 底板中心距下沿。必须 >= (t+fit)/2 + 余量, 否则四周板上的底板榫眼
     * 会跮出板下沿(零件非法)。UI 默认 15mm, 但用户把板厚改到 25 就破了。 */
    var botNeed = (t + fit) / 2 + Math.max(1, t * 0.15);
    var botWant = num(p.bottomInset, t);
    var botIn = G.clamp(botWant, botNeed, Math.max(botNeed, H - botNeed));
    if (Math.abs(botIn - botWant) > 1e-6) {
      warn.push({
        level: 'warn',
        text: '底板离下沿 ' + G.round(botWant, 1) + 'mm 对 ' + G.round(t, 1) +
          'mm 板太小(榫眼会开出板边), 已自动改为 ' + G.round(botIn, 1) + 'mm'
      });
    }
    var spBotW = tenonSpans(fbW, t, 3);
    var spBotD = tenonSpans(lrD, t, 3);

    /* --- 前/后板: fbW x H, 左右出榫 phase1 --- */
    function fb(name, isFront) {
      var pt = tabPanel(name, t, fbW, H, {
        right: sp1,
        left: mirrorSpans(sp1, H)
      }, oc, rl, ctx);
      midHost(pt, om, spBotW, G.frame(G.P(0, botIn), G.P(fbW, botIn)), t, rl, ctx);
      noteOf(pt, name + '(两侧' + labelOf(oc.style) + ' + 底板' + labelOf(om.style) + ')');
      /* 局部 (x,y) -> 世界 (x,z); 原点 x=t(左板内表面), z=0。
       * 前板在 y=D-t, 后板在 y=0。 */
      pt.meta.asm = { plane: 'XZ', x: t, y: isFront ? D - t : 0, z: 0 };
      return pt;
    }
    /* --- 左/右板: lrD x H, 前后出榫 phase0(与 phase1 互补, 四角交错咬合) --- */
    function lr(name, isRight) {
      var pt = tabPanel(name, t, lrD, H, {
        right: sp0,
        left: mirrorSpans(sp0, H)
      }, oc, rl, ctx);
      midHost(pt, om, spBotD, G.frame(G.P(0, botIn), G.P(lrD, botIn)), t, rl, ctx);
      noteOf(pt, name + '(前后' + labelOf(oc.style) + ' + 底板' + labelOf(om.style) + ')');
      /* 局部 (x,y) -> 世界 (y,z); 原点 y=t(后板内表面), z=0 */
      pt.meta.asm = { plane: 'YZ', x: isRight ? W - t : 0, y: t, z: 0 };
      return pt;
    }
    parts.push(fb('抽屉前板', true));
    parts.push(fb('抽屉后板', false));
    parts.push(lr('抽屉左板', false));
    parts.push(lr('抽屉右板', true));

    // 底板: 四边通榫, 矩形 = 四周板的内净尺
    var bot = tabPanel('抽屉底板', t, fbW, lrD, {
      bottom: spBotW,
      top: mirrorSpans(spBotW, fbW),
      right: spBotD,
      left: mirrorSpans(spBotD, lrD)
    }, om, rl, ctx);
    noteOf(bot, '底板(四边' + labelOf(om.style) + ')');
    /* 局部 (x,y) -> 世界 (x,y); 原点 (t, t); 中心面 z=botIn -> 低面 botIn-t/2 */
    bot.meta.asm = { plane: 'XY', x: t, y: t, z: botIn - t / 2 };
    parts.push(bot);
    collectExtras(parts, t).forEach(function (q) { parts.push(q); });
    reliefWarn(ctx, rl, warn);

    return {
      parts: parts, warnings: warn,
      info: {
        outer: [W, D, H], fingers: spH.m,
        shoulder: [G.round(fbW, 1), G.round(lrD, 1)],
        bottomInset: G.round(botIn, 1),
        jointStyle: ss.want, cornerStyle: oc.style, midStyle: om.style,
        grow: G.round(ss.grow, 3),
        /* 四角互补咬合 4 处 + 底板四边各一处 4 处 */
        tenonJoints: 8,
        lapJoints: 0
      }
    };
  }

  global.Models = {
    panel: panel,
    mirrorSpans: mirrorSpans,
    isPalindromic: isPalindromic,
    throughTenon: throughTenon,
    tenonSpans: tenonSpans,
    box: box,
    bookshelf: bookshelf,
    lattice: latticeImpl,
    table: table,
    tenonSpans: tenonSpans,
    drawer: drawer,
    /* 接合层的公共 helper。custom.js 必须用**同一套**,
     * 否则"家具模型支持 11 种样式而自定义永远只有指接"。 */
    jointOpts: jointOpts, styleSet: styleSet, styleWarnings: styleWarnings,
    labelOf: labelOf, lapProf: lapProf, edgeFrame: edgeFrame,
    tabPanel: tabPanel, midHost: midHost, collectExtras: collectExtras,
    addHoleRelieved: addHoleRelieved, reliefOf: reliefOf, reliefWarn: reliefWarn, rel1: rel1
  };
})(typeof window !== 'undefined' ? window : this);
