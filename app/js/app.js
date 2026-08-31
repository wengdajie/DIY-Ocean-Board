/* ============================================================
 * app.js - UI 控制器
 * ============================================================ */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var G = window.G;

  var state = {
    /* 【第 9 轮: "家具类型"已并入结构配方】
     * model 只剩两个取值: 'custom'(结构配方/板位表/零件清单) 与 'image'。
     * 原来的 box/bookshelf/drawer/lattice/table 现在是 Custom.RECIPES 里的 5 个配方,
     * 与其他 11 个配方完全同构(同一个下拉框、同一套参数表单)。
     * 为何要合: 旧版两套入口各自一套参数表(EXTRA vs RECIPES.fields)、
     * 各自一套默认尺寸(DEFAULTS vs 硬编码), 新增一个结构要想清两边都改;
     * 而用户看到的是"家具类型"和"结构配方"两个概念重叠的入口。 */
    model: 'custom',
    result: null,
    nest: null,
    /* 图片模式: 源 ImageData 缓存在这里。参数变化时**只重新描摹**, 不重读文件,
     * 这样拖滑块能实时预览。 */
    image: { data: null, name: '', mask: null, maskBBox: null },
    imode: 'silhouette',
    pmode: 'overlay',
    /* ---- 自定义模式(重构版) ----
     * cmode: list 零件清单 | recipe 结构配方 | panels 板位表
     * rows / panels / recipeParams 是"活数据", 由 editor.js 直接改, 改完调 generate()。
     * 不再让用户手写 JSON。 */
    cmode: 'recipe',
    rows: [],
    panels: [],
    recipe: 'box',
    recipeGroup: '*',
    recipeParams: {},
    sel: null,
    selMulti: [],           /* 多选集(板位表对齐用) */
    planHit: null,
    planPick: null,
    view: {
      nest: { zoom: 1, panX: 0, panY: 0 },
      asm: { zoom: 1, ang: 30, tilt: 0.55, explode: 0, panX: 0, panY: 0, sel: null, hover: null, solid: true }
    },
    pane: 'nest'
  };

  /* 【EXTRA / DEFAULTS / buildExtra 已删除】
   *
   * 它们是"家具类型"那套入口的专属参数表与默认尺寸。
   * 家具类型并入 Custom.RECIPES 后, 这两张表的职责完全被
   * RECIPES[key].fields 与 RECIPES[key].dims 取代 —— 同一张表、同一个渲染函数
   * (buildRecipeFields)。保留两套的真正代价不是多写几行,
   * 而是**新增一种结构时很容易只改一边**, 然后那个参数默默失效。
   *
   * 图片模式的默认尺寸单独留着: 它不走配方。 */
  var IMAGE_DIMS = { width: 240, depth: 120, height: 300, thickness: 12 };

  /* 把一组推荐尺寸写进输入框。返回是否真的改动了东西。 */
  function applyDims(d) {
    if (!d) return false;
    var changed = false;
    [['width', 'width'], ['depth', 'depth'], ['height', 'height'], ['thickness', 'thickness']]
      .forEach(function (kv) {
        if (d[kv[1]] === undefined) return;
        var el = $(kv[0]);
        if (!el) return;
        if (String(el.value) !== String(d[kv[1]])) changed = true;
        el.value = d[kv[1]];
      });
    syncThickness();
    return changed;
  }


  /* 板厚统一入口。旧版是 <select>, 只能选 9/12/15/18/21/25 六个值;
   * 现在是自由输入, 但自由输入就会有人填空/填 0/填 500 ——
   * 板厚一旦为 0, J.spansFor 算出来的榟宽全是 0, 整张图红报错。
   * 所以在入口夹住 3..60, 并在 UI 上说清楚。 */
  var T_MIN = 3, T_MAX = 60;
  function readThickness() {
    var raw = parseFloat($('thickness').value);
    if (!isFinite(raw) || raw <= 0) return { t: 15, bad: 'empty', raw: $('thickness').value };
    var t = Math.min(T_MAX, Math.max(T_MIN, raw));
    return { t: t, bad: Math.abs(t - raw) > 1e-9 ? 'clamped' : null, raw: raw };
  }
  function thicknessOf() { return readThickness().t; }

  /* CNC 刀具直径。与板厚同理: 自由输入 + 入口夹紧 + UI 说清楚。
   * 3.175mm(1/8") 与 6.35mm(1/4") 是最常见的两支平底铣刀。 */
  var TD_MIN = 0.3, TD_MAX = 25;
  function readToolDia() {
    var raw = parseFloat($('toolDia').value);
    if (!isFinite(raw) || raw <= 0) return { d: 3.175, bad: 'empty', raw: $('toolDia').value };
    var d = Math.min(TD_MAX, Math.max(TD_MIN, raw));
    return { d: d, bad: Math.abs(d - raw) > 1e-9 ? 'clamped' : null, raw: raw };
  }
  /* T-bone 耳槽长度系数(× 刀半径)。
   * 2 是**下限而非口味**: 刀心离入边至少 r、离角点也至少 r,
   * 耳长只有 1r 时刀心根本走不到角点法线上, 残料只减 13%(实测)。 */
  function readEarLen() {
    var v = parseFloat($('earLen').value);
    if (!isFinite(v)) return 2;
    return Math.min(4, Math.max(1, v));
  }

  /* ---------- 样式专属尺寸字段 ----------
   *
   * 这 14 个输入框都是“某一种接合样式才用得上”的尺寸。
   * 全部 value="0", 语义是「0 = 自动」—— 因为这些量全是板厚的函数
   * (snapLip = max(3, 0.55t) 之类), 写死数字会导致改板厚后不再跟着算。
   * readParams 只在 >0 时写进 p -> joints.js 里
   * `opts.x === undefined ? 按板厚算 : opts.x` 那个分支才能生效。 */
  var JSX_FIELDS = [
    'tipRadius', 'rootRadius', 'chamfer',
    'wedgeExt', 'wedgeSlotW', 'wedgeTaper',
    'snapLip', 'snapBarb', 'snapSlit',
    'grooveDepth', 'dowelDia', 'dowelCount',
    'biscuitWide', 'biscuitLen'
  ];
  /* 样式 -> 该露哪几行。没列在这里的样式一行不露。 */
  var JSX_ROWS = {
    round: ['tipRow'],
    fillet: ['rootRow'],
    mitre: ['chamRow'],
    wedge: ['wxRow', 'wsRow', 'wtRow'],
    snap: ['slipRow', 'sbarbRow', 'sslitRow'],
    tongue: ['gdRow'],
    dowel: ['ddRow', 'dcRow'],
    biscuit: ['bwRow', 'blRow', 'gdRow'],
    dovetail: ['rootRow'],
    puzzle: ['rootRow']
  };
  var JSX_ALL_ROWS = (function () {
    var seen = {}, out = [];
    Object.keys(JSX_ROWS).forEach(function (k) {
      JSX_ROWS[k].forEach(function (r) { if (!seen[r]) { seen[r] = 1; out.push(r); } });
    });
    out.push('jsxHint');
    return out;
  })();

  function readParams() {
    var p = {
      width: +$('width').value, depth: +$('depth').value, height: +$('height').value,
      thickness: thicknessOf(),
      fit: +$('fit').value,
      jointStyle: $('jointStyle').value,
      lapStyle: $('lapStyle').value,
      dovetailAngle: +$('dovetailAngle').value,
      fingerW: +$('fingerW').value || 0
    };
    /* 样式专属尺寸: 全部"0 = 自动"。
     * 为何不给非零默认值: 这些量全部是**板厚的函数**
     * (倒钩外伸 = max(3, 0.55t)、嵌槽深 = max(3, 0.5t) ...)。
     * 写死一个数字到输入框里, 用户一改板厚就不再跟着算 ->
     * 25mm 板配 3mm 倒钩(根本勾不住)。所以 0 传 undefined 交给 joints.js 算。 */
    JSX_FIELDS.forEach(function (k) {
      var el = $(k);
      if (!el) return;
      var v = parseFloat(el.value);
      if (isFinite(v) && v > 0) p[k] = v;
    });
    var machine = $('machine').value;
    if (machine === 'cnc') {
      /* 让位半径 = 刀半径。刀径自由输入, 但要夹住:
       * 填 0 会让 applyRelief 变成恒等(用户以为让位了其实没有),
       * 填 500 会把整块板吃掉。范围与 UI 上的 min/max 一致。 */
      var td = readToolDia();
      p.toolDia = td.d;
      p.relief = td.d / 2;
      p.reliefType = $('reliefType').value;
      p.earLen = readEarLen();
    } else {
      p.relief = 0; p.reliefType = 'none';
    }

    if (state.model === 'image') {
      p.autoThreshold = $('autoThreshold').checked;
      p.threshold = +$('threshold').value;
      p.invert = $('invert').checked;
      p.alphaOnly = $('alphaOnly').checked;
      p.despeckle = (+$('despeckle').value || 0) / 10000;   // 滑块 0..60 => 0..0.6%
      p.simplify = +$('simplify').value;
      p.smooth = $('smooth').checked;
      p.targetWidth = +$('targetWidth').value || 0;
      p.targetHeight = +$('targetHeight').value || 0;
      p.imode = state.imode;
      if (state.imode === 'silhouette') {
        p.standStyle = $('standStyle').value;
        p.tenonWidth = +$('tenonWidth').value;
        p.baseDepth = +$('baseDepth').value || 0;
        p.baseMargin = +$('baseMargin').value;
        p.minPartArea = +$('minPartArea').value;
        p.maxParts = +$('maxParts').value;
      } else {
        p.layerCount = +$('layerCount').value;
        p.pinDia = +$('pinDia').value || 0;
        p.maxPerLayer = +$('maxPerLayer').value;
      }
    } else if (state.model === 'custom') {
      p.tenonCount = +$('tenonCount').value || 3;
      p.cmode = state.cmode;
      p.recipe = state.recipe;
      p.recipeParams = state.recipeParams;
    }
    /* 实测板厚: 海洋板标称 15 常有 ±0.5 偏差。填了就用实测值算榫眼/槽宽,
     * 否则榫头按 15 做、板其实 14.6, 装上去就是晃。*/
    var real = +$('realThickness').value || 0;
    if (real > 0) {
      p.nominalThickness = p.thickness;
      p.thickness = real;
      p.thicknessMeasured = true;
    }
    return p;
  }

  /* "300, 600" -> [300,600]；容错空串/多余逗号/中文逗号 */
  function parseNums(str) {
    return String(str || '').replace(/，/g, ',').split(/[,\s]+/)
      .map(function (v) { return parseFloat(v); })
      .filter(function (v) { return isFinite(v); });
  }
  function sheetOpts() {
    var wh = $('sheetSize').value.split('x');
    return {
      w: +wh[0], h: +wh[1],
      margin: +$('margin').value, gap: +$('gap').value, allowRotate: true,
      respectGrain: $('respectGrain').checked,
      strategy: ($('nestStrategy') && $('nestStrategy').value) || 'auto'
    };
  }

  /* ---------- 生成 ---------- */
  /* ---------- 各模式统一入口: 返回 {parts, warnings, info} ---------- */
  function buildResult(p) {
    if (state.model === 'image') return buildImage(p);
    if (state.model === 'custom') return buildCustom(p);
    return (Models[state.model] || Models.box)(p);
  }

  function buildImage(p) {
    if (!state.image.data) {
      return { parts: [], warnings: [{ level: 'info', text: '请先上传一张图片（拖入左侧虚线框 / 点击选择 / Ctrl+V 粘贴），或点"示例"试一下' }], info: {} };
    }
    var q = {
      thickness: p.thickness, fit: p.fit, relief: p.relief, reliefType: p.reliefType,
      simplify: p.simplify, smooth: p.smooth,
      autoThreshold: p.autoThreshold, threshold: p.threshold,
      invert: p.invert, alphaOnly: p.alphaOnly, despeckle: p.despeckle,
      targetWidth: p.targetWidth, targetHeight: p.targetHeight
    };
    var r;
    if (p.imode === 'layers') {
      q.layerCount = p.layerCount; q.pinDia = p.pinDia; q.maxPerLayer = p.maxPerLayer;
      r = ImageModel.layers(state.image.data, q);
    } else {
      q.standStyle = p.standStyle; q.tenonWidth = p.tenonWidth;
      q.baseDepth = p.baseDepth; q.baseMargin = p.baseMargin;
      q.minPartArea = p.minPartArea; q.maxParts = p.maxParts;
      r = ImageModel.silhouette(state.image.data, q);
    }
    // 缓存掩膜供预览
    state.image.mask = r.mask || null;
    state.image.maskBBox = r.maskBBox || null;
    if (r.info && r.info.threshold !== undefined && p.autoThreshold) {
      // 自动阈值时把结果回填到滑块, 用户可接着微调
      $('threshold').value = r.info.threshold;
      $('thVal').textContent = r.info.threshold + '(自动)';
    }
    return r;
  }

  /* 接合相关参数的统一转发。
   * 单独抽出来是因为它要喲给**三个**入口(板位表/配方/家具模型),
   * 之前靠逐个列举字段, 新增一个参数就会漏到其中一两处 ——
   * 而漏了也不报错, 只是那个输入框默默失效。 */
  function jointArgs(p) {
    var o = {
      jointStyle: p.jointStyle, lapStyle: p.lapStyle,
      dovetailAngle: p.dovetailAngle, fingerW: p.fingerW
    };
    JSX_FIELDS.forEach(function (k) { if (p[k] !== undefined) o[k] = p[k]; });
    return o;
  }

  function buildCustom(p) {
    var base = {
      thickness: p.thickness, fit: p.fit, relief: p.relief, reliefType: p.reliefType,
      earLen: p.earLen, tenonCount: p.tenonCount
    };
    Object.keys(jointArgs(p)).forEach(function (k) { base[k] = jointArgs(p)[k]; });
    if (p.cmode === 'list') {
      return Cutlist.build({
        thickness: p.thickness, fit: p.fit, relief: p.relief, reliefType: p.reliefType,
        rows: state.rows
      });
    }
    if (p.cmode === 'panels') {
      if (!state.panels.length) {
        return {
          parts: [], info: {},
          warnings: [{ level: 'info', text: '板位表是空的：用「＋ 竖隔板 / ＋ 层板 / ＋ 背板」添加，或先在结构配方里选一个结构再转过来' }]
        };
      }
      base.panels = state.panels;
      return Custom.build(base);
    }
    // recipe: 结构配方
    var q = {};
    Object.keys(state.recipeParams || {}).forEach(function (k) { q[k] = state.recipeParams[k]; });
    q.thickness = p.thickness; q.width = p.width; q.depth = p.depth; q.height = p.height;
    q.fit = p.fit; q.relief = p.relief; q.reliefType = p.reliefType; q.tenonCount = p.tenonCount;
    q.earLen = p.earLen;
    var ja = jointArgs(p);
    Object.keys(ja).forEach(function (k) { q[k] = ja[k]; });
    return Custom.recipeUnit(state.recipe, q);
  }

  function generate() {
    var p = readParams();
    var msgs = [];
    var r;
    try {
      r = buildResult(p);
    } catch (e) {
      showMsgs([{ level: 'error', text: '生成失败: ' + e.message }]);
      state.result = null;
      if (state.model === 'image') drawImgPane();
      return;
    }
    state.result = r;
    if (!r.parts.length) {
      showMsgs(r.warnings && r.warnings.length ? r.warnings : [{ level: 'warn', text: '没有生成任何零件' }]);
      $('stat').innerHTML = '';
      $('listPane').innerHTML = '';
      state.nest = null;
      if (state.model === 'image') drawImgPane();
      return;
    }
    (r.warnings || []).forEach(function (m) { msgs.push(m); });

    // 零件自检
    r.parts.forEach(function (pt) {
      pt.validate().forEach(function (m) { msgs.push(m); });
    });
    // 榫卯工艺校核
    var t = p.thickness;
    r.parts.forEach(function (pt) {
      var b = pt.bbox();
      if (b.w < t * 2 || b.h < t * 2) msgs.push({ level: 'warn', text: pt.name + ' 尺寸过小(' + Math.round(b.w) + '×' + Math.round(b.h) + ')' });
    });
    if (p.fit > 0.4) msgs.push({ level: 'warn', text: '配合间隙 ' + p.fit + 'mm 偏大，接合可能松动' });
    if (p.fit === 0) msgs.push({ level: 'info', text: '间隙为 0：属过盈配合，需实测板厚后微调' });
    if ($('machine').value === 'cnc' && p.reliefType === 'none') {
      msgs.push({ level: 'warn', text: 'CNC 铣削未启用内角让位，方榫将无法完全插入（圆角残留）' });
    }

    // 排样
    var so = sheetOpts();
    var items = r.parts.map(function (pt) { return { part: pt, qty: pt.qty || 1 }; });
    state.nest = Nest.nest(items, so);
    var nerr = Nest.verify(state.nest, so);
    nerr.forEach(function (t2) { msgs.push({ level: 'error', text: '排样冲突: ' + t2 }); });
    state.nest.oversize.forEach(function (b) {
      msgs.push({ level: 'error', text: b.part.name + ' 超出板材幅面，无法排样' });
    });
    if (state.nest.grainForced && state.nest.grainForced.length) {
      msgs.push({
        level: 'info',
        text: '有 ' + state.nest.grainForced.length + ' 种零件锁定了纹理方向（不允许转 90°），利用率会略降；' +
          '不在意纹理可关掉「遵守纹理方向」'
      });
    }
    if (p.thicknessMeasured) {
      msgs.push({
        level: 'info',
        text: '按实测板厚 ' + p.thickness + 'mm 计算榫眼与槽宽（标称 ' + p.nominalThickness + 'mm）'
      });
    }

    showMsgs(msgs);
    showStat(r, p);
    buildList(r.parts);
    if (state.model === 'custom' && window.Editor) Editor.render();
    draw();
  }

  function showMsgs(msgs) {
    var box = $('msgs');
    box.innerHTML = '';
    var seen = {};
    msgs.slice(0, 40).forEach(function (m) {
      var k = m.level + m.text;
      if (seen[k]) return;
      seen[k] = 1;
      var d = document.createElement('div');
      d.className = 'msg ' + (m.level === 'error' ? 'error' : m.level === 'warn' ? 'warn' : 'info');
      d.textContent = (m.level === 'error' ? '✕ ' : m.level === 'warn' ? '! ' : 'i ') + m.text;
      box.appendChild(d);
    });
  }

  function showStat(r, p) {
    var area = 0, cut = 0, n = 0;
    r.parts.forEach(function (pt) {
      var q = pt.qty || 1;
      area += Math.abs(pt.area()) * q; cut += pt.cutLength() * q; n += q;
    });
    var st = state.nest.stats;
    var info = r.info || {};
    var bits = [
      '零件 <b>' + n + '</b> 件',
      '板材 <b>' + st.sheetCount + '</b> 张 (' + st.sheetW + '×' + st.sheetH + ')',
      '利用率 <b>' + (st.utilization * 100).toFixed(1) + '%</b>',
      '净面积 <b>' + (area / 1e6).toFixed(3) + '</b> m²',
      '切割长度 <b>' + (cut / 1000).toFixed(2) + '</b> m'
    ];
    if (info.cornerFingers) bits.push('角部榫齿 <b>' + info.cornerFingers + '</b> 齿 / 齿宽 <b>' + info.fingerWidth + '</b>mm');
    if (info.inner) bits.push('内净空 <b>' + info.inner.map(Math.round).join('×') + '</b>');
    if (info.grid) bits.push('格 <b>' + info.grid + '</b> / 单格 ' + info.cell.join('×'));
    if (info.mode) bits.push('模式 <b>' + info.mode + '</b>');
    if (info.size) bits.push('成品 <b>' + info.size.join(' × ') + '</b> mm');
    if (info.threshold !== undefined) bits.push('阈值 <b>' + info.threshold + '</b>');
    if (info.pxPerMM) bits.push('分辨率 <b>' + info.pxPerMM + '</b> px/mm');
    if (info.shapes) bits.push('形状 <b>' + info.shapes + '</b>');
    if (info.tenons) bits.push('底榫 <b>' + info.tenons + '</b>');
    if (info.nodes) bits.push('轮廓顶点 <b>' + info.nodes + '</b>');
    if (info.layerCount) bits.push('层数 <b>' + info.layerCount + '</b> / 总高 <b>' + info.totalHeight + '</b>mm');
    if (info.panels) bits.push('板 <b>' + info.panels + '</b>' +
      (info.tenonJoints !== undefined ? ' / 榫接 <b>' + (info.tenonJoints || 0) + '</b> / 搭接 <b>' + (info.lapJoints || 0) + '</b>' : ''));
    if (info.totalQty) bits.push('清单 <b>' + info.rows + '</b> 行 / <b>' + info.totalQty + '</b> 件');
    var nH = info.holeCount !== undefined ? info.holeCount : info.featHoles;
    var nP = info.pocketCount !== undefined ? info.pocketCount : info.featPockets;
    if (nH) bits.push('孔 <b>' + nH + '</b>');
    if (nP) bits.push('定深铣槽 <b>' + nP + '</b>');
    if (st.grainLocked) bits.push('纹理锁定 <b>' + st.grainLocked + '</b> 种');
    /* 排样质量的两个关键数: 紧凑度说明排得多密,
     * 剩料说明“还能拿出多大一块整板” —— 后者对 DIY 比利用率更有用。 */
    if (st.packDensity) bits.push('紧凑度 <b>' + (st.packDensity * 100).toFixed(1) + '%</b>');
    if (st.offcut) bits.push('最大剩料 <b>' + st.offcut.w + '×' + st.offcut.h + '</b>mm');
    if (st.strategy) bits.push('策略 <b>' + (STRATEGY_CN[st.strategy] || st.strategy) + '</b>' +
      (st.strategiesTried > 1 ? '（比选 ' + st.strategiesTried + ' 方案）' : ''));
    $('stat').innerHTML = bits.join('');
    $('stat').innerHTML = bits.map(function (b) { return '<span>' + b + '</span>'; }).join('');
  }

  var GRAIN_CN = { long: '横纹', cross: '竖纹', any: '不限' };
  /* 策略名的人话翻译: 排序口径/放置口径 */
  var SORT_CN = { area: '大件优先', maxside: '长边优先', height: '按高度', width: '按宽度', peri: '按周长' };
  var PLACER_CN = { baf: '面积最贴合', bssf: '不留细条', blsf: '短边优先', bl: '尽量压低', shelf: '货架式' };
  var STRATEGY_CN = (function () {
    var m = {};
    Object.keys(SORT_CN).forEach(function (a) {
      Object.keys(PLACER_CN).forEach(function (b) { m[a + '/' + b] = SORT_CN[a] + '·' + PLACER_CN[b]; });
    });
    return m;
  })();
  function buildList(parts) {
    var rows = ['<table><thead><tr><th>#</th><th>零件</th><th>数量</th><th>长(mm)</th><th>宽(mm)</th><th>厚</th>' +
      '<th>纹理</th><th>通孔</th><th>铣槽</th><th>面积(m²)</th><th>切割(mm)</th><th>说明</th></tr></thead><tbody>'];
    var tA = 0, tC = 0, tN = 0;
    parts.forEach(function (p, i) {
      var b = p.bbox(), q = p.qty || 1;
      var a = Math.abs(p.area()) * q, c = p.cutLength() * q;
      tA += a; tC += c; tN += q;
      rows.push('<tr><td>' + (i + 1) + '</td><td>' + esc(p.name) + '</td><td>' + q + '</td><td>' +
        Math.round(b.w) + '</td><td>' + Math.round(b.h) + '</td><td>' + p.thickness + '</td><td>' +
        (GRAIN_CN[p.meta.grain] || '不限') + '</td><td>' +
        p.holes.length + '</td><td>' + p.pockets.length + '</td><td>' +
        (a / 1e6).toFixed(4) + '</td><td>' + Math.round(c) + '</td><td>' +
        esc(p.meta.note || '') + '</td></tr>');
    });
    rows.push('</tbody><tfoot><tr><td colspan="2">合计</td><td>' + tN + '</td><td colspan="6"></td><td>' +
      (tA / 1e6).toFixed(4) + '</td><td>' + Math.round(tC) + '</td><td></td></tr></tfoot></table>');
    $('listPane').innerHTML = rows.join('');
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ---------- 绘制 ---------- */
  function draw() {
    if (state.pane === 'img') { drawImgPane(); return; }
    if (state.pane === 'edit') { if (window.Editor) Editor.drawPlan(); return; }
    if (!state.result) return;
    if (state.pane === 'nest' && state.nest) {
      Render.drawNest($('cvNest'), state.nest, {
        zoom: state.view.nest.zoom, panX: state.view.nest.panX, panY: state.view.nest.panY,
        margin: +$('margin').value
      });
    } else if (state.pane === 'parts') {
      Render.drawParts($('cvParts'), state.result.parts, {});
    } else if (state.pane === 'asm') {
      var t = thicknessOf();
      var v = state.view.asm;
      var boxes = Render.boxesFrom(state.result.parts, { t: t });
      var r = Render.drawAssembly($('cvAsm'), boxes, {
        zoom: v.zoom, ang: v.ang, tilt: v.tilt,
        explode: v.explode, panX: v.panX, panY: v.panY,
        solid: v.solid,
        selected: v.sel || v.hover,
        emptyText: '没有可装配的零件'
      });
      state.asmHit = r ? r.hit : null;
      asmHud();
      syncAsmTools();
    }
  }

  /* 3D 页的浮层提示: 既说清怎么操作, 也报出当前指到/选中的是哪块板。
   * 3D 最容易"看不出这是哪块", 所以指到就报名字+尺寸。 */
  /* 把当前视角/爆炸量反映到工具条(键盘改了也要同步) */
  function syncAsmTools() {
    var v = state.view.asm;
    var sl = $('asmExplode');
    if (sl) sl.value = Math.round(v.explode * 100);
    Array.prototype.forEach.call(document.querySelectorAll('#asmTools .chip[data-asmview]'), function (ch) {
      var pv = { '1': [30, 0.55], '2': [0, 0.02], '3': [90, 0.02], '4': [45, 8] }[ch.getAttribute('data-asmview')];
      var on = pv && Math.abs(((v.ang % 360) + 360) % 360 - pv[0]) < 0.6 && Math.abs(v.tilt - pv[1]) < 0.02;
      ch.classList.toggle('on', !!on);
    });
  }

  function asmHud() {
    var el = $('hud2');
    if (!el) return;
    var v = state.view.asm;
    var name = v.sel || v.hover;
    var tip = '拖动旋转 · 滚轮缩放 · Shift+拖动平移 · E 爆炸 · 点击选中';
    if (name && state.result) {
      var p = state.result.parts.filter(function (q) { return q.name === name; })[0];
      if (p) {
        var b = p.bbox();
        tip = '<b>' + esc(p.name) + '</b>  ' + Math.round(b.w) + ' × ' + Math.round(b.h) +
          ' × ' + p.thickness + 'mm' +
          (p.holes.length ? '  孔 ' + p.holes.length : '') +
          (v.sel ? '  <i>(已选中，再点取消)</i>' : '') +
          '<br>' + tip;
      }
    }
    el.innerHTML = tip;
  }

  /* ---------- 图片预览面板 ---------- */
  function drawImgPane() {
    var im = state.image;
    /* 只有"单形状"时叠加轮廓才不会歧义(多形状各自独立缩放, 叠一起会错位)。
     * 底座是额外零件, 不参与叠加。 */
    var shapeParts = [];
    if (state.result && state.result.parts.length) {
      shapeParts = state.result.parts.filter(function (p) { return p.name !== '底座'; });
    }
    var overlayOK = shapeParts.length === 1 && im.maskBBox;
    Render.drawMaskPreview($('cvImg'), im.data, im.mask, {
      mode: state.pmode,
      parts: overlayOK ? shapeParts : null,
      traceRect: overlayOK ? im.maskBBox : null,
      label: im.name ? im.name : '',
      emptyText: '拖入 / 选择 一张图片，或点左侧"示例"'
    });
  }

  /* ---------- 图片载入 ---------- */
  function setImage(imgData, name) {
    // 过大的图会让描摹很慢, 降采样到长边 <= LIMIT
    var LIMIT = 900;
    var W = imgData.width, H = imgData.height;
    if (Math.max(W, H) > LIMIT) {
      var k = LIMIT / Math.max(W, H);
      var nw = Math.max(1, Math.round(W * k)), nh = Math.max(1, Math.round(H * k));
      var c1 = document.createElement('canvas'); c1.width = W; c1.height = H;
      c1.getContext('2d').putImageData(imgData, 0, 0);
      var c2 = document.createElement('canvas'); c2.width = nw; c2.height = nh;
      var g2 = c2.getContext('2d');
      g2.imageSmoothingEnabled = true; g2.imageSmoothingQuality = 'high';
      g2.drawImage(c1, 0, 0, nw, nh);
      imgData = g2.getImageData(0, 0, nw, nh);
    }
    state.image.data = imgData;
    state.image.name = name || '';
    $('imgInfo').textContent = imgData.width + '×' + imgData.height + ' px';
    $('imgInfo').title = (name || '') + '  ' + imgData.width + '×' + imgData.height;
    $('drop').classList.add('has');
    $('drop').querySelector('b').textContent = name ? ('已载入: ' + trunc(name, 22)) : '已载入图片';
    if (state.model !== 'image') {
      // 上传即自动切到图片模式, 省一步点击
      selectModel('image');
      return;
    }
    generate();
    // 上传后自动跳到图片预览, 让用户先确认二值化效果
    if (state.pane === 'nest') showPane('img');
    else draw();
  }
  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function loadImageSource(src, name) {
    var im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = function () {
      var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
      if (!w || !h) { showMsgs([{ level: 'error', text: '图片尺寸为 0，无法读取' }]); return; }
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var g = cv.getContext('2d');
      g.clearRect(0, 0, w, h);           // 保留透明通道(alphaOnly 依赖它)
      g.drawImage(im, 0, 0);
      try {
        setImage(g.getImageData(0, 0, w, h), name);
      } catch (e) {
        showMsgs([{ level: 'error', text: '读取像素失败(可能是跨域图片): ' + e.message }]);
      }
    };
    im.onerror = function () { showMsgs([{ level: 'error', text: '图片解码失败，请换一张（支持 PNG/JPG/GIF/WEBP/SVG）' }]); };
    im.src = src;
  }

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '')) {
      showMsgs([{ level: 'error', text: '这不是图片文件: ' + (file.name || file.type) }]);
      return;
    }
    var fr = new FileReader();
    fr.onload = function () { loadImageSource(fr.result, file.name); };
    fr.onerror = function () { showMsgs([{ level: 'error', text: '文件读取失败' }]); };
    fr.readAsDataURL(file);
  }

  /* 内置示例(不依赖外部文件, 离线可用) */
  function sampleImage(which) {
    var cv = document.createElement('canvas');
    var g;
    if (which === 1) {
      cv.width = 320; cv.height = 300;
      g = cv.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 320, 300);
      g.fillStyle = '#000';
      g.beginPath(); g.moveTo(160, 20); g.lineTo(300, 130); g.lineTo(20, 130); g.closePath(); g.fill();  // 屋顶
      g.fillRect(50, 130, 220, 140);                                                                    // 墙
      g.fillStyle = '#fff'; g.fillRect(85, 165, 55, 55); g.fillRect(180, 165, 55, 55);                   // 窗(孔)
      g.fillStyle = '#000'; g.fillRect(140, 245, 40, 25);                                                // 底部支脚
      return { data: g.getImageData(0, 0, 320, 300), name: '示例·小房子' };
    }
    // 渐变山: 给"等高分层"用, 灰度越深越靠底层
    cv.width = 300; cv.height = 300;
    g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 300);
    var levels = [['#dcdcdc', 130], ['#a8a8a8', 105], ['#707070', 78], ['#3c3c3c', 50], ['#000000', 24]];
    levels.forEach(function (lv) {
      g.fillStyle = lv[0];
      g.beginPath(); g.arc(150, 165, lv[1], 0, Math.PI * 2); g.fill();
    });
    return { data: g.getImageData(0, 0, 300, 300), name: '示例·渐变山' };
  }

  /* ---------- 导出 ---------- */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ============================================================
   * 导出位置 (路径选择)
   *
   * 浏览器永远拿不到"绝对路径"字符串 —— 没有任何 API 能把
   * D:\\xxx\\yyy 告诉网页。能做到的只有 File System Access API 给的
   * **句柄**(FileSystemDirectoryHandle / FileSystemFileHandle)。所以这里
   * 分三档:
   *   1. 用户挑了文件夹  → 直写这个文件夹, 能一键导 6 个文件不弹框
   *   2. 没挑但勾了"每次问"  → showSaveFilePicker 弹原生另存为
   *   3. 都不行(旧浏览器 / file:// / Firefox / Safari) → <a download> 默认目录
   *
   * 句柄不能 JSON.stringify, 所以持久化只能进 IndexedDB(它能存
   * 结构化克隆对象)。localStorage 存不了。 */
  var EXP = { dir: null, dirName: '' };
  var IDB_NAME = 'hyb-export', IDB_STORE = 'kv', IDB_KEY = 'dir';

  function fsaSaveOk() { return typeof window.showSaveFilePicker === 'function'; }
  function fsaDirOk() { return typeof window.showDirectoryPicker === 'function'; }

  /* 另存为对话框的类型过滤器。不给 types 的话 Chrome 会把文件名里的
   * 后缀当普通字符, 用户一不小心就存成无后缀文件。 */
  var EXT_TYPES = {
    'dxf': { description: 'AutoCAD DXF 图纸', accept: { 'image/vnd.dxf': ['.dxf'] } },
    'svg': { description: 'SVG 矢量图', accept: { 'image/svg+xml': ['.svg'] } },
    'csv': { description: 'CSV 表格', accept: { 'text/csv': ['.csv'] } },
    'json': { description: 'JSON 参数', accept: { 'application/json': ['.json'] } }
  };
  function typeOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return (m && EXT_TYPES[m[1].toLowerCase()]) || null;
  }

  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
      var rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(IDB_STORE); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error || new Error('idb open failed')); };
    });
  }
  function idbPut(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { db.close(); res(true); };
        tx.onerror = function () { db.close(); rej(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var rq = tx.objectStore(IDB_STORE).get(key);
        rq.onsuccess = function () { db.close(); res(rq.result); };
        rq.onerror = function () { db.close(); rej(rq.error); };
      });
    });
  }

  /* 当前导出位置的人话描述。必须说清楚东西到底落在哪 ——
   * "导了但不知道存到哪了"是这类工具最常见的投诉。 */
  function expPathText() {
    if (EXP.dir) return '文件夹 “' + (EXP.dirName || EXP.dir.name || '?') + '”';
    var ask = $('askSave');
    if (ask && ask.checked && fsaSaveOk()) return '每次弹“另存为”让你选';
    if (ask && ask.checked && !fsaSaveOk()) return '浏览器默认下载目录（当前环境不支持选路径）';
    return '浏览器默认下载目录';
  }
  function syncExpPath() {
    var v = $('expPathVal');
    if (v) v.textContent = expPathText();
    var pk = $('btnPickDir'), cl = $('btnClearDir'), ask = $('askSave'), all = $('btnExportAll');
    if (pk) {
      pk.disabled = !fsaDirOk();
      pk.title = fsaDirOk()
        ? '选一个文件夹后，所有导出直接写进去，不再弹框'
        : '当前浏览器/协议不支持选文件夹（需 Chrome/Edge 且非 file:// 打开）';
    }
    if (cl) cl.disabled = !EXP.dir;
    /* 选定文件夹后"每次问"就没意义了; 不支持 picker 时勾也没用。
     * 置灰比留着一个勾了不生效的框诚实。 */
    if (ask) ask.disabled = !!EXP.dir || !fsaSaveOk();
    if (all) {
      all.title = EXP.dir
        ? '6 个文件一次写进“' + (EXP.dirName || EXP.dir.name) + '”'
        : '没选文件夹时走浏览器默认下载目录（避免连弹 6 次另存为）';
    }
  }

  /* 写一个文件。resolve 出 {how, name}:
   *   how = 'dir' | 'picker' | 'download' | 'cancel'
   * 绝不 reject —— 导出失败就降级成下载, 但要把原因报出来。 */
  function saveFile(name, text, mime, opt) {
    opt = opt || {};
    var blob = new Blob([text], { type: mime || 'application/octet-stream' });
    function writeTo(handle, how) {
      return handle.createWritable().then(function (ws) {
        return ws.write(blob).then(function () { return ws.close(); });
      }).then(function () { return { how: how, name: name }; });
    }
    if (EXP.dir) {
      return EXP.dir.getFileHandle(name, { create: true })
        .then(function (h) { return writeTo(h, 'dir'); })
        .catch(function (e) {
          /* 文件夹句柄可能已失效(目录被删/权限过期) → 必须把它丢掉,
           * 否则下一次还会拿着死句柄再失败一次。 */
          EXP.dir = null; EXP.dirName = '';
          syncExpPath();
          showMsgs([{ level: 'warn', text: '导出文件夹已失效（' + (e && e.name || 'Error') + '），已改用浏览器默认下载目录，请重新选择文件夹' }]);
          download(name, text, mime);
          return { how: 'download', name: name };
        });
    }
    var ask = $('askSave');
    if (!opt.noPicker && ask && ask.checked && fsaSaveOk()) {
      var args = { suggestedName: name };
      var ty = typeOf(name);
      if (ty) args.types = [ty];
      return window.showSaveFilePicker(args)
        .then(function (h) { return writeTo(h, 'picker'); })
        .catch(function (e) {
          /* 用户点取消 = AbortError, 这是正常操作, 绝不能报错
           * 也绝不能偷偷降级成下载(用户明确说了不存) */
          if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) {
            return { how: 'cancel', name: name };
          }
          download(name, text, mime);
          return { how: 'download', name: name, err: e };
        });
    }
    download(name, text, mime);
    return Promise.resolve({ how: 'download', name: name });
  }

  /* 导出完的反馈。不报一句的话, 写进文件夹那档根本看不出来到底存没存。 */
  function reportSave(r) {
    if (!r) return;
    if (r.how === 'cancel') { showMsgs([{ level: 'info', text: '已取消保存 ' + r.name }]); return; }
    if (r.how === 'dir') {
      showMsgs([{ level: 'info', text: '已写入文件夹 “' + (EXP.dirName || '') + '”：' + r.name }]);
    } else if (r.how === 'picker') {
      showMsgs([{ level: 'info', text: '已保存 ' + r.name }]);
    } else {
      showMsgs([{ level: 'info', text: '已下载 ' + r.name + (r.err ? '（选路径失败：' + (r.err.name || 'Error') + '，已改用默认目录）' : '') }]);
    }
  }

  function pickExportDir() {
    if (!fsaDirOk()) {
      showMsgs([{
        level: 'warn',
        text: '当前环境不支持选导出文件夹（需 Chrome/Edge 且用 http(s) 打开，' +
          'file:// 直开时浏览器不开放此 API）。导出仍可用，会落在浏览器默认下载目录。'
      }]);
      return Promise.resolve(null);
    }
    return window.showDirectoryPicker({ mode: 'readwrite', id: 'hybExport' })
      .then(function (h) {
        EXP.dir = h; EXP.dirName = h.name || '';
        syncExpPath();
        showMsgs([{ level: 'info', text: '导出位置已设为文件夹 “' + EXP.dirName + '”，之后导出不再弹框' }]);
        idbPut(IDB_KEY, h).catch(function () { /* 存不下也不影响本次会话 */ });
        return h;
      })
      .catch(function (e) {
        if (!e || e.name === 'AbortError') return null;
        showMsgs([{ level: 'warn', text: '选文件夹失败：' + (e.name || 'Error') }]);
        return null;
      });
  }
  function clearExportDir() {
    EXP.dir = null; EXP.dirName = '';
    syncExpPath();
    idbPut(IDB_KEY, null).catch(function () { });
    showMsgs([{ level: 'info', text: '已清除导出文件夹' }]);
  }
  /* 启动时把上次的文件夹句柄接回来。注意: 重新打开页面后权限会
   * 降成 'prompt', 必须先 queryPermission 确认还是 'granted' 才能直接用 ——
   * 否则第一次导出会在 createWritable 里抛 NotAllowedError。
   * 不主动 requestPermission: 那必须有用户手势, 启动时调一定被拒。 */
  function restoreExportDir() {
    return idbGet(IDB_KEY).then(function (h) {
      if (!h || typeof h.queryPermission !== 'function') return null;
      return h.queryPermission({ mode: 'readwrite' }).then(function (st) {
        if (st !== 'granted') {
          showMsgs([{
            level: 'info',
            text: '上次的导出文件夹 “' + (h.name || '') + '” 需重新授权，' +
              '点「选导出文件夹」再选一次即可'
          }]);
          return null;
        }
        EXP.dir = h; EXP.dirName = h.name || '';
        syncExpPath();
        return h;
      });
    }).catch(function () { return null; });
  }

  function stamp() {
    var d = new Date(), z = function (v) { return (v < 10 ? '0' : '') + v; };
    return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes());
  }
  function nestItems() {
    var out = [];
    if (!state.nest || !state.nest.sheets) return out;
    var so = sheetOpts();
    state.nest.sheets.forEach(function (s, si) {
      s.placements.forEach(function (pl) {
        // 多张板在 X 方向依次排开
        var xf = { rot: pl.xf.rot, tx: pl.xf.tx + si * (so.w + 50), ty: pl.xf.ty, mx: pl.xf.mx };
        out.push({ part: pl.part, xf: xf });
      });
    });
    return out;
  }
  function partItems() {
    var out = [], x = 0;
    if (!state.result || !state.result.parts) return out;
    state.result.parts.forEach(function (p) {
      var b = p.bbox();
      out.push({ part: p, xf: { tx: x - b.x0, ty: -b.y0 } });
      x += b.w + 40;
    });
    return out;
  }
  var kerf = function () { return +$('kerf').value || 0; };

  /* ---------- 加工清单 CSV: 每个孔/槽一行, 带零件内坐标 ----------
   * 这是给师傅/数控上料员看的表: 哪块板、什么特征、多大、圆心在哪、下刀多深。
   * 对标慧切的"可选工艺"表格 —— 一行一个加工动作, 不用打开 CAD 量。 */
  function featureCSV(parts) {
    var rows = [['零件', '数量', '特征', '形状', '中心X(mm)', '中心Y(mm)',
      '尺寸1(mm)', '尺寸2(mm)', '深度(mm)', '通/不通', '备注']];
    (parts || []).forEach(function (p) {
      p.holes.forEach(function (h, i) {
        var b = G.loopBBox(h);
        var w = b.x1 - b.x0, ht = b.y1 - b.y0;
        // 只有两个顶点且都带 bulge => 由两段半圆构成的整圆
        var isCircle = h.length === 2 && h[0].b && h[1].b;
        rows.push([
          p.name, p.qty, '通孔#' + (i + 1), isCircle ? '圆' : (Math.abs(w - ht) < 1e-6 ? '方' : '矩形/异形'),
          G.round((b.x0 + b.x1) / 2, 2), G.round((b.y0 + b.y1) / 2, 2),
          G.round(w, 2), G.round(ht, 2), '通', '切透', ''
        ]);
      });
      p.pockets.forEach(function (q, i) {
        var b = G.loopBBox(q.loop);
        rows.push([
          p.name, p.qty, '铣槽#' + (i + 1), '矩形',
          G.round((b.x0 + b.x1) / 2, 2), G.round((b.y0 + b.y1) / 2, 2),
          G.round(b.x1 - b.x0, 2), G.round(b.y1 - b.y0, 2),
          G.round(q.depth, 2), '不通',
          '剩余料厚 ' + G.round(p.thickness - q.depth, 2) + 'mm'
        ]);
      });
    });
    return '\ufeff' + rows.map(function (r) {
      return r.map(function (c) {
        var v = String(c);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\r\n') + '\r\n';
  }

  /* 导出任务表。把"叫什么名 / 内容怎么算 / 什么 MIME / 能不能导"
   * 集中到一处, 于是单个按钮和"导出全部"走的是同一份逻辑 ——
   * 否则两边会漸行漸远(旧版就出过"单导有护栏、批导没有"的不一致)。 */
  function exportTasks() {
    return [
      {
        key: 'dxfNest', btn: 'btnDxfNest',
        name: function () { return '\u6d77\u6d0b\u677f-\u6392\u6837-' + stamp() + '.dxf'; },
        mime: 'image/vnd.dxf',
        ready: function () { return (state.nest && state.nest.sheets && state.nest.sheets.length) ? '' : '\u8fd8\u6ca1\u6709\u6392\u6837\u7ed3\u679c\u53ef\u5bfc\u51fa'; },
        text: function () { return CAD.toDXF(nestItems(), { kerf: kerf() }); }
      },
      {
        key: 'dxfParts', btn: 'btnDxfParts',
        name: function () { return '\u6d77\u6d0b\u677f-\u96f6\u4ef6-' + stamp() + '.dxf'; },
        mime: 'image/vnd.dxf',
        ready: function () { return hasParts() ? '' : '\u8fd8\u6ca1\u6709\u96f6\u4ef6\u53ef\u5bfc\u51fa'; },
        text: function () { return CAD.toDXF(partItems(), { kerf: kerf() }); }
      },
      {
        key: 'svg', btn: 'btnSvg',
        name: function () { return '\u6d77\u6d0b\u677f-\u6392\u6837-' + stamp() + '.svg'; },
        mime: 'image/svg+xml',
        ready: function () { return (state.nest && state.nest.sheets && state.nest.sheets.length) ? '' : '\u8fd8\u6ca1\u6709\u6392\u6837\u7ed3\u679c\u53ef\u5bfc\u51fa'; },
        text: function () { return CAD.toSVG(nestItems(), { kerf: kerf() }); }
      },
      {
        key: 'csv', btn: 'btnCsv',
        name: function () { return '\u6d77\u6d0b\u677f-\u6599\u5355-' + stamp() + '.csv'; },
        mime: 'text/csv',
        ready: function () { return hasParts() ? '' : '\u8fd8\u6ca1\u6709\u96f6\u4ef6\u53ef\u5bfc\u51fa'; },
        text: function () { return CAD.toCSV(state.result.parts); }
      },
      {
        key: 'featCsv', btn: 'btnFeatCsv',
        name: function () { return '\u6d77\u6d0b\u677f-\u52a0\u5de5\u6e05\u5355-' + stamp() + '.csv'; },
        mime: 'text/csv',
        ready: function () {
          if (!hasParts()) return '\u8fd8\u6ca1\u6709\u96f6\u4ef6\u53ef\u5bfc\u51fa';
          var n = 0;
          state.result.parts.forEach(function (p) { n += p.holes.length + p.pockets.length; });
          /* 没孔没槽时导出一个只有表头的 CSV 比不导更让人困惑 */
          return n ? '' : '\u5f53\u524d\u96f6\u4ef6\u6ca1\u6709\u5b54\u6216\u94e3\u69fd\uff0c\u52a0\u5de5\u6e05\u5355\u662f\u7a7a\u7684';
        },
        text: function () { return featureCSV(state.result.parts); }
      },
      {
        key: 'json', btn: 'btnJson',
        name: function () { return '\u6d77\u6d0b\u677f-\u53c2\u6570-' + stamp() + '.json'; },
        mime: 'application/json',
        ready: function () { return ''; },     // 参数总是能导(即使零零件也能存下现场)
        text: function () { return JSON.stringify(exportPayload(), null, 2); }
      }
    ];
  }
  function hasParts() { return !!(state.result && state.result.parts && state.result.parts.length); }

  function exportPayload() {
    return {
      model: state.model, params: readParams(), sheet: sheetOpts(), kerf: kerf(),
      info: (state.result && state.result.info) || {},
      /* 自定义数据一起存, 下次可原样恢复(清单/板位/配方参数) */
      custom: state.model === 'custom' ? {
        cmode: state.cmode, rows: state.rows, panels: state.panels,
        recipe: state.recipe, recipeParams: state.recipeParams
      } : undefined,
      image: state.model === 'image' ? { name: state.image.name, px: state.image.data ? [state.image.data.width, state.image.data.height] : null } : undefined,
      generated: new Date().toISOString()
    };
  }

  /* 跑一个导出任务。quiet=true 时不单独报消息(留给批量导出汇总报)。 */
  function runExport(task, quiet) {
    var why = task.ready();
    if (why) {
      if (!quiet) showMsgs([{ level: 'warn', text: why }]);
      return Promise.resolve({ how: 'skip', name: task.name(), why: why });
    }
    var name = task.name(), txt;
    try {
      txt = task.text();
    } catch (e) {
      showMsgs([{ level: 'error', text: '\u751f\u6210 ' + name + ' \u5931\u8d25\uff1a' + e.message }]);
      return Promise.resolve({ how: 'error', name: name, err: e });
    }
    return saveFile(name, txt, task.mime).then(function (r) {
      if (!quiet) reportSave(r);
      return r;
    });
  }

  /* 一键导全部。**必须串行** —— 并行写同一个目录句柄会抢, 而且若走
   * showSaveFilePicker 分支, 浏览器只允许一个手势弹一个对话框,
   * 并发开 6 个会被直接报 NotAllowedError。
   * 同理, 没选文件夹时不该连弹 6 次另存为 → noPicker 直接走下载。 */
  function exportAll() {
    var tasks = exportTasks();
    var useDir = !!EXP.dir;
    var out = [];
    var chain = Promise.resolve();
    tasks.forEach(function (tk) {
      chain = chain.then(function () {
        var why = tk.ready();
        if (why) { out.push({ how: 'skip', name: tk.name(), why: why }); return; }
        var name = tk.name(), txt;
        try { txt = tk.text(); }
        catch (e) { out.push({ how: 'error', name: name, err: e }); return; }
        return saveFile(name, txt, tk.mime, { noPicker: !useDir }).then(function (r) { out.push(r); });
      });
    });
    return chain.then(function () {
      var okN = out.filter(function (r) { return r.how === 'dir' || r.how === 'picker' || r.how === 'download'; }).length;
      var skip = out.filter(function (r) { return r.how === 'skip'; });
      var bad = out.filter(function (r) { return r.how === 'error'; });
      var msgs = [{
        level: okN ? 'info' : 'warn',
        text: '\u5bfc\u51fa\u5168\u90e8\uff1a\u6210\u529f ' + okN + ' \u4e2a' +
          (useDir ? '\uff08\u5199\u5165\u6587\u4ef6\u5939 \u201c' + (EXP.dirName || '') + '\u201d\uff09'
                  : '\uff08\u6d4f\u89c8\u5668\u9ed8\u8ba4\u4e0b\u8f7d\u76ee\u5f55\uff09') +
          (skip.length ? '\uff0c\u8df3\u8fc7 ' + skip.length + ' \u4e2a' : '') +
          (bad.length ? '\uff0c\u5931\u8d25 ' + bad.length + ' \u4e2a' : '')
      }];
      skip.forEach(function (r) { msgs.push({ level: 'info', text: '\u8df3\u8fc7 ' + r.name + '\uff1a' + r.why }); });
      bad.forEach(function (r) { msgs.push({ level: 'error', text: r.name + '\uff1a' + (r.err && r.err.message || 'Error') }); });
      showMsgs(msgs);
      return out;
    });
  }

  function bindExports() {
    exportTasks().forEach(function (tk) {
      var b = $(tk.btn);
      if (b) b.onclick = function () { runExport(tk, false); };
    });
    var pk = $('btnPickDir');
    if (pk) pk.onclick = function () { pickExportDir(); };
    var cl = $('btnClearDir');
    if (cl) cl.onclick = clearExportDir;
    var ask = $('askSave');
    if (ask) ask.onchange = syncExpPath;
    var all = $('btnExportAll');
    if (all) all.onclick = function () { exportAll(); };
    syncExpPath();
    restoreExportDir();
  }

  /* ---------- 交互 ---------- */
  function bindUI() {
    // 模型切换
    Array.prototype.forEach.call(document.querySelectorAll('#modelChips .chip'), function (c) {
      c.onclick = function () { selectModel(c.dataset.model); };
    });

    /* 常用厚度快捷 chip: 只是往输入框里填个值, 真正的值永远以 #thickness 为准。
     * 旧版把这六个值做成 <select> 的 <option>, 于是填 16.5 会默默变成空串 -> t=0。 */
    Array.prototype.forEach.call(document.querySelectorAll('#thickChips .chip'), function (c) {
      c.onclick = function () {
        $('thickness').value = c.dataset.t;
        syncThickness();
        syncVis();
        generate();
      };
    });
    $('thickness').addEventListener('input', syncThickness);

    // 常用刀径快捷 chip: 同样只是往输入框填值, 真值以 #toolDia 为准
    Array.prototype.forEach.call(document.querySelectorAll('#toolChips .chip'), function (c) {
      c.onclick = function () {
        $('toolDia').value = c.dataset.d;
        syncVis();
        generate();
      };
    });
    $('toolDia').addEventListener('input', syncTool);

    // 图片生成方式
    Array.prototype.forEach.call(document.querySelectorAll('#imgModeChips .chip'), function (c) {
      c.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('#imgModeChips .chip'), function (x) { x.classList.remove('on'); });
        c.classList.add('on');
        state.imode = c.dataset.imode;
        $('imodeHint').textContent = state.imode === 'layers'
          ? '按灰度切成 N 片叠起来（自下往上，越深越靠底层），带层间对位销孔。适合浮雕、等高线地图、LOGO。'
          : '按剪影切一块板，底部自动出榫，配一块开好榫眼的底座。适合立牌、摆件、门牌。';
        syncVis();
        generate();
      };
    });

    // 预览显示方式
    Array.prototype.forEach.call(document.querySelectorAll('#imgTools .chip'), function (c) {
      c.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('#imgTools .chip'), function (x) { x.classList.remove('on'); });
        c.classList.add('on');
        state.pmode = c.dataset.pmode;
        drawImgPane();
      };
    });

    /* ---- 图片上传: 点击 / 拖拽 / 粘贴 三条路都要通 ---- */
    var drop = $('drop'), file = $('imgFile');
    drop.onclick = function () { file.click(); };
    file.onchange = function () { if (file.files && file.files[0]) loadFile(file.files[0]); file.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.remove('hot'); });
    });
    drop.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files && dt.files.length) { loadFile(dt.files[0]); return; }
      var uri = dt.getData('text/uri-list') || dt.getData('text/plain');
      if (uri) loadImageSource(uri, uri.split('/').pop());
    });
    // 整页也接受拖拽(拖到画布区同样有效)
    ['dragover', 'drop'].forEach(function (ev) {
      window.addEventListener(ev, function (e) {
        if (e.target === drop || drop.contains(e.target)) return;
        e.preventDefault();
        if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          loadFile(e.dataTransfer.files[0]);
        }
      });
    });
    window.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { loadFile(f); e.preventDefault(); return; }
        }
      }
    });
    $('btnSample1').onclick = function () { var s1 = sampleImage(1); state.imode = 'silhouette'; syncImodeChips(); setImage(s1.data, s1.name); };
    $('btnSample2').onclick = function () { var s2 = sampleImage(2); state.imode = 'layers'; syncImodeChips(); setImage(s2.data, s2.name); };

    // 图片参数: 滑块实时联动
    $('threshold').addEventListener('input', function () {
      $('autoThreshold').checked = false;
      $('thVal').textContent = $('threshold').value;
      syncVis(); generate();
    });
    $('despeckle').addEventListener('input', function () {
      $('dsVal').textContent = ((+$('despeckle').value) / 100).toFixed(2) + '%';
      generate();
    });
    ['autoThreshold', 'invert', 'alphaOnly', 'simplify', 'smooth', 'targetWidth', 'targetHeight',
      'standStyle', 'tenonWidth', 'baseDepth', 'baseMargin', 'minPartArea', 'maxParts',
      'layerCount', 'pinDia', 'maxPerLayer'].forEach(function (id) {
        var el = $(id);
        if (el) el.addEventListener('change', function () { syncVis(); generate(); });
      });

    // ---------- 自定义: 三子模式 ----------
    Array.prototype.forEach.call(document.querySelectorAll('#cusModeChips .chip'), function (c) {
      c.onclick = function () { setCmode(c.dataset.cmode); };
    });
    $('tenonCount').addEventListener('change', function () { syncVis(); generate(); });

    // 清单模板
    var tk = $('tplKey');
    Cutlist.templateList().forEach(function (t) {
      var op = document.createElement('option');
      op.value = t.key; op.textContent = t.label;
      tk.appendChild(op);
    });
    $('btnTpl').onclick = function () {
      var rows = Cutlist.template(tk.value, thicknessOf());
      if (!rows) return;
      state.rows = JSON.parse(JSON.stringify(rows));
      state.sel = null;
      state.selMulti = [];
      setCmode('list');
      showPane('edit');
    };
    $('btnAddRow').onclick = function () {
      state.rows.push(Cutlist.blankRow(state.rows.length + 1));
      setCmode('list');
      showPane('edit');
    };

    // 结构配方
    buildRecipeGroupChips();
    buildRecipeSelect();
    var rk = $('recipeKey');
    rk.addEventListener('change', function () {
      state.recipe = rk.value;
      /* 换配方就要跟着换推荐整体尺寸。不换的后果是: 从"长凳"切到"书架"
       * 会拿到 1200x320x450 这种横着的书架。旧版家具类型 chip 就是这么做的。 */
      var dimChanged = applyDims(Custom.recipeDims(state.recipe));
      buildRecipeFields();
      syncRecipeHint(dimChanged);
      generate();
    });
    $('btnRecipeDims').onclick = function () {
      var d = Custom.recipeDims(state.recipe);
      if (!d) {
        $('recipeDimHint').style.display = '';
        $('recipeDimHint').className = 'hint warnHint';
        $('recipeDimHint').textContent = '这个结构没声明推荐尺寸，请自己填长宽高。';
        return;
      }
      applyDims(d);
      syncRecipeHint(true, true);
      generate();
    };

    // 板位表按钮
    $('btnLoadPanels').onclick = function () {
      /* 与 editor.js 里那个"转为板位表"按钮同一道护栏:
       * build 型配方(桌/凳/抽屉/箱体/书架)展开不出板位表,
       * 不拦的话会默默进入一张空表 -> 右侧零件全没了。 */
      if (Custom.recipeExpandable && !Custom.recipeExpandable(state.recipe)) {
        showMsgs([{
          level: 'warn',
          text: '「' + (Custom.RECIPES[state.recipe] || {}).label + '」含异形板或四角互补咬合，' +
            '板位表（只能描述轴向摆放的矩形板）表达不了，已继续用配方模式。' +
            '想自己摆板请选一个可展开的结构（下拉里未标“不可展开”的那些）。'
        }]);
        showPane('edit');
        return;
      }
      state.panels = Editor.derivedPanels();
      setCmode('panels');
      showPane('edit');
    };
    $('btnAddVert').onclick = function () { setCmode('panels'); Editor.addPanel('vert'); showPane('edit'); };
    $('btnAddShelf').onclick = function () { setCmode('panels'); Editor.addPanel('shelf'); showPane('edit'); };
    $('btnAddBack').onclick = function () { setCmode('panels'); Editor.addPanel('back'); showPane('edit'); };
    $('btnDelPanel').onclick = function () { Editor.delPanel(); };
    $('btnOpenEdit').onclick = function () { showPane('edit'); };
    // 标签页
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.onclick = function () { showPane(t.dataset.pane); };
    });
    ['width', 'depth', 'height', 'thickness', 'fit', 'jointStyle', 'lapStyle', 'dovetailAngle', 'fingerW',
      'machine', 'toolDia', 'earLen', 'reliefType', 'kerf', 'sheetSize', 'margin', 'gap', 'nestStrategy',
      'realThickness', 'respectGrain'].concat(JSX_FIELDS).forEach(function (id) {
        var el = $(id);
        if (el) el.addEventListener('change', function () { syncVis(); generate(); });
      });
    $('btnGen').onclick = generate;
    $('btnFit').onclick = function () {
      state.view.nest = { zoom: 1, panX: 0, panY: 0 };
      state.view.asm.zoom = 1; state.view.asm.panX = 0; state.view.asm.panY = 0;
      draw();
    };

    // 排样视图: 缩放/平移
    var cn = $('cvNest');
    cn.addEventListener('wheel', function (e) {
      e.preventDefault();
      var v = state.view.nest;
      v.zoom = G.clamp(v.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 14);
      draw();
    }, { passive: false });
    drag(cn, function (dx, dy) {
      state.view.nest.panX += dx; state.view.nest.panY += dy; draw();
    });

    // 3D: 旋转/缩放
    var ca = $('cvAsm');
    ca.addEventListener('wheel', function (e) {
      e.preventDefault();
      var v = state.view.asm;
      v.zoom = G.clamp(v.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 14);
      draw();
    }, { passive: false });
    /* 视角预设 + 爆炸滑块: 快捷键不直观, 给上可点的按钮 */
    var ASM_VIEWS = {
      '1': { ang: 30, tilt: 0.55 }, '2': { ang: 0, tilt: 0.02 },
      '3': { ang: 90, tilt: 0.02 }, '4': { ang: 45, tilt: 8 }
    };
    Array.prototype.forEach.call(document.querySelectorAll('#asmTools .chip[data-asmview]'), function (ch) {
      ch.addEventListener('click', function () {
        var pv = ASM_VIEWS[ch.getAttribute('data-asmview')];
        if (!pv) return;
        state.view.asm.ang = pv.ang; state.view.asm.tilt = pv.tilt;
        syncAsmTools();
        draw();
      });
    });
    var expSl = $('asmExplode');
    if (expSl) {
      expSl.addEventListener('input', function () {
        state.view.asm.explode = (+expSl.value || 0) / 100;
        draw();
      });
    }

    var asmDragged = false;
    drag(ca, function (dx, dy, ev) {
      var v = state.view.asm;
      asmDragged = true;
      if (ev.shiftKey) { v.panX += dx; v.panY += dy; }
      else { v.ang = (v.ang + dx * 0.35) % 360; v.tilt = G.clamp(v.tilt - dy * 0.004, 0.05, 1.6); }
      draw();
    });
    /* 点击选中某块板。拖动也会触发 click, 所以用 asmDragged 区分
     * "旋转完松手" 和 "真的想点选" —— 否则每次旋转都会乱选一块。 */
    ca.addEventListener('mousedown', function () { asmDragged = false; });
    ca.addEventListener('click', function (ev) {
      if (asmDragged) { asmDragged = false; return; }
      if (!state.asmHit) return;
      var r = ca.getBoundingClientRect();
      var p = state.asmHit(ev.clientX - r.left, ev.clientY - r.top);
      var v = state.view.asm;
      var nm = p ? p.name : null;
      v.sel = (v.sel === nm) ? null : nm;
      draw();
    });
    /* 悬停高亮: 鰠标划到哪块就亮哪块 + 报名字。
     * 只在名字变了才重画, 避免每个 mousemove 都重绘整个 3D。 */
    ca.addEventListener('mousemove', function (ev) {
      if (state.pane !== 'asm' || !state.asmHit) return;
      var r = ca.getBoundingClientRect();
      var p = state.asmHit(ev.clientX - r.left, ev.clientY - r.top);
      var nm = p ? p.name : null;
      var v = state.view.asm;
      if (nm === v.hover) return;
      v.hover = nm;
      ca.style.cursor = nm ? 'pointer' : 'grab';
      draw();
    });
    ca.addEventListener('mouseleave', function () {
      var v = state.view.asm;
      if (v.hover === null) return;
      v.hover = null; draw();
    });
    window.addEventListener('resize', draw);
    window.addEventListener('keydown', function (e) {
      if (state.pane !== 'asm') return;
      var v = state.view.asm;
      var t = (e.target && e.target.tagName) || '';
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
      var k = e.key;
      if (k === 'e' || k === 'E') {
        v.explode = v.explode > 0 ? 0 : 0.35;
      } else if (k === '+' || k === '=') {
        v.explode = G.clamp(v.explode + 0.1, 0, 2);        // 渐进爆炸: 看清咬合过程
      } else if (k === '-' || k === '_') {
        v.explode = G.clamp(v.explode - 0.1, 0, 2);
      } else if (k === '1') { v.ang = 30; v.tilt = 0.55; }  // 标准等轴测
      else if (k === '2') { v.ang = 0; v.tilt = 0.02; }     // 正视
      else if (k === '3') { v.ang = 90; v.tilt = 0.02; }    // 侧视
      else if (k === '4') { v.ang = 45; v.tilt = 8; }       // 俯视
      else if (k === 'w' || k === 'W') { v.solid = !v.solid; }  // 实体/盒体
      else if (k === 'Escape') { v.sel = null; }
      else return;
      e.preventDefault();
      draw();
    });
    syncVis();
  }
  function drag(el, cb) {
    var on = false, lx = 0, ly = 0;
    el.addEventListener('mousedown', function (e) { on = true; lx = e.clientX; ly = e.clientY; el.style.cursor = 'grabbing'; });
    window.addEventListener('mousemove', function (e) {
      if (!on) return;
      cb(e.clientX - lx, e.clientY - ly, e);
      lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener('mouseup', function () { on = false; el.style.cursor = ''; });
  }
  function showPane(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('on'); });
    Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (x) { x.classList.remove('on'); });
    var tab = document.querySelector('.tab[data-pane="' + name + '"]');
    var pane = document.querySelector('.pane[data-pane="' + name + '"]');
    if (!tab || !pane) return;
    tab.classList.add('on'); pane.classList.add('on');
    state.pane = name;
    draw();
  }

  /* 顶层模式切换。现在只有两个真模式: 'custom' 与 'image'。
   *
   * 【向后兼容】旧的五个家具类型名(box/bookshelf/drawer/lattice/table)
   * 现在是配方 key。传这些名字进来时**自动转成"配方模式 + 选中该配方"**,
   * 而不是报错或静默退化。这条路径真在用: 导入旧的参数 JSON、
   * 以及大量已有测试都会调 selectModel('box')。 */
  function selectModel(m) {
    if (Custom.RECIPES[m]) {
      state.model = 'custom';
      state.recipe = m;
      syncModelChips();
      var rk = $('recipeKey');
      /* 分类筛选可能把该配方滤掉了 -> 先把筛选重置成全部, 否则 select 里没有这个 option */
      if (rk && !rk.querySelector('option[value="' + m + '"]')) {
        state.recipeGroup = '*';
        buildRecipeSelect();
      }
      if (rk) rk.value = m;
      setCmode('recipe');
      var dc = applyDims(Custom.recipeDims(m));
      buildRecipeFields();
      syncRecipeHint(dc);
      syncVis();
      generate();
      showPane('edit');
      return;
    }
    if (m !== 'custom' && m !== 'image') m = 'custom';
    Array.prototype.forEach.call(document.querySelectorAll('#modelChips .chip'), function (x) {
      x.classList.toggle('on', x.dataset.model === m);
    });
    state.model = m;
    if (m === 'image') {
      applyDims(IMAGE_DIMS);
      // 图片模式的"目标宽/高"独立于整体尺寸, 用高度做默认更符合立牌直觉
      if (!+$('targetWidth').value && !+$('targetHeight').value) $('targetHeight').value = 300;
    } else if (state.cmode === 'recipe') {
      applyDims(Custom.recipeDims(state.recipe));
    }
    syncVis();
    /* 离开图片/自定义模式时对应的专属页会被隐藏, 必须先把视图切回来再生成,
     * 否则画布不可见, 画出来是空的。 */
    if (m !== 'image' && state.pane === 'img') state.pane = 'nest';
    if (m !== 'custom' && state.pane === 'edit') state.pane = 'nest';
    generate();
    if (state.pane === 'nest') showPane('nest');
    /* 进自定义模式直接把编辑器摊开 —— 上一版最大的问题是用户根本找不到"在哪填" */
    if (m === 'custom') showPane('edit');
  }
  function syncModelChips() {
    Array.prototype.forEach.call(document.querySelectorAll('#modelChips .chip'), function (x) {
      x.classList.toggle('on', x.dataset.model === state.model);
    });
  }

  function syncImodeChips() {
    Array.prototype.forEach.call(document.querySelectorAll('#imgModeChips .chip'), function (x) {
      x.classList.toggle('on', x.dataset.imode === state.imode);
    });
  }

  /* 把当前配方展开成板位表（板位模式的起点） */
  function panelsOf(p) {
    var q = {};
    Object.keys(state.recipeParams || {}).forEach(function (k) { q[k] = state.recipeParams[k]; });
    q.thickness = p.thickness; q.width = p.width; q.depth = p.depth; q.height = p.height;
    return Custom.recipePanels(state.recipe, q);
  }

  /* ---------- 自定义: 子模式切换 ---------- */
  function setCmode(m) {
    Array.prototype.forEach.call(document.querySelectorAll('#cusModeChips .chip'), function (x) {
      x.classList.toggle('on', x.dataset.cmode === m);
    });
    state.cmode = m;
    state.sel = null;
    state.selMulti = [];
    syncVis();
    generate();
  }
  function syncCmode() {
    Array.prototype.forEach.call(document.querySelectorAll('#cusModeChips .chip'), function (x) {
      x.classList.toggle('on', x.dataset.cmode === state.cmode);
    });
    syncVis();
  }

  /* ---------- 结构配方: 分类筛选 + 下拉渲染 ----------
   *
   * 家具类型并入配方后一共 16 种, 平铺在一个 <select> 里很难找。
   * 所以：上面一排分类 chip（全部/家具/柜架/...）, 下面下拉按分类分组。
   * 分类名单一律从 Custom.recipeGroups() 拿, 不在这里再写一份硬编码。 */
  function buildRecipeGroupChips() {
    var box = $('recipeGroupChips');
    if (!box) return;
    box.innerHTML = '';
    var gs = ['*'].concat(Custom.recipeGroups ? Custom.recipeGroups() : []);
    gs.forEach(function (g) {
      var c = document.createElement('span');
      c.className = 'chip' + (state.recipeGroup === g ? ' on' : '');
      c.dataset.rgroup = g;
      c.textContent = g === '*' ? '全部' : g;
      c.onclick = function () {
        state.recipeGroup = g;
        buildRecipeGroupChips();
        buildRecipeSelect();
        /* 筛选后当前配方可能不在列表里了 -> buildRecipeSelect 会把 state.recipe
         * 改成该分类的第一个。那就必须跟着换尺寸+参数表+重算。 */
        var dimChanged = applyDims(Custom.recipeDims(state.recipe));
        buildRecipeFields();
        syncRecipeHint(dimChanged);
        generate();
      };
      box.appendChild(c);
    });
  }

  function buildRecipeSelect() {
    var rk = $('recipeKey');
    if (!rk) return;
    var list = Custom.recipeList();
    var keep = state.recipeGroup && state.recipeGroup !== '*' ? state.recipeGroup : null;
    var show = keep ? list.filter(function (r) { return r.group === keep; }) : list;
    if (!show.length) { show = list; state.recipeGroup = '*'; }
    rk.innerHTML = '';
    if (keep) {
      show.forEach(function (r) { rk.appendChild(recipeOption(r)); });
    } else {
      /* 全部模式下用 <optgroup> 分组, 而不是 16 项拉通单 */
      var order = Custom.recipeGroups ? Custom.recipeGroups() : [];
      order.forEach(function (g) {
        var mem = show.filter(function (r) { return r.group === g; });
        if (!mem.length) return;
        var og = document.createElement('optgroup');
        og.label = g;
        mem.forEach(function (r) { og.appendChild(recipeOption(r)); });
        rk.appendChild(og);
      });
      /* 漏网的（group 不在 recipeGroups 里）也得出现, 宁可重复也不能丢 */
      var got = {};
      Array.prototype.forEach.call(rk.querySelectorAll('option'), function (o) { got[o.value] = 1; });
      show.forEach(function (r) { if (!got[r.key]) rk.appendChild(recipeOption(r)); });
    }
    /* 当前选中项被筛掉了 -> 改指第一个可见项（而不是留个空 value） */
    if (!rk.querySelector('option[value="' + state.recipe + '"]')) {
      state.recipe = show[0].key;
    }
    rk.value = state.recipe;
  }

  function recipeOption(r) {
    var op = document.createElement('option');
    op.value = r.key;
    /* build 型配方无法展开成板位表（异形板 / 互补咬合）—— 在选项里就标出来,
     * 别等用户点完"转为板位表"拿到一张空表才知道。 */
    op.textContent = r.label + (r.expandable ? '' : ' · 不可展开板位表');
    return op;
  }

  /* 配方提示区: 推荐尺寸是不是刚被套上了 / 能不能展开板位表。 */
  function syncRecipeHint(dimChanged, explicit) {
    var el = $('recipeDimHint');
    if (!el) return;
    var d = Custom.recipeDims(state.recipe);
    var msg = [];
    if (d) {
      var dim = d.width + '×' + d.depth + '×' + d.height + 'mm・板厚 ' + d.thickness + 'mm';
      if (explicit) msg.push('已套用推荐尺寸 ' + dim + '。');
      else if (dimChanged) msg.push('已自动套用该结构的推荐尺寸 ' + dim + '，可直接改。');
      else msg.push('推荐尺寸 ' + dim + '。');
    }
    if (Custom.recipeExpandable && !Custom.recipeExpandable(state.recipe)) {
      msg.push('这个结构含异形板或四角互补咬合，无法转成板位表（板位表只能描述矩形板）。');
    }
    el.textContent = msg.join('');
    el.className = 'hint';
    el.style.display = msg.length ? '' : 'none';
  }

  /* ---------- 结构配方的动态参数表单 ---------- */
  function buildRecipeFields() {
    var box = $('recipeFields');
    box.innerHTML = '';
    var rc = Custom.RECIPES[state.recipe];
    if (!rc) return;
    $('recipeHint').textContent = rc.hint || '';
    /* 换配方时把参数重置成该配方的默认值, 否则残留上一个配方的键会互相干扰 */
    var np = {};
    (rc.fields || []).forEach(function (f) {
      np[f.id] = (state.recipeParams && state.recipeParams[f.id] !== undefined &&
        state.recipeParams.__recipe === state.recipe) ? state.recipeParams[f.id] : parseField(f, f.value);
    });
    np.__recipe = state.recipe;
    state.recipeParams = np;

    (rc.fields || []).forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'row';
      var lab = document.createElement('label');
      lab.textContent = f.label;
      row.appendChild(lab);
      var e;
      if (f.type === 'check') {
        e = document.createElement('input');
        e.type = 'checkbox';
        e.checked = !!np[f.id];
        e.style.flex = '0 0 104px';
      } else if (f.type === 'nums') {
        e = document.createElement('input');
        e.type = 'text';
        e.value = Array.isArray(np[f.id]) ? np[f.id].join(',') : String(np[f.id] === undefined ? '' : np[f.id]);
      } else if (f.type === 'select') {
        /* 家具配方带进来的类型。当初没这一支 -> backStyle 会被渲染成 number 输入框,
         * 而 parseField 又会把 'tenon' 过成 +v||0 === 0 -> 背板选项永远失效。 */
        e = document.createElement('select');
        (f.options || []).forEach(function (o) {
          var op = document.createElement('option');
          op.value = Array.isArray(o) ? o[0] : o;
          op.textContent = Array.isArray(o) ? (o[1] === undefined ? o[0] : o[1]) : o;
          e.appendChild(op);
        });
        e.value = np[f.id];
        /* 存的值不在选项里（导入了旧参数）-> 回退到首选项并同步回 state */
        if (e.selectedIndex < 0 && e.options.length) { e.selectedIndex = 0; np[f.id] = e.value; }
      } else {
        e = document.createElement('input');
        e.type = 'number';
        e.value = np[f.id];
        if (f.step !== undefined) e.step = f.step;
        if (f.min !== undefined) e.min = f.min;
        if (f.max !== undefined) e.max = f.max;
      }
      e.id = 'r_' + f.id;
      e.addEventListener('change', function () {
        state.recipeParams[f.id] = f.type === 'check' ? e.checked : parseField(f, e.value);
        generate();
      });
      row.appendChild(e);
      if (f.unit) {
        var u = document.createElement('span');
        u.className = 'unit'; u.textContent = f.unit;
        row.appendChild(u);
      }
      box.appendChild(row);
      if (f.hint) {
        var h = document.createElement('p');
        h.className = 'hint'; h.textContent = f.hint;
        box.appendChild(h);
      }
    });
  }
  function parseField(f, v) {
    if (f.type === 'nums') return parseNums(v);
    if (f.type === 'check') return !!v;
    if (f.type === 'select') return v;          // 字符串枚举, 不能过 +v
    return +v || 0;
  }

  /* 把当前板厚反映到 chip 高亮与提示文字。
   * 自由输入后用户很容易不知道"我填的到底生效了没", 所以夹住时必须明说。 */
  function syncThickness() {
    var r = readThickness();
    Array.prototype.forEach.call(document.querySelectorAll('#thickChips .chip'), function (x) {
      x.classList.toggle('on', Math.abs(+x.dataset.t - r.t) < 1e-9);
    });
    var h = $('thickHint');
    if (r.bad === 'empty') {
      h.textContent = '板厚没填或不是正数，已按 15mm 计算。';
      h.className = 'hint warnHint';
    } else if (r.bad === 'clamped') {
      h.textContent = '板厚 ' + r.raw + 'mm 超出可用范围，已按 ' + G.round(r.t, 2) + 'mm 计算（限 ' + T_MIN + '～' + T_MAX + 'mm）。';
      h.className = 'hint warnHint';
    } else {
      h.textContent = '当前板厚 ' + G.round(r.t, 2) + 'mm，可直接输入任意值（' + T_MIN + '～' + T_MAX +
        'mm，支持小数），榟宽/榟眼/槽宽全部跟着重算。';
      h.className = 'hint';
    }
  }

  /* 刀径 chip 高亮 + 夹紧提示 + T-bone 专属行的显隐。 */
  function syncTool() {
    var r = readToolDia();
    Array.prototype.forEach.call(document.querySelectorAll('#toolChips .chip'), function (x) {
      x.classList.toggle('on', Math.abs(+x.dataset.d - r.d) < 1e-9);
    });
    var h = $('toolHint');
    if (r.bad === 'empty') {
      h.innerHTML = '刀径没填或不是正数，已按 3.175mm 计算。';
      h.className = 'hint warnHint';
    } else if (r.bad === 'clamped') {
      h.innerHTML = '刀径 ' + r.raw + 'mm 超出可用范围，已按 ' + G.round(r.d, 3) +
        'mm 计算（限 ' + TD_MIN + '～' + TD_MAX + 'mm）。';
      h.className = 'hint warnHint';
    } else {
      h.innerHTML = '当前刀径 ' + G.round(r.d, 3) + 'mm，让位半径 = ' + G.round(r.d / 2, 3) +
        'mm。3.175mm（1/8"）与 6.35mm（1/4"）是最常见的两支平底铣刀。';
      h.className = 'hint';
    }
  }

  /* 接合方式下拉框: **从 J.STYLES 动态渲染**。
   *
   * 为何不写死在 HTML 里: 上一版就是写死的, 只有 finger/dovetail 两项 ——
   * joints.js 里已经有 11 种可用样式, 用户在界面上一个都看不到。
   * 动态渲染之后, joints.js 里注册一种新样式, UI 自动就有。 */
  function buildStyleSelect() {
    var sel = $('jointStyle');
    var keep = sel.value;
    sel.innerHTML = '';
    (J.STYLES || []).forEach(function (st) {
      var op = document.createElement('option');
      op.value = st.key;
      /* 标题里直接标出适用场合。不标的后果: 用户选了"楔钉榫"发现
       * 四角切出来是直榫, 以为程序坏了 —— 而那是几何必然。 */
      var tag = st.corner === false
        ? (st.mid === false ? '（仅共面拼板）' : '（仅中部接合）')
        : '';
      op.textContent = st.label + tag;
      sel.appendChild(op);
    });
    sel.value = (J.STYLE_BY_KEY && J.STYLE_BY_KEY[keep]) ? keep : 'finger';
  }
  function buildLapSelect() {
    var sel = $('lapStyle');
    var keep = sel.value;
    sel.innerHTML = '';
    (J.LAP_STYLES || []).forEach(function (st) {
      var op = document.createElement('option');
      op.value = st.key; op.textContent = st.label;
      sel.appendChild(op);
    });
    sel.value = (J.LAP_BY_KEY && J.LAP_BY_KEY[keep]) ? keep : 'plain';
  }

  /* 样式提示 + 降级预告 + 专属参数行的显隐。
   *
   * 【降级预告为何要在选的那一刻就说】生成后的警告区在右侧,
   * 而下拉框在左侧 —— 用户选完往下翻参数, 根本不会回头看右边。
   * 直接在下拉框下面告诉他"四角会改用直榫", 才不会白选。 */
  function syncStyle() {
    var k = $('jointStyle').value;
    var st = (J.STYLE_BY_KEY || {})[k];
    var h = $('jsHint');
    h.innerHTML = st ? st.hint : '';
    h.style.display = (st && st.hint) ? '' : 'none';

    /* 降级预告: 拿 J.resolveStyle 逐场合算, 与生成时走的是**同一套逻辑**。
     * 如果这里自己再写一遍判断, 两边早晚会不一致。 */
    var fh = $('jsFallHint'), lines = [];
    ['corner', 'mid'].forEach(function (kind) {
      var rs = J.resolveStyle(k, kind);
      if (rs.fell) lines.push(J.fallbackText(rs, kind));
    });
    if (lines.length) {
      fh.innerHTML = lines.join('<br>');
      fh.className = 'hint warnHint';
      fh.style.display = '';
    } else {
      fh.style.display = 'none';
    }

    var show = JSX_ROWS[k] || [];
    JSX_ALL_ROWS.forEach(function (rid) {
      var el = $(rid);
      if (el) el.style.display = show.indexOf(rid) >= 0 ? '' : 'none';
    });
    $('jsxHint').style.display = show.length ? '' : 'none';
    $('dtRow').style.display = (k === 'dovetail' || k === 'puzzle') ? '' : 'none';
  }
  function syncLap() {
    var st = (J.LAP_BY_KEY || {})[$('lapStyle').value];
    var h = $('lapHint');
    h.innerHTML = st ? st.hint : '';
    h.style.display = (st && st.hint) ? '' : 'none';
  }

  function syncVis() {
    syncThickness();
    var cnc = $('machine').value === 'cnc';
    $('toolRow').style.display = cnc ? '' : 'none';
    $('toolChipRow').style.display = cnc ? '' : 'none';
    $('toolHint').style.display = cnc ? '' : 'none';
    $('reliefRow').style.display = cnc ? '' : 'none';
    /* 耳槽长度只对 T-bone 有意义 —— dogbone 是圆, 没有"耳长"这回事。 */
    var isTb = cnc && $('reliefType').value === 'tbone';
    $('earRow').style.display = isTb ? '' : 'none';
    $('earHint').style.display = isTb ? '' : 'none';
    if (cnc) syncTool();
    syncStyle();
    syncLap();

    var isImg = state.model === 'image', isCus = state.model === 'custom';
    /* 三视图的拖拽分隔条: 只在"真的有三视图"时露。
     * 为什么不只交给 Editor.drawPlan 管: generate() 在零零件时会提前 return,
     * 根本转不到 Editor.render() → 切到空的板位表时分隔条会停在上一个状态。
     * 显隐是纯 UI 事, 放在 syncVis 里才与生成成败与否无关。 */
    var spl = $('splitH');
    if (spl) spl.style.display = (isCus && state.cmode !== 'list') ? '' : 'none';
    $('imgSec').style.display = isImg ? '' : 'none';
    $('cusSec').style.display = isCus ? '' : 'none';
    $('dimSec').style.display = isImg ? 'none' : '';
    $('tabImg').style.display = isImg ? '' : 'none';
    /* “结构选项”这个空容器已不再使用(配方参数全在 #recipeFields 里) */
    $('extraHead').style.display = 'none';

    /* 接合方式下拉框的显隐必须与"该模式到底会不会用它"严格一致。
     *   图片模式      : 不用(固定剖面出榫 + 底座开眼) -> 隐
     *   自定义·清单  : 不用。Cutlist.build 是**逐行独立下料**,
     *                    行与行之间根本没有接合(只有用户自己填的切口/孔/槽) -> 隐
     *   自定义·配方/板位表 : 走 Custom.build 求交分配榫卐 -> **必须露**
     *   五种家具      : 走 Models.* -> 露
     * 露了却不生效比藏起来更坏: 用户会以为自己选的样式生效了。 */
    var hideJs = isImg || (isCus && state.cmode === 'list');
    $('jsRow').style.display = hideJs ? 'none' : '';
    $('jsHint').style.display = hideJs ? 'none' : $('jsHint').style.display;
    if (hideJs) { $('jsFallHint').style.display = 'none'; $('jsxHint').style.display = 'none'; }
    if (hideJs) JSX_ALL_ROWS.forEach(function (rid) { var e = $(rid); if (e) e.style.display = 'none'; });
    if (hideJs) $('dtRow').style.display = 'none';
    $('fwRow').style.display = hideJs ? 'none' : '';
    $('fwHint').style.display = hideJs ? 'none' : '';
    /* 十字搭接口径只在**真的会出现互穿**的模式下露:
     * 格架/酒格必然互穿; 自定义的板位表求交也可能出 cross。
     * 箱体/书架/抽屉/桌凳里没有互穿, 露出来就是个改了没反应的框。 */
    var hasLap = (state.model === 'lattice' || (isCus && state.cmode !== 'list'));
    $('lapRow').style.display = hasLap ? '' : 'none';
    $('lapHint').style.display = hasLap ? $('lapHint').style.display : 'none';
    $('tcRow').style.display = isCus ? '' : 'none';

    if (isImg) {
      var lay = state.imode === 'layers';
      $('silSec').style.display = lay ? 'none' : '';
      $('layerSec').style.display = lay ? '' : 'none';
      var auto = $('autoThreshold').checked;
      $('threshold').disabled = auto;
      $('threshold').parentNode.style.opacity = auto ? .5 : 1;
      if (!auto) $('thVal').textContent = $('threshold').value;
      // 只用透明通道时阈值无意义
      var ao = $('alphaOnly').checked;
      $('autoThreshold').disabled = ao;
      if (ao) { $('threshold').disabled = true; $('thVal').textContent = 'α'; }
    }
    $('tabEdit').style.display = isCus ? '' : 'none';
    if (isCus) {
      var cm = state.cmode;
      $('listSec').style.display = cm === 'list' ? '' : 'none';
      $('recipeSec').style.display = cm === 'recipe' ? '' : 'none';
      $('panelsSec').style.display = cm === 'panels' ? '' : 'none';
      /* 清单模式下"整体尺寸"没有意义(尺寸逐行填), 配方/板位模式才用 W/D/H */
      $('dimSec').style.display = cm === 'list' ? 'none' : '';
      $('tcRow').style.display = cm === 'list' ? 'none' : '';
      $('cmodeHint').textContent = CMODE_HINT[cm] || '';
    }
  }

  var CMODE_HINT = {
    list: '填表格就行：一行 = 一块板，长×宽×数量，再挑工艺（圆孔／腰形孔／洞洞板／四角切口／定深铣槽）。不需要懂 CAD。',
    recipe: '选一种常见结构，填几个参数，榫卯全自动。想再改细节就点「转为板位表继续改」。',
    panels: '每块板 = 位置（左起X／前起Y／离地Z）+ 尺寸（宽W／深D／高H），六个数搞定。板厚那一格自动置灰。'
  };

  /* ---------- 启动自检 ---------- */
  function selfTest() {
    var ok = 0, fail = 0;
    function t(c) { if (c) ok++; else fail++; }
    try {
      t(Math.abs(G.loopArea(G.rect(0, 0, 10, 10)) - 100) < 1e-9);
      t(Math.abs(G.loopArea(G.circle(0, 0, 10)) - Math.PI * 25) < 1e-9);
      var sp = J.spansFor(200, { t: 12, m: 5, phase: 0 });
      t(sp.m === 5 && sp.tabs.length === 3);
      var sp1 = J.spansFor(200, { t: 12, m: 5, phase: 1 });
      t(JSON.stringify(sp.tabs) === JSON.stringify(sp1.gaps));
      var r = Models.box({ thickness: 12, width: 400, depth: 300, height: 500, fit: 0.2, shelves: 1 });
      t(r.parts.length === 6);
      var errs = 0;
      r.parts.forEach(function (p) { p.validate().forEach(function (m) { if (m.level === 'error') errs++; }); });
      t(errs === 0);
      var d = CAD.toDXF([{ part: r.parts[0] }]);
      t(d.indexOf('EOF') > 0 && d.indexOf('AC1009') > 0);
      t(CAD.toSVG([{ part: r.parts[0] }]).indexOf('<svg') === 39 || CAD.toSVG([{ part: r.parts[0] }]).indexOf('<svg') > 0);
      var nn = Nest.nest([{ part: r.parts[0], qty: 1 }], { w: 2440, h: 1220 });
      t(nn.sheets.length === 1 && Nest.verify(nn, { margin: 10 }).length === 0);

      /* ---- 图片描摹内核 ---- */
      var cv = document.createElement('canvas');
      cv.width = 200; cv.height = 120;
      var cg = cv.getContext('2d');
      cg.fillStyle = '#fff'; cg.fillRect(0, 0, 200, 120);
      cg.fillStyle = '#000'; cg.fillRect(20, 20, 160, 80);
      cg.fillStyle = '#fff'; cg.fillRect(70, 45, 40, 30);
      var imd = cg.getImageData(0, 0, 200, 120);
      // 纯黑白双峰图: Otsu 必须落在中间(曾经的 bug 是返回 0)
      var th = Trace.otsu(Trace.grayFrom(imd));
      t(th > 60 && th < 200);
      var mm = Trace.maskFrom(imd, {});
      t(Trace.maskArea(mm) === 160 * 80 - 40 * 30);
      var lps = Trace.traceMask(mm);
      t(lps.length === 2);
      var shp = Trace.loopsToShapes(lps.map(function (l) { return Trace.refineLoop(l, 0.5); }),
        { scale: 1, imgH: 120 });
      // 外轮廓 CCW / 孔 CW —— 方向错了 DXF 里孔会被填成实体
      t(shp.length === 1 && shp[0].holes.length === 1);
      t(G.signedArea(shp[0].outer) > 0 && G.signedArea(shp[0].holes[0]) < 0);
      // 保角平滑不能吃掉直角
      t(Trace.refineLoop(Trace.traceMask(Trace.maskFrom(imd, {}))[0], 1.0).length === 4);

      /* ---- 图片 -> 零件 ---- */
      var si = ImageModel.silhouette(imd, { thickness: 12, targetWidth: 160, standStyle: 'none' });
      t(si.parts.length === 1 && si.parts[0].holes.length === 1);
      t(Math.abs(si.parts[0].bbox().w - 160) < 1.5);
      var se = 0;
      si.parts.forEach(function (q) { q.validate().forEach(function (m) { if (m.level === 'error') se++; }); });
      t(se === 0);
      // 分层: 层数与总高
      var la = ImageModel.layers(imd, { thickness: 9, layerCount: 3, targetWidth: 160, pinDia: 0 });
      t(la.parts.length >= 3 && la.info.totalHeight === 27);

      /* ---- 自定义结构求解 ---- */
      var cu = Custom.shelfUnit({ thickness: 15, width: 600, depth: 300, height: 600, dividers: [300], shelvesPerBay: [1, 1] });
      t(cu.parts.length === 4 + 1 + 2);
      t(cu.info.tenonJoints > 0);
      var ce = 0;
      cu.parts.forEach(function (q) { q.validate().forEach(function (m) { if (m.level === 'error') ce++; }); });
      t(ce === 0);
      // 空间求交: 层板顶到侧板内表面(仅相切)必须判为相交, 否则不会生成榫卯
      t(!!Custom.intersect({ plane: 'XY', at: 300, u0: 15, u1: 585, v0: 0, v1: 300 },
        { plane: 'YZ', at: 7.5, u0: 0, u1: 300, v0: 0, v1: 600 }, 15));

      /* ---- 加工特征库 ---- */
      var pb = Feat.pegboard(400, 300, { dia: 12, pitch: 40, margin: 30 });
      // (400-60-12)/40 = 8.2 -> 9 列; (300-60-12)/40 = 5.7 -> 6 行
      t(pb.cols === 9 && pb.rows === 6 && pb.count === 54);
      // 阵列必须整体居中(左右留边相等), 否则挂墙看着歪
      var pbb = pb.holes.map(function (l) { return G.loopBBox(l); });
      var xs = pbb.map(function (b) { return b.x0; }), xe = pbb.map(function (b) { return b.x1; });
      t(Math.abs(Math.min.apply(null, xs) - (400 - Math.max.apply(null, xe))) < 1e-6);
      t(Feat.pegboard(400, 300, { dia: 12, pitch: 40, margin: 190 }).count === 0);
      // 四角圆角: 面积必须变小(切掉了料), 且 = w*h - 4*(r²-πr²/4)
      var rr = Feat.panelOutline(200, 100, { corners: { all: { type: 'round', size: 10 } } });
      t(Math.abs(G.loopArea(rr) - (200 * 100 - 4 * (100 - Math.PI * 25))) < 1e-6);
      // 方切口: 面积 = w*h - 4*s²
      var nn2 = Feat.panelOutline(200, 100, { corners: { all: { type: 'notch', size: 10 } } });
      t(Math.abs(G.loopArea(nn2) - (200 * 100 - 4 * 100)) < 1e-6);
      // 斜角: 面积 = w*h - 4*(s²/2)
      var cf = Feat.panelOutline(200, 100, { corners: { all: { type: 'chamfer', size: 10 } } });
      t(Math.abs(G.loopArea(cf) - (200 * 100 - 4 * 50)) < 1e-6);
      // 同一条边上重叠的切口必须被识别出来(否则轮廓自交)
      t(Feat.edgeConflict([Feat.notchProfile(10, 40, 20), Feat.notchProfile(30, 40, 20)]) === true);
      t(Feat.edgeConflict([Feat.notchProfile(10, 20, 20), Feat.notchProfile(40, 20, 20)]) === false);

      /* ---- 清单模式 ---- */
      var cl = Cutlist.build({
        thickness: 15, fit: 0.2,
        rows: [
          { name: 'A', len: 600, wid: 300, qty: 2, grain: 'long' },
          { name: 'B', len: 400, wid: 200, qty: 1, corners: { all: { type: 'round', size: 10 } },
            pockets: [{ ref: 'center', x: 0, y: 0, w: 100, h: 20, depth: 6 }] }
        ]
      });
      t(cl.parts.length === 2 && cl.parts[0].qty === 2);
      t(cl.info.totalQty === 3 && cl.info.pocketCount === 1);
      t(cl.parts[1].pockets.length === 1 && cl.parts[1].pockets[0].depth === 6);
      var cle = 0;
      cl.parts.forEach(function (q) { q.validate().forEach(function (m) { if (m.level === 'error') cle++; }); });
      t(cle === 0);
      // 铣槽深度 >= 板厚 = 切透, 必须报 error 而不是默默生成
      t(Cutlist.build({ thickness: 15, rows: [{ name: 'X', len: 300, wid: 200, pockets: [{ w: 50, h: 20, depth: 15 }] }] })
        .warnings.some(function (m) { return m.level === 'error'; }));
      // 长/宽非法必须报 error
      t(Cutlist.build({ thickness: 15, rows: [{ name: 'Y', len: 0, wid: 200 }] })
        .warnings.some(function (m) { return m.level === 'error'; }));

      /* ---- 纹理方向约束排样 ---- */
      var gp = new Part('横纹件', 15);
      gp.setOuter(G.rect(0, 0, 1000, 400));
      gp.meta.grain = 'long';
      var gn = Nest.nest([{ part: gp, qty: 2 }], { w: 2440, h: 1220, margin: 10, gap: 6, respectGrain: true });
      t(gn.sheets[0].placements.every(function (pl) { return pl.rot === 0; }));
      t(Nest.verify(gn, { margin: 10, respectGrain: true }).length === 0);
      var gp2 = new Part('竖纹件', 15);
      gp2.setOuter(G.rect(0, 0, 1000, 400));
      gp2.meta.grain = 'cross';
      var gn2 = Nest.nest([{ part: gp2, qty: 1 }], { w: 2440, h: 1220, margin: 10, gap: 6, respectGrain: true });
      t(gn2.sheets[0].placements[0].rot === 90);

      /* ---- 配方库 ---- */
      t(Custom.recipeList().length >= 6);
      Custom.recipeList().forEach(function (rc) {
        var u = Custom.recipeUnit(rc.key, { thickness: 15, width: 800, depth: 300, height: 800, fit: 0.2 });
        var e2 = 0;
        u.parts.forEach(function (q) { q.validate().forEach(function (m) { if (m.level === 'error') e2++; }); });
        t(u.parts.length >= 3 && e2 === 0);
      });
      // 悬空板必须被 validate 抓出来
      t(Custom.build({
        thickness: 15, panels: [
          { id: 'A', name: 'A', plane: 'XY', at: 7.5, u0: 0, u1: 300, v0: 0, v1: 300 },
          { id: 'B', name: 'B', plane: 'YZ', at: 2000, u0: 0, u1: 300, v0: 0, v1: 300 }
        ]
      }).warnings.some(function (m) { return /悬空/.test(m.text); }));

      /* ---- 三视图渲染器 ---- */
      var pcv = document.createElement('canvas');
      pcv.width = 900; pcv.height = 400;
      Object.defineProperty(pcv, 'clientWidth', { value: 900 });
      Object.defineProperty(pcv, 'clientHeight', { value: 400 });
      var pr = Render.drawPlan(pcv, Custom.recipePanels('grid', { thickness: 15, width: 600, depth: 300, height: 600, dividers: [300], shelvesPerBay: [1, 1] }), { thickness: 15 });
      t(pr && pr.views.length === 3 && typeof pr.hit === 'function');
    } catch (e) { fail++; window.__selfTestErr = e; }
    var el = $('selfTest');
    el.textContent = '自检 ' + ok + '/' + (ok + fail);
    el.style.color = fail ? '#9e3730' : '#1a6647';
    el.style.borderColor = fail ? '#9e3730' : '#1a6647';
    el.style.background = fail ? '#fadfdc' : '#dcefe5';
    window.__selfTest = { ok: ok, fail: fail };
  }

  /* ---------- 可拖拽布局 (面板大小) ----------
   * 两根分隔条:
   *   #splitV —— 左侧参数栈 <-> 视图区  (存 px)
   *   #splitH —— 清单表格 <-> 三视图    (存百分比, 窗口变高也不走形)
   * 拖完必须 draw(): canvas 是 width:100% + dpr 重设位图,
   * 不重绘就只是把旧位图拉伸 → 模糊且比例尺会错。 */
  var LAYOUT_KEY = 'hyb.layout.v1';
  var LAYOUT_DEF = { side: 320, plan: 44 };
  var layout = { side: LAYOUT_DEF.side, plan: LAYOUT_DEF.plan };

  /* 夹紧边界: 左栈再窄就放不下 104px 的输入框 + 标签,
   * 再宽就把图纸区挤死; 上限又不能超过半个窗口(小屏上)。 */
  function clampSide(px) {
    var vw = window.innerWidth || 1280;
    var hi = Math.max(240, Math.min(560, Math.round(vw * 0.5)));
    return Math.round(G.clamp(+px || 0, 240, hi));
  }
  /* 三视图低于 150px 就什么都看不清; 上面的表格至少要留 180px
   * (表头两行 + 两三行数据)。
   *
   * 坑: plan 是对 editPane 高度的百分比, 但 editPane 里除了表格和三视图
   * 还夹着 #editBar / #alignBar / 分隔条本身 (实测共 ~57px)。直接用
   * (h-180)/h 作上限 → 表格只剩 123px, 还不到两行。所以必须把这些
   * 固定高度的兄弟先扣掉。editPane 隐藏时 clientHeight=0, 量不到
   * 就只能给个宽松区间往回夹。 */
  function clampPlan(pct) {
    var pane = $('editPane');
    var h = pane ? pane.clientHeight : 0;
    var lo = 12, hi = 88;
    if (h >= 340) {
      var chrome = 0;
      ['editBar', 'alignBar', 'splitH'].forEach(function (id) {
        var e = $(id);
        if (e) chrome += e.offsetHeight || 0;
      });
      var avail = h - chrome;                 // 表格 + 三视图 真正能分的高度
      if (avail > 340) {
        lo = 150 / h * 100;                   // 三视图不低于 150
        hi = (avail - 180) / h * 100;         // 表格不低于 180
        if (hi < lo) hi = lo;
      }
    }
    return +G.clamp(+pct || 0, lo, hi).toFixed(3);
  }

  function applyLayout(redraw) {
    layout.side = clampSide(layout.side);
    layout.plan = clampPlan(layout.plan);
    var sd = $('side');
    if (sd) { sd.style.flex = '0 0 ' + layout.side + 'px'; sd.style.width = layout.side + 'px'; }
    var pw = $('planWrap');
    if (pw) pw.style.flexBasis = layout.plan + '%';
    var sv = $('splitV');
    if (sv) {
      sv.setAttribute('aria-valuenow', String(layout.side));
      sv.setAttribute('aria-valuemin', '240');
      sv.setAttribute('aria-label', '参数栈宽度 ' + layout.side + 'px');
    }
    var sh = $('splitH');
    if (sh) {
      sh.setAttribute('aria-valuenow', String(Math.round(layout.plan)));
      sh.setAttribute('aria-label', '三视图占高 ' + Math.round(layout.plan) + '%');
    }
    if (redraw !== false) draw();
    return layout;
  }

  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) { /* file:// 下可能报错 */ }
  }
  /* 读回的值可能是上次大窗口存的 → 必须重新夹一次 */
  function loadLayout() {
    try {
      var raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return false;
      var o = JSON.parse(raw);
      if (o && isFinite(+o.side)) layout.side = +o.side;
      if (o && isFinite(+o.plan)) layout.plan = +o.plan;
      return true;
    } catch (e) { return false; }
  }
  function resetLayout() {
    layout.side = LAYOUT_DEF.side;
    layout.plan = LAYOUT_DEF.plan;
    applyLayout();
    saveLayout();
  }

  function evPt(ev) {
    if (ev.touches && ev.touches.length) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    if (ev.changedTouches && ev.changedTouches.length) return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY };
    if (typeof ev.clientX === 'number') return { x: ev.clientX, y: ev.clientY };
    return null;
  }

  function bindSplitter(el, axis) {
    if (!el) return;
    var drag = null;
    function down(ev) {
      var p = evPt(ev);
      if (!p) return;
      var pane = $('editPane');
      drag = {
        x: p.x, y: p.y, side: layout.side, plan: layout.plan,
        h: pane ? pane.clientHeight : 0
      };
      el.classList.add('dragging');
      document.body.classList.add('splitting');
      if (axis === 'y') document.body.classList.add('rowwise');
      if (ev.preventDefault) ev.preventDefault();
    }
    function move(ev) {
      if (!drag) return;
      var p = evPt(ev);
      if (!p) return;
      if (axis === 'x') {
        layout.side = drag.side + (p.x - drag.x);
      } else {
        var h = drag.h || (($('editPane') || {}).clientHeight || 0);
        /* 往下拖 = 三视图变矮, 所以是减 */
        if (h > 0) layout.plan = drag.plan - (p.y - drag.y) / h * 100;
      }
      applyLayout();
      if (ev.preventDefault) ev.preventDefault();
    }
    function up() {
      if (!drag) return;
      drag = null;
      el.classList.remove('dragging');
      document.body.classList.remove('splitting');
      document.body.classList.remove('rowwise');
      applyLayout();
      saveLayout();
    }
    el.addEventListener('mousedown', down);
    el.addEventListener('touchstart', down, { passive: false });
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);
    el.addEventListener('dblclick', function () {
      if (axis === 'x') layout.side = LAYOUT_DEF.side; else layout.plan = LAYOUT_DEF.plan;
      applyLayout(); saveLayout();
    });
    /* 键盘可操作: 鼠标拖不准的人(或只有触控板)靠这个微调 */
    el.addEventListener('keydown', function (ev) {
      var k = ev.key, step = ev.shiftKey ? 48 : 16;
      var hit = true;
      if (k === 'Home') {
        if (axis === 'x') layout.side = LAYOUT_DEF.side; else layout.plan = LAYOUT_DEF.plan;
      } else if (axis === 'x' && k === 'ArrowLeft') { layout.side -= step; }
      else if (axis === 'x' && k === 'ArrowRight') { layout.side += step; }
      else if (axis === 'y' && k === 'ArrowUp') { layout.plan += pctStep(step); }
      else if (axis === 'y' && k === 'ArrowDown') { layout.plan -= pctStep(step); }
      else hit = false;
      if (!hit) return;
      ev.preventDefault();
      applyLayout(); saveLayout();
    });
  }
  function pctStep(px) {
    var pane = $('editPane');
    var h = pane ? pane.clientHeight : 0;
    return h > 0 ? px / h * 100 : 4;
  }

  function initSplitters() {
    bindSplitter($('splitV'), 'x');
    bindSplitter($('splitH'), 'y');
    var rb = $('btnLayoutReset');
    if (rb) rb.onclick = resetLayout;
    loadLayout();
    applyLayout(false);
    /* 窗口变小后旧值可能超过上限 → 重新夹紧(不写回 localStorage,
     * 否则把窗口拉小再拉大就把用户原本的宽度弄丢了) */
    window.addEventListener('resize', function () { applyLayout(false); });
  }

  /* ---------- init ---------- */
  /* 两个下拉框必须在 bindUI/readParams 之前建好 ——
   * HTML 里它们是空的 <select>, 空选框的 .value 是 '' ,
   * 于是 readParams 会拿到 jointStyle:'' → resolveStyle 报 unknown。 */
  buildStyleSelect();
  buildLapSelect();
  /* 自定义模式默认给一份"墙面层板 3 件套"清单, 打开就有东西看,
   * 比面对空表格强得多(空表格是上一版最大的可用性问题之一)。 */
  state.rows = Cutlist.template('shelfSet', 15) || [];
  bindUI();
  initSplitters();
  buildRecipeFields();
  syncRecipeHint(false);
  bindExports();
  Editor.init({
    state: state,
    changed: function () { generate(); },
    thickness: function () { return +$('realThickness').value || thicknessOf(); }
  });
  selfTest();
  syncVis();
  generate();
  // 供自动化测试驱动: 可直接喂 ImageData, 免去构造 File
  window.__app = {
    state: state, generate: generate, readParams: readParams, sheetOpts: sheetOpts,
    nestItems: nestItems, partItems: partItems,
    selectModel: selectModel, showPane: showPane, setImage: setImage,
    sampleImage: sampleImage, loadImageSource: loadImageSource,
    setImode: function (m) { state.imode = m; syncImodeChips(); syncVis(); generate(); },
    drawImgPane: drawImgPane, panelsOf: panelsOf, buildResult: buildResult,
    setCmode: setCmode, syncCmode: syncCmode, buildRecipeFields: buildRecipeFields,
    readThickness: readThickness, thicknessOf: thicknessOf, syncThickness: syncThickness,
    featureCSV: featureCSV, showMsgs: showMsgs,
    syncVis: syncVis, syncStyle: syncStyle, syncLap: syncLap,
    buildStyleSelect: buildStyleSelect, buildLapSelect: buildLapSelect,
    JSX_FIELDS: JSX_FIELDS, JSX_ROWS: JSX_ROWS, JSX_ALL_ROWS: JSX_ALL_ROWS,
    buildRecipeSelect: buildRecipeSelect, buildRecipeGroupChips: buildRecipeGroupChips,
    syncRecipeHint: syncRecipeHint, applyDims: applyDims, IMAGE_DIMS: IMAGE_DIMS,
    syncModelChips: syncModelChips, parseField: parseField,
    layout: layout, LAYOUT_KEY: LAYOUT_KEY, LAYOUT_DEF: LAYOUT_DEF,
    applyLayout: applyLayout, resetLayout: resetLayout, saveLayout: saveLayout,
    loadLayout: loadLayout, clampSide: clampSide, clampPlan: clampPlan,
    EXP: EXP, saveFile: saveFile, exportTasks: exportTasks, exportAll: exportAll,
    runExport: runExport, exportPayload: exportPayload, syncExpPath: syncExpPath,
    expPathText: expPathText, pickExportDir: pickExportDir, clearExportDir: clearExportDir,
    restoreExportDir: restoreExportDir, download: download, reportSave: reportSave
  };
})();
