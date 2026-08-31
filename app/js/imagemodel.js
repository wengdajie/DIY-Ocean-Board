/* ============================================================
 * imagemodel.js - 图片 -> 可加工的榫卯零件
 *
 * 两种模式:
 *   1) silhouette  轮廓件：把图形直接做成板件（可选自动加底部榫头 + 配套底座）
 *   2) layers      等高分层：把图形按高度切成 N 层叠层件（浮雕/地形/LOGO 立体字）
 *
 * 关键点: 所有"加榫头 / 开槽"都在**位图掩膜**上完成，之后再统一追踪。
 * 这样不需要多边形布尔运算，拓扑变化(开槽把一件切成两半)由追踪器自然处理。
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G, J = global.J, Trace = global.Trace, Part = global.Part;

  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }

  /* 计算 像素->mm 的比例: 让图形的目标尺寸达到 targetW / targetH */
  function scaleFor(bb, opts) {
    var tw = num(opts.targetWidth, 0), th = num(opts.targetHeight, 0);
    if (tw > 0 && th > 0) return Math.min(tw / bb.w, th / bb.h);   // 等比,取小
    if (tw > 0) return tw / bb.w;
    if (th > 0) return th / bb.h;
    return 1;
  }

  /* ============================================================
   * 模式 1: 轮廓件
   *  - 描摹图形 -> 板件
   *  - standStyle='tenon': 底部自动生成榫头, 并配一块带榫眼的底座
   * ============================================================ */
  function silhouette(img, p) {
    p = p || {};
    var t = num(p.thickness, 12);
    var fit = num(p.fit, 0.2);
    var relief = num(p.relief, 0), rtype = p.reliefType || 'none';
    var ropts = (p && p.earLen !== undefined) ? { earLen: num(p.earLen, 2) } : {};
    var simplify = num(p.simplify, 1.2);

    // 1) 二值化 + 去噪
    var m0 = Trace.maskFrom(img, {
      threshold: (p.autoThreshold === false ? num(p.threshold, 128) : -1),
      invert: !!p.invert,
      alphaOnly: !!p.alphaOnly
    });
    var usedT = m0.threshold;
    var px = Trace.maskArea(m0);
    if (!px) return { parts: [], warnings: [{ level: 'error', text: '未识别到图形：请调整阈值或勾选"反相"' }], mask: m0, maskBBox: null, info: { threshold: usedT } };

    var bbPx = Trace.maskBBox(m0);
    var despMin = Math.max(4, Math.round(bbPx.w * bbPx.h * num(p.despeckle, 0.0004)));
    Trace.despeckle(m0, despMin, despMin);
    if (!Trace.maskArea(m0)) return { parts: [], warnings: [{ level: 'error', text: '去噪后图形为空：请降低去噪强度' }], mask: m0, maskBBox: null, info: { threshold: usedT } };
    bbPx = Trace.maskBBox(m0);

    /* 预览掩膜: 取"加榫头之前"的快照。加榫头会 padMask 放大画布, 尺寸就与源图
     * 不一致了, 叠加预览会错位。 */
    var previewMask = { mask: m0.mask.slice(0), w: m0.w, h: m0.h, threshold: m0.threshold };
    var previewBBox = { x0: bbPx.x0, y0: bbPx.y0, x1: bbPx.x1, y1: bbPx.y1, w: bbPx.w, h: bbPx.h };

    // 2) 比例
    var sc = scaleFor(bbPx, p);
    var warn = [];
    var mmW = bbPx.w * sc, mmH = bbPx.h * sc;

    // 3) 底部榫头（在掩膜上加料）
    var tenonSpansPx = [], baseInfo = null;
    var standStyle = p.standStyle || 'none';
    if (standStyle === 'tenon') {
      var tenonLenPx = Math.max(1, Math.round(t / sc));           // 榫长 = 底座板厚
      var pad = tenonLenPx + 4;
      m0 = Trace.padMask(m0, pad);
      bbPx = Trace.maskBBox(m0);
      var bs = Trace.bottomSpans(m0, Math.max(1, Math.round(2 / sc)));
      var minTenonPx = Math.max(2, Math.round(num(p.tenonWidth, 40) / sc));
      var chosen = [];
      bs.spans.forEach(function (sp) {
        var w = sp[1] - sp[0];
        if (w < Math.max(2, Math.round(8 / sc))) return;          // 太窄的着地点跳过
        var cx = (sp[0] + sp[1]) / 2;
        var half = Math.min(w * 0.45, minTenonPx / 2);
        chosen.push([cx - half, cx + half]);
      });
      if (!chosen.length && bs.spans.length) {
        var sp0 = bs.spans[0], c0 = (sp0[0] + sp0[1]) / 2;
        chosen.push([c0 - minTenonPx / 2, c0 + minTenonPx / 2]);
      }
      chosen.forEach(function (c) {
        Trace.paintRect(m0, c[0], bs.baseY, c[1], bs.baseY + tenonLenPx, 1);
      });
      tenonSpansPx = chosen;
      baseInfo = { baseY: bs.baseY, tenonLenPx: tenonLenPx, spans: chosen };
      if (!chosen.length) warn.push({ level: 'warn', text: '未找到合适的着地面，未能生成榫头' });
    }

    // 4) 追踪 + 简化 + 转 mm
    var smooth = p.smooth !== false;
    var loops = Trace.traceMask(m0).map(function (l) {
      return Trace.refineLoop(l, Math.max(0, simplify / sc), smooth);
    });
    var shapes = Trace.loopsToShapes(loops, {
      scale: sc, imgH: m0.h,
      minAreaMM: num(p.minPartArea, 25)
    });
    if (!shapes.length) return { parts: [], warnings: [{ level: 'error', text: '未能提取轮廓，可放大目标尺寸或调低"最小零件面积"' }], mask: previewMask, maskBBox: previewBBox, info: { threshold: usedT } };

    var maxParts = Math.max(1, Math.round(num(p.maxParts, 8)));
    if (shapes.length > maxParts) {
      warn.push({ level: 'info', text: '识别到 ' + shapes.length + ' 个独立图形，只保留最大的 ' + maxParts + ' 个' });
      shapes = shapes.slice(0, maxParts);
    }

    var parts = [];
    shapes.forEach(function (sh, i) {
      var pt = new Part(shapes.length > 1 ? ('轮廓件' + (i + 1)) : '轮廓件', t);
      pt.setOuter(relief > 0 ? J.applyRelief(sh.outer, relief, rtype, ropts) : sh.outer);
      sh.holes.forEach(function (h) {
        pt.addHole(relief > 0 ? J.applyRelief(h, relief, rtype, ropts) : h);
      });
      pt.meta.note = '图片描摹';
      /* 立牌: 竖着立在 XZ 面。asm 给的是**局部原点**在世界里的位置,
       * 这里给 0 => 保留描摹出来的相对位置(多个图形不会堆到一起)。 */
      pt.meta.asm = { plane: 'XZ', x: 0, y: 0, z: 0 };
      parts.push(pt);
    });

    // 5) 底座（带榫眼）
    if (standStyle === 'tenon' && tenonSpansPx.length) {
      var main = parts[0];
      var mb = main.bbox();
      var baseW = mmW + num(p.baseMargin, 40) * 2;
      var baseD = num(p.baseDepth, 0) || Math.max(60, mmH * 0.28);
      var base = new Part('底座', t);
      base.setOuter(G.roundRect(0, 0, baseW, baseD, Math.min(num(p.baseRadius, 8), baseD / 2)));
      // 榫眼: x 由榫头像素位置换算; 沿底座深度居中
      var offX = (baseW - mmW) / 2;
      tenonSpansPx.forEach(function (c) {
        var x0 = (c[0] - bbPx.x0) * sc + offX;
        var x1 = (c[1] - bbPx.x0) * sc + offX;
        var w = (x1 - x0) + fit;
        var cx = (x0 + x1) / 2;
        var loop = G.rectC(cx, baseD / 2, w, t + fit);
        base.addHole(G.ensureOrient(relief > 0 ? J.applyRelief(loop, relief, rtype, ropts) : loop, false));
      });
      base.meta.note = '底座(带榫眼)';
      base.meta.asm = { plane: 'XY', x: 0, y: 0, z: 0 };
      /* 立牌本体: x 居中于底座, y 在底座深度中央(低面 = baseD/2 - t/2),
       * z 底面与底座底面齐(榫头没入底座)。
       * 描摹出来的轮廓 bbox 并不从 (0,0) 开始, 而 asm 语义是"局部原点位置",
       * 所以要把 bbox 偏移反扣回去, 否则本体在 3D 里会飘到底座外。 */
      var mb2 = main.bbox();
      main.meta.asm = { plane: 'XZ', x: offX - mb2.x0, y: baseD / 2 - t / 2, z: -mb2.y0 };
      parts.push(base);
    }

    return {
      parts: parts,
      warnings: warn,
      mask: previewMask, maskBBox: previewBBox,   // 供 UI 预览"看见阈值切出了什么"
      info: {
        mode: '轮廓件',
        threshold: usedT,
        pxPerMM: G.round(1 / sc, 3),
        size: [G.round(mmW, 1), G.round(mmH, 1)],
        shapes: shapes.length,
        tenons: tenonSpansPx.length,
        nodes: parts.reduce(function (a, q) { return a + q.outer.length + q.holes.reduce(function (b, h) { return b + h.length; }, 0); }, 0)
      }
    };
  }

  /* ============================================================
   * 模式 2: 等高分层（浮雕 / 地形 / 立体 LOGO）
   *  按灰度把图分成 N 个等级，第 k 层 = 灰度 <= 阈值_k 的区域，
   *  层层叠加即形成台阶式立体。每层加对位销孔。
   * ============================================================ */
  /* 等面积直方图分位 (用于分层阈值)
   *
   * 为何不能直接把 [lo,hi] 等分:
   *   图的灰度很少是均匀分布的。台阶图/量化图里灰度成簇堆在几个值上,
   *   等分阈值会有好几条落在同一个空隙里 → 相邻几层切出**完全一样**的轮廓。
   *   实测(台阶图 N=5): 面积 31481>10498>10216>10033>2084 —— 中间三层几乎相同,
   *   用户花三张料切出三块一模一样的板, 叠起来看不到台阶。
   *
   * 做法: 按累积直方图取分位数(等面积), 让**每层新增的平面面积大致相等**,
   * 这才是“台阶均匀”的真正含义。再用 dedupe 兼顾极端量化图(灰度种类 < 层数)。
   */
  /* 逐层阈值选取
   *
   * 目标: 每层切出来的轮廓必须**真的不一样**, 且面积递减尽量均匀。
   *
   * 为何不能等分灰度区间 [lo,hi]:
   *   灰度很少均匀分布。量化图/台阶图里灰度成簇堆在几个值上,
   *   等分阈值会有好几条落在同一个空隙里 → 相邻几层轮廓完全重合。
   *   实测(四同心圆台阶图 N=5): 面积 31481>10498>10216>10033>2084,
   *   中间三层几乎一模一样 —— 用户白白切三张重复的板。
   *
   * 也不能简单按累积直方图等面积分位:
   *   量化图里“等面积分位”的好几个分位点会落在同一个灰度平台上,
   *   反而把 4 个真台阶压成 2 层(实测台阶图只剩 2 层)。
   *
   * 正确做法: 先把累积直方图压成“面积台阶”(一个台阶 = 一种可达成的轮廓),
   * 再在这些台阶里挑 N 个面积最接近等分目标的。台阶不够 N 个就只出那么多层,
   * 并由调用方提示用户 —— 总比默默切出一摸一样的重复板好。
   * 取每个台阶的**最大**阈值, 自然避开抗锯齿过渡带。
   */
  function layerThresholds(gray, mask, invert, N) {
    var hist = new Float64Array(256), total = 0, i;
    for (i = 0; i < gray.length; i++) {
      if (!mask[i]) continue;
      var v = invert ? 255 - gray[i] : gray[i];
      hist[v]++; total++;
    }
    if (!total) return null;
    // 面积台阶: 相邻累积面积差 < 0.4% 视为同一台阶(抗锯齿边缘归入台阶)
    var steps = [], acc = 0;
    for (i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc <= 0) continue;
      var last = steps.length ? steps[steps.length - 1] : null;
      if (last && acc - last.area <= total * 0.004) { last.v = i; last.area = acc; }
      else steps.push({ v: i, area: acc });
    }
    if (!steps.length) return null;
    var full = steps[steps.length - 1].area;
    var out = [], used = {};
    for (var k = 0; k < N; k++) {
      var target = full * (N - k) / N;
      var best = -1, bestD = Infinity;
      for (var j = 0; j < steps.length; j++) {
        if (used[j]) continue;
        var dd = Math.abs(steps[j].area - target);
        if (dd < bestD) { bestD = dd; best = j; }
      }
      if (best < 0) break;
      used[best] = 1;
      out.push(steps[best]);
    }
    out.sort(function (a, b) { return b.area - a.area; });   // 底层面积最大
    return out.map(function (o) { return o.v; });
  }
  function layers(img, p) {
    p = p || {};
    var t = num(p.thickness, 9);
    var N = Math.max(2, Math.min(12, Math.round(num(p.layerCount, 4))));
    var simplify = num(p.simplify, 1.2);
    var invert = !!p.invert;

    var gray = Trace.grayFrom(img);
    var w = img.width, h = img.height;

    /* 底层轮廓(“哪些像素算图形”)。
     *
     * 旧版用 Otsu 二值化当主体掩膜 —— 这在分层模式下是错的:
     * Otsu 把图分成“前景/背景”两类, 于是浅灰的最外层会被当成背景扔掉。
     * 实测台阶图(4 个同心圆, 最外圈 #d0d0d0/gray208): Otsu 阈值 176,
     * 主体掩膜 bbox 只有 140×140 而不是 200×200 —— **整个最底层丢了**,
     * 用户看到的模型比图小了一圈。
     *
     * 正确的语义: 分层模式下“图形”= 除了纯背景以外的一切。
     * 默认用一个宽松的背景阈值(bgCut, 默认 250)把白底去掉就好;
     * 仍然允许用户手动指定阈值或只用透明通道。 */
    var base;
    if (p.alphaOnly) {
      base = Trace.maskFrom(img, { threshold: -1, invert: invert, alphaOnly: true });
    } else if (p.autoThreshold === false && p.threshold !== undefined && p.threshold !== null) {
      base = Trace.maskFrom(img, { threshold: num(p.threshold, 128), invert: invert });
    } else {
      var bgCut = num(p.bgCut, 250);
      base = { mask: new Uint8Array(w * h), w: w, h: h };
      for (var bi = 0; bi < gray.length; bi++) {
        var bv = invert ? 255 - gray[bi] : gray[bi];
        base.mask[bi] = bv <= bgCut ? 1 : 0;
      }
    }
    var bbPx = Trace.maskBBox(base);
    if (!bbPx) return { parts: [], warnings: [{ level: 'error', text: '未识别到图形' }], mask: base, maskBBox: null, info: {} };
    var despMin = Math.max(4, Math.round(bbPx.w * bbPx.h * num(p.despeckle, 0.0004)));
    var sc = scaleFor(bbPx, p);

    // 主体内的灰度范围
    var lo = 255, hi = 0;
    for (var i = 0; i < gray.length; i++) {
      if (!base.mask[i]) continue;
      var v = invert ? 255 - gray[i] : gray[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi <= lo) { hi = lo + 1; }

    /* 阈值序列: 底层最宽松 -> 顶层最严格。
     * 默认等面积分位; layerMode==='even' 则回到等灰度间隔。 */
    /* 阈值序列: 总是恰好 N 条(底层最宽松 -> 顶层最严格)。
     *
     * 为何必须凑足 N 条而不是"去重后少几层":
     *   纯剑影图(只有黑白两种灰度)选分层模式时, 用户的意图就是
     *   **叠厚度**(N 层 × 板厚 = 总高), 此时各层形状相同是正确的;
     *   而且 totalHeight = N × t 是 UI 对外的承诺, 不能静静少几层。
     * 所以真正要修的不是"层数", 而是"在可达成的台阶里尽量多切出不同轮廓"。
     *
     * 做法: 先拿到可达成的不同台阶(steps), 再把 N 层**尽量均匀地摊**到
     * 这些台阶上。台阶够多 => 层层不同(真浮雕); 台阶不够 => 多层共用
     * 同一轮廓(叠厚度), 并在 info/warn 里说清楚"其中几层只是厚度"。 */
    var ths, distinct;
    if (p.layerMode === 'even') {
      ths = [];
      for (var e = 0; e < N; e++) ths.push(lo + (hi - lo) * ((N - e) / N));
      distinct = N;
    } else {
      var steps = layerThresholds(gray, base.mask, invert, N);
      if (!steps || !steps.length) {
        ths = [];
        for (var e2 = 0; e2 < N; e2++) ths.push(lo + (hi - lo) * ((N - e2) / N));
        distinct = N;
      } else {
        distinct = Math.min(N, steps.length);
        ths = [];
        /* 把 N 个层位均匀映射到 distinct 个台阶:
         * 例如 N=6 / distinct=2 -> 底三层用台阶1、上三层用台阶2。 */
        for (var k2 = 0; k2 < N; k2++) {
          var si2 = Math.floor(k2 * distinct / N);
          ths.push(steps[Math.min(distinct - 1, si2)]);
        }
      }
    }
    var askedN = N;

    var parts = [], warn = [], counts = [], dupSkipped = 0;
    var prevArea = -1, prevMaskArea = -1;
    /* 第 k 层(k=0 为最底层): 阈值从"最宽松"递减到"最严格"，
     * 于是底层 = 整个轮廓、越往上面积越小，叠起来才是正的台阶金字塔。 */
    for (var k = 0; k < N; k++) {
      var th = ths[k];
      if (th === undefined) continue;
      var mk = { mask: new Uint8Array(w * h), w: w, h: h };
      for (var j = 0; j < gray.length; j++) {
        if (!base.mask[j]) continue;
        var g2 = invert ? 255 - gray[j] : gray[j];
        // 灰度越小(越深)越"高" => 第 k 层保留 g <= th 的部分
        mk.mask[j] = (g2 <= th) ? 1 : 0;
      }
      Trace.despeckle(mk, despMin, despMin);
      var mArea = Trace.maskArea(mk);
      if (!mArea) { counts.push(0); continue; }
      /* 与上一层轮廓相同的层仍然要出(它是"厚度"), 只是记下数量
       * 用于提示; 早期版本在这里直接 continue 丢层, 会把纯剑影图的
       * "叠厚度"用法弄坏(3 层只出 1 层, 总高不对)。 */
      if (prevMaskArea > 0 && Math.abs(mArea - prevMaskArea) <= prevMaskArea * 0.02) dupSkipped++;
      var loops = Trace.traceMask(mk).map(function (l) {
        return Trace.refineLoop(l, Math.max(0, simplify / sc), p.smooth !== false);
      });
      var shapes = Trace.loopsToShapes(loops, { scale: sc, imgH: h, minAreaMM: num(p.minPartArea, 25) });
      if (!shapes.length) { counts.push(0); continue; }
      // 每层只取最大的若干块
      var keep = Math.max(1, Math.round(num(p.maxPerLayer, 4)));
      if (shapes.length > keep) shapes = shapes.slice(0, keep);
      counts.push(shapes.length);
      prevMaskArea = mArea;
      shapes.forEach(function (sh, si) {
        var pt = new Part('L' + (k + 1) + (shapes.length > 1 ? ('-' + (si + 1)) : ''), t);
        pt.setOuter(sh.outer);
        sh.holes.forEach(function (hh) { pt.addHole(hh); });
        pt.meta.srcLayer = k;
        pt.meta.shapeIdx = si;
        pt.meta.shapeCount = shapes.length;
        parts.push(pt);
      });
    }
    if (!parts.length) return { parts: [], warnings: [{ level: 'error', text: '分层后无有效零件，请减少层数或降低去噪' }], mask: base, maskBBox: bbPx, info: {} };

    /* 重排层序: 去重跳掉的层不能在名字/高度上留空洞,
     * 否则出现“第1层、第3层”而中间没板, 叠起来悬空一层。 */
    var order = [], seen = {};
    parts.forEach(function (pt) {
      if (!(pt.meta.srcLayer in seen)) { seen[pt.meta.srcLayer] = order.length; order.push(pt.meta.srcLayer); }
    });
    var realN = order.length;
    parts.forEach(function (pt) {
      var li = seen[pt.meta.srcLayer];
      pt.name = '第' + (li + 1) + '层' + (pt.meta.shapeCount > 1 ? ('-' + (pt.meta.shapeIdx + 1)) : '');
      pt.meta.note = '叠层 #' + (li + 1) + '（自下往上第 ' + (li + 1) + ' 层）';
      /* 分层件全部描自同一张图, 保留各自的 bbox 偏移才能层间对位;
       * 旧版强制 x/y=0, 于是面积不同的层在 3D 里全靠左下角, 堆成阶梓而非金字塔。 */
      pt.meta.asm = { plane: 'XY', x: 0, y: 0, z: li * t };
      delete pt.meta.shapeIdx; delete pt.meta.shapeCount;
    });
    /* 说实话: 哪几层是真台阶、哪几层只是厚度。
     * 不说的话用户会以为自己白切了几张重复的板。 */
    if (distinct < askedN) {
      warn.push({
        level: 'info',
        text: '图的灰度层次只够切出 ' + distinct + ' 种不同轮廓，剩下的层与相邻层同形（用来叠厚度）。' +
          '想要层层不同的浮雕效果，请换灰度过渡更丰富的图，或把层数降到 ' + distinct + '。'
      });
    }

    // 对位销孔: 在所有层的公共区域内打 2 个孔
    var pinD = num(p.pinDia, 0);
    if (pinD > 0) {
      /* 销孔必须落在**所有层**的材料内部。最小的那一层(面积最小)是限制条件，
       * 因此在它的内部撒候选点, 再逐层验证。 */
      var smallest = parts.reduce(function (a, b) {
        return Math.abs(b.area()) < Math.abs(a.area()) ? b : a;
      }, parts[0]);
      var sb = smallest.bbox();
      var cand = [];
      // 在最小层的包围盒内网格化撒点, 优先靠近左右两侧(便于抗旋转)
      for (var gy = 0.3; gy <= 0.75; gy += 0.15) {
        for (var gx = 0.2; gx <= 0.85; gx += 0.1) {
          cand.push({ x: sb.x0 + sb.w * gx, y: sb.y0 + sb.h * gy });
        }
      }
      var pinR = (pinD + num(p.fit, 0.2)) / 2;
      var okAll = cand.filter(function (c) {
        return parts.every(function (q) {
          var op = G.flatten(q.outer, 0.6);
          // 圆周上取样, 确保整个孔都在材料内且不碰已有孔
          for (var a2 = 0; a2 < 8; a2++) {
            var pt = { x: c.x + pinR * 1.6 * Math.cos(a2 * Math.PI / 4), y: c.y + pinR * 1.6 * Math.sin(a2 * Math.PI / 4) };
            if (!G.pointInPoly(pt, op)) return false;
            if (q.holes.some(function (hh) { return G.pointInPoly(pt, G.flatten(hh, 0.6)); })) return false;
          }
          return true;
        });
      });
      // 选两个相距最远的点
      var chosen = [];
      if (okAll.length >= 2) {
        var bestD = -1, bi = 0, bj = 1;
        for (var a3 = 0; a3 < okAll.length; a3++) {
          for (var b3 = a3 + 1; b3 < okAll.length; b3++) {
            var dd = Math.hypot(okAll[a3].x - okAll[b3].x, okAll[a3].y - okAll[b3].y);
            if (dd > bestD) { bestD = dd; bi = a3; bj = b3; }
          }
        }
        chosen = [okAll[bi], okAll[bj]];
      } else if (okAll.length === 1) chosen = [okAll[0]];

      if (chosen.length) {
        parts.forEach(function (q) {
          chosen.forEach(function (c) { q.addHole(G.ensureOrient(G.circle(c.x, c.y, pinD + num(p.fit, 0.2)), false)); });
        });
        if (chosen.length === 1) warn.push({ level: 'warn', text: '只找到 1 个公共销孔位置，装配时需自行防转' });
      } else {
        warn.push({ level: 'warn', text: '各层无足够公共区域，未能生成对位销孔' });
      }
    }
    warn.push({ level: 'info', text: '叠层总高 ' + G.round(N * t, 1) + 'mm（' + N + ' 层 × ' + t + 'mm）' });

    return {
      parts: parts,
      warnings: warn,
      mask: base, maskBBox: bbPx,
      info: {
        mode: '等高分层',
        layerCount: N,
        pxPerMM: G.round(1 / sc, 3),
        distinctLayers: distinct,
        dupLayers: dupSkipped,
        size: [G.round(bbPx.w * sc, 1), G.round(bbPx.h * sc, 1)],
        totalHeight: G.round(N * t, 1),
        grayRange: [Math.round(lo), Math.round(hi)],
        perLayer: counts
      }
    };
  }

  global.ImageModel = { silhouette: silhouette, layers: layers, scaleFor: scaleFor };
})(typeof window !== 'undefined' ? window : this);
