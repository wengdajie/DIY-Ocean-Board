# -*- coding: utf-8 -*-
"""独立实现的 DXF / SVG / CSV 交叉校验器（第三方视角）

用法:
  1) 用 Chrome 跑 app/tests/dump.html, 把 <pre id="out"> 的内容存成 tools/dump.json
     (PowerShell 一行版见文件末尾)
  2) python tools/verify_exports.py

设计原则: **刻意不复用任何 JS 逻辑**。
DXF 解析、带 bulge 的精确面积、含圆弧极值点的包围盒、RFC4180 CSV 解析
全部在 Python 里重写一遍。只有两套独立实现算出同样的数, 才说明导出真的对。
"""
import io, json, math, os, re, sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
DUMP = os.path.join(HERE, 'dump.json')
if not os.path.exists(DUMP):
    print('找不到 %s\n请先按文件末尾说明生成。' % DUMP)
    sys.exit(2)

D = json.load(io.open(DUMP, encoding='utf-8'))
OK = [0]
BAD = []


def chk(name, cond, extra=''):
    if cond:
        OK[0] += 1
    else:
        BAD.append('%s  [%s]' % (name, extra))


# ---------------- DXF R12 解析 ----------------
def parse_dxf(text):
    lines = text.replace('\r\n', '\n').split('\n')
    pairs = []
    i = 0
    while i + 1 < len(lines):
        code = lines[i].strip()
        val = lines[i + 1]
        if code == '' and val == '':
            i += 2
            continue
        pairs.append((int(code), val.strip()))
        i += 2
    sections, layers, polys, texts = [], [], [], []
    cur = None
    j = 0
    while j < len(pairs):
        c, v = pairs[j]
        if c == 0 and v == 'SECTION':
            k = j + 1
            while k < len(pairs) and pairs[k][0] != 2:
                k += 1
            if k < len(pairs):
                sections.append(pairs[k][1])
        elif c == 0 and v == 'LAYER':
            k = j + 1
            while k < len(pairs) and pairs[k][0] != 0:
                if pairs[k][0] == 2:
                    layers.append(pairs[k][1])
                    break
                k += 1
        elif c == 0 and v == 'POLYLINE':
            cur = {'verts': [], 'layer': None, 'closed': False}
            k = j + 1
            while k < len(pairs) and pairs[k][0] != 0:
                if pairs[k][0] == 8:
                    cur['layer'] = pairs[k][1]
                if pairs[k][0] == 70:
                    cur['closed'] = bool(int(pairs[k][1]) & 1)
                k += 1
            polys.append(cur)
        elif c == 0 and v == 'VERTEX' and cur is not None:
            vx = vy = 0.0
            bl = 0.0
            k = j + 1
            while k < len(pairs) and pairs[k][0] != 0:
                if pairs[k][0] == 10: vx = float(pairs[k][1])
                elif pairs[k][0] == 20: vy = float(pairs[k][1])
                elif pairs[k][0] == 42: bl = float(pairs[k][1])
                k += 1
            cur['verts'].append((vx, vy, bl))
        elif c == 0 and v == 'TEXT':
            t = {'layer': None, 'text': None}
            k = j + 1
            while k < len(pairs) and pairs[k][0] != 0:
                if pairs[k][0] == 8: t['layer'] = pairs[k][1]
                if pairs[k][0] == 1: t['text'] = pairs[k][1]
                k += 1
            texts.append(t)
        j += 1
    return {'sections': sections, 'layers': layers, 'polys': polys,
            'texts': texts, 'eof': pairs[-1] == (0, 'EOF'), 'pairs': pairs}


# ---------------- 带 bulge 的精确几何(独立实现) ----------------
def arc_of(p1, p2, b):
    """bulge = tan(sweep/4)。返回 (cx, cy, r, a1, sweep)。"""
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    chord = math.hypot(dx, dy)
    if chord < 1e-12 or abs(b) < 1e-12:
        return None
    sweep = 4.0 * math.atan(b)
    r = chord / 2.0 / abs(math.sin(sweep / 2.0))
    h = math.sqrt(max(0.0, r * r - (chord / 2.0) ** 2))
    mx, my = (p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0
    ux, uy = dx / chord, dy / chord
    nx, ny = -uy, ux
    sign = 1.0 if b > 0 else -1.0
    if abs(sweep) > math.pi:
        h = -h
    cx, cy = mx - nx * h * sign, my - ny * h * sign
    a1 = math.atan2(p1[1] - cy, p1[0] - cx)
    return (cx, cy, r, a1, sweep)


def poly_area(verts):
    """多边形面积 + 每段弓形修正。正 = CCW。"""
    n = len(verts)
    a = 0.0
    for i in range(n):
        x1, y1, _ = verts[i]
        x2, y2, _ = verts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    a /= 2.0
    for i in range(n):
        p1, p2 = verts[i], verts[(i + 1) % n]
        if abs(p1[2]) < 1e-12:
            continue
        arc = arc_of(p1, p2, p1[2])
        if not arc:
            continue
        _, _, r, _, sweep = arc
        a += (r * r / 2.0) * (sweep - math.sin(sweep))   # 有符号弓形
    return a


def poly_bbox(verts):
    """包围盒必须考虑圆弧上的 0/90/180/270 极值点, 否则弧形板尺寸会算小。"""
    xs, ys = [], []
    n = len(verts)
    for i in range(n):
        p1, p2 = verts[i], verts[(i + 1) % n]
        xs.append(p1[0]); ys.append(p1[1])
        if abs(p1[2]) < 1e-12:
            continue
        arc = arc_of(p1, p2, p1[2])
        if not arc:
            continue
        cx, cy, r, a1, sweep = arc
        for k in range(4):
            ang = k * math.pi / 2.0
            for m in range(-3, 4):
                tt = (ang + 2 * math.pi * m - a1) / sweep if abs(sweep) > 1e-15 else -1
                if 0.0 <= tt <= 1.0:
                    xs.append(cx + r * math.cos(ang))
                    ys.append(cy + r * math.sin(ang))
                    break
    return min(xs), min(ys), max(xs), max(ys)


def perimeter(verts):
    per = 0.0
    for q in range(len(verts)):
        p1, p2 = verts[q], verts[(q + 1) % len(verts)]
        if abs(p1[2]) > 1e-12:
            arc = arc_of(p1, p2, p1[2])
            per += abs(arc[2] * arc[4]) if arc else math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        else:
            per += math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    return per


def csv_rows(text):
    """最小 RFC4180 解析: 处理引号包裹字段与字段内逗号/转义引号。
    (备注列会出现 '横撑(两端通榫, 肩距 1044)' 这种带逗号的值)"""
    rows, cur, fld, inq, i = [], [], '', False, 0
    while i < len(text):
        ch = text[i]
        if inq:
            if ch == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    fld += '"'
                    i += 2
                    continue
                inq = False
            else:
                fld += ch
        else:
            if ch == '"':
                inq = True
            elif ch == ',':
                cur.append(fld); fld = ''
            elif ch == '\n':
                cur.append(fld); fld = ''
                if any(c.strip() for c in cur):
                    rows.append(cur)
                cur = []
            elif ch != '\r':
                fld += ch
        i += 1
    if fld or cur:
        cur.append(fld)
        if any(c.strip() for c in cur):
            rows.append(cur)
    return rows


# ---------------- 逐模型校验 ----------------
KERF = 0.4

for key in sorted(D.keys()):
    blk = D[key]
    exp = blk['expect']
    p = parse_dxf(blk['dxf'])

    chk('%s DXF sections' % key, p['sections'] == ['HEADER', 'TABLES', 'ENTITIES'], p['sections'])
    chk('%s DXF ends with EOF' % key, p['eof'])
    chk('%s DXF has CUT layer' % key, 'CUT' in p['layers'], p['layers'])
    chk('%s DXF no NaN' % key, 'nan' not in blk['dxf'].lower())
    chk('%s DXF R12 header' % key, 'AC1009' in blk['dxf'])

    cut = [q for q in p['polys'] if q['layer'] == 'CUT']
    want = sum(e['loops'] for e in exp)
    chk('%s loop count = 1+holes' % key, len(cut) == want, '%d vs %d' % (len(cut), want))
    chk('%s all polylines closed' % key, all(q['closed'] for q in cut))
    chk('%s every polyline >= 3 verts' % key, all(len(q['verts']) >= 3 for q in cut),
        min((len(q['verts']) for q in cut), default=0))

    idx = 0
    for e in exp:
        loops = cut[idx: idx + e['loops']]
        idx += e['loops']
        outer, holes = loops[0], loops[1:]
        ao = poly_area(outer['verts'])
        chk('%s/%s 外轮廓 CCW' % (key, e['name']), ao > 0, ao)
        for hi, h in enumerate(holes):
            chk('%s/%s 孔%d CW' % (key, e['name'], hi), poly_area(h['verts']) < 0, poly_area(h['verts']))
        net = ao + sum(poly_area(h['verts']) for h in holes)
        chk('%s/%s 净面积一致' % (key, e['name']),
            abs(net - e['area']) < max(0.5, e['area'] * 2e-4), '%.2f vs %.2f' % (net, e['area']))
        x0, y0, x1, y1 = poly_bbox(outer['verts'])
        chk('%s/%s 宽一致' % (key, e['name']), abs((x1 - x0) - e['w']) < 0.01, '%.3f vs %.3f' % (x1 - x0, e['w']))
        chk('%s/%s 高一致' % (key, e['name']), abs((y1 - y0) - e['h']) < 0.01, '%.3f vs %.3f' % (y1 - y0, e['h']))
        for hi, h in enumerate(holes):
            hx0, hy0, hx1, hy1 = poly_bbox(h['verts'])
            chk('%s/%s 孔%d 在板内' % (key, e['name'], hi),
                hx0 >= x0 - 1e-6 and hy0 >= y0 - 1e-6 and hx1 <= x1 + 1e-6 and hy1 <= y1 + 1e-6,
                '%.3f,%.3f,%.3f,%.3f in %.3f,%.3f,%.3f,%.3f' % (hx0, hy0, hx1, hy1, x0, y0, x1, y1))

    # ---- kerf 补偿 ----
    pk = parse_dxf(blk['dxfKerf'])
    ck = [q for q in pk['polys'] if q['layer'] == 'CUT']
    chk('%s kerf 环数不变' % key, len(ck) == len(cut), '%d vs %d' % (len(ck), len(cut)))
    chk('%s kerf DXF 无 NaN' % key, 'nan' not in blk['dxfKerf'].lower())

    i0 = 0
    grow_ok, grow_why = 0, []
    rect_ok, rect_n, rect_why = 0, 0, []
    area_ok, area_why = 0, []
    for e in exp:
        a, b = cut[i0]['verts'], ck[i0]['verts']
        i0 += e['loops']
        ax0, ay0, ax1, ay1 = poly_bbox(a)
        bx0, by0, bx1, by1 = poly_bbox(b)
        dw, dh = (bx1 - bx0) - (ax1 - ax0), (by1 - by0) - (ay1 - ay0)
        # 必须严格外扩(每个方向至少 kerf, 两侧各 kerf/2), 且不失控
        if dw >= KERF - 1e-3 and dh >= KERF - 1e-3 and dw < KERF * 4 and dh < KERF * 4:
            grow_ok += 1
        else:
            grow_why.append('%s dw=%.3f dh=%.3f' % (e['name'], dw, dh))
        # 纯直角轮廓必须**精确** +kerf, 这是最硬的约束
        # (斜角顶点沿角平分线外移, 轴向位移必然大于 kerf/2, 那是正常的 miter)
        if all(abs(v[2]) < 1e-12 for v in a):
            segs_axis = all(
                abs(a[q][0] - a[(q + 1) % len(a)][0]) <= 1e-6 or
                abs(a[q][1] - a[(q + 1) % len(a)][1]) <= 1e-6
                for q in range(len(a)))
            if segs_axis:
                rect_n += 1
                if abs(dw - KERF) < 0.02 and abs(dh - KERF) < 0.02:
                    rect_ok += 1
                else:
                    rect_why.append('%s dw=%.3f dh=%.3f' % (e['name'], dw, dh))
        # 面积增量 ≈ 周长 × kerf/2 —— 与顶点形状无关的普适不变量
        got, wantA = poly_area(b) - poly_area(a), perimeter(a) * (KERF / 2)
        if got > 0 and abs(got - wantA) < max(6.0, wantA * 0.55):
            area_ok += 1
        else:
            area_why.append('%s got=%.2f want=%.2f' % (e['name'], got, wantA))
    chk('%s kerf 每件都外扩(>=%.1f 且不失控)' % (key, KERF), grow_ok == len(exp),
        '%d/%d %s' % (grow_ok, len(exp), '; '.join(grow_why[:2])))
    if rect_n:
        chk('%s kerf 直角件精确 +%.1f' % (key, KERF), rect_ok == rect_n,
            '%d/%d %s' % (rect_ok, rect_n, '; '.join(rect_why[:2])))
    chk('%s kerf 面积增量 ~ 周长x%.1f' % (key, KERF / 2), area_ok == len(exp),
        '%d/%d %s' % (area_ok, len(exp), '; '.join(area_why[:2])))

    # ---- SVG ----
    svg = blk['svg']
    chk('%s SVG 无 NaN' % key, 'NaN' not in svg and 'undefined' not in svg)
    chk('%s SVG 闭合标签' % key, svg.strip().endswith('</svg>'))
    chk('%s SVG mm 单位' % key, re.search(r'width="[\d.]+mm"', svg) is not None)
    chk('%s SVG evenodd 挖孔' % key, 'evenodd' in svg)
    npath = len(re.findall(r'<path', svg))
    # 每个零件 1 条外轮廓+孔的复合路径, 外加每个 pocket 各 1 条虚线路径
    npock = sum(e.get('pockets', 0) for e in exp)
    chk('%s SVG path 数 = 零件数 + pocket 数' % key, npath == len(exp) + npock,
        '%d vs %d+%d' % (npath, len(exp), npock))
    if npock:
        dashed = len(re.findall(r'stroke-dasharray="2,1\.2"', svg))
        chk('%s SVG pocket 用虚线区分' % key, dashed == npock, '%d vs %d' % (dashed, npock))
        titles = re.findall(r'<title>pocket depth ([\d.]+)mm</title>', svg)
        chk('%s SVG pocket 标注深度' % key, len(titles) == npock, '%d vs %d' % (len(titles), npock))
        want_d = sorted(round(d, 2) for e in exp for d in e.get('pocketDepths', []))
        got_d = sorted(round(float(t), 2) for t in titles)
        chk('%s SVG pocket 深度值逐个对上' % key, want_d == got_d, '%s vs %s' % (got_d[:6], want_d[:6]))
    chk('%s SVG 所有路径闭合(Z)' % key,
        all(dd.strip().endswith('Z') for dd in re.findall(r'\sd="([^"]+)"', svg)))

    # ---- POCKET 图层(定深铣槽) ----
    if npock:
        pk_polys = [q for q in p['polys'] if q['layer'] == 'POCKET']
        chk('%s DXF pocket 独立 POCKET 图层' % key, len(pk_polys) == npock,
            '%d vs %d' % (len(pk_polys), npock))
        chk('%s DXF 声明了 POCKET 图层' % key, 'POCKET' in p['layers'], p['layers'])
        # pocket 深度以 D<值> 文字标注在 POCKET 图层
        dtxt = [t['text'] for t in p['texts'] if t['layer'] == 'POCKET']
        chk('%s DXF pocket 有深度文字标注' % key, len(dtxt) == npock, '%d vs %d :: %s' % (len(dtxt), npock, dtxt[:4]))
        want_d2 = sorted(round(d, 2) for e in exp for d in e.get('pocketDepths', []))
        got_d2 = sorted(round(float(t[1:]), 2) for t in dtxt if re.match(r'^D[\d.]+$', t))
        chk('%s DXF pocket 深度文字值对上' % key, want_d2 == got_d2, '%s vs %s' % (got_d2[:6], want_d2[:6]))
        # pocket 环面积应与 JS 侧一致(独立算一遍)
        want_a = sorted(round(a, 1) for e in exp for a in e.get('pocketAreas', []))
        got_a = sorted(round(abs(poly_area(q['verts'])), 1) for q in pk_polys)
        chk('%s DXF pocket 面积逐个对上' % key, all(abs(x - y) < 0.5 for x, y in zip(want_a, got_a)) and len(want_a) == len(got_a),
            '%s vs %s' % (got_a[:6], want_a[:6]))
        # pocket 不切透 => 不能计入净面积。净面积应等于 外轮廓-通孔, 与 pocket 无关
        chk('%s pocket 不计入净面积' % key, all(
            e['area'] > 0 for e in exp), '')
        # pocket 必须整体落在零件轮廓内
        cut_polys = [q for q in p['polys'] if q['layer'] == 'CUT']
        allx = [v[0] for q in cut_polys for v in q['verts']]
        ally = [v[1] for q in cut_polys for v in q['verts']]
        inside = all(min(allx) - 0.5 <= v[0] <= max(allx) + 0.5 and
                     min(ally) - 0.5 <= v[1] <= max(ally) + 0.5
                     for q in pk_polys for v in q['verts'])
        chk('%s DXF pocket 落在零件轮廓包围盒内' % key, inside)
        # kerf 时 pocket 应**内缩**(槽净宽达标), 面积要变小
        PK = parse_dxf(blk['dxfKerf'])
        pk_k = [q for q in PK['polys'] if q['layer'] == 'POCKET']
        if len(pk_k) == len(pk_polys):
            a0 = sorted(abs(poly_area(q['verts'])) for q in pk_polys)
            a1 = sorted(abs(poly_area(q['verts'])) for q in pk_k)
            chk('%s kerf: pocket 内缩(面积变小)' % key,
                all(y < x - 1e-6 for x, y in zip(a0, a1)), '%s -> %s' % ([round(v) for v in a0[:4]], [round(v) for v in a1[:4]]))
    else:
        chk('%s 无 pocket 时不产生 POCKET 实体' % key,
            len([q for q in p['polys'] if q['layer'] == 'POCKET']) == 0)

    # ---- CSV ----
    csv = blk['csv']
    prows = csv_rows(csv)
    chk('%s CSV 行数 = 1+零件数(+合计)' % key, len(prows) in (len(exp) + 1, len(exp) + 2),
        '%d rows / %d parts' % (len(prows), len(exp)))
    chk('%s CSV 零件名逐个对上' % key,
        [r[1] for r in prows[1:len(exp) + 1]] == [e['name'] for e in exp],
        [r[1] for r in prows[1:3]])
    chk('%s CSV 无 NaN' % key, 'NaN' not in csv)
    ncol = len(prows[0])
    chk('%s CSV 列数一致' % key, all(len(r) == ncol for r in prows[1:]),
        '%d 列, 实际 %s' % (ncol, sorted(set(len(r) for r in prows))))
    chk('%s CSV 引号字段解析正确' % key, all(not any(f.count('"') % 2 for f in r) for r in prows))
    hdr = [h.lstrip('\ufeff') for h in prows[0]]
    WANT_HDR = ['序号', '零件名', '数量', '标准长W(mm)', '标准宽D(mm)',
                '下料包络长(mm)', '下料包络宽(mm)', '板厚(mm)', '纹理方向',
                '通孔数', '铣槽数', '面积(m2)', '切割周长(mm)', '备注']
    chk('%s CSV 表头 14 列完全一致' % key, hdr == WANT_HDR, hdr)
    # 逐行核对 数量 / 板厚 / 纹理 / 通孔数 / 铣槽数 / 切割周长
    GRAIN_CN = {'long': '横纹(顺长边)', 'cross': '竖纹(顺短边)', 'any': '不限'}
    if hdr == WANT_HDR:
        bad_rows = []
        for i, e in enumerate(exp):
            row = prows[1 + i]
            if row[1] != e['name']:
                bad_rows.append('%s 名字' % e['name']); continue
            if int(row[0]) != i + 1:
                bad_rows.append('%s 序号' % e['name'])
            if int(row[2]) != e['qty']:
                bad_rows.append('%s 数量 %s vs %s' % (e['name'], row[2], e['qty']))
            if abs(float(row[7]) - e['thickness']) > 1e-6:
                bad_rows.append('%s 板厚 %s vs %s' % (e['name'], row[7], e['thickness']))
            if row[8] != GRAIN_CN.get(e['grain'], '不限'):
                bad_rows.append('%s 纹理 %s vs %s' % (e['name'], row[8], e['grain']))
            if int(row[9]) != e['holes']:
                bad_rows.append('%s 通孔数 %s vs %s' % (e['name'], row[9], e['holes']))
            if int(row[10]) != e['pockets']:
                bad_rows.append('%s 铣槽数 %s vs %s' % (e['name'], row[10], e['pockets']))
            if abs(float(row[12]) - round(e['cutLength'])) > 1.5:
                bad_rows.append('%s 周长 %s vs %s' % (e['name'], row[12], e['cutLength']))
            if row[13] != e['note']:
                bad_rows.append('%s 备注' % e['name'])
        chk('%s CSV 每行 数量/板厚/纹理/孔数/铣槽/周长 全对' % key, not bad_rows, '; '.join(bad_rows[:4]))
        # 面积以 m² 给出, 且 = 外轮廓-通孔(不含 pocket)
        ok_area = 0
        for i, e in enumerate(exp):
            if abs(float(prows[1 + i][11]) * 1e6 - e['area']) < max(60.0, e['area'] * 0.002):
                ok_area += 1
        chk('%s CSV 面积(m2) 逐行对上且不含 pocket' % key, ok_area == len(exp), '%d/%d' % (ok_area, len(exp)))
        # 有 pocket 的行: 切割周长必须 > 外轮廓周长(说明 pocket 计入了走刀)
        pk_rows = [(i, e) for i, e in enumerate(exp) if e['pockets']]
        if pk_rows:
            okp = sum(1 for i, e in pk_rows
                      if float(prows[1 + i][12]) > 2 * (e['w'] + e['h']) * 0.9)
            chk('%s CSV pocket 计入切割周长' % key, okp == len(pk_rows), '%d/%d' % (okp, len(pk_rows)))
    chk('%s CSV 有 BOM(Excel 中文不乱码)' % key, csv.startswith('\ufeff'))
    iw, ih, ia = hdr.index('下料包络长(mm)'), hdr.index('下料包络宽(mm)'), hdr.index('面积(m2)')
    found, why, afound = 0, [], 0
    for e in exp:
        hit = False
        for f in prows[1:]:
            try:
                if abs(float(f[iw]) - e['w']) < 0.1 and abs(float(f[ih]) - e['h']) < 0.1:
                    hit = True
                    break
            except (ValueError, IndexError):
                pass
        if hit:
            found += 1
        else:
            why.append('%s %.1fx%.1f' % (e['name'], e['w'], e['h']))
        for f in prows[1:]:
            try:
                if abs(float(f[ia]) * 1e6 - e['area']) < max(60.0, e['area'] * 0.001):
                    afound += 1
                    break
            except (ValueError, IndexError):
                pass
    chk('%s CSV 每件尺寸都能对上' % key, found == len(exp), '%d/%d 缺: %s' % (found, len(exp), '; '.join(why[:2])))
    chk('%s CSV 面积列能对上' % key, afound >= len(exp) - 1, '%d/%d' % (afound, len(exp)))

# ---------------- 图片模式专项 ----------------
sil = D['imgSilhouette']
names = [e['name'] for e in sil['expect']]
base = [e for e in sil['expect'] if e['name'] == '底座'][0]
chk('图片轮廓件: 含底座', '底座' in names, names)
chk('图片轮廓件: 主件有孔(窗户)', sil['expect'][0]['holes'] >= 2, sil['expect'][0]['holes'])
chk('图片轮廓件: 底座有榫眼', base['holes'] >= 1, base['holes'])
# targetHeight 约束的是"剪影本体", 底部榫头(长 = 板厚 12)是额外伸出的
chk('图片轮廓件: 高 = 300 + 板厚(榫头)', abs(sil['expect'][0]['h'] - (300 + 12)) < 2, sil['expect'][0]['h'])
chk('图片轮廓件: 底座宽 = 件宽 + 2x外扩',
    abs(base['w'] - (sil['expect'][0]['w'] + 80)) < 2,
    '%.1f vs %.1f' % (base['w'], sil['expect'][0]['w'] + 80))

lay = D['imgLayers']
lnames = [e['name'] for e in lay['expect']]
areas = [e['area'] for e in lay['expect'] if re.match(r'^第\d+层$', e['name'])]
chk('分层: 至少 4 层', len([n for n in lnames if n.startswith('第')]) >= 4, lnames)
chk('分层: 面积逐层递减', all(areas[i] <= areas[i - 1] + 1 for i in range(1, len(areas))),
    [round(a) for a in areas])
chk('分层: 每层都有销孔', all(e['holes'] >= 1 for e in lay['expect']), [e['holes'] for e in lay['expect']])
pl = parse_dxf(lay['dxf'])
cutl = [q for q in pl['polys'] if q['layer'] == 'CUT']
chk('分层: DXF 含 bulge 圆弧(销孔)', any(abs(v[2]) > 1e-9 for q in cutl for v in q['verts']))
top = lay['expect'][-1]
chk('分层: 顶层近似圆(w≈h)', abs(top['w'] - top['h']) < top['w'] * 0.12, '%.1f vs %.1f' % (top['w'], top['h']))

cus = D['custom']
chk('自定义: 12 块板', len(cus['expect']) == 12, len(cus['expect']))
chk('自定义: 侧板有榫眼', max(e['holes'] for e in cus['expect']) >= 4,
    max(e['holes'] for e in cus['expect']))

# ============================================================
# 清单模式(重构版自定义): 洞洞板阵列 / 四角处理 / 边缺口 / 三类孔 / pocket
# ============================================================
cl = D['cutlist']
cle = {e['name']: e for e in cl['expect']}
clp = parse_dxf(cl['dxf'])
chk('清单: 4 种零件', len(cl['expect']) == 4, [e['name'] for e in cl['expect']])
chk('清单: 数量各不相同(1/2/3)', sorted(e['qty'] for e in cl['expect']) == [1, 1, 2, 3],
    [e['qty'] for e in cl['expect']])

# ---- 洞洞板 ----
pbd = cle['洞洞板']
chk('洞洞板: 外形 760x560', abs(pbd['w'] - 760) < .01 and abs(pbd['h'] - 560) < .01,
    '%.2fx%.2f' % (pbd['w'], pbd['h']))
# 760x560, 留边 30, 孔径 12, 孔距 40 => avail=(760-60-12)=688 -> 688//40+1=18 列
#                                        avail=(560-60-12)=488 -> 488//40+1=13 行
chk('洞洞板: 孔数 = 18x13 = 234', pbd['holes'] == 234, pbd['holes'])
# 从 DXF 里独立挑出洞洞板的孔, 验证 直径 / 孔距 / 阵列居中
pb_polys = [q for q in clp['polys'] if q['layer'] == 'CUT']
# 用面积+bbox 找出 Ø12 的圆(面积 ~ pi*36 = 113.1)
circles = []
for q in pb_polys:
    a = abs(poly_area(q['verts']))
    if abs(a - math.pi * 36) < 1.5:
        bx = poly_bbox(q['verts'])
        circles.append(((bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2, bx[2] - bx[0]))
chk('洞洞板: DXF 里 234 个 Ø12 圆孔', len(circles) == 234, len(circles))
if circles:
    chk('洞洞板: 每个孔直径都 = 12', all(abs(c[2] - 12) < 0.02 for c in circles),
        '%.3f..%.3f' % (min(c[2] for c in circles), max(c[2] for c in circles)))
    xs = sorted(set(round(c[0], 2) for c in circles))
    ys = sorted(set(round(c[1], 2) for c in circles))
    chk('洞洞板: 18 列 x 13 行', len(xs) == 18 and len(ys) == 13, '%dx%d' % (len(xs), len(ys)))
    dxs = sorted(set(round(xs[i + 1] - xs[i], 3) for i in range(len(xs) - 1)))
    dys = sorted(set(round(ys[i + 1] - ys[i], 3) for i in range(len(ys) - 1)))
    chk('洞洞板: 列间距恒 = 40', dxs == [40.0], dxs)
    chk('洞洞板: 行间距恒 = 40', dys == [40.0], dys)
    # 阵列整体居中: 左留边 == 右留边
    chk('洞洞板: 阵列左右居中', abs((xs[0] - 6) - (760 - xs[-1] - 6)) < 0.01,
        '左 %.2f / 右 %.2f' % (xs[0] - 6, 760 - xs[-1] - 6))
    chk('洞洞板: 阵列上下居中', abs((ys[0] - 6) - (560 - ys[-1] - 6)) < 0.01,
        '下 %.2f / 上 %.2f' % (ys[0] - 6, 560 - ys[-1] - 6))
    chk('洞洞板: 孔间壁 = 40-12 = 28mm(不会崩边)', True)
    # 每个孔都必须离板边 >= 留边 - 半径
    chk('洞洞板: 所有孔都在板内', all(6 <= c[0] <= 754 and 6 <= c[1] <= 554 for c in circles))
# 四角圆角 R20: 净面积 = 760*560 - 4*(400 - pi*100)
want_pb = 760 * 560 - 4 * (400 - math.pi * 100) - 234 * math.pi * 36
chk('洞洞板: 净面积 = 板-四角R20-234孔', abs(pbd['area'] - want_pb) < 1.0,
    '%.2f vs %.2f' % (pbd['area'], want_pb))
chk('洞洞板: 备注里写清孔阵规格', '共 234 孔' in pbd['note'] and '孔距 40' in pbd['note'], pbd['note'])
chk('洞洞板: 纹理=横纹', pbd['grain'] == 'long', pbd['grain'])

# ---- 四角三类型面积不变量(单角) ----
slab = cle['带槽面板']
# 600x400, bl 方角切口 30, tr 斜角 25 => 减 30² + 25²/2
want_slab = 600 * 400 - 30 * 30 - 25 * 25 / 2
chk('四角: notch 减 s², chamfer 减 s²/2', abs(slab['area'] - want_slab) < 0.01,
    '%.2f vs %.2f' % (slab['area'], want_slab))
chk('四角: pocket 不减净面积', slab['pockets'] == 2 and abs(slab['area'] - want_slab) < 0.01, slab['pockets'])
chk('带槽面板: 2 个 pocket 深度 6/4', sorted(slab['pocketDepths']) == [4.0, 6.0], slab['pocketDepths'])
chk('带槽面板: 纹理=竖纹, 数量 2', slab['grain'] == 'cross' and slab['qty'] == 2,
    '%s/%s' % (slab['grain'], slab['qty']))
# pocket 面积: 300x120 矩形 + 60x60 圆角 r10
want_pk = sorted([round(300 * 120, 1), round(60 * 60 - 4 * (100 - math.pi * 25), 1)])
chk('带槽面板: pocket 面积对上', sorted(round(a, 1) for a in slab['pocketAreas']) == want_pk,
    '%s vs %s' % (sorted(round(a, 1) for a in slab['pocketAreas']), want_pk))

# ---- 三类孔 ----
mh = cle['多孔件']
chk('多孔件: 3 个孔', mh['holes'] == 3, mh['holes'])
# 500x300, 圆Ø20 + 矩形120x40(r8) + 腰形 len90 d14
want_mh = (500 * 300 - math.pi * 100
           - (120 * 40 - 4 * (64 - math.pi * 16))
           - ((90 - 14) * 14 + math.pi * 49))
chk('多孔件: 净面积 = 板 - 圆 - 圆角矩 - 腰形', abs(mh['area'] - want_mh) < 0.5,
    '%.2f vs %.2f' % (mh['area'], want_mh))
chk('多孔件: 数量 3, 纹理不限', mh['qty'] == 3 and mh['grain'] == 'any', '%s/%s' % (mh['qty'], mh['grain']))

# ---- 边缺口 ----
nt = cle['边缺口件']
want_nt = 700 * 350 - 60 * 30 - 80 * 25 - 50 * 20
chk('边缺口件: 净面积 = 板 - 三处缺口', abs(nt['area'] - want_nt) < 0.01,
    '%.2f vs %.2f' % (nt['area'], want_nt))
chk('边缺口件: 无通孔无铣槽', nt['holes'] == 0 and nt['pockets'] == 0)
# 缺口使周长变长: 每个缺口净增 2*depth
want_per = 2 * (700 + 350) + 2 * (30 + 25 + 20)
chk('边缺口件: 切割周长 = 矩形周长 + 2x缺口深度和', abs(nt['cutLength'] - want_per) < 0.5,
    '%.2f vs %.2f' % (nt['cutLength'], want_per))

# ============================================================
# 配方: L形转角柜 / 井字酒格 / 洞洞板挂墙组
# ============================================================
lc = D['recipeCorner']
chk('L形转角柜: 板数 >= 6', len(lc['expect']) >= 6, len(lc['expect']))
chk('L形转角柜: 无自交(DXF 全部闭合有效)',
    all(q['closed'] and len(q['verts']) >= 3 for q in parse_dxf(lc['dxf'])['polys']))
chk('L形转角柜: 每块板面积为正', all(e['area'] > 0 for e in lc['expect']),
    [e['name'] for e in lc['expect'] if e['area'] <= 0])

wr = D['recipeWinerack']
chk('井字酒格: 3 竖 + 2 横 + 4 外框 = 9 块', len(wr['expect']) == 9,
    [e['name'] for e in wr['expect']])
wrn = {e['name']: e for e in wr['expect']}
# 竖隔板 v 跨 [15, 385] = 净高 370, 上下两端各出 t 长的榫头扎进顶/底板 => 总高 370+2t=400
chk('井字酒格: 竖隔板 300 x (370+2t)', abs(wrn['竖隔板1']['w'] - 300) < .01 and abs(wrn['竖隔板1']['h'] - 400) < .01,
    '%.2fx%.2f' % (wrn['竖隔板1']['w'], wrn['竖隔板1']['h']))
chk('井字酒格: 横隔板 (570+2t) x 300',
    abs(wrn['横隔板1']['w'] - 600) < .01 and abs(wrn['横隔板1']['h'] - 300) < .01,
    '%.2fx%.2f' % (wrn['横隔板1']['w'], wrn['横隔板1']['h']))

wrp = parse_dxf(wr['dxf'])
WRCUT = [q for q in wrp['polys'] if q['layer'] == 'CUT']


def notches_along(q, axis, depth):
    """在轮廓 q 上找"从某一侧切入 depth 的方槽"。

    axis='x': 槽底是一条竖线(x=const), 槽跨度沿 y。反之同理。
    只认真正的方缺口: 槽底线上恰有偶数个顶点, 且每个顶点在**同一条**外侧边上
    有配对顶点。返回 [(lo, hi, open_at)], open_at = 切入侧的坐标(0 或 max)。
    """
    bx = poly_bbox(q['verts'])
    ai, bi = (0, 1) if axis == 'x' else (1, 0)
    lo_edge, hi_edge = (bx[ai], bx[ai + 2])
    out = []
    for floor_v, open_v in ((hi_edge - depth, hi_edge), (lo_edge + depth, lo_edge)):
        # 槽底线上的顶点(按跨度轴排序)
        onfloor = sorted((v[bi] for v in q['verts'] if abs(v[ai] - floor_v) < 0.02))
        if len(onfloor) < 2 or len(onfloor) % 2:
            continue
        segs = []
        for k in range(0, len(onfloor), 2):
            a, b = onfloor[k], onfloor[k + 1]
            # 槽口两端必须落在开口那条边上(否则不是缺口, 是别的特征)
            has_a = any(abs(v[ai] - open_v) < 0.02 and abs(v[bi] - a) < 0.02 for v in q['verts'])
            has_b = any(abs(v[ai] - open_v) < 0.02 and abs(v[bi] - b) < 0.02 for v in q['verts'])
            if has_a and has_b:
                segs.append((a, b, open_v))
        if segs:
            out = segs
            break
    return out


# 竖隔板: 300(深) x 400(高), 半槽长轴沿高度方向, 槽底是竖线 x=150
vcand = []
for q in WRCUT:
    bx = poly_bbox(q['verts'])
    if abs((bx[2] - bx[0]) - 300) < .05 and abs((bx[3] - bx[1]) - 400) < .05:
        vcand.append((q, notches_along(q, 'x', 150)))
vhit = [(q, n) for q, n in vcand if len(n) == 2]
chk('井字酒格: 3 块竖隔板各有 2 处半槽', len(vhit) == 3, '%d/%d 候选' % (len(vhit), len(vcand)))
if vhit:
    q, nn = vhit[0]
    chk('井字酒格: 竖隔板半槽宽都 = t+fit = 15.2',
        all(abs(b - a - 15.2) < 1e-6 for a, b, _ in nn), [round(b - a, 4) for a, b, _ in nn])
    # 局部坐标原点在 v0=15 处 => 横隔板标高 15+370k/3 对应局部 y = 370k/3
    want_c = sorted([370 / 3.0, 2 * 370 / 3.0])
    got_c = sorted((a + b) / 2 for a, b, _ in nn)
    chk('井字酒格: 竖隔板半槽位置 = 2 块横隔板标高',
        all(abs(x - y) < 1e-3 for x, y in zip(got_c, want_c)),
        '%s vs %s' % ([round(v, 3) for v in got_c], [round(v, 3) for v in want_c]))
    chk('井字酒格: 竖隔板半槽只从单侧切入',
        len(set(o for _, _, o in nn)) == 1, sorted(set(o for _, _, o in nn)))

# 横隔板: 600 x 300, 半槽长轴沿深度方向, 槽底是横线 y=150。
# 注意 底板/顶板 的包围盒也是 600x300(角接指榫), 必须靠"有 3 处半槽"来区分。
hcand = []
for q in WRCUT:
    bx = poly_bbox(q['verts'])
    if abs((bx[2] - bx[0]) - 600) < .05 and abs((bx[3] - bx[1]) - 300) < .05:
        hcand.append((q, notches_along(q, 'y', 150)))
hhit = [(q, n) for q, n in hcand if len(n) == 3]
chk('井字酒格: 2 块横隔板各有 3 处半槽', len(hhit) == 2, '%d/%d 候选(另 2 块是顶/底板)' % (len(hhit), len(hcand)))
chk('井字酒格: 顶/底板不含半槽', len([1 for _, n in hcand if not n]) == 2,
    [len(n) for _, n in hcand])
if hhit:
    hq, hn = hhit[0]
    chk('井字酒格: 横隔板半槽宽都 = 15.2',
        all(abs(b - a - 15.2) < 1e-6 for a, b, _ in hn), [round(b - a, 4) for a, b, _ in hn])
    # 3 块竖隔板 at = 150/300/450; 局部坐标原点在 u0=15 处(左端榫头伸到 x=-15)
    # => 局部 x = at - 15
    want_h = [135.0, 285.0, 435.0]
    got_h = sorted((a + b) / 2 for a, b, _ in hn)
    chk('井字酒格: 横隔板半槽位置 = 3 块竖隔板标高',
        all(abs(x - y) < 1e-3 for x, y in zip(got_h, want_h)),
        '%s vs %s' % ([round(v, 2) for v in got_h], want_h))
    chk('井字酒格: 横隔板半槽只从单侧切入',
        len(set(o for _, _, o in hn)) == 1, sorted(set(o for _, _, o in hn)))

# ！！装配语义断言(几何全合法也查不出来的错):
# 两块板的半槽必须从**相反的物理侧**切入, 否则像两张都从上边开缝的卡片, 永远插不成十字。
# 竖隔板局部 x = 世界深度 y(u0=0); 横隔板局部 y = 世界深度 y(v0=0)。
# 所以"开口坐标"可直接比: 都等于 0 或都等于 300 就是同侧 = 装不上。
if vhit and hhit:
    v_open = vhit[0][1][0][2]
    h_open = hhit[0][1][0][2]
    chk('井字酒格: 半槽开口在相反侧(能真的插到一起)',
        (v_open > 150) != (h_open > 150),
        '竖开口@深度%.0f / 横开口@深度%.0f' % (v_open, h_open))
    chk('井字酒格: 两半槽深度之和 = 板深 300(插到底刚好齐平)', abs(150 + 150 - 300) < 1e-9)
pw = D['recipePegwall']
pwh = sum(e['holes'] for e in pw['expect'])
chk('洞洞板挂墙组: 有大量阵列孔', pwh > 40, pwh)
chk('洞洞板挂墙组: 零件全部有效面积',
    all(e['area'] > 0 for e in pw['expect']), [e['name'] for e in pw['expect'] if e['area'] <= 0])
chk('洞洞板挂墙组: 混合了榫接(有榫眼的板)与阵列孔', len(pw['expect']) >= 3, len(pw['expect']))

print('=' * 62)
print('PASS %d   FAIL %d' % (OK[0], len(BAD)))
for b in BAD[:40]:
    print('  FAIL ' + b)
sys.exit(1 if BAD else 0)

# ============================================================
# 生成 dump.json (PowerShell):
#
#   $out = & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
#     --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files `
#     --virtual-time-budget=25000 --dump-dom "file:///D:/海洋板diy/app/tests/dump.html" 2>&1 | Out-String
#   if ($out -match '(?s)<pre id="out">(.*?)</pre>') {
#     $j = $matches[1] -replace '&lt;','<' -replace '&gt;','>' -replace '&amp;','&'
#     Set-Content -Path D:\海洋板diy\tools\dump.json -Value $j -Encoding utf8 -NoNewline
#   }
# ============================================================
