# -*- coding: utf-8 -*-
"""用 iframe harness 抓 test-e2e 的失败详情(单页跑法在这台机器上会挂)。"""
import subprocess, tempfile, shutil, os, sys, re
sys.stdout.reconfigure(encoding='utf-8')

CHROME = os.environ.get('CHROME') or r'C:/Program Files/Google/Chrome/Application/chrome.exe'

HARNESS = u'''<!doctype html><meta charset="utf-8">
<body><pre id="grab">waiting</pre>
<iframe id="f" src="http://127.0.0.1:8123/app/tests/test-e2e.html"></iframe>
<script>
var f = document.getElementById('f');
var t0 = Date.now();
function poll() {
  try {
    var t = f.contentDocument.getElementById('out').textContent;
    if (/TOTAL [0-9]+ FAILS [0-9]+/.test(t) || Date.now() - t0 > 60000) {
      document.getElementById('grab').textContent = t;
      return;
    }
  } catch (e) {}
  setTimeout(poll, 500);
}
f.onload = poll;
</script></body></html>'''


def main():
    # 起一个临时 http 服务承载 harness(file:// 访问 http iframe 是跨域, 拿不到内容)
    import threading, http.server, functools
    tmp = tempfile.mkdtemp(prefix='ob-e2eh-')
    port = 8199
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=tmp)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        hp = os.path.join(tmp, 'h.html')
        with open(hp, 'w', encoding='utf-8') as fh:
            fh.write(HARNESS)
        r = subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--no-sandbox',
                            '--user-data-dir=' + tmp, '--window-size=1600,1000',
                            '--hide-scrollbars', '--virtual-time-budget=120000',
                            '--dump-dom', 'http://127.0.0.1:%d/h.html' % port],
                           capture_output=True, timeout=400)
        dom = r.stdout.decode('utf-8', 'replace')
        m = re.search(r'(?s)<pre id="grab">(.*?)</pre>', dom)
        txt = (m.group(1) if m else 'NO OUTPUT').replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
        tot = re.search(r'TOTAL (\d+) FAILS (\d+)', txt)
        print('=== test-e2e(via iframe) TOTAL', tot.groups() if tot else '?')
        for l in txt.split('\n'):
            if 'FAIL' in l and 'FAILS' not in l:
                print(' ', l[:200])
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
