import pathlib
p = pathlib.Path("lib/server.js"); t = p.read_text()
def rep(o,n):
    global t
    assert t.count(o)==1, t.count(o)
    t = t.replace(o,n)

# store_industry_mix — 시도/시군구/행정동 지원
rep("""        "반경 또는 행정동 단위로 점포를 모아 업종 대/중/소분류별 구성비를 낸다. " +
        "'이 상권은 무슨 업종이 몰려 있는가', '음식업 비중이 얼마인가'를 판단할 때 쓴다. " +
        "반경 조회는 lon/lat/radius, 행정동 조회는 adongCd 를 준다.",""",
"""        "반경 또는 행정구역(시도/시군구/행정동) 단위로 점포를 모아 업종 대/중/소분류별 구성비를 낸다. " +
        "'이 상권은 무슨 업종이 몰려 있는가', '이 구는 무슨 업종이 많은가'를 판단할 때 쓴다. " +
        "반경 조회는 lon/lat/radius, 행정구역 조회는 ctprvnCd(시도 2자리)/signguCd(시군구 5자리)/" +
        "adongCd(행정동 8자리) 중 하나를 준다. 자릿수가 틀리면 에러가 아니라 0건이 온다.",""")

rep("""        adongCd: z.string().optional().describe("행정동코드 10자리"),""",
"""        ctprvnCd: z.string().optional().describe("시도코드 2자리 (예: 11 서울)"),
        signguCd: z.string().optional().describe("시군구코드 5자리 (예: 11680 강남구)"),
        adongCd: z.string().optional().describe("행정동코드 8자리 (예: 11680640 역삼1동). 10자리를 주면 0건이 온다"),""")

rep("""    async ({ lon, lat, radius, adongCd, level, maxItems }) => {
      try {
        let c;
        let scope;
        if (adongCd) {
          c = await sbiz.collectStoresInDong({ adongCd }, { cap: maxItems });
          scope = { 행정동코드: adongCd };
        } else {""",
"""    async ({ lon, lat, radius, ctprvnCd, signguCd, adongCd, level, maxItems }) => {
      try {
        let c;
        let scope;
        if (adongCd || signguCd || ctprvnCd) {
          c = await sbiz.collectStoresInRegion({ ctprvnCd, signguCd, adongCd }, { cap: maxItems });
          scope = adongCd
            ? { 행정동코드: adongCd }
            : signguCd
            ? { 시군구코드: signguCd }
            : { 시도코드: ctprvnCd };
        } else {""")

# resolve_region — SGIS 응답의 adm_cd 를 그대로 쓰고, 소상공인용 코드까지 함께 돌려준다
rep("""          out.지오코딩 = r.map((v) => ({
            주소: v.road_nm_main_nm ? `${v.sido_nm || ""} ${v.sgg_nm || ""} ${v.road_nm_main_nm}` : v.addr_type,
            경도: v.x ? Number(v.x) : null,
            위도: v.y ? Number(v.y) : null,
            시도코드: v.sido_cd,
            시군구코드: v.sgg_cd,
            읍면동코드: v.emdong_cd,
            adm_cd: [v.sido_cd, v.sgg_cd, v.emdong_cd].filter(Boolean).join(""),
          }));""",
"""          const nn = (x) => (x && x !== "null" ? x : null);
          out.지오코딩 = r.map((v) => {
            // ★ adm_cd 는 응답에 이미 들어 있다. sido_cd+sgg_cd 를 이어붙이면 안 된다
            //   (SGIS 의 sgg_cd 는 법정 시군구코드가 아니라 자체 코드라 엉뚱한 구가 된다).
            const admCd = nn(v.adm_cd);
            const legCd = nn(v.leg_cd); // 법정동코드 10자리 — 앞 5자리가 법정 시군구코드다
            return {
              주소: [nn(v.sido_nm), nn(v.sgg_nm), nn(v.adm_nm) || nn(v.leg_nm)].filter(Boolean).join(" ") || null,
              경도: v.x ? Number(v.x) : null,
              위도: v.y ? Number(v.y) : null,
              "adm_cd(SGIS)": admCd,
              법정동코드: legCd,
              "시군구코드(소상공인 signguCd)": legCd ? legCd.slice(0, 5) : null,
              "시도코드(소상공인 ctprvnCd)": legCd ? legCd.slice(0, 2) : null,
            };
          });
          out.안내 =
            "SGIS 의 adm_cd 와 소상공인 상가정보의 행정동코드는 서로 다른 체계입니다. " +
            "소상공인 행정동코드(8자리)가 필요하면 stores_nearby 를 그 좌표로 한 번 부른 뒤 " +
            "응답 점포의 '행정동코드' 를 읽으세요.";""")
p.write_text(t)
print("ok")
