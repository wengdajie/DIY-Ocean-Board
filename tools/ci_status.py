# -*- coding: utf-8 -*-
"""查 GitHub Actions 最近一轮的结果与失败原因。

为何不靠下载日志: `GET /actions/runs/<id>/logs` 匿名访问返 403。
但 **check-runs 的 annotations 接口是公开可读的** —— 所以 ci_run_tests.py
把关键信息全发成了 ::notice:: / ::error::, 这里把它们拉出来。

用法:
    python tools\\ci_status.py            # 看最近各工作流
    python tools\\ci_status.py pages      # 只看某个
环境变量:
    HTTPS_PROXY   若直连 github 不通(国内常见), 设一下
    GH_TOKEN      可选。匿名限额只有 60/小时, 带上令牌是 5000/小时
"""
import json, os, sys, urllib.error, urllib.request

REPO = os.environ.get('GH_REPO_FULL', 'wengdajie/DIY-Ocean-Board')
API = 'https://api.github.com'
sys.stdout.reconfigure(encoding='utf-8')

proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
if proxy:
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({'https': proxy, 'http': proxy}))
    urllib.request.install_opener(opener)


def api(path):
    req = urllib.request.Request(path if path.startswith('http') else API + path)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'ci-status')
    tok = os.environ.get('GH_TOKEN')
    if tok:
        req.add_header('Authorization', 'Bearer ' + tok)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read().decode('utf-8', 'replace') or '{}')
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {'raw': body[:300]}
    except Exception as e:
        return -1, {'error': str(e)}


def main():
    want = sys.argv[1] if len(sys.argv) > 1 else None

    st, rl = api('/rate_limit')
    if st == 200:
        c = rl['resources']['core']
        print('限额: %s/%s' % (c['remaining'], c['limit']))
        if c['remaining'] == 0:
            import datetime
            t = datetime.datetime.fromtimestamp(c['reset'])
            print('✕ 匿名限额用尽, %s 后恢复。设 GH_TOKEN 可提到 5000/小时。'
                  % t.strftime('%H:%M:%S'))
            return 2

    st, runs = api('/repos/%s/actions/runs?per_page=20' % REPO)
    if st != 200:
        print('✕ 拿不到 runs (HTTP %s): %s' % (st, runs.get('message')))
        return 3

    seen = set()
    rc = 0
    for run in runs.get('workflow_runs', []):
        nm = run['name']
        if nm in seen:
            continue
        if want and nm != want:
            continue
        seen.add(nm)
        print('\n' + '=' * 62)
        print('%s  %s / %s   %s' % (nm, run['status'], run['conclusion'], run['created_at']))
        print('  ' + run['html_url'])
        if run['conclusion'] not in (None, 'success'):
            rc = 1

        st2, jobs = api('/repos/%s/actions/runs/%s/jobs' % (REPO, run['id']))
        if st2 != 200:
            continue
        for job in jobs.get('jobs', []):
            print('  JOB %s -> %s' % (job['name'], job['conclusion']))
            for s in job.get('steps', []):
                mark = {'success': 'ok', 'failure': '✕✕', 'skipped': '--'}.get(
                    s['conclusion'], str(s['conclusion']))
                print('    [%-3s] %s' % (mark, s['name']))
            st3, anns = api('/repos/%s/check-runs/%s/annotations' % (REPO, job['id']))
            if st3 == 200 and anns:
                for a in anns:
                    if a['annotation_level'] == 'warning' and 'Node.js' in (a['message'] or ''):
                        continue          # Node 20 弃用警告, 噪声
                    print('      <%s> %s' % (a['annotation_level'],
                                             (a['message'] or '').replace('\n', ' ')[:240]))
    return rc


if __name__ == '__main__':
    sys.exit(main())
