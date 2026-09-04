import pathlib
p = pathlib.Path("lib/sbiz_client.js"); t = p.read_text()
anchor = "export function aggregateByIndustry("
add = '''/**
 * 행정구역 내 **건수만** 센다(numOfRows=1 로 totalCount 만 읽음).
 * 행을 모으지 않으므로 지역이 아무리 커도 1회 호출로 정확한 건수를 얻는다.
 */
export async function countStoresInRegion({ ctprvnCd, signguCd, adongCd, indsLclsCd, indsMclsCd, indsSclsCd }) {
  const [divId, key] = adongCd
    ? ["adongCd", adongCd]
    : signguCd
    ? ["signguCd", signguCd]
    : ["ctprvnCd", ctprvnCd];
  const r = await call("storeListInDong", {
    divId, key, indsLclsCd, indsMclsCd, indsSclsCd, numOfRows: 1, pageNo: 1,
  });
  return { totalCount: r.totalCount, stdrYm: r.stdrYm };
}

'''
assert t.count(anchor) == 1
p.write_text(t.replace(anchor, add + anchor))
print("ok")
