# -*- coding: utf-8 -*-
"""CI \u91cc\u8dd1\u6d4b\u8bd5\u603b\u63a7\u9875, \u628a\u6c47\u603b\u63d0\u51fa\u6765\u5e76\u6309\u5931\u8d25\u6570\u8bbe\u9000\u51fa\u7801\u3002

\u8bbe\u8ba1\u8981\u70b9(\u90fd\u662f\u8e29\u8fc7\u7684\u5751):
  1. **\u4e0d\u80fd\u53ea\u770b"FAILS 0"** \u2014\u2014 \u5957\u4ef6\u8dd1\u5d29\u4e86\u6839\u672c\u4e0d\u4f1a\u5199\u51fa TOTAL \u884c,
     \u4e8e\u662f "\u6ca1\u6709 FAIL \u5b57\u6837" \u4f1a\u88ab\u8bef\u5f53\u6210\u901a\u8fc7\u3002\u6240\u4ee5\u8fd9\u91cc\u540c\u65f6\u5361:
       - \u5957\u4ef6\u6570\u91cf\u5fc5\u987b = 11
       - \u6bcf\u4e2a\u5957\u4ef6\u7684\u65ad\u8a00\u6570\u5fc5\u987b >= \u57fa\u7ebf(\u9632\u6b62"\u53ea\u8dd1\u4e86\u524d\u4e09\u6761\u5c31\u629b\u5f02\u5e38"\u4e5f\u7b97\u7ee7)
       - \u603b\u6570\u5fc5\u987b >= TOTAL_MIN
  2. \u603b\u63a7\u9875\u662f\u7528 iframe \u5e76\u884c\u8dd1 11 \u4e2a\u5957\u4ef6\u7684, \u5b8c\u6210\u540e\u624d\u628a document.title
     \u6539\u6210 "ALL PASS" / "FAIL n"\u3002\u62ff title \u5f53\u5b8c\u6210\u4fe1\u53f7\u6bd4\u778e\u7b49\u56fa\u5b9a\u79d2\u6570\u53ef\u9760\u3002
  3. --virtual-time-budget \u5fc5\u987b\u7ed9\u8db3(\u5168\u5957 ~40s, \u7ed9 300s \u5bbd\u677e\u533a\u95f4)\u3002
"""
import io, os, re, subprocess, sys

sys.stdout.reconfigure(encoding='utf-8')

IN_CI = bool(os.environ.get('GITHUB_ACTIONS'))


def ann(level, msg):
    """发一条 GitHub Actions 注释(匿名可读), 本地跑时退化成普通打印。"""
    one = ' | '.join(str(msg).split('\n'))
    if IN_CI:
        print('::%s::%s' % (level, one), flush=True)
    else:
        print('[%s] %s' % (level, one), flush=True)


CHROME = os.environ.get('CHROME') or 'google-chrome'
BASE = os.environ.get('BASE') or 'http://127.0.0.1:8123'

# \u57fa\u7ebf: \u5f53\u524d\u6bcf\u4e2a\u5957\u4ef6\u7684\u65ad\u8a00\u6570\u3002\u5141\u8bb8\u53ea\u589e\u4e0d\u5141\u8bb8\u51cf \u2014\u2014
# \u65ad\u8a00\u6570\u7a81\u7136\u53d8\u5c11\u51e0\u4e4e\u603b\u662f"\u4e2d\u9014\u629b\u5f02\u5e38\u4e86"\u800c\u4e0d\u662f"\u6211\u771f\u60f3\u5220\u6d4b\u8bd5"\u3002
BASELINE = {
    'test-geom.html': 41,
    'test-joints.html': 167,
    'test-models.html': 85,
    'test-nest.html': 71,
    'test-mate.html': 52,
    'test-trace.html': 66,
    'test-relief.html': 140,
    'test-image.html': 87,
    'test-custom.html': 499,
    'test-e2e.html': 490,
    'test-visual.html': 150,
}
TOTAL_MIN = sum(BASELINE.values())


def run(url, budget=300000):
    p = subprocess.run([
        CHROME, '--headless=new', '--disable-gpu', '--no-sandbox',
        '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=1600,1000',
        '--virtual-time-budget=%d' % budget, '--dump-dom', url
    ], capture_output=True, timeout=600)
    return p.stdout.decode('utf-8', 'replace')


def chrome_info():
    try:
        p = subprocess.run([CHROME, '--version'], capture_output=True, timeout=60)
        v = (p.stdout.decode('utf-8', 'replace') or
             p.stderr.decode('utf-8', 'replace')).strip()
    except Exception as e:
        v = '(\u62ff\u4e0d\u5230\u7248\u672c: %s)' % e
    ann('notice', 'CHROME=%s | %s | BASE=%s' % (CHROME, v, BASE))


def main():
    chrome_info()
    dom = run(BASE + '/app/tests/index.html')
    # \u603b\u63a7\u9875\u628a\u6bcf\u4e2a\u5957\u4ef6\u7684 pass/fail \u5199\u5728 <tbody id="tb"> \u7684\u5355\u5143\u683c\u91cc
    m = re.search(r'(?s)<tbody id="tb">(.*?)</tbody>', dom)
    if not m:
        ann('error', '\u6ca1\u627e\u5230\u6d4b\u8bd5\u8868\u683c \u2014\u2014 \u603b\u63a7\u9875\u672c\u8eab\u6ca1\u8dd1\u8d77\u6765'
                     '\uff08DOM \u957f\u5ea6 %d\uff09' % len(dom))
        ann('error', 'DOM \u5f00\u5934: %s' % dom[:600])
        io.open('ci-dom.html', 'w', encoding='utf-8').write(dom)
        return 2

    rows = []
    for tr in m.group(1).split('</tr>'):
        cells = [re.sub(r'<[^>]+>', '', c).strip()
                 for c in re.findall(r'(?s)<t[dh][^>]*>(.*?)</t[dh]>', tr)]
        if len(cells) >= 5:
            rows.append(cells)

    bad = []
    total = 0
    seen = set()
    for cells in rows:
        name = cells[0]
        try:
            npass = int(cells[2])
        except ValueError:
            npass = -1
        nfail = cells[3]
        seen.add(name)
        total += max(0, npass)
        base = BASELINE.get(name)
        flag = 'OK'
        if nfail != '0':
            flag = 'FAIL(%s)' % nfail
            bad.append('%s: %s \u9879\u5931\u8d25' % (name, nfail))
        elif base is None:
            flag = '\u65b0\u5957\u4ef6?'
            bad.append('%s: \u4e0d\u5728\u57fa\u7ebf\u540d\u5355\u91cc, \u8bf7\u66f4\u65b0 BASELINE' % name)
        elif npass < base:
            flag = '\u65ad\u8a00\u53d8\u5c11'
            bad.append('%s: \u65ad\u8a00\u6570 %d < \u57fa\u7ebf %d\uff08\u4e2d\u9014\u629b\u5f02\u5e38\u4e86?\uff09' % (name, npass, base))
        print('%-22s pass=%-5s fail=%-4s %s' % (name, npass, nfail, flag))
        ann('notice', '%s pass=%s fail=%s %s' % (name, npass, nfail, flag))

    # 哪条断言红了: 单独重跑失败套件, 把 FAIL 行提出来
    for cells in rows:
        if cells[3] != '0':
            name = cells[0]
            ann('error', '--- 重跑 %s 取失败详情 ---' % name)
            d2 = run('%s/app/tests/%s' % (BASE, name), 180000)
            mo = re.search(r'(?s)<pre id="out"[^>]*>(.*?)</pre>', d2)
            if not mo:
                ann('error', '%s: 拿不到 <pre id="out">' % name)
                continue
            txt = re.sub(r'<[^>]+>', '', mo.group(1))
            txt = (txt.replace('&lt;', '<').replace('&gt;', '>')
                      .replace('&quot;', '"').replace('&#39;', "'")
                      .replace('&amp;', '&'))
            hit = 0
            for ln in txt.split('\n'):
                if 'FAIL' in ln and 'FAILS' not in ln:
                    ann('error', '%s %s' % (name, ln.strip()[:300]))
                    hit += 1
                    if hit >= 12:
                        break
            if not hit:
                ann('error', '%s: 重跑时没看到 FAIL 行\uff08不稳定用例?\uff09' % name)

    missing = set(BASELINE) - seen
    if missing:
        bad.append('\u7f3a\u5957\u4ef6: %s' % ', '.join(sorted(missing)))
    if total < TOTAL_MIN:
        bad.append('\u603b\u65ad\u8a00\u6570 %d < \u57fa\u7ebf %d' % (total, TOTAL_MIN))

    print('-' * 60)
    summary = '\u5957\u4ef6 %d/%d\uff0c\u603b\u65ad\u8a00 %d\uff08\u57fa\u7ebf %d\uff09' % (
        len(seen), len(BASELINE), total, TOTAL_MIN)
    print(summary)
    ann('notice', summary)

    # \u542f\u52a8\u81ea\u68c0\u5355\u72ec\u518d\u770b\u4e00\u773c: \u5b83\u5728\u4e3b\u9875\u53f3\u4e0a\u89d2\u5f90\u6807\u91cc, \u603b\u63a7\u8868\u683c\u91cc\u770b\u4e0d\u5230
    home = run(BASE + '/app/index.html', 60000)
    ms = re.search(r'id="selfTest"[^>]*>([^<]*)<', home)
    st = ms.group(1).strip() if ms else '(\u672a\u53d6\u5230)'
    print('\u542f\u52a8\u81ea\u68c0: %s' % st)
    mn = re.match(r'\D*(\d+)\s*/\s*(\d+)', st)
    if not mn or mn.group(1) != mn.group(2):
        bad.append('\u542f\u52a8\u81ea\u68c0\u672a\u5168\u901a\u8fc7: %s' % st)
    # \u6839\u91cd\u5b9a\u5411\u9875\u4e5f\u8981\u771f\u7684\u80fd\u8fdb\u5f97\u53bb(Pages \u7684\u5165\u53e3\u5c31\u662f\u5b83)
    root = run(BASE + '/index.html', 60000)
    if 'id="side"' not in root:
        bad.append('\u6839 index.html \u6ca1\u6709\u91cd\u5b9a\u5411\u5230\u4e3b\u5e94\u7528')
    else:
        print('\u6839\u91cd\u5b9a\u5411: OK')

    if bad:
        print('-' * 60)
        for b in bad:
            print('\u2715 ' + b)
            ann('error', b)
        return 1
    print('\u2713 \u5168\u90e8\u901a\u8fc7')
    return 0


if __name__ == '__main__':
    sys.exit(main())
