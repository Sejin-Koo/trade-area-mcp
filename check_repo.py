import json, pathlib, re, urllib.request

cred = pathlib.Path("/root/.git-credentials").read_text().strip()
user, token = re.match(r"https://([^:]+):([^@]+)@github\.com", cred).groups()

def api(path):
    req = urllib.request.Request(
        "https://api.github.com" + path,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "trade-area-mcp-setup",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except Exception as e:
        body = ""
        if hasattr(e, "read"):
            try:
                body = e.read().decode()[:300]
            except Exception:
                pass
        return getattr(e, "code", "ERR"), f"{e} {body}"

s, d = api("/repos/%s/trade-area-mcp" % user)
print("GET /repos/%s/trade-area-mcp ->" % user, s)
if isinstance(d, dict) and "full_name" in d:
    print("  존재:", d["full_name"], "private=", d.get("private"), "default_branch=", d.get("default_branch"))
else:
    print("  ", str(d)[:300])

s2, d2 = api("/user/repos?per_page=100&sort=created&affiliation=owner")
print("GET /user/repos ->", s2)
if isinstance(d2, list):
    names = [r["name"] for r in d2]
    print("  최근 저장소 10개:", names[:10])
    print("  trade-area-mcp 포함:", "trade-area-mcp" in names)
else:
    print("  ", str(d2)[:300])
