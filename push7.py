import subprocess, os
REPO = os.path.dirname(os.path.abspath(__file__))
def run(args):
    r = subprocess.run(args, cwd=REPO, capture_output=True, text=True)
    print(">", " ".join(args[:3]), "=>", r.returncode)
    if r.stdout.strip(): print(r.stdout.strip()[-400:])
    if r.stderr.strip(): print("!", r.stderr.strip()[-400:])
run(["git","add","-A"])
run(["git","commit","-q","-m",
     "chore: 배포 검증 스크립트 gitignore 처리\n\n"
     "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n"
     "Claude-Session: https://claude.ai/code/session_01QrSKwr3BStx9QNwFbdDPMk"])
run(["git","push","origin","main"])
run(["git","status","--porcelain","--untracked-files=all"])
run(["git","log","-1","--format=%h %an <%ae>"])
