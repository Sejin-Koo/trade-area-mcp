import pathlib
p = pathlib.Path("lib/sbiz_client.js"); t = p.read_text()
anchor = "export function aggregateByIndustry("
add = '''// ── 집계용 전량 수집 ────────────────────────────────────────────────────────
// ★ 집계가 목적일 때 한 페이지만 받으면 구성비가 통째로 틀어진다(2026-09-04 실측:
//   영등포 반경 536m 음식점 전체 610건인데 100건만 집계해 한식이 263 → 60으로 나왔다).
//   그래서 집계 경로는 페이지를 이어 받는다.
// 종료 판정은 **받은 행 수**로 한다 — totalCount 는 페이지 수 상한 계산에만 쓴다
// (totalCount 보다 많이 주는 소스가 있어 루프가 어긋날 수 있다. sys-mcp-server-dev 1-11).
async function collectAll(op, params, { cap = 5000 } = {}) {
  const items = [];
  let totalCount = 0;
  let stdrYm = null;
  let pages = 0;
  const maxPages = Math.max(1, Math.ceil(cap / MAX_ROWS));
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const r = await call(op, { ...params, numOfRows: MAX_ROWS, pageNo });
    pages += 1;
    if (pageNo === 1) {
      totalCount = r.totalCount;
      stdrYm = r.stdrYm;
    }
    for (const it of r.items) items.push(it);
    if (r.items.length < MAX_ROWS) {
      return { items, totalCount, stdrYm, pages, capped: false };
    }
  }
  return { items, totalCount, stdrYm, pages, capped: items.length < totalCount };
}

/** 반경 내 점포를 집계용으로 전량(또는 cap까지) 수집 */
export function collectStoresInRadius(
  { lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd },
  opts
) {
  return collectAll(
    "storeListInRadius",
    { cx: lon, cy: lat, radius, indsLclsCd, indsMclsCd, indsSclsCd },
    opts
  );
}

/** 행정동 내 점포를 집계용으로 전량(또는 cap까지) 수집 */
export function collectStoresInDong(
  { adongCd, indsLclsCd, indsMclsCd, indsSclsCd },
  opts
) {
  return collectAll(
    "storeListInDong",
    { adongCd, indsLclsCd, indsMclsCd, indsSclsCd },
    opts
  );
}

'''
assert t.count(anchor) == 1
t = t.replace(anchor, add + anchor)
p.write_text(t)
print("sbiz_client.js ok")
