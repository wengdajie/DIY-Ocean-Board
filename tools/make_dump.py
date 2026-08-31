# -*- coding: utf-8 -*-
"""\u7528\u65e0\u5934 Chrome \u8dd1 app/tests/dump.html, \u628a\u5bfc\u51fa\u6837\u672c\u5b58\u6210 tools/dump.json\u3002

\u4e3a\u4ec0\u4e48\u4e0d\u76f4\u63a5\u5199 PowerShell \u4e00\u884c\u547d\u4ee4:
  1. `--dump-dom` \u7684\u8f93\u51fa\u91cc\u4e2d\u6587\u5728 PowerShell \u7ba1\u9053\u91cc\u5f88\u5bb9\u6613\u88ab\u91cd\u65b0\u7f16\u7801\u6210\u4e71\u7801;
  2. HTML \u5b9e\u4f53\uff08&amp; &lt; &gt; &quot;\uff09\u5fc5\u987b\u5168\u90e8\u53cd\u8f6c\u4e49, \u5c11\u4e00\u4e2a JSON \u5c31\u89e3\u6790\u4e0d\u4e86;
  3. \u5b58\u76d8\u524d\u5e94\u8be5\u5148 json.loads \u9a8c\u4e00\u9057 \u2014\u2014 \u5426\u5219\u5b58\u4e0b\u4e00\u4e2a\u574f\u6587\u4ef6, \u4e0b\u4e00\u6b65\u624d\u62a5\u9519,
     \u800c\u90a3\u65f6\u5df2\u7ecf\u5206\u4e0d\u6e05"\u662f\u751f\u6210\u9519\u4e86\u8fd8\u662f\u6821\u9a8c\u5668\u9519\u4e86"\u3002

\u7528\u6cd5:
  python tools/make_dump.py
  python tools/verify_exports.py
"""
import io, json, os, re, subprocess, sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
]


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit('\u627e\u4e0d\u5230 Chrome/Edge, \u8bf7\u5728 CHROME_CANDIDATES \u91cc\u52a0\u4e0a\u4f60\u7684\u8def\u5f84')


def main():
    page = os.path.join(ROOT, 'app', 'tests', 'dump.html')
    if not os.path.exists(page):
        raise SystemExit('\u627e\u4e0d\u5230 %s' % page)
    # \u4e2d\u6587\u8def\u5f84\u5fc5\u987b\u8f6c\u6210 file:// URL \u7684 percent-encoding
    from urllib.request import pathname2url
    url = 'file:' + pathname2url(page)
    p = subprocess.run([
        find_chrome(), '--headless=new', '--disable-gpu', '--no-sandbox',
        '--allow-file-access-from-files', '--virtual-time-budget=90000',
        '--dump-dom', url
    ], capture_output=True, timeout=300)
    dom = p.stdout.decode('utf-8', 'replace')
    m = re.search(r'(?s)<pre id="out">(.*?)</pre>', dom)
    if not m:
        raise SystemExit('\u9875\u9762\u6ca1\u8dd1\u51fa <pre id="out">, \u5148\u624b\u52a8\u6253\u5f00 dump.html \u770b\u770b\u62a5\u4ec0\u4e48\u9519')
    t = m.group(1)
    # &amp; \u5fc5\u987b\u6700\u5148\u53cd\u8f6c\u4e49\u2014\u2014\u5426\u5219 "&amp;lt;" \u4f1a\u88ab\u9519\u9636\u6210 "<"
    for a, b in (('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"')):
        t = t.replace(a, b)
    d = json.loads(t)          # \u5b58\u76d8\u524d\u5148\u9a8c\u4e00\u9057
    out = os.path.join(HERE, 'dump.json')
    io.open(out, 'w', encoding='utf-8', newline='').write(json.dumps(d))
    print('\u5df2\u5199\u5165 %s' % out)
    print('%d \u7ec4\u573a\u666f: %s' % (len(d), ', '.join(sorted(d))))


if __name__ == '__main__':
    main()
