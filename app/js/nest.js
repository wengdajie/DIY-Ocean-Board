/* ============================================================
 * nest.js - 板材排样（多策略比选，追求最大利用率）
 *
 * 以包围盒为单位，支持 0/90 度旋转、板边留白、零件间距。
 * 返回 {sheets, oversize, grainForced, stats}，sheets[i].placements[j]
 * 给出 {part, xf, x, y, w, h, rot, name}，xf 可直接喂给 part.transformed()。
 *
 * ---------------- 为什么要多策略比选 ----------------
 * 二维装箱是 NP-hard，没有"一招通吃"的启发式：
 *   · 货架式(shelf)对"尺寸接近的一批板"很整齐，但一旦混进一个高个子零件，
 *     那一层上方的空间就整层浪费掉；
 *   · MaxRects 把空隙登记成"自由矩形"继续利用，对杂乱尺寸强得多，
 *     但它的几种打分口径(BAF/BSSF/BLSF/BL)各有各的失效场景。
 * 所以这里把 5 种排序 × 5 种放置口径 = 25 个方案全跑一遍，再按
 * 「板材张数最少 → 排布越紧凑（剩料越完整）越好」挑冠军。
 * 单次排样零件数量级在几十~几百，25 遍完全跑得动，换来的是实打实的板材钱。
 *
 * ---------------- 间距(gap)是怎么严格保证的 ----------------
 * 把每个零件按 (w+gap, h+gap) 放进一个 (availW+gap, availH+gap) 的虚拟框，
 * 零件实体占据该膨胀矩形的左下角 (w, h)。
 * 两个膨胀矩形互不重叠 => 实体之间在 x 或 y 上至少隔开 gap；
 * 而最后一列/一行多出来的那条 gap 挂在可用区之外 —— 不占板面，
 * 于是"贴着右边缘的零件"也能放下（旧版货架算法在这里白扔一条 gap）。
 *
 * ---------------- 纹理方向约束 (part.meta.grain) ----------------
 *   大板有长边与短边；最外层单板的纹理相对大板长边分横纹/竖纹。
 *   排样时若零件指定了纹理方向，就不能随便转 90 度，否则成品纹理会串向。
 *     'long'  零件长边(局部 +x) 必须平行于大板长边 -> 只允许 rot 0
 *     'cross' 零件长边必须垂直于大板长边          -> 只允许 rot 90
 *     'any' / 未指定                              -> 0 或 90 都行
 *   注意: 大板长边在本坐标系里是 X 轴（sheet.w 通常 2440 > sheet.h 1220）。
 *   若 sheet.w < sheet.h（竖幅面），长边其实是 Y，需交换约束。
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G;
  var EPS = 1e-9;

  /* ---------------- 策略表 ---------------- */
  /* 排序口径: 先放"难安置"的大件, 小件留着填缝 */
  var SORTS = [    { key: 'area',    cmp: function (a, b) { return (b.w * b.h) - (a.w * a.h); } },
    { key: 'maxside', cmp: function (a, b) { return Math.max(b.w, b.h) - Math.max(a.w, a.h); } },
    { key: 'height',  cmp: function (a, b) { return b.h - a.h; } },
    { key: 'width',   cmp: function (a, b) { return b.w - a.w; } },
    { key: 'diff',    cmp: function (a, b) { return Math.abs(b.w - b.h) - Math.abs(a.w - a.h); } }  ];
  /* 放置口径(分数越小越优):
   *   baf   Best Area Fit         选面积最接近的自由矩形 —— 整体最省料
   *   bssf  Best Short Side Fit   让剩下的短边最小 —— 不留细长废条
   *   blsf  Best Long Side Fit    让剩下的长边最小
   *   bl    Bottom-Left           尽量压低 —— 对同高零件最整齐
   *   bwf   Best Waste Fit        废料最短边最大化(剩料越方正越有用)
   *   shelf 货架式                 旧算法, 留着当保底(保证不比从前差)
   */
  var PLACERS = ['baf', 'bssf', 'bwf', 'bl', 'shelf'];

  function strategies() {
    var out = [];
    SORTS.forEach(function (s) {
      PLACERS.forEach(function (p) { out.push(s.key + '/' + p); });
    });
    return out;
  }

  /* ---------------- MaxRects 自由矩形维护 ---------------- */
  // 用 used 去切 fr，返回切完剩下的若干自由矩形；两者不相交返回 null
  function splitFree(fr, used) {
    if (used.x >= fr.x + fr.w - EPS || used.x + used.w <= fr.x + EPS ||
        used.y >= fr.y + fr.h - EPS || used.y + used.h <= fr.y + EPS) return null;
    var out = [];
    var ux1 = used.x + used.w, uy1 = used.y + used.h;
    var fx1 = fr.x + fr.w, fy1 = fr.y + fr.h;
    if (uy1 < fy1 - EPS)      out.push({ x: fr.x, y: uy1,  w: fr.w,          h: fy1 - uy1 });   // 上
    if (used.y > fr.y + EPS)  out.push({ x: fr.x, y: fr.y, w: fr.w,          h: used.y - fr.y }); // 下
    if (used.x > fr.x + EPS)  out.push({ x: fr.x, y: fr.y, w: used.x - fr.x, h: fr.h });        // 左
    if (ux1 < fx1 - EPS)      out.push({ x: ux1,  y: fr.y, w: fx1 - ux1,     h: fr.h });        // 右
    return out;
  }
  function contains(a, b) {   // a 是否完全包含 b
    return b.x >= a.x - EPS && b.y >= a.y - EPS &&
           b.x + b.w <= a.x + a.w + EPS && b.y + b.h <= a.y + a.h + EPS;
  }
  /* 剪掉被别人完全包住的自由矩形。
   * 注意等大重复的情况: 若 i、j 互相包含(即完全相同), 只能删掉其中一个,
   * 否则两个都被判死, 自由矩形凭空消失 -> 后面的零件放不下, 白开一张板。 */
  function pruneFree(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.w <= EPS || a.h <= EPS) continue;
      var dead = false;
      for (var j = 0; j < list.length && !dead; j++) {
        if (i === j) continue;
        var b = list[j];
        if (!contains(b, a)) continue;
        if (contains(a, b) && j > i) continue;   // 完全相同 -> 保留下标小的
        dead = true;
      }
      if (!dead) out.push(a);
    }
    return out;
  }

  /* 在自由矩形 fr 里按 placer 给 (w,h) 打分, 越小越优。返回 null = 放不下 */
  function scoreFit(fr, w, h, placer, top, right) {
    var lw = fr.w - w, lh = fr.h - h;
    if (lw < -EPS || lh < -EPS) return null;
    var shortSide = Math.min(lw, lh), longSide = Math.max(lw, lh);
    switch (placer) {
      case 'bssf': return { a: shortSide, b: longSide };
      case 'blsf': return { a: longSide, b: shortSide };
      case 'bl':   return { a: fr.y + h, b: fr.x };
      case 'bwf':  return { a: -(Math.min(lw, lh)), b: fr.w * fr.h - w * h };  // 最短边越长越好(负号=越小越优)
      default:     return { a: fr.w * fr.h - w * h, b: shortSide };   // baf
    }
  }
  function better(s1, s2) {
    if (!s2) return true;
    if (s1.a < s2.a - 1e-7) return true;
    if (s1.a > s2.a + 1e-7) return false;
    return s1.b < s2.b - 1e-7;
  }

  /* ---------------- 单次排样 ---------------- */
  /* boxes: [{part, bb, w, h, idx, total, rots, seq}]（w/h 为零件真实包围盒）
   * cfg:   {SW, SH, margin, gap, availW, availH}
   * 返回 {sheets, oversize} */
  function packOnce(boxes, cfg, sortIdx, placer) {
    var gap = cfg.gap, margin = cfg.margin;
    // 虚拟框: 可用区各边多加一条 gap, 让最后一列/行的 gap 落在区外
    var boxW = cfg.availW + gap, boxH = cfg.availH + gap;

    var order = boxes.slice();
    var cmp = SORTS[sortIdx].cmp;
    order.sort(function (a, b) { return cmp(a, b) || (a.seq - b.seq); });

    var sheets = [], oversize = [];

    function newSheet() {
      var s = {
        placements: [], w: cfg.SW, h: cfg.SH,
        free: [{ x: 0, y: 0, w: boxW, h: boxH }],
        shelves: []
      };
      sheets.push(s);
      return s;
    }

    // 候选朝向: 返回 [{w,h,r}]（已含 gap 膨胀）
    function cands(bx) {
      return bx.rots.map(function (r) {
        var w = r === 0 ? bx.w : bx.h, h = r === 0 ? bx.h : bx.w;
        return { w: w + gap, h: h + gap, rw: w, rh: h, r: r };
      });
    }

    /* 货架式: 逐层码放, 层高 = 该层最高零件 */
    function shelfTry(s, bx) {
      var cs = cands(bx), i, k, best = null, bestSc = null;
      for (i = 0; i < cs.length; i++) {
        var c = cs[i];
        for (k = 0; k < s.shelves.length; k++) {
          var sh = s.shelves[k];
          if (c.h <= sh.h + EPS && sh.x + c.w <= boxW + EPS) {
            var sc = scoreFit({ x: sh.x, y: sh.y, w: boxW - sh.x, h: sh.h }, c.w, c.h, 'baf');
            if (better(sc, bestSc)) { bestSc = sc; best = { x: sh.x, y: sh.y, c: c, shelf: sh }; }
          }
        }
      }
      if (best) return best;
      // 开新货架：挑"层高更矮"的朝向，为后续留更多纵向空间
      var top = 0;
      if (s.shelves.length) {
        var last = s.shelves[s.shelves.length - 1];
        top = last.y + last.h;
      }
      var fresh = cs.filter(function (c2) {
        return c2.w <= boxW + EPS && top + c2.h <= boxH + EPS;
      });
      fresh.sort(function (a, b) { return (a.h - b.h) || (b.w - a.w); });
      if (fresh.length) {
        var c2 = fresh[0], ns = { x: 0, y: top, h: c2.h };
        s.shelves.push(ns);
        return { x: 0, y: top, c: c2, shelf: ns };
      }
      return null;
    }

    /* MaxRects: 在所有自由矩形 × 所有朝向里选分数最优的 */
    function rectTry(s, bx) {
      var cs = cands(bx), best = null, bestSc = null;
      for (var i = 0; i < s.free.length; i++) {
        var fr = s.free[i];
        for (var k = 0; k < cs.length; k++) {
          var c = cs[k];
          var sc = scoreFit(fr, c.w, c.h, placer);
          if (!sc) continue;
          if (better(sc, bestSc)) { bestSc = sc; best = { x: fr.x, y: fr.y, c: c }; }
        }
      }
      return best;
    }

    function commit(s, spot, bx) {
      var c = spot.c;
      var x = margin + spot.x, y = margin + spot.y;   // 实体落在膨胀矩形左下角
      var xf;
      if (c.r === 0) xf = { rot: 0, tx: x - bx.bb.x0, ty: y - bx.bb.y0 };
      else           xf = { rot: 90, tx: x + bx.bb.y1, ty: y - bx.bb.x0 };
      s.placements.push({
        part: bx.part, xf: xf, w: c.rw, h: c.rh, x: x, y: y, rot: c.r,
        name: bx.part.name + (bx.total > 1 ? ('#' + bx.idx) : '')
      });
      if (spot.shelf) {
        spot.shelf.x = spot.x + c.w;
        if (c.h > spot.shelf.h) spot.shelf.h = c.h;
      } else {
        // 用膨胀矩形去切自由矩形（保证 gap）
        var used = { x: spot.x, y: spot.y, w: c.w, h: c.h };
        var next = [];
        s.free.forEach(function (fr) {
          var parts = splitFree(fr, used);
          if (parts === null) next.push(fr);
          else parts.forEach(function (q) { next.push(q); });
        });
        s.free = pruneFree(next);
      }
    }

    var useShelf = (placer === 'shelf');
    order.forEach(function (bx) {
      // 连空板都放不下 -> 超幅面
      var fits = bx.rots.some(function (r) {
        var w = r === 0 ? bx.w : bx.h, h = r === 0 ? bx.h : bx.w;
        return w <= cfg.availW + EPS && h <= cfg.availH + EPS;
      });
      if (!fits) { oversize.push(bx); return; }

      for (var si = 0; si < sheets.length; si++) {
        var spot = useShelf ? shelfTry(sheets[si], bx) : rectTry(sheets[si], bx);
        if (spot) { commit(sheets[si], spot, bx); return; }
      }
      var s = newSheet();
      var sp2 = useShelf ? shelfTry(s, bx) : rectTry(s, bx);
      if (sp2) { commit(s, sp2, bx); return; }
      oversize.push(bx);
    });

    return { sheets: sheets, oversize: oversize };
  }

  /* ---------------- 方案打分 ----------------
   * 零件是同一批, 板材张数一样时"利用率"这个比值必然相同, 分不出高下。
   * 真正有价值的差别是**剩料是否完整**: 把零件都挤到角上, 剩下一块大整料
   * 才能给下一个项目用。所以次级指标取"各板已用包围盒面积之和", 越小越好。 */
  function usedBBoxArea(s) {
    if (!s.placements.length) return 0;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    s.placements.forEach(function (p) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x + p.w > x1) x1 = p.x + p.w;
      if (p.y + p.h > y1) y1 = p.y + p.h;
    });
    return (x1 - x0) * (y1 - y0);
  }
  function planScore(res) {
    var span = 0, lastUtil = 0, maxOffcut = 0;
    res.sheets.forEach(function (s, i) {
      var bb = usedBBoxArea(s);
      span += bb;
      if (i === res.sheets.length - 1) {
        lastUtil = bb / ((s.availW || 0) * (s.availH || 0) || 1);
      }
      if (s.offcut && s.offcut.w && s.offcut.h) {
        var oa = s.offcut.w * s.offcut.h;
        if (oa > maxOffcut) maxOffcut = oa;
      }
    });
    return { sheetCount: res.sheets.length, oversize: res.oversize.length,
             span: span, lastUtil: lastUtil, maxOffcut: maxOffcut };
  }
  function planBetter(a, b) {
    if (!b) return true;
    if (a.oversize !== b.oversize) return a.oversize < b.oversize;
    if (a.sheetCount !== b.sheetCount) return a.sheetCount < b.sheetCount;
    // 主指标: 已用 bbox 总面积越小 = 零件越集中 = 剩料越完整
    if (Math.abs(a.span - b.span) > 1e-3) return a.span < b.span - 1e-6;
    // 次指标: 最后一张板利用率越高越好(排得越密)
    if (a.lastUtil !== undefined && b.lastUtil !== undefined) {
      if (Math.abs(a.lastUtil - b.lastUtil) > 1e-6) return a.lastUtil > b.lastUtil + 1e-6;
    }
    // 再次: 最大剩料面积越大越好(越可能再利用)
    if (a.maxOffcut !== undefined && b.maxOffcut !== undefined) {
      if (Math.abs(a.maxOffcut - b.maxOffcut) > 1e-3) return a.maxOffcut > b.maxOffcut + 1e-3;
    }
    return false;
  }

  /* ---------------- 最大剩余整料 ----------------
   * 求"最大空矩形"。最优矩形的四条边必然贴着障碍物边或板边, 因此
   * 枚举所有 x 候选对构成竖条, 再在条内找 y 方向最大空隙即可(精确解)。
   * 只用于给用户报"这张板还剩多大一块整料", 因此对零件数设了上限。 */
  function largestFreeRect(s, cfg) {
    var ps = s.placements;
    if (ps.length > 140) return null;
    var L = cfg.margin, R = cfg.margin + cfg.availW;
    var B = cfg.margin, T = cfg.margin + cfg.availH;
    var xs = [L, R], i, j;
    ps.forEach(function (p) {
      if (p.x > L - EPS && p.x < R + EPS) xs.push(p.x);
      var xr = p.x + p.w;
      if (xr > L - EPS && xr < R + EPS) xs.push(xr);
    });
    xs.sort(function (a, b) { return a - b; });
    var ux = [];
    for (i = 0; i < xs.length; i++) if (!i || xs[i] - xs[i - 1] > 1e-6) ux.push(xs[i]);
    var best = null;
    for (i = 0; i < ux.length; i++) {
      for (j = i + 1; j < ux.length; j++) {
        var xL = ux[i], xR = ux[j], w = xR - xL;
        if (w <= 1e-6) continue;
        if (best && w * (T - B) <= best.w * best.h + 1e-9) continue;   // 上界剪枝
        // 竖条内与之水平重叠的障碍 -> 禁止的 y 区间
        var bars = [];
        for (var k = 0; k < ps.length; k++) {
          var p = ps[k];
          if (p.x + p.w <= xL + 1e-6 || p.x >= xR - 1e-6) continue;
          bars.push([p.y, p.y + p.h]);
        }
        bars.sort(function (a, b) { return a[0] - b[0]; });
        var cur = B;
        for (var m = 0; m < bars.length; m++) {
          if (bars[m][0] > cur + 1e-6) {
            var hh = bars[m][0] - cur;
            if (!best || w * hh > best.w * best.h + 1e-9) best = { x: xL, y: cur, w: w, h: hh };
          }
          if (bars[m][1] > cur) cur = bars[m][1];
        }
        if (T > cur + 1e-6) {
          var h2 = T - cur;
          if (!best || w * h2 > best.w * best.h + 1e-9) best = { x: xL, y: cur, w: w, h: h2 };
        }
      }
    }
    return best;
  }

  /* ============================================================
   * 主入口
   * items: [{part, qty}]  sheet: {w,h,margin,gap,allowRotate,respectGrain,strategy}
   * sheet.strategy: 'auto'(默认, 全策略比选) 或 'sortKey/placer' 指定单策略
   * ============================================================ */
  function nest(items, sheet) {
    sheet = sheet || {};
    var SW = sheet.w || 2440, SH = sheet.h || 1220;
    var margin = sheet.margin === undefined ? 10 : sheet.margin;
    var gap = sheet.gap === undefined ? 6 : sheet.gap;
    var rot = sheet.allowRotate !== false;
    var respectGrain = sheet.respectGrain === true;
    var longIsX = SW >= SH;      // 幅面竖放时长边是 Y, 纹理约束的允许角度要跟着翻

    function allowedRots(part) {
      var g = respectGrain ? (part.meta && part.meta.grain) : null;
      if (g !== 'long' && g !== 'cross') return rot ? [0, 90] : [0];
      var parallel = (g === 'long');            // 零件 +x 需平行于大板长边
      return [(parallel === longIsX) ? 0 : 90];
    }

    // 展开数量 & 计算包围盒
    var boxes = [], grainForced = [], seq = 0;
    items.forEach(function (it) {
      var p = it.part || it;
      var q = it.qty || p.qty || 1;
      var b = p.bbox();
      var rs = allowedRots(p);
      if (rs.length === 1 && rot) grainForced.push(p.name);
      for (var i = 0; i < q; i++) {
        boxes.push({ part: p, bb: b, w: b.w, h: b.h, idx: i + 1, total: q, rots: rs, seq: seq++ });
      }
    });

    var cfg = {
      SW: SW, SH: SH, margin: margin, gap: gap,
      availW: SW - margin * 2, availH: SH - margin * 2
    };

    /* 策略集: 零件极多时缩减规模, 保证交互不卡(仍覆盖两种排序 × 三种口径) */
    var sortIdxs = [];
    for (var si = 0; si < SORTS.length; si++) sortIdxs.push(si);
    var placers = PLACERS;
    if (boxes.length > 260) { sortIdxs = [0, 1]; placers = ['baf', 'bwf', 'shelf']; }

    var pick = null, pickScore = null, pickName = '', tried = 0;
    var only = sheet.strategy && sheet.strategy !== 'auto' ? String(sheet.strategy) : null;
    for (var a = 0; a < sortIdxs.length; a++) {
      for (var b2 = 0; b2 < placers.length; b2++) {
        var nm = SORTS[sortIdxs[a]].key + '/' + placers[b2];
        if (only && nm !== only) continue;
        var res = packOnce(boxes, cfg, sortIdxs[a], placers[b2]);
        tried++;
        var sc = planScore(res);
        if (planBetter(sc, pickScore)) { pickScore = sc; pick = res; pickName = nm; }
      }
    }
    if (!pick) {   // 指定了不存在的策略名 -> 退回默认, 不静默产出空排样
      pick = packOnce(boxes, cfg, 0, 'baf'); pickName = 'area/baf'; tried = 1;
    }

    var sheets = pick.sheets;

    // 统计
    var totalArea = 0, usedArea = 0, spanArea = 0;
    sheets.forEach(function (s) {
      var ar = 0;
      s.placements.forEach(function (pl) { ar += Math.abs(pl.part.area()); });
      s.usedArea = ar;
      s.utilization = ar / (SW * SH);
      s.bboxArea = usedBBoxArea(s);
      s.offcut = largestFreeRect(s, cfg);
      delete s.free; delete s.shelves;     // 内部结构不外泄, 避免测试/导出误用
      usedArea += ar; spanArea += s.bboxArea;
      totalArea += SW * SH;
    });
    var lastOff = sheets.length ? sheets[sheets.length - 1].offcut : null;

    return {
      sheets: sheets,
      oversize: pick.oversize,
      grainForced: grainForced,
      stats: {
        sheetCount: sheets.length,
        utilization: totalArea ? usedArea / totalArea : 0,
        partArea: usedArea,
        sheetArea: totalArea,
        sheetW: SW, sheetH: SH,
        grainLocked: grainForced.length,
        strategy: pickName,
        strategiesTried: tried,
        /* 紧凑度: 零件净面积 / 已占包围盒面积。越接近 1 说明排布越密实,
         * 剩下的料越可能是一整块而不是一堆碎条。 */
        packDensity: spanArea ? usedArea / spanArea : 0,
        spanArea: spanArea,
        offcut: lastOff ? { w: G.round(lastOff.w, 1), h: G.round(lastOff.h, 1) } : null
      }
    };
  }

  /* 校验排样结果：同板零件包围盒不得重叠、不得越界、纹理方向未被违背、间距达标 */
  function verify(result, sheet) {
    var errs = [];
    var margin = (sheet && sheet.margin !== undefined) ? sheet.margin : 10;
    var gap = (sheet && sheet.gap !== undefined) ? sheet.gap : null;
    var respectGrain = !!(sheet && sheet.respectGrain === true);
    result.sheets.forEach(function (s, si) {
      s.placements.forEach(function (a, i) {
        if (respectGrain) {
          var g = a.part.meta && a.part.meta.grain;
          if (g === 'long' || g === 'cross') {
            var longIsX = s.w >= s.h;
            var want = ((g === 'long') === longIsX) ? 0 : 90;
            if (a.rot !== want) {
              errs.push('板' + (si + 1) + ' ' + a.name + ' 纹理方向被旋转破坏(要求 ' + want + '° 实际 ' + a.rot + '°)');
            }
          }
        }
        if (a.x < margin - 1e-6 || a.y < margin - 1e-6 ||
            a.x + a.w > s.w - margin + 1e-6 || a.y + a.h > s.h - margin + 1e-6) {
          errs.push('板' + (si + 1) + ' ' + a.name + ' 越界');
        }
        for (var j = 0; j < i; j++) {
          var b = s.placements[j];
          var hit = !(a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 ||
                      a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6);
          if (hit) errs.push('板' + (si + 1) + ' ' + a.name + ' 与 ' + b.name + ' 重叠');
          else if (gap !== null && gap > 0) {
            /* 不重叠还要够间距: 在 x 或 y 上至少让开 gap(容差 1e-6)。
             * 只要有一个方向达标就行(斜对角的两件不需要额外让位)。 */
            var dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
            var dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
            if (dx < gap - 1e-6 && dy < gap - 1e-6) {
              errs.push('板' + (si + 1) + ' ' + a.name + ' 与 ' + b.name + ' 间距不足(' +
                G.round(Math.max(dx, dy), 2) + ' < ' + gap + ')');
            }
          }
        }
      });
    });
    return errs;
  }

  global.Nest = {
    nest: nest, verify: verify,
    strategies: strategies, largestFreeRect: largestFreeRect,
    splitFree: splitFree, pruneFree: pruneFree
  };
})(typeof window !== 'undefined' ? window : this);
