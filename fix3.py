import pathlib
p = pathlib.Path("lib/sbiz_client.js"); t = p.read_text()
def rep(o,n):
    global t
    assert t.count(o)==1, t.count(o)
    t = t.replace(o,n)

rep("""/** 행정동 내 점포를 집계용으로 전량(또는 cap까지) 수집 */
export function collectStoresInDong(
  { adongCd, indsLclsCd, indsMclsCd, indsSclsCd },
  opts
) {
  return collectAll(
    "storeListInDong",
    { adongCd, indsLclsCd, indsMclsCd, indsSclsCd },
    opts
  );
}""",
"""/**
 * 행정구역(시도/시군구/행정동) 내 점포를 집계용으로 전량(또는 cap까지) 수집.
 *
 * ★ storeListInDong 은 코드를 `adongCd=...` 로 직접 받지 않는다. **divId(구분자) + key(값)**
 *   형식이어야 하며, 아니면 `NO_MANDATORY_REQUEST_PARAMETERS_ERROR(11)`가 난다.
 *   divId 는 ctprvnCd(시도) / signguCd(시군구) / adongCd(행정동) 세 가지를 실측 확인했다.
 *
 * ★ 자릿수 실측(2026-09-04) — 틀리면 에러가 아니라 조용히 NODATA(0건)가 온다.
 *   | divId     | 자릿수 | 예            | 결과            |
 *   | ctprvnCd  | 2     | 11            | 서울 554,092건  |
 *   | signguCd  | 5     | 11680         | 강남구 66,269건 |
 *   | adongCd   | 8     | 11680640      | 역삼1동 14,077건|
 *   | adongCd   | 10    | 1168064000    | NODATA          |
 */
export function collectStoresInRegion(
  { ctprvnCd, signguCd, adongCd, indsLclsCd, indsMclsCd, indsSclsCd },
  opts
) {
  const [divId, key] = adongCd
    ? ["adongCd", adongCd]
    : signguCd
    ? ["signguCd", signguCd]
    : ctprvnCd
    ? ["ctprvnCd", ctprvnCd]
    : [null, null];
  if (!divId) throw new Error("ctprvnCd / signguCd / adongCd 중 하나는 반드시 주어야 합니다.");
  return collectAll(
    "storeListInDong",
    { divId, key, indsLclsCd, indsMclsCd, indsSclsCd },
    opts
  );
}

/** 하위호환 — 행정동 전용 */
export function collectStoresInDong({ adongCd, ...rest }, opts) {
  return collectStoresInRegion({ adongCd, ...rest }, opts);
}""")
p.write_text(t)
print("ok")
