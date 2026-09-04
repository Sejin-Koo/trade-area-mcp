import json, urllib.request
URL="https://trade-area-mcp.vercel.app/api/mcp?k=plk_koo_3e4674419336d32a78a3760f83627112"
def call(n,a):
    b={"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":n,"arguments":a}}
    r=urllib.request.Request(URL,data=json.dumps(b).encode(),method="POST")
    r.add_header("Content-Type","application/json"); r.add_header("Accept","application/json, text/event-stream")
    with urllib.request.urlopen(r,timeout=180) as resp: raw=resp.read().decode()
    for l in raw.splitlines():
        if l.startswith("data:"):
            d=json.loads(l[5:])["result"]
            return d.get("isError"), json.loads(d["content"][0]["text"]) if not d.get("isError") else d["content"][0]["text"]

print("=== 행정동 (역삼1동 11680640) ===")
e,d=call("store_industry_mix",{"adongCd":"11680640","level":"large","maxItems":10000})
print("  오류" if e else f"  전체 {d['전체점포수']} / 표본 {d['집계표본']} / 페이지 {d['조회페이지수']} / 표본부족 {d['표본이_전체보다_적음']}")
if not e:
    for a in d["업종구성"][:3]: print("    ",a["업종"],a["점포수"],a["비중"])

print("\n=== 시군구 (강남구 11680) ===")
e,d=call("store_industry_mix",{"signguCd":"11680","level":"large","maxItems":10000})
print("  오류:",d) if e else print(f"  전체 {d['전체점포수']} / 표본 {d['집계표본']} / 페이지 {d['조회페이지수']} / 표본부족 {d['표본이_전체보다_적음']}")
if not e:
    for a in d["업종구성"][:3]: print("    ",a["업종"],a["점포수"],a["비중"])

print("\n=== resolve_region (역삼동) ===")
e,d=call("resolve_region",{"address":"서울특별시 강남구 역삼동"})
print(json.dumps(d.get("지오코딩"),ensure_ascii=False,indent=1) if not e else d)
