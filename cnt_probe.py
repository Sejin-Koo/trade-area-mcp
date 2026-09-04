import json, urllib.request, urllib.parse, time
KEY="e08d4f4e80b7e3c8ec949274de127a8ea8eb7916023523105eca391a5890ec33"
BASE="http://apis.data.go.kr/B553077/api/open/sdsc2"
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
def get(op, params):
    q=urllib.parse.urlencode({"serviceKey":KEY,"type":"json",**params})
    with urllib.request.urlopen(urllib.request.Request(f"{BASE}/{op}?{q}",headers=UA),timeout=60) as r:
        return json.loads(r.read().decode())
d=get("largeUpjongList",{})
b=d.get("body") or (d.get("response") or {}).get("body") or {}
it=b.get("items") or []
if isinstance(it,dict): it=it.get("item") or []
print("업종 대분류 수:", len(it))
codes=[(x.get("indsLclsCd"), x.get("indsLclsNm")) for x in it]
print(codes)
print("\n강남구 대분류별 totalCount (numOfRows=1 로 건수만):")
t0=time.time(); tot=0
for cd,nm in codes:
    r=get("storeListInDong",{"divId":"signguCd","key":"11680","indsLclsCd":cd,"numOfRows":1,"pageNo":1})
    bb=r.get("body") or (r.get("response") or {}).get("body") or {}
    n=int(bb.get("totalCount") or 0); tot+=n
    print(f"   {nm:14s} {n:7,d}")
print(f"  합계 {tot:,d} (전체 66,269 와 대조) / 소요 {time.time()-t0:.1f}초 / 호출 {len(codes)}회")
