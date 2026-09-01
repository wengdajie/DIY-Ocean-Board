/* ============================================================
 * joints.js - 榫卯 / 板式接合生成器
 * 依赖 geom.js
 *
 * 设计约定
 *  - 边坐标 (u,v): u 沿边 A->B，v>0 = 离开材料(凸出)，v<0 = 切入材料
 *  - fit = **总配合间隙**（榫与槽之间的全部松量），而不是单侧值：
 *      · 沿边长方向: 榫头两侧各收 fit/4、槽两侧各放 fit/4 => 榫进槽总间隙 = fit
 *        （指接的两个配对件都会被收窄，故每侧只能取 fit/4，否则会松一倍）
 *      · 厚度方向:   榫眼宽 = 板厚 + fit                  => 总间隙 = fit
 *  - 内凹尖角按刀具半径做让位(dogbone / T-bone)，激光可关闭
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G;

  /* ---------------- 分格：保证配对件严格互补 ----------------
   * 把长度 L 分成 m 段(m 为奇数)。phase=0 -> 取偶数段为榫头(两端为榫)
   *                                phase=1 -> 取奇数段为榫头(两端为槽)
   * 同一 (L, m) 下 phase 0/1 天然互补。
   */
  function suggestSegs(L, t, targetW) {
    var w = targetW || Math.max(2.2 * t, 14);
    var m = Math.round(L / w);
    if (m < 3) m = 3;
    if (m % 2 === 0) m += 1;                 // 强制奇数
    var maxM = Math.max(3, Math.floor(L / Math.max(3, t * 0.8)));
    if (maxM % 2 === 0) maxM -= 1;
    if (m > maxM) m = Math.max(3, maxM);
    return m;
  }

  // 返回 {tabs:[[u0,u1]..], gaps:[[u0,u1]..], m, seg}
  function spansFor(L, opts) {
    opts = opts || {};
    var inset = opts.inset || 0;
    var L2 = L - inset * 2;
    var m = opts.m || suggestSegs(L2, opts.t || 12, opts.fingerW);
    var seg = L2 / m, tabs = [], gaps = [], i;
    var phase = opts.phase ? 1 : 0;
    for (i = 0; i < m; i++) {
      var a = inset + seg * i, b = inset + seg * (i + 1);
      if (i % 2 === phase) tabs.push([a, b]); else gaps.push([a, b]);
    }
    if (inset > 0) {                            // 两端留边算作槽区
      gaps.unshift([0, inset]);
      gaps.push([L - inset, L]);
    }
    return { tabs: tabs, gaps: gaps, m: m, seg: seg, inset: inset, L: L };
  }

  /* ---------------- 边轮廓：榫头 / 燕尾 ----------------
   * depth: 榫头凸出长度(通常 = 配合板厚)
   * fit  : 总配合间隙(槽单侧放宽 fit/2 => 榫头两侧各让 fit/2)
   * style: 'finger' 直榫 | 'dovetail' 燕尾 | 'round' 圆角直榫
   */
  /* 【第 6 轮证明的硬几何事实】
   * 直刀通切的片材家具里, **90° 对接的角接/T 接永远不能用燕尾**。
   *
   * 证明: 把两块板的角部公共区域看成一个 (u, p, q) 长方体,
   *   p = A 的板厚方向, q = B 的板厚方向。
   *   A 是平板且直刀通切 => A 的轮廓沿 p **恒定**, 只能随 q 变;
   *   B 同理 => B 的轮廓只能随 p 变。
   *   两者的分界面 u = f_A(q) 与 u = f_B(p) 要既不重叠也不留缝,
   *   必须处处相等 => 两者只能是**常数** => 只能是直榫。
   *
   * 实测印证(探针 _a5): t=12/H=120/燕尾角 11° 时, 前板与侧板的榫尖
   * 四处两两侵入 4.59mm, 且侧板榫尖跮出板边 -2.3 / +122.3(超出 H=120)。
   * 这就是旧版 drawer 用 dovetail 时 3D 包围盒变成 z[-2.3,122.3] 的原因 ——
   * 那不是渲染 bug, 是零件真的彼此干涉、切出来装不上。
   *
   * 所以这里强制 flare = 0, 并把"想要自锁"的需求引到真正可切的方案:
   *   · puzzleProfile   共面拼板燕尾(两板同平面, p≡q, 互补成立)
   *   · wedgeTenonProfile 楛钉榫(通榫伸出 + 斜楷口 + 独立楛片)
   *   · hookLapProfile  勾齿搭接
   * 详见各函数注释。
   */
  function tabProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, style = opts.style || 'finger';
    var half = fit / 4;                 // 每侧让量(见文件头: fit 为总间隙)
    var ang = opts.dovetailAngle === undefined ? 11 : opts.dovetailAngle;
    /* 允许调用方显式要求张角(共面拼板才用), 否则一律归零。 */
    var flare = (style === 'dovetail' && opts.allowFlare) ? depth * Math.tan(ang * G.D2R) : 0;
    if (style === 'dovetail' && !opts.allowFlare) style = 'finger';
    var rr = opts.tipRadius || 0;
    var prof = [], i;
    var tabs = spans.tabs;
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] + half, u1 = tabs[i][1] - half;
      if (u1 - u0 < 0.2) continue;              // 太窄则跳过
      // 根部
      prof.push({ u: u0, v: 0 });
      if (style === 'dovetail') {
        prof.push({ u: u0 - flare, v: depth });
        prof.push({ u: u1 + flare, v: depth });
      } else if (rr > 0) {
        var r = Math.min(rr, (u1 - u0) / 2, depth / 2);
        prof.push({ u: u0, v: depth - r, b: G.bulgeOf(90) });
        prof.push({ u: u0 + r, v: depth });
        prof.push({ u: u1 - r, v: depth, b: G.bulgeOf(90) });
        prof.push({ u: u1, v: depth - r });
      } else {
        prof.push({ u: u0, v: depth });
        prof.push({ u: u1, v: depth });
      }
      prof.push({ u: u1, v: 0 });
    }
    return prof;
  }

  /* 母件边槽（与 tabProfile 互补，切入材料）
   * 重要：槽必须落在边的"内部"。若某个槽紧贴边端点，会与相邻边产生共线重合，
   * 生成非法轮廓 —— 那种情况属于箱体转角，应由配对件的 phase 处理(见 tabProfile)，
   * 而不是在这里开槽。因此此处跳过贴端的 span，并在 prof.skipped 中报告数量。
   */
  function socketProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, style = opts.style || 'finger';
    var half = fit / 4;                 // 每侧放量
    var ang = opts.dovetailAngle === undefined ? 11 : opts.dovetailAngle;
    /* 与 tabProfile 保持一致: 默认不张角(详见 tabProfile 头部的几何证明) */
    var flare = (style === 'dovetail' && opts.allowFlare) ? depth * Math.tan(ang * G.D2R) : 0;
    var prof = [], i, tabs = spans.tabs, L = spans.L, skipped = 0;
    var tol = 1e-6;
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] - half - flare, u1 = tabs[i][1] + half + flare;
      if (u0 <= tol || u1 >= L - tol) { skipped++; continue; }
      prof.push({ u: u0, v: 0 });
      prof.push({ u: u0 + flare, v: -depth });
      prof.push({ u: u1 - flare, v: -depth });
      prof.push({ u: u1, v: 0 });
    }
    prof.skipped = skipped;
    return prof;
  }

  /* ---------------- 榫眼(母件面上的通孔/盲槽) ----------------
   * 由同一组 spans 派生，天生与榫头匹配
   * f: 母件上接合线的 frame(A->B)；thickness: 公件板厚；
   * v0: 槽在 v 方向的起点(默认 -thickness/2 居中于接合线)
   */
  function mortisesFromSpans(spans, f, thickness, opts) {
    opts = opts || {};
    var fit = opts.fit || 0;
    var half = fit / 4;              // 沿榫眼长度方向每侧放量
    var w = thickness + fit;         // 厚度方向: 总间隙 = fit
    var vc = opts.vOffset || 0;                 // 接合线法向偏移
    var out = [], i, tabs = spans.tabs;
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] - half, u1 = tabs[i][1] + half;
      var loop = f.rectUV(u0, vc - w / 2, u1 - u0, w);
      out.push(G.ensureOrient(loop, false));    // 孔 = CW
    }
    return out;
  }

  /* 角部指接的"内缩式"轮廓。
   *
   * 与 tabProfile 的区别在于**板的标称矩形代表什么**:
   *   tabProfile          —— 矩形 = 肩距, 榫头额外**凸出** depth (models.js 的家具走这条)
   *   fingerRecessProfile —— 矩形 = 成品外形, 把 gap 段向内**挖掉** depth, 榫头与板边齐平
   *
   * 为什么必须有它: 板位表/配方里用户填的是**外形尺寸**。
   * 若两块板在角上都用 tabProfile 往外长榫, 整个柜子每个方向都会
   * 胖出一个板厚(实测: 标称 900 高的柜子 3D 包围盒是 z[-15,915]),
   * 而且两块板的榫头会抢同一个角部方块 -> 真实干涉。
   *
   * 配对关系: child(端面顶在 host 上) 用 tabProfile 凸出穿过 host;
   *           host(角部就是它的外边界) 用本函数内缩。两者 phase 互补 => 互不占位。
   *
   * fit: gap 段两侧各放宽 fit/4 => 剩下的榫头两侧各收 fit/4, 总间隙 = fit。
   */
  function fingerRecessProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0;
    var half = fit / 4;
    var L = spans.L, prof = [], i;
    var gaps = (spans.gaps || []).slice().sort(function (a, b) { return a[0] - b[0]; });
    for (i = 0; i < gaps.length; i++) {
      var u0 = Math.max(0, gaps[i][0] - half);
      var u1 = Math.min(L, gaps[i][1] + half);
      if (u1 - u0 < 0.2) continue;
      prof.push({ u: u0, v: 0 });
      prof.push({ u: u0, v: -depth });
      prof.push({ u: u1, v: -depth });
      prof.push({ u: u1, v: 0 });
    }
    return prof;
  }

  /* ---------------- 内凹尖角让位 (dogbone / T-bone, 俗称"小耳朵") ----------------
   *
   * 【问题本质】圆刀切不出方内角。半径 r 的立铣刀在内凹角上最多能留下一个
   * 半径 r 的圆角残料, 于是配对件的方榫**插不到底**。让位就是在角上多切掉
   * 一点, 把那块残料挪到"不影响配合"的地方去。
   *
   * 【第 8 轮的栅格化取证 —— 旧实现的 T-bone 几乎没用】
   * 用形态学开运算模拟真实刀路(刀心可达域 = void 的 r-腐蚀, 实切域 = 再 r-膨胀),
   * 在 24x16 缺口 / 刀 r=3.2 上量"名义缺口里仍是材料的面积":
   *     无让位                4.84 mm2
   *     旧 T-bone(耳长 = r)   4.22 mm2   <- 只解决了 13%, 等于没做
   *     新 T-bone(耳长 = 2r)  0.00 mm2   <- 干净
   *     dogbone               0.00 mm2
   * 原因是纯几何的: 耳槽只挖到离角点 r 处, 刀心要走到那儿, 刀盘边缘就必须
   * 越过角点 —— 而角点另一侧是材料, 走不进去。**耳长必须 >= 2r** 刀心才够得着。
   * (实测 1.5r 仍残 2.34mm2, 2r 归零, 故取 2r。)
   *
   * 【第 8 轮修掉的另外三个真实缺陷】
   *  1) 邻边比 r 短就整个跳过 -> 浅缺口(60 宽 x 1.0 深)完全没让位, 镂 0mm2。
   *     现在改为**按邻边长度把 r 缩小**后照做, 缩不动才放弃并记 skipped。
   *  2) turn < 20° 就跳过 -> 钝内角(转角 15°)也是内凹角, 一样卡刀。
   *     阈值降到 2°(纯共线才跳过)。
   *  3) dogbone 的 270° 过切圆在**锐内角**(转角 >= 135°)会自交, 切出废图。
   *     实测 6mm 宽缺口 + r=3.2: 旧版镂 74mm2 且 selfIntersects=true。
   *     现在: 过切圆的两个落点必须都留在邻边内, 且缺口宽度必须容得下
   *     2r 的圆(否则圆会跨过缺口另一侧) —— 容不下就自动降级到 T-bone。
   *
   * type: 'dogbone' 过切圆 | 'tbone' 矩形耳 | 'none'
   * opts: { earLen: 耳长系数(默认 2, 即 2r), minTurn: 最小转角(默认 2°),
   *         allowShrink: 邻边不够时是否缩小 r (默认 true) }
   * 返回值带 .stats = { applied, skipped, shrunk, degraded }
   */
  function applyRelief(loop, r, type, opts) {
    opts = opts || {};
    if (!r || r <= 0 || !type || type === 'none') {
      var pass = loop.map(G.clone);
      pass.stats = { applied: 0, skipped: 0, shrunk: 0, degraded: 0 };
      return pass;
    }
    var earMul = opts.earLen === undefined ? 2 : Math.max(1, opts.earLen);
    var minTurn = opts.minTurn === undefined ? 2 : opts.minTurn;
    var allowShrink = opts.allowShrink !== false;
    var rMin = opts.minRadius === undefined ? 0.15 : opts.minRadius;
    var n = loop.length, i, j;
    var st = { applied: 0, skipped: 0, shrunk: 0, degraded: 0 };

    /* 让位在**入边**(tbone)或**两条边**(dogbone)上都要占掉一段长度。
     * 两个相邻内凹角若共用一条短边, 各自占一段就会**互相越过** ->
     * 轮廓折回自己 = 自交废图。实测 6mm 宽 x 10 深缺口 + 刀 r=3.2:
     * 两个角各要 3.2mm, 合计 6.4 > 6, 旧版直接切出自交轮廓(镂 74mm2)。
     * 所以必须把"每条边的长度"当作**两端共享的预算**统一分配。
     * 系数: tbone 只吃入边(earMul 倍), dogbone 两边各吃 1 倍。 */
    function cIn(k) { return k === 'tbone' ? earMul : 1; }
    function cOut(k) { return k === 'tbone' ? 0 : 1; }

    // ---- pass 1: 找出候选角, 记下几何量 ----
    var V = new Array(n), eLen = new Array(n);
    for (i = 0; i < n; i++) {
      eLen[i] = G.len(G.sub(loop[(i + 1) % n], loop[i]));
      V[i] = null;
    }
    for (i = 0; i < n; i++) {
      var prev = ((i - 1) % n + n) % n, next = (i + 1) % n;
      var C = loop[i];
      // 圆弧端点不做让位(已经是圆角, 刀本来就走得进去)
      if (loop[prev].b || C.b) continue;
      var a = G.norm(G.sub(C, loop[prev]));                 // 入向
      var b = G.norm(G.sub(loop[next], C));                 // 出向
      var cr = G.cross(a, b);
      var turn = Math.abs(Math.atan2(cr, G.dot(a, b))) * G.R2D;
      /* 只处理右转(材料侧内凹)。turn 只排除"几乎共线"的假角:
       * 钝内角同样卡刀, 旧版 20° 的阈值把这些角全漏掉了。 */
      if (cr >= -1e-9 || turn < minTurn) continue;
      /* 锐内角(转角 > 100°)的 270° 过切圆必然穿出邻边 -> 自交。
       * 矩形耳沿单边挖, 任何角度都安全, 所以这里直接选 tbone。 */
      var kind = type === 'tbone' ? 'tbone' : 'dogbone';
      if (kind === 'dogbone' && turn > 100) { kind = 'tbone'; st.degraded++; }
      V[i] = {
        kind: kind, r: r, a: a, b: b, turn: turn,
        lenIn: eLen[prev], lenOut: eLen[i], degraded: false
      };
    }

    /* ---- pass 2: 按边预算把 r 缩到互不越界 ----
     * 每条边的可用长度打 0.98 折(落点压在端点上同样会退化成零长边)。
     * dogbone 缩小后若仍塞不进楔形, 降级成 tbone 再重新分配预算 ——
     * 降级会把系数从 (1,1) 变成 (earMul,0), 所以要重跑, 最多 4 轮。 */
    for (var round = 0; round < 4; round++) {
      for (var it = 0; it < 12; it++) {
        var moved = false;
        for (i = 0; i < n; i++) {
          j = (i + 1) % n;
          var vi = V[i], vj = V[j];
          var dem = (vi ? cOut(vi.kind) * vi.r : 0) + (vj ? cIn(vj.kind) * vj.r : 0);
          var budget = eLen[i] * 0.98;
          if (dem > budget + 1e-9) {
            if (!allowShrink) {
              if (vi && cOut(vi.kind) > 0) V[i] = null;
              if (vj && cIn(vj.kind) > 0) V[j] = null;
            } else {
              var f = budget / dem;
              if (vi && cOut(vi.kind) > 0) { vi.r *= f; vi.shrunk = true; }
              if (vj && cIn(vj.kind) > 0) { vj.r *= f; vj.shrunk = true; }
            }
            moved = true;
          }
        }
        if (!moved) break;
      }
      var deg = false;
      for (i = 0; i < n; i++) {
        var v = V[i];
        if (!v || v.kind !== 'dogbone') continue;
        /* 过切圆要塞进内角的楔形(张开角 = 180 - turn):
         * 沿邻边最远要够到 r / sin(张开角/2)。够不到就降级。 */
        var open = (180 - v.turn) * G.D2R;
        var reach = v.r / Math.max(0.08, Math.sin(open / 2));
        if (reach > Math.min(v.lenIn, v.lenOut) * 0.98) {
          v.kind = 'tbone'; v.degraded = true; deg = true;
        }
      }
      if (!deg) break;
    }
    // 缩到不可加工的就放弃(切一个 0.1mm 的耳朵没有意义, 只是给刀添麻烦)
    for (i = 0; i < n; i++) {
      if (V[i] && V[i].r < rMin) { V[i] = null; st.skipped++; }
    }

    // ---- pass 3: 落点 ----
    var out = [];
    for (i = 0; i < n; i++) {
      var Ci = loop[i], vv = V[i];
      if (!vv) { out.push(G.clone(Ci)); continue; }
      if (vv.shrunk) st.shrunk++;
      if (vv.degraded) st.degraded++;
      var rr = vv.r;
      if (vv.kind === 'tbone') {
        /* 矩形耳: 沿**入边**往回挖 earMul*rr, 往材料侧深 rr。
         * 材料恒在前进方向左侧 => 入边的材料侧法向 = left(a)。
         * 【耳长必须 >= 2rr】见函数头的栅格化取证: 刀心离入边至少 rr、
         * 离角点也至少 rr, 耳长只有 rr 时刀心根本走不到角点那条法线上。 */
        var m = G.left(vv.a), eL = earMul * rr;
        out.push(G.P(Ci.x - vv.a.x * eL, Ci.y - vv.a.y * eL));
        out.push(G.P(Ci.x - vv.a.x * eL + m.x * rr, Ci.y - vv.a.y * eL + m.y * rr));
        out.push(G.P(Ci.x + m.x * rr, Ci.y + m.y * rr));
        out.push(G.P(Ci.x, Ci.y));
      } else {
        /* dogbone: 严格按参考加工图：阴角就是圆心，半径 rr = 刀具直径/2，
         * 所以完整小耳朵的直径始终等于用户输入的 CNC 刀具直径；不是把圆心
         * 沿 45° 对角线偏移，也不是把刀具直径误当半径。
         * 轮廓沿顺时针大弧绕过角点，等价于“名义缺口 ∪ 以阴角为心的刀圆”。
         *
         * 【第 8 轮修的真实几何 BUG】旧版把扫掠角硬编码成 -270°,
         * 而 -270° **只对 90° 内角成立**。落点固定在 C-a*rr 与 C+b*rr,
         * 弦长 = 2*rr*cos(turn/2); 由 bulge 反算的半径 = 弦/(2*sin(|sweep|/2))。
         * 要让它等于 rr, 必须 sin(|sweep|/2) = cos(turn/2) => |sweep| = 180 + turn。
         * 实测(探针): turn=60° 时旧版反算出 R=3.674(应 3)、圆心偏离角点 1.098mm;
         * turn=45° 时 R=3.92、偏离 1.62mm —— 圆根本不在角上, 让位量既不对、
         * 位置也不对, 斜肩榫/V 形槽的内角全都白让。
         * 正解: sweep = -(180 + turn)。turn=90 时自然退回 -270, 与旧行为兼容。 */
        out.push(G.P(Ci.x - vv.a.x * rr, Ci.y - vv.a.y * rr, G.bulgeOf(-(180 + vv.turn))));
        out.push(G.P(Ci.x + vv.b.x * rr, Ci.y + vv.b.y * rr));
      }
      st.applied++;
    }
    var res = G.cleanLoop(out);
    res.stats = st;
    return res;
  }

  /* ---------------- 直槽 / 搭接槽 ---------------- */
  // 面上的一条直槽(用于隔板插入)：沿 A->B，宽 = 板厚+fit
  function grooveLoop(A, B, thickness, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, w = thickness + fit;
    var f = G.frame(A, B);
    var u0 = opts.u0 || 0, u1 = opts.u1 === undefined ? f.L : opts.u1;
    var vc = opts.vOffset || 0;
    var loop = f.rectUV(u0, vc - w / 2, u1 - u0, w);
    return G.ensureOrient(loop, false);
  }

  // 十字搭接：在板边开一个深 = h、宽 = 板厚+fit 的缺口(边轮廓 profile)
  function lapNotchProfile(uCenter, thickness, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, w = thickness + fit;
    return [
      { u: uCenter - w / 2, v: 0 },
      { u: uCenter - w / 2, v: -depth },
      { u: uCenter + w / 2, v: -depth },
      { u: uCenter + w / 2, v: 0 }
    ];
  }

  /* ============================================================
   * 共面拼板燕尾 (puzzle / jigsaw dovetail)
   *
   * 与角接不同: 两块板在**同一个平面**里对拼(拿来加宽台面/拼长板),
   * 于是两者的板厚方向重合(p ≡ q), tabProfile 头部那个"只能是常数"的
   * 限制完全不适用 —— 张角在这里是真能切、真能自锁的。
   *
   * 双方用同一组 spans, phase 互补 + 沿边长方向镜像, 就育一定能合上。
   * 拉伸方向(垂直于拼缝)上自锁, 不靠胶也不会拉开。
   *
   * neck: 颈部宽占榫头根部的比例(0.35~0.7), 越小越"招耳", 但根部越易崩。
   */
  function puzzleProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, half = fit / 4;
    var neck = G.clamp(opts.neck === undefined ? 0.5 : opts.neck, 0.25, 0.85);
    var prof = [], i, tabs = spans.tabs;
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] + half, u1 = tabs[i][1] - half;
      var wide = u1 - u0;
      if (wide < 0.4) continue;
      var nw = wide * neck;                     // 颈部宽
      var inset = (wide - nw) / 2;              // 根部向内收的量
      prof.push({ u: u0, v: 0 });
      prof.push({ u: u0 + inset, v: depth * 0.42 });   // 收颈
      prof.push({ u: u0, v: depth });                  // 再张开 -> 燕尾头
      prof.push({ u: u1, v: depth });
      prof.push({ u: u1 - inset, v: depth * 0.42 });
      prof.push({ u: u1, v: 0 });
    }
    return prof;
  }

  /* ============================================================
   * 楛钉榫 (贯通楛榫, wedged through tenon)
   *
   * 传统木作里最强的可拆装接合: 榫头穿过母件后**多伸出** ext,
   * 伸出部分开一个斜向的楛口, 敲进一片楛子就把两块板抽紧。
   * 不靠胶、不靠五金, 拆的时候把楛子敲出来就行(平板家具的杀手销)。
   *
   * 本函数只负责**榫头轮廓**(比 tabProfile 多伸 ext);
   * 楛口是开在榫头上的孔, 由 wedgeSlots() 给; 楛片本体由 wedgePart() 给。
   */
  function wedgeTenonProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, half = fit / 4;
    var ext = opts.ext === undefined ? depth * 0.9 : opts.ext;   // 穿出量
    var prof = [], i, tabs = spans.tabs;
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] + half, u1 = tabs[i][1] - half;
      if (u1 - u0 < 0.4) continue;
      prof.push({ u: u0, v: 0 });
      prof.push({ u: u0, v: depth + ext });
      prof.push({ u: u1, v: depth + ext });
      prof.push({ u: u1, v: 0 });
    }
    prof.ext = ext;
    return prof;
  }

  /* 楛口: 开在榫头穿出段上的斜孔。
   * 孔的一侧垂直、另一侧向外斜(taper), 楛子敲进去就越敲越紧。
   * 孔必须跨过母件内表面(否则楛子敲不到肩), 所以从 depth - inBite 开始。
   *
   * f: 榫头所在边的 frame(u 沿边长, v>0 离开材料)
   */
  function wedgeSlots(spans, f, thickness, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, half = fit / 4;
    var depth = opts.depth === undefined ? thickness : opts.depth;   // 母件板厚
    var ext = opts.ext === undefined ? depth * 0.9 : opts.ext;
    var taper = opts.taper === undefined ? 4 : opts.taper;           // 斜度(度)
    var wide = opts.slotW === undefined ? Math.max(3, thickness * 0.35) : opts.slotW;
    var inBite = opts.inBite === undefined ? Math.max(1.5, thickness * 0.18) : opts.inBite;
    var out = [], i, tabs = spans.tabs;
    var tanT = Math.tan(taper * G.D2R);
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] + half, u1 = tabs[i][1] - half;
      var uc = (u0 + u1) / 2;
      var v0 = depth - inBite, v1 = depth + ext * 0.86;
      var L2 = v1 - v0;
      var wTop = wide + 2 * L2 * tanT;               // 远端更宽 => 楔子越敲越紧
      /* 【必须按 wTop 而不是 wide 判断】楔口是梯形, 远端才是最宽处。
       * 旧版拿 wide + 2 当门槛, 而 wTop 比 wide 宽出 2*L2*tanT
       * (t=15/4° 时约 +2.0mm), 于是楔口的宽端正好顶穿榫齿侧壁 ->
       * 零件自检报"孔越出板边", 整个楔钉榫方案直接出废图。
       * 两侧各留 1.2mm 净料, 否则楔子一敲榫齿就从侧面裂开。 */
      if (u1 - u0 < wTop + 2.4) continue;            // 榫齿太窄, 开了就崩
      out.push(G.ensureOrient([
        f.at(uc - wide / 2, v0), f.at(uc + wide / 2, v0),
        f.at(uc + wTop / 2, v1), f.at(uc - wTop / 2, v1)
      ], false));
    }
    return out;
  }

  /* 楛片本体(独立小零件, 与 wedgeSlots 同参数 => 天生匹配)。
   * 取 fit 的一半作为过盈: 楛子就是靠过盈敲紧的。 */
  function wedgePart(thickness, opts) {
    opts = opts || {};
    var fit = opts.fit || 0;
    var depth = opts.depth === undefined ? thickness : opts.depth;
    var ext = opts.ext === undefined ? depth * 0.9 : opts.ext;
    var taper = opts.taper === undefined ? 4 : opts.taper;
    var wide = opts.slotW === undefined ? Math.max(3, thickness * 0.35) : opts.slotW;
    var inBite = opts.inBite === undefined ? Math.max(1.5, thickness * 0.18) : opts.inBite;
    var L2 = (depth + ext * 0.86) - (depth - inBite);
    var over = fit / 2;                                   // 过盈量
    var wTop = wide + 2 * L2 * Math.tan(taper * G.D2R);
    var tail = opts.tail === undefined ? Math.max(6, thickness) : opts.tail;   // 露头便于敲
    /* 楛子画成一个梯形: 窄端(先进去那端) + 宽端 + 露头 */
    return G.ensureOrient([
      G.P(-(wide + over) / 2, 0),
      G.P((wide + over) / 2, 0),
      G.P((wTop + over) / 2, L2),
      G.P((wTop + over) / 2, L2 + tail),
      G.P(-(wTop + over) / 2, L2 + tail),
      G.P(-(wTop + over) / 2, L2)
    ], true);
  }

  /* ============================================================
   * 勾齿搭接 (hooked half-lap / 锢头搭)
   *
   * 普通十字半槽搭接只防得住"扭", 沿槽长方向一抽就开。
   * 勾齿在槽的底部多开一个侧向的小口, 两片插到底再横推一点就钱住。
   *
   * 方向约定: hookDir = +1 向 u 增大侧钱, -1 反之。
   * 配对的两块板必须取**相反**的 hookDir, 否则推不拢。
   */
  function hookLapProfile(uCenter, thickness, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, w = thickness + fit;
    var dir = opts.hookDir >= 0 ? 1 : -1;
    var hook = opts.hook === undefined ? Math.max(2.5, thickness * 0.55) : opts.hook;
    var hookDeep = opts.hookDeep === undefined ? Math.max(2, thickness * 0.45) : opts.hookDeep;
    var a = uCenter - w / 2, b = uCenter + w / 2;
    if (dir > 0) {
      /* 入口在 [a,b], 到底后往 +u 拐一个 hook */
      return [
        { u: a, v: 0 },
        { u: a, v: -depth },
        { u: b + hook, v: -depth },
        { u: b + hook, v: -(depth - hookDeep) },
        { u: b, v: -(depth - hookDeep) },
        { u: b, v: 0 }
      ];
    }
    return [
      { u: a, v: 0 },
      { u: a, v: -(depth - hookDeep) },
      { u: a - hook, v: -(depth - hookDeep) },
      { u: a - hook, v: -depth },
      { u: b, v: -depth },
      { u: b, v: 0 }
    ];
  }

  /* ============================================================
   * 斜口榫 / 镐尾榫 的“斜肩”轮廓 (mitred shoulder)
   *
   * 在外观上把榫头的肩部倒成斜面 —— 直刀切不出真斜面,
   * 但把肩部在**平面内**做成梯形, 装好后正面看不到直角缝, 视觉上很“中式”。
   * 仍然严格与 phase 互补的 socket 匹配(双方同时倒同一个量)。
   */
  function mitreTabProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, half = fit / 4;
    var cham = opts.chamfer === undefined ? Math.min(depth * 0.5, 4) : opts.chamfer;
    var prof = [], i, tabs = spans.tabs;
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] + half, u1 = tabs[i][1] - half;
      var c = Math.min(cham, (u1 - u0) / 2 - 0.2);
      if (u1 - u0 < 0.4) continue;
      prof.push({ u: u0, v: 0 });
      if (c > 0.05) {
        prof.push({ u: u0 + c, v: depth });
        prof.push({ u: u1 - c, v: depth });
      } else {
        prof.push({ u: u0, v: depth });
        prof.push({ u: u1, v: depth });
      }
      prof.push({ u: u1, v: 0 });
    }
    return prof;
  }

  /* ============================================================
   * 圆角直榫 (刷子头 / 防崩角)
   *
   * 榫头根部两个肩角倒圆。目的不是好看, 而是**应力集中**:
   * 直角肩是裂纹的起点, 海洋板(多层胶合板)沿层开裂就从这里开始。
   * 注意: 圆角开在**榫头根部**(v=0 侧), 与 tipRadius(开在顶部)正好相反。
   *
   * 【第 8 轮修的真实干涉 BUG】
   * 旧版把圆角画到榫头**外侧**: 起点 u0-rr、终点 u1+rr, 于是榫头在根部
   * 沿 u 向外胖出了 rr。而配对件的槽(socket/榫眼)只按名义 tabs 开,
   * 结果榫头根部两侧各多出 rr 的料 —— 插不进去。
   * 体素法实测(t=12 / 5 格 / 11°): 角接干涉体素 0.208%, 其余样式全为 0。
   * 边界采样也印证: v=0.01 处 u 区间是 [-1.41, 25.41] 而名义是 [0, 24],
   * 甚至**跑到 u<0 的板外**去了。
   *
   * 正解: 圆角必须往榫头**内侧**让(削掉榫头自己的根部材料), 榫头在任何
   * 高度上都不得超出名义 tabs 区间。于是 bulge 取 +90(弧朝 u 增大侧凸,
   * 即从榫头内部挖出一个凹圆角), 起止点都留在 [u0, u1] 内。
   * 代价是根部略窄一点点(rr 通常 1.5mm), 换来"永远装得进去"。
   * ============================================================ */
  function filletTabProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, half = fit / 4;
    var r = opts.rootRadius === undefined ? Math.min(1.5, depth * 0.2) : opts.rootRadius;
    var prof = [], i, tabs = spans.tabs;
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] + half, u1 = tabs[i][1] - half;
      if (u1 - u0 < 0.4) continue;
      var rr = Math.min(r, (u1 - u0) / 2 - 0.1, depth / 2);
      if (rr <= 0.05) {
        prof.push({ u: u0, v: 0 });
        prof.push({ u: u0, v: depth });
        prof.push({ u: u1, v: depth });
        prof.push({ u: u1, v: 0 });
        continue;
      }
      /* 根部凹圆角, 完全落在 [u0, u1] 内:
       *   (u0, 0) --弧--> (u0+rr, rr) 之后竖直上到榫顶
       * 弧的 bulge 取 +90: 从榫头内侧挖掉一个四分之一圆。 */
      prof.push({ u: u0, v: 0, b: G.bulgeOf(90) });
      prof.push({ u: u0 + rr, v: rr });
      prof.push({ u: u0 + rr, v: depth });
      prof.push({ u: u1 - rr, v: depth });
      prof.push({ u: u1 - rr, v: rr, b: G.bulgeOf(90) });
      prof.push({ u: u1, v: 0 });
    }
    return prof;
  }

  /* ============================================================
   * 木销对接 (dowel butt joint)
   * 两块板对接, 各钻一排孔, 插圆棒。没有任何榫头, 最省料、最省刀路,
   * 但靠胶。适合背板/内部不受力的板。
   *
   * 返回 {edgeHoles, faceHoles}:
   *   edgeHoles —— 开在**端面**(需侧向钻孔, 不能靠激光/CNC 上面完成)
   *   faceHoles —— 开在母件板面上(可直接切)
   * 所以导出时 edgeHoles 只能当"钻孔标记"给师傅看, 这一点必须说清楚。
   */
  function dowelPairs(f, L, thickness, opts) {
    opts = opts || {};
    var dia = opts.dia === undefined ? Math.max(5, thickness * 0.45) : opts.dia;
    var n = Math.max(2, Math.round(opts.count === undefined ? Math.max(2, L / 120) : opts.count));
    var inset = opts.inset === undefined ? Math.max(dia * 2, L * 0.12) : opts.inset;
    var faceHoles = [], marks = [], i;
    if (L - 2 * inset < 0) inset = L / 4;
    for (i = 0; i < n; i++) {
      var u = n === 1 ? L / 2 : inset + (L - 2 * inset) * i / (n - 1);
      var p = f.at(u, 0);
      faceHoles.push(G.ensureOrient(G.circle(p.x, p.y, dia), false));
      marks.push({ u: u, dia: dia });
    }
    return { faceHoles: faceHoles, marks: marks, dia: dia, count: n };
  }

  /* ============================================================
   * 饼干 / 骑马榛 (biscuit / domino slot)
   * 在两块板的对接面上各铣一个腻形槽, 塞入橄榄木饼干。
   * 与木销相比胶面积大得多, 而且对孔容错好(可沿槽长微调)。
   * 这里产出的是**定深铣槽**(pocket), 不切透。
   */
  function biscuitSlots(f, L, thickness, opts) {
    opts = opts || {};
    var wide = opts.wide === undefined ? Math.max(3.5, thickness * 0.28) : opts.wide;
    var len = opts.len === undefined ? Math.max(20, thickness * 2.5) : opts.len;
    var n = Math.max(1, Math.round(opts.count === undefined ? Math.max(2, L / 150) : opts.count));

    /* ============================================================
     * 【第 8 轮修的真实"槽跑到板外"缺陷】
     *
     * 旧版把 len 当作硬性尺寸, 只调整 inset。可 inset 的兜底是 L/4,
     * 于是第一个槽的中心就在 u = L/4, 而槽本身长 len —— len > L/2 时
     * 槽的左端 u = L/4 - len/2 直接是**负数**, 跑到板外。
     *
     * 实测(box t=25 / 400x300x120): 侧板高只有 70mm, 而饼干长
     * 2.5t = 62.5mm, 两个槽落在 u=17.5 与 52.5, 区间分别是
     * [-13.75, 48.75] 与 [21.25, 83.75] —— 两头都出界, 而且互相重叠。
     * 侧板各报 2 条"铣槽越出板边", 4752 个参数组合里就这 12 组静默出废图。
     *
     * 正解: 饼干是**买来的标准件**, 但"这条边放不下这么长的饼干"时
     * 唯一正确的做法是换小号饼干 / 减少个数, 而不是把槽切到板外。
     * 所以这里按可用长度反算: 先夹 len, 再按"槽间不重叠"夹 n,
     * 并把最终用的规格报出去(调用方据此写进料单, 用户才知道要买几号饼干)。
     * ============================================================ */
    var edge = Math.max(2, wide * 0.5);          // 槽端到板边的最小净料
    var avail = L - 2 * edge;
    var out = [], i, shrunk = false, dropped = 0;
    if (avail < 6) {
      /* 连一个最小的饼干都放不下 —— 这条边只能改用别的接合方式 */
      return { slots: [], len: 0, wide: wide, count: 0, shrunk: true, dropped: n, tooShort: true };
    }
    if (len > avail) { len = avail; shrunk = true; }
    /* n 个槽首尾中心分布在 [edge+len/2, L-edge-len/2], 相邻中心距必须 >= len + 间隙,
     * 否则两个槽会连成一条(那就不是两个饼干位了, 强度也不是叠加的)。 */
    var gap = Math.max(2, wide);
    var span = avail - len;                       // 中心可移动的总跨度
    var maxN = span > 0 ? Math.floor(span / (len + gap)) + 1 : 1;
    if (n > maxN) { dropped = n - maxN; n = Math.max(1, maxN); }
    for (i = 0; i < n; i++) {
      var uc = n === 1 ? L / 2 : (edge + len / 2) + span * i / (n - 1);
      out.push(G.ensureOrient(f.rectUV(uc - len / 2, -wide / 2, len, wide), false));
    }
    return {
      slots: out, len: len, wide: wide, count: n,
      shrunk: shrunk, dropped: dropped, tooShort: false
    };
  }

  /* 所有可选接合样式的元数据。UI 直接照这份清单渲染下拉框,
   * 新增一种只需在这里注册 + 在 profileFor 里接一下。
   * corner 字段 = 能否用于 90° 角接(燕尾类的不行, 详见 tabProfile 的证明)。 */
  /* ============================================================
   * 卡扣榫 (snap-fit barbed tab) —— 免胶、免五金、可反复拆装
   *
   * 榫头穿过母件后, 在**母件远端表面之外**长出一个倒钩(barb)勾住母件,
   * 于是不靠胶也拔不出来。要能塞进去, 榫头必须能瞬时变窄 ->
   * 沿榫头中线开一条通到尖端的**弹性缝**(slit), 两瓣可以捏合。
   *
   * 【为什么它不像燕尾那样必然干涉】
   * tabProfile 头部证明了: 90° 角接时 A 的轮廓只能随 q 变、B 只能随 p 变,
   * 两者的**公共分界面**必须是常数。关键在"公共" —— 倒钩位于 v > depth,
   * 也就是**已经穿出母件之外**, 那里根本没有母件的材料, 不构成分界面。
   * 所以装配完成态干涉严格为 0(体素法实测 0.000%), 干涉只发生在
   * **插入过程中**, 由弹性缝吸收。这是真能切、真能装的自锁结构。
   *
   * 代价(必须告诉用户):
   *   1) 倒钩会露在外表面之外 lip mm, 想齐平就装好后锯掉;
   *   2) 弹性缝把榫头劈成两瓣, 抗拉降低, 不要用在承重结构的主受力方向;
   *   3) 多层板顺层易崩, 板越厚越不"弹", 12mm 以上建议改楔钉榫。
   *
   * barb 逐侧夹紧: 倒钩只能长进**相邻的槽区**里, 否则会伸出板外自交。
   * 榫齿贴板端时(phase=0 的首末齿)那一侧自然拿不到倒钩, 单侧勾住也有效。
   */
  function snapTabProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, half = fit / 4;
    var tabs = spans.tabs, L = spans.L, prof = [], i;
    var lip = opts.lip === undefined ? Math.max(3, depth * 0.55) : opts.lip;
    var slit = opts.slit === undefined ? Math.max(1.2, depth * 0.12) : opts.slit;
    var back = opts.slitBack === undefined ? Math.max(depth * 0.9, 4) : opts.slitBack;
    /* 【弹性缝必须夹住, 否则真的会切出自交废图】
     * 缝要往板身里割 back mm 才有弹性长度, 但割进去的那一段会和
     *   (a) 垂直邻边上的缝     (b) 对面边上的缝
     * 撞在一起 -> 外轮廓自交。
     * (a) 用 spans.inset 挡: 本边第一个榫齿在 u >= inset, 而邻边的缝
     *     沿本边方向只伸到 back; 只要 back < inset 两者就不可能相交。
     * (b) 需要知道**垂直方向**的板宽, 边坐标系里拿不到 -> 由调用方传 maxBack
     *     (models/custom 传 0.35 * 垂直边长)。 */
    if (spans.inset > 0) back = Math.min(back, spans.inset * 0.8);
    if (opts.maxBack > 0) back = Math.min(back, opts.maxBack);
    back = Math.max(0, back);
    var nBarb = 0, nPlain = 0;
    for (i = 0; i < tabs.length; i++) {
      var u0 = tabs[i][0] + half, u1 = tabs[i][1] - half;
      var wide = u1 - u0;
      if (wide < 1) continue;
      var want = opts.barb === undefined ? Math.max(1.2, depth * 0.22) : opts.barb;
      want = Math.min(want, wide * 0.3);
      /* 倒钩只能占用相邻槽区的一部分, 留 40% 余量给刀和公差 */
      var loB = (i === 0 ? 0 : tabs[i - 1][1]);
      var hiB = (i === tabs.length - 1 ? L : tabs[i + 1][0]);
      /* 0.4 而不是 0.5: 相邻两个榫齿的倒钩**从两侧对着长进同一个槽区**,
       * 各取 0.6 时两者之和是槽宽的 1.2 倍 -> 必然穿插相交。
       * 各取 0.4 留下 0.2 倍槽宽的净空给刀径与公差。 */
      var bl = Math.min(want, Math.max(0, (u0 - loB) * 0.4));
      var br = Math.min(want, Math.max(0, (hiB - u1) * 0.4));
      if (bl < 0.3) bl = 0;
      if (br < 0.3) br = 0;
      if (bl || br) nBarb++; else nPlain++;
      /* 缝宽必须 >= 1mm: 再窄的缝平底铣刀进不去(最小 3.175mm 的刀根本不可能),
       * 激光也会因热影响把两瓣熔回一起 -> 等于没开缝, 卡扣塞不进去。
       * 宽度不够就干脆不开缝(退化成"硬倒钩", 靠板材自身弹性), 并在 prof 上报告。 */
      var sw = Math.min(slit, wide * 0.35);
      if (sw < 1) sw = 0;
      var uc = (u0 + u1) / 2;
      prof.push({ u: u0, v: 0 });
      prof.push({ u: u0, v: depth });
      if (bl) prof.push({ u: u0 - bl, v: depth });
      prof.push({ u: u0, v: depth + lip });
      if (sw > 0 && back > 0.5) {
        /* 弹性缝: 从尖端一直割进板身 back mm, 两瓣才捏得动。
         * 缝是**外轮廓的一部分**而不是一个封闭孔 —— 封闭孔割不断榫头, 等于没缝。 */
        prof.push({ u: uc - sw / 2, v: depth + lip });
        prof.push({ u: uc - sw / 2, v: -back });
        prof.push({ u: uc + sw / 2, v: -back });
        prof.push({ u: uc + sw / 2, v: depth + lip });
      }
      prof.push({ u: u1, v: depth + lip });
      if (br) prof.push({ u: u1 + br, v: depth });
      prof.push({ u: u1, v: depth });
      prof.push({ u: u1, v: 0 });
    }
    prof.lip = lip;
    prof.barbed = nBarb;
    prof.plain = nPlain;
    prof.slitWidth = Math.min(slit, 1e9);
    prof.slitBack = back;
    return prof;
  }

  /* ============================================================
   * 全长舌榫 (tongue) + 嵌槽 (dado / groove)
   *
   * 背板/层板最常见的做法: 母件内表面铣一条**定深槽**(不切透),
   * 子件整条边做成"舌"插进去。好处:
   *   · 外表面看不到任何榫眼(通榫背板会在侧板上留一排方孔);
   *   · 全长受力, 比 3 个榫齿抗剪好得多;
   *   · 槽本身就是定位基准, 装配不会歪。
   * 代价: 需要能**控深**的设备(CNC 铣 / 电木铣), 激光切不出来。
   *
   * 这里的"舌"就是一条从 inset 到 L-inset 的连续榫头, 深 = 槽深;
   * 槽由 grooveLoop() 给, 以 pocket(定深铣槽) 形式挂到母件上。
   */
  function tongueProfile(spans, depth, opts) {
    opts = opts || {};
    var fit = opts.fit || 0, half = fit / 4;
    var L = spans.L;
    var inset = tongueInsetOf(opts, L);
    var u0 = inset + half, u1 = L - inset - half;
    if (u1 - u0 < 1) return [];
    var prof = [
      { u: u0, v: 0 }, { u: u0, v: depth },
      { u: u1, v: depth }, { u: u1, v: 0 }
    ];
    prof.tongue = true;
    prof.inset = inset;
    return prof;
  }
  /* 【嵌槽必须"停"在板内, 不能开到板边】
   * 通长嵌槽(两端敞口)在木工上完全正常, 但这里有两个硬约束:
   *   1) Part.validate 要求 pocket 严格落在轮廓**内部**; 开到板边的槽
   *      边界与轮廓共线 -> 判为"铣槽越出板边", 整张图变非法(实测 box/drawer/table 各 2 条);
   *   2) 舌槽榫的卖点就是"外表面看不到榫眼", 槽一开到边就露在端面上, 卖点没了。
   * 所以两端都往里缩 inset, 做成**停止槽(stopped dado)**, 舌也同步缩短。
   * 默认取 0.45 倍板厚(至少 2mm): 太小挡不住视线, 太大会让舌的有效长度不够。 */
  function tongueInsetOf(opts, L) {
    var w = opts.tongueInset;
    if (!(w > 0)) w = Math.max(2, (opts.thickness || 12) * 0.45);
    return Math.min(w, Math.max(0, L / 2 - 2));
  }

  /* 所有可选接合样式的元数据。UI 直接照这份清单渲染下拉框,
   * 新增一种只需在这里注册 + 在 profileFor 里接一下。
   *
   * 能力位(一律显式声明, 不许靠猜):
   *   corner —— 能否用于 90° 角接/T 接(燕尾类的不行, 详见 tabProfile 的证明)
   *   mid    —— 能否用于板中部对接(子件端面顶在母件板面上)
   *   flat   —— 不改轮廓, 靠额外五金/嵌件(木销/饼干)
   *   depth  —— 是否需要**控深**设备(定深铣槽, 激光做不到)
   *   grow   —— 装好后是否会**突出**公称外表面(卡扣的倒钩、楔钉的穿出段)
   */
  var STYLES = [
    { key: 'finger', label: '直榫 / 指接', corner: true, mid: true, hint: '最通用、最结实。齿数强制奇数以保证左右对称。' },
    { key: 'round', label: '圆头直榫', corner: true, mid: true, hint: '榫头顶部倒圆，好插入；CNC 铣切时不用额外让位。' },
    { key: 'fillet', label: '圆角直榫（防崩）', corner: true, mid: true, hint: '榫头根部倒圆，避开应力集中；海洋板沿层开裂就从直角肩开始。' },
    { key: 'mitre', label: '斜肩榫（视觉无缝）', corner: true, mid: true, hint: '肩部做成梯形，装好后正面看不到直角缝。' },
    {
      /* corner:false 是几何结论而非保守: 箱体的角接是两块板**互补咬合**,
       * 双方都出榫、谁也没有通孔, 楔子无处可楔。楔钉榫必须有母件的通榫眼
       * 才能"穿出去再楔紧", 所以它只能用在中部接合(层板/背板/横撑)。 */
      key: 'wedge', label: '楔钉榫（可拆装）', corner: false, mid: true, grow: true,
      hint: '榫头穿过母件后多伸出一段，敲一片楔子抽紧。免胶免五金、能反复拆装；只能用于层板/背板这类穿过母件的接合。'
    },
    {
      /* 同理: 倒钩要勾住母件的**远端表面**, 没有通孔就没有可勾的面。 */
      key: 'snap', label: '卡扣榫（免胶自锁）', corner: false, mid: true, grow: true,
      hint: '榫头穿过母件后长一个倒钩勾住背面，中线开弹性缝好捏进去。免胶免五金，倒钩会露在外面；只能用于穿过母件的接合。'
    },
    {
      key: 'dowel', label: '木销对接', corner: true, mid: true, flat: true, overlap: true,
      hint: '没榫头，最省料最省刀路；母件板面上的销孔能直接切，子件端面要另外侧向钻孔。四角改为"盖板压侧板"叠合式。'
    },
    {
      key: 'biscuit', label: '饼干 / 骑马榫', corner: true, mid: true, flat: true, depth: true, overlap: true,
      hint: '对接面各铣一个腰槽塞饼干，胶面大、对位容错好；需要能控深的设备。'
    },
    {
      /* 【corner:false 是量出来的, 不是保守】
       * 嵌槽的净宽 = 板厚 + fit。四角处这条槽的中心线只能落在侧板的中心面上,
       * 也就是距外沿 t/2 处 -> 槽的外侧壁落在 -fit/2, **已经在板外**。
       * 实测(box t=15/fit=0.2): 顶底板各报 2 条"铣槽越出板边", 共 4 条。
       * 想合法就得把槽往里挪 >= t/2, 那样顶底板会比标称 W 各外伸 t/2,
       * 等于悄悄改掉用户填的外形尺寸 —— 不能这么干。
       * 所以四角退回直榫(照样结实), 嵌槽用在它真正的主场: 层板/背板。 */
      key: 'tongue', label: '舌槽榫 / 嵌槽', corner: false, mid: true, depth: true,
      hint: '母件板面铣一条定深槽，子件整条边做成舌插进去。外表面看不到榫眼、全长受力，是层板/背板的最佳做法；箱体四角放不下这条槽，会自动改用直榫。'
    },
    {
      key: 'dovetail', label: '燕尾榫（仅共面拼板）', corner: false, mid: false,
      hint: '90° 角接用燕尾在直刀通切下必然干涉，已自动降为直榫；拼宽台面时才真自锁。'
    },
    {
      key: 'puzzle', label: '拼图燕尾（拼宽板）', corner: false, mid: false,
      hint: '两块板同平面对拼加宽，拉伸方向真自锁。'
    }
  ];
  var STYLE_BY_KEY = {};
  STYLES.forEach(function (o) { STYLE_BY_KEY[o.key] = o; });

  /* 十字搭接的两种口径。搭接不是"榫头样式"的一种 —— 它没有榫头,
   * 所以单独一张表, UI 上也是单独一个下拉框。 */
  var LAP_STYLES = [
    { key: 'plain', label: '平口半槽（好插）', hint: '最常见：两片各切一半深度对插。加工最简单，但沿槽长方向一抽就开。' },
    { key: 'hook', label: '勾齿半槽（防抽出）', hint: '槽底多开一个侧向小口，插到底再横推一点就锁住，不靠胶也抽不出来。' }
  ];
  var LAP_BY_KEY = {};
  LAP_STYLES.forEach(function (o) { LAP_BY_KEY[o.key] = o; });

  /* 某样式能否用在某种接合场合。kind: 'corner' | 'mid'
   * 不认识的样式一律返回 false —— 让调用方去报错, 而不是在这里静默放过。 */
  function styleOk(style, kind) {
    var st = STYLE_BY_KEY[style];
    if (!st) return false;
    if (kind === 'corner') return st.corner !== false;
    if (kind === 'mid') return st.mid !== false;
    return true;
  }
  /* 该场合下可用的样式清单(给 UI 过滤下拉框用) */
  function stylesFor(kind) {
    return STYLES.filter(function (st) { return styleOk(st.key, kind); });
  }
  /* 把"用户选的样式"解析成"这个场合真能用的样式"。
   * 一律显式返回降级信息 —— 静默降级会让用户以为自己做出了燕尾柜。
   *   kind='corner' 箱体四角互补咬合(双方都出榫, 没有通孔)
   *   kind='mid'    子件端面顶在母件板面上(母件有通榫眼可穿过去)
   * 返回 { style, from, fell, reason } */
  function resolveStyle(style, kind) {
    var st = STYLE_BY_KEY[style];
    if (!st) {
      return { style: 'finger', from: style, fell: true, reason: 'unknown' };
    }
    if (styleOk(style, kind)) return { style: style, from: style, fell: false, reason: '' };
    return { style: 'finger', from: style, fell: true, reason: kind };
  }
  var KIND_CN = { corner: '箱体四角', mid: '板中部对接' };
  /* 降级的人话解释。为什么必须一句一句说清楚: 这些"不能用"全都是**几何结论**,
   * 用户没有办法从界面上看出来, 只会觉得"我选了燕尾怎么切出来是直榫"。 */
  function fallbackText(rs, kind) {
    var st = STYLE_BY_KEY[rs.from];
    var name = st ? st.label : ('「' + rs.from + '」');
    if (rs.reason === 'unknown') {
      return '未知接合方式「' + rs.from + '」，已按直榫处理。可选：' +
        STYLES.map(function (o) { return o.key; }).join(' / ');
    }
    var why;
    if (rs.from === 'dovetail' || rs.from === 'puzzle') {
      why = '直刀通切时燕尾在 90° 接合处必然干涉（详见说明），拼宽台面才真自锁';
    } else if (rs.from === 'wedge' || rs.from === 'snap') {
      why = '它要靠"穿过母件后在背面楔紧/勾住"，而' + (KIND_CN[kind] || kind) +
        '处两块板是互补咬合、谁也没有通孔，楔子和倒钩无处可用';
    } else if (rs.from === 'tongue') {
      why = '嵌槽要铣在母件的**板面**上，而' + (KIND_CN[kind] || kind) + '处只有端面，槽没地方开';
    } else {
      why = (KIND_CN[kind] || kind) + '处用不了它';
    }
    return name + '：' + why + '，此处已改用直榫。';
  }

  /* 统一入口: 根据 style 选轮廓函数。
   * 不认识的 style **不得静默退化** —— 退化了用户永远不知道自己拼错了名字。
   *
   * 返回的 profile 上会挂 .spans / .style / .depth:
   * 下游(models/custom)要据此生成**样式专属的附加特征**
   * (木销孔、饼干槽、楔口、卡扣缝……)。没有这三个字段就只能生成"光轮廓",
   * 于是 dowel/biscuit 这类"轮廓不变"的样式等于什么都没做 —— 那是第 8 轮
   * 真实踩到的坑: 选了木销对接, 图纸上一个孔都没有。 */
  function profileFor(style, spans, depth, opts) {
    var prof = rawProfileFor(style, spans, depth, opts || {});
    if (prof) {
      prof.spans = spans;
      prof.style = style;
      prof.depth = depth;
    }
    return prof;
  }
  function rawProfileFor(style, spans, depth, opts) {
    switch (style) {
      case 'puzzle': return puzzleProfile(spans, depth, opts);
      case 'wedge': return wedgeTenonProfile(spans, depth, opts);
      case 'mitre': return mitreTabProfile(spans, depth, opts);
      case 'fillet': return filletTabProfile(spans, depth, opts);
      case 'snap': return snapTabProfile(spans, depth, opts);
      case 'tongue':
        /* 舌的凸出量 = 槽深, 不是板厚。depth 传进来是"配合板厚",
         * 舌插进定深槽里, 伸出量只能是槽深(留 0.3mm 不顶底)。 */
        return tongueProfile(spans, Math.min(opts.grooveDepth || Math.max(3, depth * 0.5), depth * 0.7),
          Object.assign({ thickness: depth }, opts));
      case 'round':
        return tabProfile(spans, depth, Object.assign({}, opts, {
          style: 'finger',
          tipRadius: opts.tipRadius || Math.min(depth * 0.35, 2.5)
        }));
      case 'dovetail':
        /* 共面拼板场景才能真张角; 角接场景会在 tabProfile 里自动降级 */
        return tabProfile(spans, depth, opts);
      case 'dowel':
      case 'biscuit':
        /* 这两种不改轮廓(平对接), 孔/槽由 styleExtras 另行生成。
         * 注意仍然返回一个**带 .spans 的空数组**: panel() 见 length===0 会跳过,
         * 而下游据 .spans 知道该在哪些位置打孔。 */
        return [];
      default: return tabProfile(spans, depth, opts);
    }
  }
  /* 该样式是否靠"平对接 + 额外五金/嵌件"而不靠轮廓互锁 */
  function isFlatStyle(style) { return style === 'dowel' || style === 'biscuit'; }

  /* 【这个判据决定了整个箱体的下料尺寸, 是第 8 轮抓到的最深的一个缺陷】
   *
   * 指接类靠"双方都出榫、在角部立方体里互补咬合"成型: 顶底板画成 W-2t、
   * 侧板画成 H-2t, 各自的榫头再伸出 t 补齐到 W / H。
   *
   * 但木销/饼干/舌槽**没有榫头**。把它们套进同一套尺寸的话:
   *   顶底板 x ∈ [t, W-t]、侧板 x ∈ [0, t] —— 两者在 x 上根本不重叠,
   *   z 方向也一样(顶底板 z ∈ [0,t]、侧板 z ∈ [t, H-t])。
   *   于是角部立方体是**空的**, 两块板只是端面对着端面碰在一条棱上:
   *   销孔得钻在两个端面上(平板机床都做不到), 槽更是无处可铣。
   *   整套柜子实际上是散的 —— 而包围盒却仍然等于 W×D×H, 连断言都抓不到。
   *
   * 正解是换一套构造: **盖板压侧板**(overlap)。
   *   顶底板画成整个 W×D(压在最外面), 侧板夹在中间(z ∈ [t, H-t]),
   *   侧板的端面正对顶底板的**板面** -> 销孔/饼干槽/嵌槽全都开在板面上, 能切。
   * 这也正是所有平板家具(宜家式)的实际做法。
   *
   * 返回 true 的样式在 models/custom 里必须走 overlap 构造。 */
  function needsFaceOverlap(style) {
    var st = STYLE_BY_KEY[style];
    return !!(st && st.overlap);
  }

  /* 该样式的榫头会**穿出母件外表面**多少 mm。
   *
   * 为什么必须能算出来: 楔钉榫/卡扣榫的穿出段是**有意为之**(不穿出就没法楔、
   * 没法勾), 于是装配包围盒必然大于用户填的 W/D/H。
   *   实测 box t=15: 楔钉 600 -> 627 (每侧 13.5 = 0.9t), 卡扣 600 -> 616.5 (每侧 8.25)。
   * 这既不是错位也不是 bug, 但**必须能被断言覆盖** —— 否则
   * "装配包围盒 == 标称尺寸"这条护栏一旦为了迁就它而放宽, 真正的错位
   * (整块板偏半个板厚那类)就再也抓不住了。
   * 所以这里把穿出量算成确定值, 由 models 报进 info.grow, 测试按
   * 「标称 + 2*grow」来核对, 护栏精度一分不降。 */
  function growOf(style, thickness, opts) {
    opts = opts || {};
    if (style === 'wedge') {
      return opts.ext === undefined ? thickness * 0.9 : opts.ext;
    }
    if (style === 'snap') {
      return opts.lip === undefined ? Math.max(3, thickness * 0.55) : opts.lip;
    }
    return 0;
  }

  /* ============================================================
   * 样式专属附加特征 (styleExtras)
   *
   * 有些接合方式**不是**靠外轮廓完成的:
   *   · dowel   子件端面钻孔(切不出来, 只能给标记) + 母件板面钻孔(能切)
   *   · biscuit 两侧各铣一个腰形定深槽
   *   · wedge   榫头穿出段上开斜楔口 + 一片独立楔子
   * 若只调 profileFor 就收工, 这几种等于"什么都没做"。
   *
   * 统一约定(必须由调用方遵守):
   *   side = 'tab'  —— 出榫/子件那一侧, f 是该边的 frame(v>0 离开材料)
   *   side = 'host' —— 开眼/母件那一侧, f 是接合线的 frame(v>0 指向子件)
   * 返回 { holes, pockets:[{loop,depth,note}], marks, notes, extraParts }
   * 全部已经映射到该零件的局部 2D 坐标, 直接挂到 Part 上即可。
   */
  function styleExtras(style, spans, f, thickness, side, opts) {
    opts = opts || {};
    var out = { holes: [], pockets: [], marks: [], notes: [], extraParts: [] };
    if (!spans || !f) return out;
    var t = thickness;
    if (style === 'dowel') {
      var dp = dowelPairs(f, spans.L, t, opts);
      if (side === 'host') {
        dp.faceHoles.forEach(function (h) { out.holes.push(h); });
        out.notes.push('木销孔 ' + dp.count + '×φ' + G.round(dp.dia, 1));
      } else {
        /* 端面孔切不出来 -> 只给圆形标记 + 说明, 让师傅拿夹具钻 */
        dp.marks.forEach(function (m) {
          var p = f.at(m.u, 0);
          out.marks.push({ type: 'circle', x: p.x, y: p.y, d: m.dia, note: '端面销孔' });
        });
        out.notes.push('端面需侧向钻 ' + dp.count + '×φ' + G.round(dp.dia, 1) + ' 销孔');
      }
      return out;
    }
    if (style === 'biscuit') {
      var bs = biscuitSlots(f, spans.L, t, opts);
      var d = Math.min(opts.slotDepth === undefined ? t * 0.45 : opts.slotDepth, t * 0.7);
      if (bs.tooShort) {
        /* 这条边太短, 放不下任何饼干。必须说出来 —— 静默跳过的话
         * 用户会以为这处接合做好了, 实际上两块板之间什么都没有。 */
        out.notes.push('此边仅 ' + G.round(spans.L, 0) + 'mm，放不下饼干槽，该处需改用木销或自攻螺丝');
        return out;
      }
      if (side === 'host') {
        bs.slots.forEach(function (l) { out.pockets.push({ loop: l, depth: d, note: '饼干槽' }); });
        out.notes.push('饼干槽 ' + bs.count + '×' + G.round(bs.len, 0) + '×' + G.round(bs.wide, 1) +
          (bs.shrunk ? '(受边长限制已缩短)' : '') + (bs.dropped ? '(已减 ' + bs.dropped + ' 个)' : ''));
      } else {
        bs.slots.forEach(function (l) {
          var b = G.loopBBox(l);
          out.marks.push({
            type: 'circle', x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2,
            d: bs.wide, note: '端面饼干槽'
          });
        });
        out.notes.push('端面需铣 ' + bs.count + ' 个饼干槽(饼干机/控深铣)');
      }
      return out;
    }
    if (style === 'tongue') {
      /* 舌槽: 母件铣一条**定深**通长槽(不切透 -> pocket), 子件的舌由 tongueProfile 出。
       * 槽必须比舌略宽(fit) 且略深(0.3mm 余量), 否则舌顶到槽底、肩合不严。 */
      var gd = opts.grooveDepth === undefined ? Math.max(3, t * 0.5) : opts.grooveDepth;
      gd = Math.min(gd, t * 0.7);
      var gi = tongueInsetOf(Object.assign({ thickness: t }, opts), spans.L);
      if (side === 'host') {
        var gw = t + (opts.fit || 0);
        /* 【槽必须比舌略长】平底铣刀在槽的两端各留一个 r 的圆角,
         * 而舌的端头是方的 —— 槽和舌一样长时那两个圆角就把舌顶住,
         * 肩合不严(缝隙 = r), 用户会以为是尺寸算错了。
         * 两端各多铣 endGap(默认 1.5mm, 够 3.175 刀的圆角), 但不许因此顶到板边。 */
        var eg = Math.min(opts.grooveEndGap === undefined ? 1.5 : opts.grooveEndGap, gi * 0.6);
        var gu0 = gi - eg, gLen = Math.max(0, spans.L - 2 * gi + 2 * eg);
        if (gLen > 1) {
          var gl = f.rectUV(gu0, -gw / 2, gLen, gw);
          out.pockets.push({ loop: G.ensureOrient(gl, false), depth: gd + 0.3, note: '嵌槽' });
          out.notes.push('停止嵌槽 ' + G.round(gw, 1) + '×长' + G.round(gLen, 0) +
            '×深' + G.round(gd + 0.3, 1) + '(两端各缩 ' + G.round(gi - eg, 1) + 'mm，端面看不到)');
        }
      } else {
        out.notes.push('全长舌 深' + G.round(gd, 1) + '，两端各缩 ' + G.round(gi, 1) + 'mm(插进对件停止嵌槽)');
      }
      return out;
    }
    if (style === 'wedge' && side === 'tab') {
      var ws = wedgeSlots(spans, f, t, opts);
      ws.forEach(function (l) { out.holes.push(l); });
      if (ws.length) {
        out.notes.push('楔口 ' + ws.length + ' 处');
        out.extraParts.push({ kind: 'wedge', loop: wedgePart(t, opts), count: ws.length });
      }
      return out;
    }
    return out;
  }

  /* ---------------- 常用孔位 ---------------- */
  function shelfPinHoles(x, y0, y1, pitch, dia, ccw) {
    var out = [], y;
    for (y = y0; y <= y1 + 1e-9; y += pitch) out.push(G.ensureOrient(G.circle(x, y, dia), false));
    return out;
  }
  function boltCrossDowel(f, u, opts) {
    opts = opts || {};
    var boltD = opts.boltD || 6.5, dowelD = opts.dowelD || 10, dowelDepth = opts.dowelDepth || 24;
    var holes = [];
    holes.push({ kind: 'bolt', loop: G.ensureOrient(G.circle(f.at(u, 0).x, f.at(u, 0).y, boltD), false) });
    var p = f.at(u, -dowelDepth);
    holes.push({ kind: 'dowel', loop: G.ensureOrient(G.circle(p.x, p.y, dowelD), false) });
    return holes;
  }

  /* ---------------- 榫卯校核 ---------------- */
  function checkJoint(spec) {
    var msgs = [];
    var t = spec.thickness, L = spec.edgeLen, m = spec.m, seg = L / m;
    if (seg < t * 0.8) msgs.push({ level: 'warn', text: '榫齿宽 ' + G.round(seg, 1) + 'mm 小于 0.8 倍板厚，易崩齿' });
    if (spec.relief && spec.relief > seg / 2.5) msgs.push({ level: 'warn', text: '让位半径过大，会削弱榫齿' });
    if (spec.fit > 0.4) msgs.push({ level: 'warn', text: '配合间隙 ' + spec.fit + 'mm 偏大，接合会松动' });
    if (spec.fit < 0) msgs.push({ level: 'error', text: '配合间隙不能为负' });
    return msgs;
  }

  global.J = {
    suggestSegs: suggestSegs,
    spansFor: spansFor,
    tabProfile: tabProfile,
    fingerRecessProfile: fingerRecessProfile,
    socketProfile: socketProfile,
    puzzleProfile: puzzleProfile,
    wedgeTenonProfile: wedgeTenonProfile, wedgeSlots: wedgeSlots, wedgePart: wedgePart,
    hookLapProfile: hookLapProfile,
    mitreTabProfile: mitreTabProfile, filletTabProfile: filletTabProfile,
    snapTabProfile: snapTabProfile, tongueProfile: tongueProfile,
    dowelPairs: dowelPairs, biscuitSlots: biscuitSlots,
    STYLES: STYLES, STYLE_BY_KEY: STYLE_BY_KEY, profileFor: profileFor, isFlatStyle: isFlatStyle,
    LAP_STYLES: LAP_STYLES, LAP_BY_KEY: LAP_BY_KEY,
    styleOk: styleOk, stylesFor: stylesFor, styleExtras: styleExtras,
    needsFaceOverlap: needsFaceOverlap, growOf: growOf,
    resolveStyle: resolveStyle, fallbackText: fallbackText,
    mortisesFromSpans: mortisesFromSpans,
    applyRelief: applyRelief,
    grooveLoop: grooveLoop,
    lapNotchProfile: lapNotchProfile,
    shelfPinHoles: shelfPinHoles,
    boltCrossDowel: boltCrossDowel,
    checkJoint: checkJoint
  };
})(typeof window !== 'undefined' ? window : this);
