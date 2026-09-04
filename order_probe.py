import json, urllib.request, urllib.parse
from collections import Counter
KEY="e08d4f4e80b7e3c8ec949274de127a8ea8eb7916023523105eca391a5890ec33"
B="http://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong"
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
def page(no):
    q=urllib.parse.urlencode({"serviceKey":KEY,"type":"json","divId":"signguCd","key":"11680","numOfRows":1000,"pageNo":no})
    with urllib.request.urlopen(urllib.request.Request(f"{B}?{q}",headers=UA),timeout=60) as r:
        d=json.loads(r.read().decode())
    b=d.get("body") or (d.get("response") or {}).get("body") or {}
    it=b.get("items") or []
    if isinstance(it,dict): it=it.get("item") or []
    return it
for no in (1, 30, 66):
    items=page(no)
    c=Counter(x.get("indsLclsNm","?") for x in items)
    top=", ".join(f"{k} {v}" for k,v in c.most_common(4))
    ids=[x.get("bizesId","") for x in items[:2]]
    print(f"page {no:2d} ({len(items):4d}건)  {top}   선두ID {ids}")
