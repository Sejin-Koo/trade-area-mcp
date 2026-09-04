import subprocess, os
REPO = os.path.dirname(os.path.abspath(__file__))
def run(args):
    r = subprocess.run(args, cwd=REPO, capture_output=True, text=True)
    print(">", " ".join(args[:3]), "=>", r.returncode)
    if r.stdout.strip(): print(r.stdout.strip()[-600:])
    if r.stderr.strip(): print("!", r.stderr.strip()[-600:])
run(["git","add","-A"])
run(["git","commit","-q","-m",
     "chore: 배포 작성자 진단 스크립트 gitignore 처리\n\n"
     "git push 배포가 BLOCKED로 떨어진 원인(커밋 작성자 미해석 + private 저장소)을\n"
     "확인하고 다른 MCP 프로젝트로 번지는지 대조한 조회 스크립트를 추적에서 제외한다.\n\n"
     "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n"
     "Claude-Session: https://claude.ai/code/session_01QrSKwr3BStx9QNwFbdDPMk"])
run(["git","push","origin","main"])
run(["git","status","--porcelain","--untracked-files=all"])
run(["git","log","--oneline","-1"])
