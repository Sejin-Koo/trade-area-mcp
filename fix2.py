import pathlib
p = pathlib.Path("lib/server.js"); t = p.read_text()
def rep(o, n):
    global t
    assert t.count(o) == 1, t.count(o)
    t = t.replace(o, n)

# ── stores_nearby ──
rep("""        maxItems: num(1, 1000, 100).describe("최대 반환 건수"),
        summaryOnly: bool(false).describe("true면 개별 점포 목록 없이 업종별 집계만 반환"),""",
"""        maxItems: num(1, 1000, 100).describe("최대 반환 건수 (목록 모드에만 적용. summaryOnly=true면 무시된다)"),
        summaryOnly: bool(false).describe(
          "true면 개별 점포 목록 없이 업종별 집계만 반환한다. 이때 maxItems 를 무시하고 " +
          "페이지를 이어 받아 반경 내 전량(수집 상한 5,000건)을 집계한다."
        ),""")

rep("""    async ({ lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd, maxItems, summaryOnly }) => {
      try {
        const r = await sbiz.storeListInRadius({
          lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd,
          numOfRows: maxItems, pageNo: 1,
        });
        const rows = r.items.map((it) => {
          const s = sbiz.slimStore(it);
          s.거리m = s.경도 && s.위도 ? haversine(lon, lat, s.경도, s.위도) : null;
          return s;
        }).sort((a, b) => (a.거리m ?? 1e9) - (b.거리m ?? 1e9));

        const out = {
          기준점: { 경도: lon, 위도: lat, 반경m: radius },
          데이터기준월: r.stdrYm,
          전체건수: r.totalCount,
          반환건수: rows.length,
          잘림: r.totalCount > rows.length,
          업종중분류별_집계: sbiz.aggregateByIndustry(r.items, "middle"),
        };
        if (!summaryOnly) out.점포목록 = rows;
        if (out.잘림) {
          out.안내 = `반경 내 전체 ${r.totalCount}건 중 ${rows.length}건만 반환했습니다. maxItems를 올리거나 반경을 좁히세요.`;
        }
        return ok(out);""",
"""    async ({ lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd, maxItems, summaryOnly }) => {
      try {
        const 기준점 = { 경도: lon, 위도: lat, 반경m: radius };

        // 집계 전용 모드 — maxItems 를 무시하고 페이지를 이어 받아 전량 집계한다.
        // 한 페이지만 집계하면 구성비가 통째로 틀어지므로(sbiz_client collectAll 주석) 여기서 갈라 놓는다.
        if (summaryOnly) {
          const c = await sbiz.collectStoresInRadius(
            { lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd },
            { cap: 5000 }
          );
          const out = {
            기준점,
            데이터기준월: c.stdrYm,
            전체건수: c.totalCount,
            집계표본: c.items.length,
            잘림: c.capped,
            조회페이지수: c.pages,
            업종중분류별_집계: sbiz.aggregateByIndustry(c.items, "middle"),
          };
          if (c.capped) {
            out.안내 =
              `반경 내 전체 ${c.totalCount}건 중 수집 상한까지인 ${c.items.length}건만 모아 집계했습니다. ` +
              `구성비가 표본 기준이므로 반경을 좁히거나 업종코드를 지정해 다시 조회하세요.`;
          }
          return ok(out);
        }

        const r = await sbiz.storeListInRadius({
          lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd,
          numOfRows: maxItems, pageNo: 1,
        });
        const rows = r.items.map((it) => {
          const s = sbiz.slimStore(it);
          s.거리m = s.경도 && s.위도 ? haversine(lon, lat, s.경도, s.위도) : null;
          return s;
        }).sort((a, b) => (a.거리m ?? 1e9) - (b.거리m ?? 1e9));

        const 잘림 = r.totalCount > rows.length;
        const out = {
          기준점,
          데이터기준월: r.stdrYm,
          전체건수: r.totalCount,
          반환건수: rows.length,
          잘림,
          // ★ 이 집계는 반환된 rows 기준이다. 잘렸으면 구성비로 쓰면 안 된다.
          "업종중분류별_집계(반환분 기준)": sbiz.aggregateByIndustry(r.items, "middle"),
          점포목록: rows,
        };
        if (잘림) {
          out.안내 =
            `반경 내 전체 ${r.totalCount}건 중 ${rows.length}건만 반환했습니다. ` +
            `위 집계는 반환분 기준이므로 구성비로 쓰지 마시고, 업종 구성이 목적이면 ` +
            `summaryOnly=true 로 다시 부르거나 store_industry_mix 를 쓰세요.`;
        }
        return ok(out);""")

# ── store_industry_mix ──
rep("""        maxItems: num(1, 1000, 1000).describe("집계에 사용할 최대 점포 수"),""",
"""        maxItems: num(1, 10000, 5000).describe(
          "집계에 사용할 최대 점포 수(수집 상한). 1,000건을 넘으면 페이지를 이어 받는다."
        ),""")

rep("""        let r;
        let scope;
        if (adongCd) {
          r = await sbiz.storeListInDong({ adongCd, numOfRows: maxItems, pageNo: 1 });
          scope = { 행정동코드: adongCd };
        } else {
          if (lon === undefined || lat === undefined) {
            throw new Error("lon/lat/radius 또는 adongCd 중 하나는 반드시 주어야 합니다.");
          }
          r = await sbiz.storeListInRadius({ lon, lat, radius: radius || 500, numOfRows: maxItems, pageNo: 1 });
          scope = { 경도: lon, 위도: lat, 반경m: radius || 500 };
        }
        const agg = sbiz.aggregateByIndustry(r.items, level);
        const total = r.items.length || 1;
        return ok({
          범위: scope,
          데이터기준월: r.stdrYm,
          전체점포수: r.totalCount,
          집계표본: r.items.length,
          표본이_전체보다_적음: r.totalCount > r.items.length,
          집계단위: level,
          업종구성: agg.map((a) => ({ ...a, 비중: `${((a.점포수 / total) * 100).toFixed(1)}%` })),
        });""",
"""        let c;
        let scope;
        if (adongCd) {
          c = await sbiz.collectStoresInDong({ adongCd }, { cap: maxItems });
          scope = { 행정동코드: adongCd };
        } else {
          if (lon === undefined || lat === undefined) {
            throw new Error("lon/lat/radius 또는 adongCd 중 하나는 반드시 주어야 합니다.");
          }
          c = await sbiz.collectStoresInRadius({ lon, lat, radius: radius || 500 }, { cap: maxItems });
          scope = { 경도: lon, 위도: lat, 반경m: radius || 500 };
        }
        const agg = sbiz.aggregateByIndustry(c.items, level);
        const total = c.items.length || 1;
        const out = {
          범위: scope,
          데이터기준월: c.stdrYm,
          전체점포수: c.totalCount,
          집계표본: c.items.length,
          표본이_전체보다_적음: c.capped,
          조회페이지수: c.pages,
          집계단위: level,
          업종구성: agg.map((a) => ({ ...a, 비중: `${((a.점포수 / total) * 100).toFixed(1)}%` })),
        };
        if (c.capped) {
          out.안내 =
            `전체 ${c.totalCount}건 중 수집 상한까지인 ${c.items.length}건만 모아 집계했습니다. ` +
            `비중은 표본 기준이므로 maxItems 를 올리거나 범위를 좁히세요.`;
        }
        return ok(out);""")

p.write_text(t)
print("server.js ok")
