import subprocess, os

REPO = os.path.dirname(os.path.abspath(__file__))

def run(args):
    r = subprocess.run(args, cwd=REPO, capture_output=True, text=True)
    print(">", " ".join(args[:4]), "=>", r.returncode)
    if r.stdout.strip():
        print("  ", r.stdout.strip()[-800:])
    if r.stderr.strip():
        print("  !", r.stderr.strip()[-800:])
    return r

run(["git", "init", "-q"])
run(["git", "config", "user.email", "mysejin.koo@gmail.com"])
run(["git", "config", "user.name", "Sejin-Koo"])
run(["git", "add", "-A"])
run(["git", "commit", "-q", "-m", "상권분석 MCP 서버 신규 구축\n\n소상공인 상가정보, 행정안전부 인허가 20종, SGIS 통계지리정보,\n서울 상권분석서비스를 좌표계 통일까지 포함해 하나의 MCP 서버로 묶었다.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01QrSKwr3BStx9QNwFbdDPMk"])
run(["git", "branch", "-M", "main"])
run(["git", "remote", "add", "origin", "https://github.com/Sejin-Koo/trade-area-mcp.git"])
run(["git", "log", "--oneline", "-1"])
run(["git", "status", "--short"])
