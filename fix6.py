import pathlib
p = pathlib.Path("lib/server.js"); t = p.read_text()
def rep(o,n):
    global t
    assert t.count(o)==1, t.count(o)
    t=t.replace(o,n)

rep("""        if (adongCd || signguCd || ctprvnCd) {
          c = await sbiz.collectStoresInRegion({ ctprvnCd, signguCd, adongCd }, { cap: maxItems });
          scope = adongCd
            ? { 행정동코드: adongCd }
            : signguCd
            ? { 시군구코드: signguCd }
            : { 시도코드: ctprvnCd };
        } else {""",
"""        if (adongCd || signguCd || ctprvnCd) {
          const region = { ctprvnCd, signguCd, adongCd };
          scope = adongCd
            ? { 행정동코드: adongCd }
            : signguCd
            ? { 시군구코드: signguCd }
            : { 시도코드: ctprvnCd };

          // ★ 대분류는 업종코드별 totalCount 만 세어 **정확히** 집계한다.
          //   행을 모으면 지역이 클수록 표본이 되는데, 이 API 의 정렬은 무작위가 아니라
          //   업종군이 몰려 있어(실측 2026-09-04: 강남구 1페이지 과학·기술 41%·음식 12%,
          //   마지막 페이지 음식 52%·과학·기술 3%) 앞부분만 모으면 구성비가 크게 편향된다.
          if (level === "large") {
            const lst = await sbiz.largeUpjongList();
            const codes = lst.items.map((v) => ({ cd: v.indsLclsCd, nm: v.indsLclsNm })).filter((v) => v.cd);
            const rows = [];
            let total = 0;
            let stdrYm = null;
            for (const { cd, nm } of codes) {
              const r1 = await sbiz.countStoresInRegion({ ...region, indsLclsCd: cd });
              stdrYm = stdrYm || r1.stdrYm;
              if (r1.totalCount > 0) rows.push({ 업종: nm, 코드: cd, 점포수: r1.totalCount });
              total += r1.totalCount;
            }
            rows.sort((a, b) => b.점포수 - a.점포수);
            return ok({
              범위: scope,
              데이터기준월: stdrYm,
              전체점포수: total,
              집계방식: "업종코드별 건수 조회(전수)",
              집계표본: total,
              표본이_전체보다_적음: false,
              집계단위: level,
              업종구성: rows.map((r2) => ({ ...r2, 비중: `${((r2.점포수 / (total || 1)) * 100).toFixed(1)}%` })),
            });
          }

          c = await sbiz.collectStoresInRegion(region, { cap: maxItems });
        } else {""")

rep("""        if (c.capped) {
          out.안내 =
            `전체 ${c.totalCount}건 중 수집 상한까지인 ${c.items.length}건만 모아 집계했습니다. ` +
            `비중은 표본 기준이므로 maxItems 를 올리거나 범위를 좁히세요.`;
        }
        return ok(out);""",
"""        if (c.capped) {
          // ★ 이 API 의 정렬은 업종군이 몰려 있어 앞부분 표본은 무작위가 아니다.
          //   비중을 그대로 내보내면 조용히 틀리므로 아예 빼고 사유를 밝힌다.
          out.업종구성 = agg.map(({ 비중, ...rest }) => rest);
          out.비중_미제공_사유 =
            "수집 상한에 걸려 표본이 전체보다 적은데, 이 API 의 정렬은 업종군이 몰려 있어 " +
            "앞부분 표본이 무작위가 아닙니다(실측: 같은 시군구에서 1페이지 과학·기술 41%, " +
            "마지막 페이지 음식 52%). 편향된 비중을 내보내지 않습니다.";
          out.안내 =
            `전체 ${c.totalCount}건 중 ${c.items.length}건만 모았습니다. ` +
            `대분류 구성비가 목적이면 level="large" 로 부르세요 — 업종코드별 건수 조회로 ` +
            `전수를 정확히 집계합니다. 중·소분류가 필요하면 범위를 좁히세요.`;
        }
        return ok(out);""")
p.write_text(t)
print("ok")
