# -*- coding: utf-8 -*-
"""把本地仓库发到 GitHub 并开启 Pages。

用法(令牌从 stdin 进, 不进命令行历史、不写任何文件):

    python tools/publish.py marine-ply-diy
    # 然后粘上新令牌, 回车

安全约定:
  * 令牌只存在于进程内存。不写 .git/config、不开 credential.helper。
  * remote URL 是干净的 https 地址(不嵌用户名密码)。
  * 所有输出过 mask(), 令牌不会回显到日志。
  * 本文件本身不含任何密钥, 可以安心入仓。

需要的令牌权限: classic token 勾 `repo`；或 fine-grained 给
Contents=Read/Write + Pages=Read/Write + Administration=Read/Write(建仓用)。

它还兼当 GIT_ASKPASS: 被 git 带着 "Username for ..." 这类提示语调起时,
直接从环境变量吐出凭据并退出 —— 省了一个额外的包装文件。
"""
import io, json, os, ssl, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

# --- GIT_ASKPASS 分支: 必须在任何其他逻辑之前 ---
if len(sys.argv) > 1 and ('assword' in sys.argv[1] or 'sername' in sys.argv[1]):
    p = sys.argv[1].lower()
    if 'sername' in p:
        sys.stdout.write(os.environ.get('GH_USER', 'x-access-token') + '\n')
    else:
        sys.stdout.write(os.environ.get('GH_TOKEN', '') + '\n')
    sys.exit(0)

sys.stdout.reconfigure(encoding='utf-8')

REPO = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('GH_REPO', '')).strip()
if os.environ.get('GH_TOKEN'):
    TOKEN = os.environ['GH_TOKEN'].strip()
else:
    sys.stderr.write('\u7c98\u4e0a GitHub \u4ee4\u724c\u540e\u56de\u8f66(\u4e0d\u4f1a\u56de\u663e\u5230\u65e5\u5fd7): ')
    sys.stderr.flush()
    TOKEN = sys.stdin.readline().strip()
API = 'https://api.github.com'
LOG = []


def mask(s):
    s = str(s)
    if TOKEN and len(TOKEN) > 8:
        s = s.replace(TOKEN, TOKEN[:4] + '***REDACTED***')
    return s


def say(*a):
    line = ' '.join(mask(x) for x in a)
    LOG.append(line)
    print(line)


def api(path, method='GET', body=None, accept='application/vnd.github+json'):
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Accept', accept)
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    req.add_header('User-Agent', 'haiyangban-diy-deploy')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            j = json.loads(raw)
        except Exception:
            j = {'raw': raw[:400]}
        return e.code, j
    except Exception as e:
        return -1, {'error': str(e)}


def git(args, env_extra=None, timeout=300):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(['git'] + args, capture_output=True, env=env, timeout=timeout)
    out = (p.stdout.decode('utf-8', 'replace') + p.stderr.decode('utf-8', 'replace')).strip()
    return p.returncode, out


def main():
    global REPO
    if not TOKEN:
        say('\u2715 \u6ca1\u62ff\u5230 GH_TOKEN')
        return 2

    # ---------- 1. \u9a8c\u8bc1\u4ee4\u724c\u4e0e\u6743\u9650 ----------
    st, me = api('/user')
    if st != 200:
        say('\u2715 \u4ee4\u724c\u65e0\u6548\u6216\u5df2\u64a4\u9500 (HTTP %s): %s' % (st, me.get('message')))
        return 3
    user = me['login']
    say('\u2713 \u4ee4\u724c\u6709\u6548, \u5e10\u53f7 = %s' % user)

    if not REPO:
        say('\u2715 \u6ca1\u62ff\u5230 GH_REPO')
        return 2
    say('\u76ee\u6807\u4ed3\u5e93: %s/%s' % (user, REPO))

    # ---------- 2. \u5efa\u4ed3(\u5df2\u5b58\u5728\u5219\u590d\u7528) ----------
    st, r = api('/repos/%s/%s' % (user, urllib.parse.quote(REPO)))
    if st == 200:
        say('\u2713 \u4ed3\u5e93\u5df2\u5b58\u5728, \u76f4\u63a5\u590d\u7528 (private=%s)' % r.get('private'))
        REPO = r.get('name') or REPO
    else:
        st, r = api('/user/repos', 'POST', {
            'name': REPO,
            'description': '\u6d77\u6d0b\u677f DIY \u69ab\u537f CAD \u56fe\u7eb8\u5728\u7ebf\u751f\u6210\u5668 \u00b7 16 \u79cd\u7ed3\u6784\u914d\u65b9 / 11 \u79cd\u69ab\u537f\u6837\u5f0f / \u56fe\u7247\u81ea\u52a8\u5efa\u6a21 / \u6392\u6837\u4f18\u5316 / DXF\u00b7SVG\u00b7CSV \u5bfc\u51fa\u3002\u7eaf\u9759\u6001\u65e0\u4f9d\u8d56\u3002',
            'private': False,
            'has_issues': True,
            'has_wiki': False,
            'auto_init': False,
        })
        if st not in (201,):
            say('\u2715 \u5efa\u4ed3\u5931\u8d25 (HTTP %s): %s' % (st, json.dumps(r, ensure_ascii=False)[:400]))
            return 4
        REPO = r.get('name') or REPO
        say('\u2713 \u4ed3\u5e93\u5df2\u521b\u5efa (public)')
        say('   \u5b9e\u9645\u4ed3\u5e93\u540d = %s' % REPO)

    # ---------- 3. push ----------
    remote = 'https://github.com/%s/%s.git' % (user, urllib.parse.quote(REPO))
    rc, out = git(['remote'])
    if 'origin' in out.split():
        git(['remote', 'set-url', 'origin', remote])
    else:
        git(['remote', 'add', 'origin', remote])
    say('remote origin = %s' % remote)

    askpass = os.path.abspath(__file__)
    env_extra = {
        'GIT_ASKPASS': askpass,
        'GIT_TERMINAL_PROMPT': '0',
        'GH_USER': user,
        'GH_TOKEN': TOKEN,
    }
    # \u8ba9 GIT_ASKPASS \u6307\u5411\u4e00\u4e2a\u53ef\u6267\u884c\u5305\u88c5: Windows \u4e0b git \u4e0d\u4f1a\u81ea\u5df1\u8c03 python
    bat = os.path.join(os.path.dirname(askpass), '_askpass.cmd')
    io.open(bat, 'w', encoding='ascii', newline='\r\n').write(
        '@echo off\r\n"%s" "%s" %%1\r\n' % (sys.executable, askpass))
    env_extra['GIT_ASKPASS'] = bat

    rc, out = git(['-c', 'credential.helper=', 'push', '-u', 'origin', 'main'], env_extra)
    say('push rc=%d\n%s' % (rc, out))
    if rc != 0:
        return 5
    say('\u2713 \u5df2\u63a8\u9001\u5230 main')

    # ---------- 4. \u5f00 Pages ----------
    pg = '/repos/%s/%s/pages' % (user, urllib.parse.quote(REPO))
    st, r = api(pg)
    if st == 200:
        say('Pages \u5df2\u5f00\u542f: %s' % r.get('html_url'))
    else:
        st, r = api(pg, 'POST', {'source': {'branch': 'main', 'path': '/'}})
        if st in (201, 204):
            say('\u2713 Pages \u5df2\u5f00\u542f(\u5206\u652f main / \u76ee\u5f55 root)')
        else:
            say('! \u5f00 Pages \u8fd4\u56de HTTP %s: %s' % (st, json.dumps(r, ensure_ascii=False)[:300]))

    # ---------- 5. \u7b49\u90e8\u7f72\u5e76\u9a8c\u8bc1\u7ad9\u70b9\u771f\u7684\u80fd\u6253\u5f00 ----------
    st, r = api(pg)
    site = (r.get('html_url') or '') if st == 200 else ''
    if not site:
        site = 'https://%s.github.io/%s/' % (user, urllib.parse.quote(REPO))
    say('\u7ad9\u70b9\u5730\u5740: %s' % site)

    ctx = ssl.create_default_context()
    ok = False
    for i in range(40):
        time.sleep(15)
        st2, b = api(pg)
        status = b.get('status') if st2 == 200 else '?'
        try:
            req = urllib.request.Request(site, headers={'User-Agent': 'deploy-check'})
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                html = resp.read().decode('utf-8', 'replace')
            if 'app/index.html' in html:
                say('\u2713 \u7b2c%d \u6b21\u63a2\u6d4b: \u6839\u9875\u53ef\u8bbf\u95ee\u4e14\u542b\u91cd\u5b9a\u5411 (build=%s)' % (i + 1, status))
                ok = True
                break
            say('\u7b2c%d \u6b21: HTTP 200 \u4f46\u5185\u5bb9\u4e0d\u5bf9 (build=%s)' % (i + 1, status))
        except urllib.error.HTTPError as e:
            say('\u7b2c%d \u6b21: HTTP %s (build=%s)' % (i + 1, e.code, status))
        except Exception as e:
            say('\u7b2c%d \u6b21: %s (build=%s)' % (i + 1, type(e).__name__, status))

    if ok:
        # \u518d\u786e\u8ba4\u4e3b\u5e94\u7528\u9875\u672c\u4f53 + \u4e00\u4e2a js \u8d44\u6e90\u771f\u7684\u80fd\u62c9\u5230
        for sub in ['app/index.html', 'app/js/joints.js', 'app/tests/index.html']:
            u = site.rstrip('/') + '/' + sub
            try:
                req = urllib.request.Request(u, headers={'User-Agent': 'deploy-check'})
                with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                    n = len(resp.read())
                say('  \u2713 %s -> HTTP %s, %d \u5b57\u8282' % (sub, resp.status, n))
            except Exception as e:
                say('  \u2715 %s -> %s' % (sub, e))
    return 0 if ok else 6


if __name__ == '__main__':
    code = main()
    io.open('publish.log', 'w', encoding='utf-8', newline='\n').write('\n'.join(LOG) + '\n')
    sys.exit(code)
