/* ============================================================
 * editor.js - 自定义模式的表格编辑器（零 CAD 交互层）
 *
 * 三条并列路径:
 *   list   零件清单  —— 一行 = 一块板(长/宽/数量/纹理/工艺)，最低门槛
 *   recipe 结构配方  —— 选结构类型 + 填几个参数，自动展开板位
 *   panels 板位表    —— 进阶：三视图点选 + 表格改坐标，不必手写 JSON
 *
 * 对外: Editor.init(ctx) / Editor.render() / Editor.drawPlan() / Editor.selected()
 *   ctx = { state, changed(), thickness() }
 * ============================================================ */
(function (global) {
  'use strict';
  var G = global.G;
  var ctx = null, host = null, bar = null, planCv = null;
  var expanded = {};          // 行详情展开状态

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }
  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }

  /* ============================================================
   * 选中集：单选 + Ctrl/Shift 多选
   * st.sel 仍是"主选"(表格滚动/复制/删除都认它)，st.selMulti 是完整选中集。
   * 两者保持同步：selMulti 非空时 sel 必是其中一个。
   * ============================================================ */
  function selIds() {
    var st = ctx.state;
    if (st.selMulti && st.selMulti.length) return st.selMulti.slice();
    return st.sel ? [st.sel] : [];
  }
  function isSel(id) {
    var st = ctx.state;
    if (st.selMulti && st.selMulti.length) return st.selMulti.indexOf(id) >= 0;
    return st.sel === id;
  }
  function setSel(id, additive) {
    var st = ctx.state;
    if (!st.selMulti) st.selMulti = [];
    if (id === null || id === undefined) { st.selMulti = []; st.sel = null; return; }
    if (additive) {
      var i = st.selMulti.indexOf(id);
      if (st.selMulti.length === 0 && st.sel && st.sel !== id) st.selMulti.push(st.sel);
      i = st.selMulti.indexOf(id);
      if (i >= 0) {
        st.selMulti.splice(i, 1);
        st.sel = st.selMulti.length ? st.selMulti[st.selMulti.length - 1] : null;
      } else {
        st.selMulti.push(id);
        st.sel = id;
      }
    } else {
      st.selMulti = [id];
      st.sel = id;
    }
  }

  /* ============================================================
   * 三视图拖拽状态
   * drag = null 表示没在拖。按下时先记录"基准盒"，移动时用绝对位置算目标，
   * 而不是每帧累加增量 —— 累加会把浮点误差和吸附回弹越积越歪。
   * ============================================================ */
  var drag = null;
  var hoverId = null;
  var lastSnaps = [];

  function init(c) {
    ctx = c;
    host = $('editGrid');
    bar = $('editBar');
    planCv = $('cvPlan');
    planCv.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    planCv.addEventListener('mouseleave', function () {
      if (drag) return;
      if (hoverId !== null) { hoverId = null; drawPlan(); }
    });
    planCv.style.cursor = 'pointer';
  }

  function cvPos(ev) {
    var r = planCv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function draggable() { return ctx.state.cmode === 'panels'; }

  function onDown(ev) {
    var st = ctx.state;
    if (!st.planPick) return;
    var q = cvPos(ev);
    var r = st.planPick(q.x, q.y);
    var additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    if (!r || !r.panel) {
      /* 点空白 = 取消选中（多选时按住 Ctrl 点空白不清空，避免手滑丢选） */
      if (!additive) { setSel(null); lastSnaps = []; render(); drawPlan(); }
      return;
    }
    var id = r.panel.id;
    if (!isSel(id) || additive) setSel(id, additive);
    if (!draggable()) { render(); drawPlan(); return; }
    var t = ctx.thickness();
    var C = global.Custom;
    var ids = selIds();
    var lead = st.panels.filter(function (p) { return p.id === id; })[0];
    if (!lead) { render(); drawPlan(); return; }
    var w0 = r.view.toWorld(q.x, q.y);
    drag = {
      view: r.view, axes: [r.view.h, r.view.v],
      startH: w0.h, startV: w0.v, moved: false,
      lead: lead,
      base: st.panels.filter(function (p) { return ids.indexOf(p.id) >= 0; })
        .map(function (p) { return { p: p, box: C.panelBox(p, t) }; })
    };
    lastSnaps = [];
    render(); drawPlan();
    ev.preventDefault();
  }

  function onMove(ev) {
    var st = ctx.state;
    if (!drag) {
      if (!st.planPick || !draggable()) return;
      var q0 = cvPos(ev);
      var inside = q0.x >= 0 && q0.y >= 0 && q0.x <= planCv.clientWidth && q0.y <= planCv.clientHeight;
      var r0 = inside ? st.planPick(q0.x, q0.y) : null;
      var nid = (r0 && r0.panel) ? r0.panel.id : null;
      planCv.style.cursor = nid ? 'move' : 'default';
      if (nid !== hoverId) { hoverId = nid; drawPlan(); }
      return;
    }
    var C = global.Custom, t = ctx.thickness();
    var q = cvPos(ev);
    var w = drag.view.toWorld(q.x, q.y);
    var dh = w.h - drag.startH, dv = w.v - drag.startV;
    if (Math.abs(dh) * drag.view.scale > 2 || Math.abs(dv) * drag.view.scale > 2) drag.moved = true;
    var K = C.BOX_KEYS;
    var leadBase = null;
    drag.base.forEach(function (o) { if (o.p.id === drag.lead.id) leadBase = o.box; });
    if (!leadBase) return;
    /* 目标位置(未吸附) */
    var want = {};
    want[K[drag.view.h][0]] = leadBase[K[drag.view.h][0]] + dh;
    want[K[drag.view.v][0]] = leadBase[K[drag.view.v][0]] + dv;
    /* 吸附时不能把"一起被拖的其它板"算作参考线：它们也在动 */
    var movingIds = drag.base.map(function (o) { return o.p.id; });
    var refs = st.panels.filter(function (p) { return movingIds.indexOf(p.id) < 0; });
    var tol = 7 / Math.max(1e-6, drag.view.scale);      // 屏幕 7px 换算成 mm
    var res = C.movePanel(refs.concat([drag.lead]), drag.lead, want, drag.axes, t,
      { snap: !(ev.altKey), tol: tol });
    lastSnaps = res.snaps || [];
    /* 主选实际落点 -> 反推真实位移 -> 同样搬动其它选中板(不各自吸附, 保持相对关系) */
    var realD = {};
    drag.axes.forEach(function (ax) { realD[ax] = res.box[K[ax][0]] - leadBase[K[ax][0]]; });
    drag.base.forEach(function (o) {
      if (o.p.id === drag.lead.id) return;
      var b = C.panelBox(o.p, t);
      drag.axes.forEach(function (ax) { b[K[ax][0]] = o.box[K[ax][0]] + realD[ax]; });
      C.setPanelBox(o.p, b, t);
    });
    drawPlan();
    ev.preventDefault();
  }

  function onUp(ev) {
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    if (moved) {
      /* 拖完才重新求解(拖动中每帧求解会卡)；表格里的六列数字也要跟着刷新 */
      roundSel();
      ctx.changed();
      render();
    }
    drawPlan();
  }

  /* 拖拽落点圆整到 0.1mm：屏幕像素换算出来的坐标会带一串小数，
   * 导出到 CSV/DXF 里全是 312.7364991 这种数字，师傅没法读。 */
  function roundSel() {
    var C = global.Custom, t = ctx.thickness();
    var ids = selIds();
    ctx.state.panels.forEach(function (p) {
      if (ids.indexOf(p.id) < 0) return;
      var b = C.panelBox(p, t);
      ['x', 'y', 'z', 'w', 'd', 'h'].forEach(function (k) { b[k] = G.round(b[k], 1); });
      C.setPanelBox(p, b, t);
    });
  }

  /* ---------- 通用输入控件 ---------- */
  function inp(type, val, oncommit, cls, attrs) {
    var e = el('input', cls || '');
    e.type = type;
    e.value = (val === undefined || val === null) ? '' : val;
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    e.addEventListener('change', function () { oncommit(e.value); });
    return e;
  }
  function sel(options, val, oncommit, cls) {
    var e = el('select', cls || '');
    options.forEach(function (o) {
      var op = el('option');
      op.value = o[0]; op.textContent = o[1];
      if (String(o[0]) === String(val)) op.selected = true;
      e.appendChild(op);
    });
    e.addEventListener('change', function () { oncommit(e.value); });
    return e;
  }
  function chk(val, oncommit) {
    var e = el('input');
    e.type = 'checkbox';
    e.checked = !!val;
    e.addEventListener('change', function () { oncommit(e.checked); });
    return e;
  }
  function btn(txt, cls, fn) {
    var b = el('button', 'mini ' + (cls || ''), txt);
    /* 把事件传给回调: 多选要看 ctrlKey */
    b.onclick = function (ev) { return fn(ev); };
    return b;
  }
  function td(node, cls) {
    var c = el('td', cls || '');
    if (node !== undefined && node !== null) {
      if (typeof node === 'string' || typeof node === 'number') c.textContent = node;
      else c.appendChild(node);
    }
    return c;
  }

  var GRAINS = [['any', '不限'], ['long', '横纹'], ['cross', '竖纹']];
  var CORNER_TYPES = [['none', '无'], ['round', '圆角'], ['chamfer', '斜角'], ['notch', '方切口']];
  var HOLE_TYPES = [['circle', '圆孔'], ['rect', '矩形孔'], ['slot', '腰形孔']];
  var REFS = [['bl', '左下'], ['center', '中心'], ['br', '右下'], ['tl', '左上'], ['tr', '右上']];
  var PLANES = [['XY', 'XY 水平板'], ['YZ', 'YZ 左右立板'], ['XZ', 'XZ 前后立板']];
  var EDGE_NAMES = [['bottom', '下边'], ['right', '右边'], ['top', '上边'], ['left', '左边']];

  /* ============================================================
   * 顶部工具条
   * ============================================================ */
  function renderBar() {
    bar.innerHTML = '';
    var st = ctx.state;
    var cm = st.cmode;
    var title = cm === 'list' ? '零件清单' : (cm === 'recipe' ? '结构配方（自动展开的板位，可切到板位表继续改）' : '板位表');
    bar.appendChild(el('span', 'lbl', title));
    bar.appendChild(el('span', 'sep'));
    if (cm === 'list') {
      bar.appendChild(btn('＋ 加一行', '', function () {
        st.rows.push(global.Cutlist.blankRow(st.rows.length + 1));
        st.sel = null; ctx.changed(); render();
      }));
      bar.appendChild(btn('清空', 'danger', function () {
        st.rows = []; ctx.changed(); render();
      }));
      bar.appendChild(el('span', 'lbl', '共 ' + st.rows.length + ' 行 / ' +
        st.rows.filter(function (r) { return !r.off; })
          .reduce(function (a, r) { return a + Math.max(1, Math.round(num(r.qty, 1))); }, 0) + ' 件'));
    } else if (cm === 'panels') {
      bar.appendChild(btn('＋ 竖隔板', '', function () { addPanel('vert'); }));
      bar.appendChild(btn('＋ 层板', '', function () { addPanel('shelf'); }));
      bar.appendChild(btn('＋ 背板', '', function () { addPanel('back'); }));
      bar.appendChild(btn('复制选中', '', function () { dupPanel(); }));
      bar.appendChild(btn('删除选中', 'danger', function () { delPanel(); }));
      bar.appendChild(el('span', 'lbl', '共 ' + st.panels.length + ' 块板'));
    } else {
      /* 【build 型配方不能展开成板位表】
       * 板位表的表达能力就是"一堆轴向摆放的矩形板", 而桌/凳腿架是带镂空的异形板、
       * 抽屉盒四角是互补咬合(求交只能得出"一方出榫一方开眼")、
       * 箱体的销/饼干需要"盖板压侧板"的另一套下料尺寸 —— 都描述不了。
       * derivedPanels() 对它们返回 [], 旧行为是默默给一张**空板位表**
       * (点下去零件全没了), 用户只会以为程序坏了。
       * 现在按钮置灰 + 说清楚为什么。 */
      var canExp = !global.Custom.recipeExpandable || global.Custom.recipeExpandable(st.recipe);
      var dp = canExp ? derivedPanels() : [];
      var b2 = btn('转为板位表继续改 →', '', function () {
        if (!canExp) return;
        st.panels = dp;
        st.cmode = 'panels';
        if (global.__app && global.__app.syncCmode) global.__app.syncCmode();
        ctx.changed(); render(); drawPlan();
      });
      if (!canExp) { b2.disabled = true; b2.title = '该结构含异形板或四角互补咬合，板位表描述不了'; }
      bar.appendChild(b2);
      bar.appendChild(el('span', 'lbl', canExp
        ? ('展开为 ' + dp.length + ' 块板')
        : '这个结构含异形板 / 四角互补咬合，无法转成板位表（参数在左侧改）'));
    }
  }

  /* 配方展开出的板位(只读预览) */
  function derivedPanels() {
    var st = ctx.state;
    try {
      return global.Custom.recipePanels(st.recipe, st.recipeParams || {});
    } catch (e) { return []; }
  }

  /* ============================================================
   * 板位增删（图形化替代手写 JSON）
   * 新板的默认位置由现有板的世界包围盒推出来，落在正中间，
   * 用户只要拖数字微调，不必从零算坐标。
   * ============================================================ */
  function worldExt() {
    var st = ctx.state, t = ctx.thickness();
    var ext = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    var n = 0;
    st.panels.forEach(function (p) {
      var b = global.Render.panelBox(p, t);
      if (!b) return;
      n++;
      ['x', 'y', 'z'].forEach(function (k) {
        ext[k][0] = Math.min(ext[k][0], b[k][0]);
        ext[k][1] = Math.max(ext[k][1], b[k][1]);
      });
    });
    if (!n) return { x: [0, 600], y: [0, 320], z: [0, 720] };
    return ext;
  }
  function uniqId(pre) {
    var st = ctx.state, k = 1;
    var used = {};
    st.panels.forEach(function (p) { used[p.id] = 1; });
    while (used[pre + k]) k++;
    return pre + k;
  }
  /* 已有的竖隔板中心面 x 列表(升序), 用来把新层板放进"某一格"而不是贯通整宽 */
  function dividerXs() {
    var st = ctx.state, out = [];
    st.panels.forEach(function (p) {
      if (p.plane !== 'YZ') return;
      out.push(p.at);
    });
    return out.sort(function (a, b) { return a - b; });
  }
  /* 在 [lo, hi] 里找一个离已占标高最远的空位, 避免新板与旧板同高压叠 */
  function freeSpot(lo, hi, taken, minGap) {
    if (hi - lo < minGap) return (lo + hi) / 2;
    var best = (lo + hi) / 2, bestD = -1;
    var N = 24;
    for (var i = 1; i < N; i++) {
      var v = lo + (hi - lo) * i / N;
      var d = Infinity;
      taken.forEach(function (q) { d = Math.min(d, Math.abs(v - q)); });
      if (!taken.length) d = hi - lo;
      if (d > bestD) { bestD = d; best = v; }
    }
    return best;
  }

  function addPanel(kind) {
    var st = ctx.state, t = ctx.thickness();
    var e = worldExt();
    var p;
    if (kind === 'vert') {
      /* 竖隔板: 和层板同一套逻辑 —— 只跨"最高的那一层格", 不贯通全高。
       * 贯通全高会同时与该 x 位置上所有层板互穿(搭接), 而这些层板通常
       * 已经顶在旁边的竖隔板上出了榫; 于是同一条边(竖隔板的后边)既要给
       * 层板让搭接缺口, 又要出榫扎进背板 —— 过约束, 只能放弃一部分接合。
       * 放进格子里就变成干净的对接: 上下各出榫扎进上下层板。 */
      var takenX = st.panels.filter(function (q) { return q.plane === 'YZ'; }).map(function (q) { return q.at; });
      var atX = freeSpot(e.x[0] + t * 2, e.x[1] - t * 2, takenX, t * 4);
      /* 该 x 处已有的水平板标高(层板/顶底板), 用来切出"格" */
      var zs = st.panels.filter(function (q) {
        if (q.plane !== 'XY') return false;
        return q.u0 - 1e-6 < atX && atX < q.u1 + 1e-6;
      }).map(function (q) { return q.at; }).sort(function (a, b) { return a - b; });
      var zLo = e.z[0] + t, zHi = e.z[1] - t;
      if (zs.length >= 2) {
        var bz = -1;
        for (var zi = 0; zi < zs.length - 1; zi++) {
          var gapz = zs[zi + 1] - zs[zi];
          if (gapz > bz) { bz = gapz; zLo = zs[zi] + t / 2; zHi = zs[zi + 1] - t / 2; }
        }
      }
      p = {
        id: uniqId('V'), name: '竖隔板', plane: 'YZ',
        at: G.round(atX, 1),
        u0: G.round(e.y[0], 1), u1: G.round(e.y[1], 1),
        v0: G.round(zLo, 1), v1: G.round(zHi, 1),
        qty: 1, grain: 'cross'
      };
    } else if (kind === 'back') {
      var takenY = st.panels.filter(function (q) { return q.plane === 'XZ'; }).map(function (q) { return q.at; });
      p = {
        id: uniqId('K'), name: '背板', plane: 'XZ',
        at: G.round(takenY.length ? freeSpot(e.y[0] + t, e.y[1] - t / 2, takenY, t * 2) : e.y[1] - t / 2, 1),
        u0: G.round(e.x[0] + t, 1), u1: G.round(e.x[1] - t, 1),
        v0: G.round(e.z[0] + t, 1), v1: G.round(e.z[1] - t, 1),
        qty: 1, grain: 'long'
      };
    } else {
      /* 层板: 若已有竖隔板, 新层板只跨"最宽的那一格"。
       * 贯通整宽会与竖隔板变成互穿(搭接), 一旦该处已有对接层板的榫眼,
       * 榫眼就落进搭接缺口 -> 非法零件。所以默认放进格子里, 走对接。 */
      var xs = dividerXs();
      var bounds = [e.x[0] + t].concat(xs).concat([e.x[1] - t]);
      var bi = 0, bw = -1;
      for (var k = 0; k < bounds.length - 1; k++) {
        var wk = bounds[k + 1] - bounds[k];
        if (wk > bw) { bw = wk; bi = k; }
      }
      var x0 = bounds[bi], x1 = bounds[bi + 1];
      /* 该格里已占的标高(只算 u 区间与本格重叠的水平板) */
      var takenZ = st.panels.filter(function (q) {
        if (q.plane !== 'XY') return false;
        return Math.max(q.u0, x0) < Math.min(q.u1, x1) - 1e-6;
      }).map(function (q) { return q.at; });
      p = {
        id: uniqId('S'), name: '层板', plane: 'XY',
        at: G.round(freeSpot(e.z[0] + t * 2, e.z[1] - t * 2, takenZ, t * 4), 1),
        u0: G.round(x0, 1), u1: G.round(x1, 1),
        v0: G.round(e.y[0], 1), v1: G.round(e.y[1], 1),
        qty: 1, grain: 'long'
      };
    }
    ctx.state.panels.push(p);
    setSel(p.id, false);
    ctx.changed(); render(); drawPlan();
  }
  function dupPanel() {
    var st = ctx.state;
    var i = st.panels.map(function (p) { return p.id; }).indexOf(st.sel);
    if (i < 0) return;
    var c = JSON.parse(JSON.stringify(st.panels[i]));
    c.id = uniqId('C');
    c.name = c.name + '·副本';
    st.panels.splice(i + 1, 0, c);
    setSel(c.id, false);
    ctx.changed(); render(); drawPlan();
  }
  function delPanel() {
    var st = ctx.state;
    var i = st.panels.map(function (p) { return p.id; }).indexOf(st.sel);
    if (i < 0) return;
    st.panels.splice(i, 1);
    setSel(st.panels.length ? st.panels[Math.min(i, st.panels.length - 1)].id : null, false);
    ctx.changed(); render(); drawPlan();
  }

  /* ============================================================
   * 工艺子表（孔 / 切口 / 铣槽）—— 与清单模式、板位模式共用
   * ============================================================ */
  function featureRows(obj, key, cols, opts) {
    var out = [];
    var list = obj[key] || (obj[key] = []);
    var head = el('tr', 'subhead');
    var hc = el('td');
    hc.colSpan = cols;
    hc.appendChild(el('span', '', opts.title + '（' + list.length + '）　'));
    hc.appendChild(btn('＋ 添加', '', function () {
      list.push(opts.blank());
      ctx.changed(); render();
    }));
    head.appendChild(hc);
    out.push(head);
    list.forEach(function (item, i) {
      var tr = el('tr');
      var c = el('td');
      c.colSpan = cols;
      c.style.textAlign = 'left';
      c.style.paddingLeft = '24px';
      c.appendChild(el('span', 'grp', opts.title + ' #' + (i + 1) + '　'));
      opts.fields(item, obj).forEach(function (nd) {
        if (typeof nd === 'string') { c.appendChild(el('span', 'grp', nd)); }
        else { c.appendChild(nd); c.appendChild(document.createTextNode(' ')); }
      });
      c.appendChild(btn('删除', 'danger', function () {
        list.splice(i, 1); ctx.changed(); render();
      }));
      tr.appendChild(c);
      out.push(tr);
    });
    return out;
  }

  function holeFields(h) {
    var f = [
      '类型 ', sel(HOLE_TYPES, h.type || 'circle', function (v) { h.type = v; ctx.changed(); render(); }),
      ' 基准 ', sel(REFS, h.ref || 'bl', function (v) { h.ref = v; ctx.changed(); }),
      ' x ', inp('number', h.x === undefined ? 0 : h.x, function (v) { h.x = num(v, 0); ctx.changed(); }, 'narrow', { step: 5 }),
      ' y ', inp('number', h.y === undefined ? 0 : h.y, function (v) { h.y = num(v, 0); ctx.changed(); }, 'narrow', { step: 5 })
    ];
    if (h.type === 'rect') {
      f = f.concat([' 宽 ', inp('number', h.w === undefined ? 40 : h.w, function (v) { h.w = num(v, 40); ctx.changed(); }, 'narrow', { step: 5, min: 1 }),
        ' 高 ', inp('number', h.h === undefined ? 20 : h.h, function (v) { h.h = num(v, 20); ctx.changed(); }, 'narrow', { step: 5, min: 1 }),
        ' 圆角 ', inp('number', h.r === undefined ? 0 : h.r, function (v) { h.r = num(v, 0); ctx.changed(); }, 'narrow', { step: 1, min: 0 })]);
    } else if (h.type === 'slot') {
      f = f.concat([' 总长 ', inp('number', h.len === undefined ? 60 : h.len, function (v) { h.len = num(v, 60); ctx.changed(); }, 'narrow', { step: 5, min: 1 }),
        ' 宽 ', inp('number', h.d === undefined ? 20 : h.d, function (v) { h.d = num(v, 20); ctx.changed(); }, 'narrow', { step: 1, min: 1 }),
        ' 角度 ', inp('number', h.ang === undefined ? 0 : h.ang, function (v) { h.ang = num(v, 0); ctx.changed(); }, 'narrow', { step: 15 })]);
    } else {
      f = f.concat([' 直径 ', inp('number', h.d === undefined ? 12 : h.d, function (v) { h.d = num(v, 12); ctx.changed(); }, 'narrow', { step: 1, min: 1 })]);
    }
    return f;
  }
  function notchFields(n) {
    return [
      '在 ', sel(EDGE_NAMES, n.edge || 'bottom', function (v) { n.edge = v; ctx.changed(); }),
      ' 距起点 ', inp('number', n.at === undefined ? 50 : n.at, function (v) { n.at = num(v, 0); ctx.changed(); }, 'narrow', { step: 5, min: 0 }),
      ' 长 ', inp('number', n.len === undefined ? 60 : n.len, function (v) { n.len = num(v, 60); ctx.changed(); }, 'narrow', { step: 5, min: 1 }),
      ' 深 ', inp('number', n.depth === undefined ? 30 : n.depth, function (v) { n.depth = num(v, 30); ctx.changed(); }, 'narrow', { step: 5, min: 1 })
    ];
  }
  function pocketFields(pk) {
    return [
      '基准 ', sel(REFS, pk.ref || 'center', function (v) { pk.ref = v; ctx.changed(); }),
      ' x ', inp('number', pk.x === undefined ? 0 : pk.x, function (v) { pk.x = num(v, 0); ctx.changed(); }, 'narrow', { step: 5 }),
      ' y ', inp('number', pk.y === undefined ? 0 : pk.y, function (v) { pk.y = num(v, 0); ctx.changed(); }, 'narrow', { step: 5 }),
      ' 宽 ', inp('number', pk.w === undefined ? 120 : pk.w, function (v) { pk.w = num(v, 120); ctx.changed(); }, 'narrow', { step: 5, min: 1 }),
      ' 高 ', inp('number', pk.h === undefined ? 20 : pk.h, function (v) { pk.h = num(v, 20); ctx.changed(); }, 'narrow', { step: 5, min: 1 }),
      ' 深 ', inp('number', pk.depth === undefined ? 6 : pk.depth, function (v) { pk.depth = num(v, 6); ctx.changed(); }, 'narrow', { step: 0.5, min: 0.5 }),
      ' 圆角 ', inp('number', pk.r === undefined ? 0 : pk.r, function (v) { pk.r = num(v, 0); ctx.changed(); }, 'narrow', { step: 1, min: 0 })
    ];
  }

  /* 四角 + 洞洞板两组"轻量工艺"直接放在主行里 */
  function cornerCells(obj) {
    var cur = obj.corners && obj.corners.all ? obj.corners.all : null;
    var tp = cur ? (cur.type || 'notch') : 'none';
    var szv = cur ? (cur.size === undefined ? 20 : cur.size) : 20;
    var a = sel(CORNER_TYPES, tp, function (v) {
      if (v === 'none') obj.corners = null;
      else obj.corners = { all: { type: v, size: szv } };
      ctx.changed(); render();
    });
    var b = inp('number', szv, function (v) {
      var s2 = num(v, 0);
      if (!obj.corners) obj.corners = { all: { type: 'notch', size: s2 } };
      else obj.corners.all.size = s2;
      ctx.changed();
    }, 'narrow', { step: 2, min: 0 });
    b.disabled = (tp === 'none');
    return [a, b];
  }
  function pegCells(obj) {
    var pb = obj.pegboard || null;
    var on = !!(pb && num(pb.dia, 0) > 0);
    var c0 = chk(on, function (v) {
      obj.pegboard = v ? { dia: 12, pitch: 40, margin: 30, stagger: false } : null;
      ctx.changed(); render();
    });
    function f(key, dflt, step) {
      var e = inp('number', pb ? (pb[key] === undefined ? dflt : pb[key]) : dflt, function (v) {
        if (!obj.pegboard) return;
        obj.pegboard[key] = num(v, dflt);
        ctx.changed();
      }, 'narrow', { step: step, min: 1 });
      e.disabled = !on;
      return e;
    }
    var st2 = chk(pb && pb.stagger, function (v) { if (obj.pegboard) { obj.pegboard.stagger = v; ctx.changed(); } });
    st2.disabled = !on;
    return [c0, f('dia', 12, 1), f('pitch', 40, 5), f('margin', 30, 5), st2];
  }

  /* ============================================================
   * 清单模式表格
   * ============================================================ */
  function renderList() {
    var st = ctx.state;
    if (!st.rows.length) {
      var tip = el('div', 'emptyTip');
      tip.innerHTML = '清单是空的。<b>左侧挑一个模板套用</b>，或点上方「＋ 加一行」自己填。<br>' +
        '一行 = 一块板：长 × 宽 × 数量，需要开孔/开槽再展开「工艺」。';
      host.innerHTML = '';
      host.appendChild(tip);
      return;
    }
    var tbl = el('table');
    var COLS = ['启用', '零件名', '长(mm)', '宽(mm)', '数量', '纹理', '四角', '角尺寸',
      '洞洞板', 'Ø孔径', '孔距', '留边', '错排', '备注', '工艺', '操作'];
    var thead = el('thead'), htr = el('tr');
    COLS.forEach(function (h) { htr.appendChild(el('th', '', h)); });
    thead.appendChild(htr);
    tbl.appendChild(thead);
    var tb = el('tbody');
    st.rows.forEach(function (row, i) {
      var tr = el('tr', (st.sel === 'row' + i ? 'sel ' : '') + (row.off ? 'off' : ''));
      tr.appendChild(td(chk(!row.off, function (v) { row.off = !v; ctx.changed(); render(); })));
      tr.appendChild(td(inp('text', row.name, function (v) { row.name = v; ctx.changed(); }, 'wide')));
      tr.appendChild(td(inp('number', row.len, function (v) { row.len = num(v, 0); ctx.changed(); }, '', { step: 10, min: 1 })));
      tr.appendChild(td(inp('number', row.wid, function (v) { row.wid = num(v, 0); ctx.changed(); }, '', { step: 10, min: 1 })));
      tr.appendChild(td(inp('number', row.qty === undefined ? 1 : row.qty, function (v) { row.qty = Math.max(1, Math.round(num(v, 1))); ctx.changed(); }, 'narrow', { step: 1, min: 1 })));
      tr.appendChild(td(sel(GRAINS, row.grain || 'any', function (v) { row.grain = v; ctx.changed(); })));
      var cc = cornerCells(row);
      tr.appendChild(td(cc[0]));
      tr.appendChild(td(cc[1]));
      pegCells(row).forEach(function (nd) { tr.appendChild(td(nd)); });
      tr.appendChild(td(inp('text', row.note || '', function (v) { row.note = v; ctx.changed(); }, 'wide')));
      var nFeat = (row.holes || []).length + (row.notches || []).length + (row.pockets || []).length;
      tr.appendChild(td(btn((expanded['row' + i] ? '收起' : '展开') + (nFeat ? ' (' + nFeat + ')' : ''), '', function () {
        expanded['row' + i] = !expanded['row' + i];
        st.sel = 'row' + i;
        render();
      })));
      var act = el('td', 'act');
      act.appendChild(btn('复制', '', function () {
        st.rows.splice(i + 1, 0, JSON.parse(JSON.stringify(row)));
        ctx.changed(); render();
      }));
      act.appendChild(btn('↑', '', function () {
        if (i === 0) return;
        st.rows.splice(i - 1, 0, st.rows.splice(i, 1)[0]); ctx.changed(); render();
      }));
      act.appendChild(btn('↓', '', function () {
        if (i >= st.rows.length - 1) return;
        st.rows.splice(i + 1, 0, st.rows.splice(i, 1)[0]); ctx.changed(); render();
      }));
      act.appendChild(btn('删', 'danger', function () {
        st.rows.splice(i, 1); delete expanded['row' + i]; ctx.changed(); render();
      }));
      tr.appendChild(act);
      tb.appendChild(tr);
      if (expanded['row' + i]) {
        featureRows(row, 'holes', COLS.length, {
          title: '孔', blank: function () { return { type: 'circle', ref: 'bl', x: 50, y: 50, d: 12 }; },
          fields: holeFields
        }).forEach(function (r) { tb.appendChild(r); });
        featureRows(row, 'notches', COLS.length, {
          title: '边部切口', blank: function () { return { edge: 'bottom', at: 50, len: 60, depth: 30 }; },
          fields: notchFields
        }).forEach(function (r) { tb.appendChild(r); });
        featureRows(row, 'pockets', COLS.length, {
          title: '定深铣槽', blank: function () { return { ref: 'center', x: 0, y: 0, w: 120, h: 20, depth: 6, r: 0 }; },
          fields: pocketFields
        }).forEach(function (r) { tb.appendChild(r); });
      }
    });
    tbl.appendChild(tb);
    host.innerHTML = '';
    host.appendChild(tbl);
  }

  /* ============================================================
   * 板位表模式
   * ============================================================ */
  /* 朝向: 用"这块板朝哪边"描述, 而不是 XY/YZ/XZ 平面代号。
   * 用户想的是"这是一块层板/立板/背板", 不是"法向是 z 轴"。 */
  var ORIENTS = [
    ['XY', '横放（层板 / 顶底板）'],
    ['YZ', '竖放（侧板 / 竖隔板）'],
    ['XZ', '竖放（背板 / 门板）']
  ];
  var ORIENT_SHORT = { XY: '横放·层板', YZ: '竖放·侧板', XZ: '竖放·背板' };

  function renderPanels(readOnly) {
    var st = ctx.state, C = global.Custom;
    var t = ctx.thickness();
    var list = readOnly ? derivedPanels() : st.panels;
    if (!list.length) {
      host.innerHTML = '';
      var tip = el('div', 'emptyTip');
      tip.innerHTML = '还没有板位。点上方「＋ 竖隔板 / ＋ 层板 / ＋ 背板」，或先在<b>结构配方</b>里选一个结构再转过来。';
      host.appendChild(tip);
      return;
    }

    /* 表头分两行: 上行是分组(位置 / 尺寸), 下行才是具体列。
     * 这样"左起X 前起Y 离地Z"与"宽W 深D 高H"一眼分得开。 */
    var GRP = [
      ['', 1], ['板名', 1], ['朝向', 1],
      ['位置（板的最小角，mm）', 3], ['尺寸（mm，灰=板厚自动）', 3],
      ['数量', 1], ['纹理', 1], ['四角', 2], ['洞洞板', 5],
      ['备注', 1], ['工艺', 1], ['操作', 1]
    ];
    var COLS = ['选中', '板名', '朝向',
      '左起 X', '前起 Y', '离地 Z', '宽 W', '深 D', '高 H',
      '数量', '纹理', '类型', '角尺寸',
      '启用', 'Ø孔径', '孔距', '留边', '错排',
      '备注', '工艺', '操作'];
    var NCOL = COLS.length;

    var tbl = el('table');
    var thead = el('thead');
    var gtr = el('tr', 'grouphead');
    GRP.forEach(function (g, gi) {
      var th = el('th', '', g[0]);
      if (g[1] > 1) th.colSpan = g[1];
      th.className = g[0] ? 'grp1' : 'grp0';
      if (gi === 0) th.className += ' stickL';
      if (gi === GRP.length - 1) th.className += ' stickR';
      gtr.appendChild(th);
    });
    thead.appendChild(gtr);
    var htr = el('tr');
    COLS.forEach(function (h, ci) {
      var th = el('th', '', h);
      /* 位置/尺寸两组各自加左边界线, 视觉上把 6 个数字分块 */
      if (ci === 3 || ci === 6 || ci === 9) th.className = 'sepL';
      /* 表太宽时要横滚: 首列(选中)钉左、末列(操作)钉右 */
      if (ci === 0) th.className = 'stickL';
      if (ci === COLS.length - 1) th.className = 'stickR';
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    tbl.appendChild(thead);

    var tb = el('tbody');
    list.forEach(function (p, i) {
      var on = readOnly ? (st.sel === p.id) : isSel(p.id);
      var tr = el('tr', on ? 'sel' : '');
      var box = C.panelBox(p, t) || { x: 0, y: 0, z: 0, w: 0, d: 0, h: 0 };
      /* 存盘后 Ctrl/Shift 点圆点 = 多选(和三视图一致) */
      var pick = btn(on ? '●' : '○', '', function (ev) {
        if (readOnly) { st.sel = on ? null : p.id; }
        else if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) setSel(p.id, true);
        else if (on && selIds().length === 1) setSel(null);
        else setSel(p.id, false);
        render(); drawPlan();
      });
      pick.title = 'Ctrl/Shift 点可多选, 多选后可用上方对齐 / 等间距';
      tr.appendChild(td(pick, 'stickL'));

      if (readOnly) {
        tr.appendChild(td(p.name));
        tr.appendChild(td(ORIENT_SHORT[p.plane] || p.plane));
        ['x', 'y', 'z', 'w', 'd', 'h'].forEach(function (k, ki) {
          var c = td(String(G.round(box[k], 1)), ki === 0 || ki === 3 ? 'sepL' : '');
          if (C.isThickField(k, p.plane)) c.className += ' thick';
          tr.appendChild(c);
        });
        tr.appendChild(td(String(p.qty || 1), 'sepL'));
        tr.appendChild(td(({ long: '横纹', cross: '竖纹' })[p.grain] || '不限'));
        for (var k2 = 0; k2 < NCOL - 12; k2++) tr.appendChild(td('—'));
        tr.appendChild(td('只读', 'act'));
      } else {
        tr.appendChild(td(inp('text', p.name, function (v) { p.name = v; ctx.changed(); }, 'wide')));
        /* 换朝向时保持世界盒不变(只把厚度塌到新轴), 否则板会瞬移 */
        tr.appendChild(td(sel(ORIENTS, p.plane, function (v) {
          C.setPanelPlane(p, v, ctx.thickness());
          ctx.changed(); render(); drawPlan();
        }, 'wide')));
        ['x', 'y', 'z', 'w', 'd', 'h'].forEach(function (k, ki) {
          var locked = C.isThickField(k, p.plane);
          var e = inp('number', G.round(box[k], 2), function (v) {
            var b2 = C.panelBox(p, ctx.thickness());
            b2[k] = num(v, 0);
            C.setPanelBox(p, b2, ctx.thickness());
            ctx.changed(); drawPlan();
          }, locked ? 'lock' : '', { step: 5 });
          if (locked) {
            e.disabled = true;
            e.title = '这个方向就是板厚方向，由板厚决定，改朝向才会变';
          }
          tr.appendChild(td(e, ki === 0 || ki === 3 ? 'sepL' : ''));
        });
        tr.appendChild(td(inp('number', p.qty || 1, function (v) {
          p.qty = Math.max(1, Math.round(num(v, 1))); ctx.changed();
        }, 'narrow', { step: 1, min: 1 }), 'sepL'));
        tr.appendChild(td(sel(GRAINS, p.grain || 'any', function (v) { p.grain = v; ctx.changed(); })));
        var cc = cornerCells(p);
        tr.appendChild(td(cc[0]));
        tr.appendChild(td(cc[1]));
        pegCells(p).forEach(function (nd) { tr.appendChild(td(nd)); });
        tr.appendChild(td(inp('text', p.note || '', function (v) { p.note = v; ctx.changed(); }, 'wide')));
        var nF = (p.holes || []).length + (p.pockets || []).length;
        tr.appendChild(td(btn((expanded[p.id] ? '收起' : '展开') + (nF ? ' (' + nF + ')' : ''), '', function () {
          expanded[p.id] = !expanded[p.id];
          st.sel = p.id;
          render(); drawPlan();
        })));
        var act = el('td', 'act');
        act.appendChild(btn('复制', '', function () { setSel(p.id, false); dupPanel(); }));
        act.appendChild(btn('删', 'danger', function () { setSel(p.id, false); delPanel(); }));
        tr.appendChild(act);
      }
      tb.appendChild(tr);
      if (!readOnly && expanded[p.id]) {
        featureRows(p, 'holes', NCOL, {
          title: '孔', blank: function () { return { type: 'circle', ref: 'bl', x: 50, y: 50, d: 12 }; },
          fields: holeFields
        }).forEach(function (r) { tb.appendChild(r); });
        featureRows(p, 'pockets', NCOL, {
          title: '定深铣槽', blank: function () { return { ref: 'center', x: 0, y: 0, w: 120, h: 20, depth: 6, r: 0 }; },
          fields: pocketFields
        }).forEach(function (r) { tb.appendChild(r); });
      }
    });
    tbl.appendChild(tb);
    host.innerHTML = '';
    /* 表格上方补一条"怎么读这张表"的说明, 免得又要猜 */
    var lead = el('div', 'gridLead');
    lead.innerHTML = '每一行 = 一块板。<b>位置</b>填板的最小角（左/前/下）在柜体里的坐标，' +
      '<b>尺寸</b>填三个方向的长度 —— 其中灰掉的那个就是板厚方向，由板厚自动决定。' +
      '下方三视图里可以<b>直接拖动</b>板位（自动吸附），拖完这里的数字跟着变。';
    host.appendChild(lead);
    host.appendChild(tbl);
  }

  /* ============================================================
   * 对齐工具条（板位表模式，多选时才有意义）
   * ============================================================ */
  var ALIGN_GROUPS = [
    { axis: 'x', label: '左右', keys: ['xmin', 'xmid', 'xmax'] },
    { axis: 'y', label: '前后', keys: ['ymin', 'ymid', 'ymax'] },
    { axis: 'z', label: '上下', keys: ['zmin', 'zmid', 'zmax'] }
  ];
  function alignInfo(key) {
    var list = global.Custom.ALIGN_MODES || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return { key: key, label: key, hint: '' };
  }
  function doAlign(key) {
    var st = ctx.state, r = global.Custom.alignPanels(st.panels, selIds(), key, ctx.thickness());
    lastSnaps = [];
    alignMsg = r.error ? r.error
      : (r.moved.length ? alignInfo(key).label + '：移动了 ' + r.moved.length + ' 块板' : alignInfo(key).label + '：本来就齐了');
    if (r.moved.length) { roundAll(selIds()); ctx.changed(); }
    render(); drawPlan();
  }
  function doDistribute(axis, mode) {
    var st = ctx.state;
    var r = global.Custom.distributePanels(st.panels, selIds(), axis, ctx.thickness(), { mode: mode });
    lastSnaps = [];
    var an = ({ x: '左右', y: '前后', z: '上下' })[axis];
    alignMsg = r.error ? r.error
      : (mode === 'center' ? an + ' 中线等距：间距 ' + G.round(r.gap, 1) + 'mm'
        : an + ' 等间距：净空 ' + G.round(r.gap, 1) + 'mm') +
      '（移动 ' + r.moved.length + ' 块）';
    if (r.moved.length) { roundAll(selIds()); ctx.changed(); }
    render(); drawPlan();
  }
  function roundAll(ids) {
    var C = global.Custom, t = ctx.thickness();
    ctx.state.panels.forEach(function (p) {
      if (ids.indexOf(p.id) < 0) return;
      var b = C.panelBox(p, t);
      ['x', 'y', 'z', 'w', 'd', 'h'].forEach(function (k) { b[k] = G.round(b[k], 1); });
      C.setPanelBox(p, b, t);
    });
  }
  var alignMsg = '';

  function renderAlignBar() {
    var st = ctx.state;
    var wrap = $('alignBar');
    if (!wrap) return;
    wrap.innerHTML = '';
    /* 必须写死 'flex': CSS 里 #alignBar 的默认值就是 display:none,
     * 写 '' 会退回 CSS 规则 -> 永远不显示。这条是被像素探针掳到的真 bug:
     * 旧断言只查 style.display !== 'none', 而 '' 确实 !== 'none', 于是假绿。 */
    if (st.cmode !== 'panels') { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    var ids = selIds();
    var n = ids.length;
    var lb = el('span', 'lbl', n ? '已选 ' + n + ' 块' : '对齐：先选板（Ctrl/Shift 点第二块可多选）');
    wrap.appendChild(lb);
    ALIGN_GROUPS.forEach(function (grp) {
      var g = el('span', 'agrp');
      g.appendChild(el('span', 'atag', grp.label));
      grp.keys.forEach(function (k) {
        var info = alignInfo(k);
        var b = btn(info.label, 'al', function () { doAlign(k); });
        b.title = info.hint + '（需 ≥2 块）';
        b.disabled = n < 2;
        g.appendChild(b);
      });
      var d1 = btn('等间距', 'al dist', function () { doDistribute(grp.axis, 'gap'); });
      d1.title = '首末两块不动，中间的重排，使相邻板之间的净空完全相等（需 ≥3 块）';
      d1.disabled = n < 3;
      g.appendChild(d1);
      var d2 = btn('中线等距', 'al dist', function () { doDistribute(grp.axis, 'center'); });
      d2.title = '按板的中线等距排布，适合格栅条 / 打孔阵列（需 ≥3 块）';
      d2.disabled = n < 3;
      g.appendChild(d2);
      wrap.appendChild(g);
    });
    var clr = btn('清除选中', '', function () { setSel(null); alignMsg = ''; render(); drawPlan(); });
    clr.disabled = !n;
    wrap.appendChild(clr);
    if (alignMsg) {
      var m = el('span', 'alignMsg', alignMsg);
      wrap.appendChild(m);
    }
    if (n >= 2) {
      var se = global.Custom.selectionExtent(st.panels, ids, ctx.thickness());
      if (se) {
        wrap.appendChild(el('span', 'lbl', '选集跨度 ' +
          G.round(se.ext.x[1] - se.ext.x[0], 1) + ' × ' +
          G.round(se.ext.y[1] - se.ext.y[0], 1) + ' × ' +
          G.round(se.ext.z[1] - se.ext.z[0], 1) + 'mm'));
      }
    }
  }

  /* ============================================================
   * 三视图（可点选 / 可拖拽 / 拖拽时画吸附参考线）
   * ============================================================ */
  function drawPlan() {
    var st = ctx.state;
    var wrap = $('planWrap');
    /* 三视图隐起来时那根拖拽分隔条也要跟着隐 ——
     * 否则清单模式下表格底下会挂一根拖不动任何东西的条。 */
    var spl = $('splitH');
    if (st.cmode === 'list') {
      wrap.style.display = 'none';
      if (spl) spl.style.display = 'none';
      st.planHit = null; st.planPick = null;
      return;
    }
    wrap.style.display = '';
    if (spl) spl.style.display = '';
    var list = st.cmode === 'panels' ? st.panels : derivedPanels();
    var guides = (drag ? lastSnaps : []).map(function (s) {
      return { axis: s.axis, v: s.line, kind: s.kind, label: s.label };
    });
    var r = global.Render.drawPlan(planCv, list, {
      thickness: ctx.thickness(),
      selected: st.cmode === 'panels' ? selIds() : (st.sel ? [st.sel] : []),
      hover: drag ? null : hoverId,
      guides: guides,
      emptyText: '还没有板位：用上方按钮添加，或先在结构配方里选一个结构'
    });
    st.planHit = r ? r.hit : null;
    st.planPick = r ? r.pick : null;
    var hud = $('planHud');
    if (!r) { hud.textContent = ''; return; }
    if (st.cmode !== 'panels') {
      hud.textContent = '配方预览为只读：点「转为板位表继续改 →」后即可拖拽调整';
      return;
    }
    if (drag && lastSnaps.length) {
      hud.innerHTML = '<b>已吸附</b>　' + lastSnaps.map(function (s) { return s.label; }).join(' ／ ');
    } else if (drag) {
      hud.textContent = '拖动中…（松手落位，按住 Alt 可临时关闭吸附）';
    } else {
      var n = selIds().length;
      hud.innerHTML = '在任一视图里<b>直接拖动矩形</b>即可移动该板，会自动吸附到其它板的边/中线（Alt 关闭吸附）。' +
        'Ctrl/Shift 点选可多选' + (n > 1 ? '（当前 ' + n + ' 块，一起拖动）' : '') + '，再用上方对齐按钮。';
    }
  }

  function render() {
    if (!host) return;
    var st = ctx.state;
    if (!st.selMulti) st.selMulti = [];
    /* 选中集里可能有已被删掉的 id, 清掉免得对齐按钮对着幽灵操作 */
    if (st.selMulti.length) {
      var live = {};
      st.panels.forEach(function (p) { live[p.id] = 1; });
      st.selMulti = st.selMulti.filter(function (id) { return live[id]; });
      if (st.sel && !live[st.sel]) st.sel = st.selMulti.length ? st.selMulti[st.selMulti.length - 1] : null;
    }
    renderBar();
    renderAlignBar();
    if (st.cmode === 'list') renderList();
    else if (st.cmode === 'panels') renderPanels(false);
    else renderPanels(true);
    drawPlan();
  }

  global.Editor = {
    init: init, render: render, drawPlan: drawPlan,
    derivedPanels: derivedPanels, addPanel: addPanel, delPanel: delPanel, dupPanel: dupPanel,
    expanded: expanded,
    selIds: selIds, setSel: setSel, isSel: isSel,
    doAlign: doAlign, doDistribute: doDistribute,
    /* 测试钩子: 用世界坐标模拟一次拖拽, 免得测试要自己算 canvas 像素 */
    __drag: function () { return drag; },
    __snaps: function () { return lastSnaps.slice(); }
  };
})(typeof window !== 'undefined' ? window : this);
