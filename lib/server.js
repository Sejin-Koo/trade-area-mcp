// trade-area-mcp — 상권분석 MCP 서버
//
// 네 갈래 소스를 하나로 묶는다.
//   ① 소상공인시장진흥공단 상가(상권)정보 — 전국 점포·업종 (WGS84)
//   ② 행정안전부 지방행정 인허가 20종     — 전국 개·폐업 이력 (EPSG:5174)
//   ③ 국가데이터처 SGIS                    — 배후 인구·가구·주택·사업체
//   ④ 서울 열린데이터광장 상권분석서비스   — 추정매출·유동인구 (서울 한정)
//
// 좌표계가 소스마다 달라 lib/geo.js 에서 통일한다.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import * as sbiz from "./sbiz_client.js";
import * as permit from "./permit_client.js";
import * as sgis from "./sgis_client.js";
import * as seoul from "./seoul_client.js";
import * as lvpop from "./livingpop_client.js";
import { findDongs, archiveStatus } from "./livingpop_archive.js";
import { transform, haversine, CRS } from "./geo.js";

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({
  content: [{ type: "text", text: `오류: ${e && e.message ? e.message : String(e)}` }],
  isError: true,
});

/** MCP 클라이언트가 인자를 문자열로 직렬화해 보내는 경우가 있어 number/boolean은 관대하게 받는다 */
const num = (min, max, def) => {
  let s = z.coerce.number();
  if (min !== undefined) s = s.min(min);
  if (max !== undefined) s = s.max(max);
  return def === undefined ? s.optional() : s.default(def);
};
const bool = (def = false) =>
  z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(def);

function keyStatus() {
  return {
    DATA_PORTAL_KEY: !!(process.env.DATA_PORTAL_KEY || process.env.PUBLIC_DATA_PORTAL_KEY),
    SGIS_SERVICE_ID: !!process.env.SGIS_SERVICE_ID,
    SGIS_SECURITY_KEY: !!process.env.SGIS_SECURITY_KEY,
    SEOUL_OPENAPI_KEY: !!process.env.SEOUL_OPENAPI_KEY,
  };
}

export function buildServer() {
  const server = new McpServer({ name: "trade-area-mcp", version: "1.0.0" });

  // ── 0. 안내·진단 ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_data_sources",
    {
      title: "상권분석 데이터 소스 안내",
      description:
        "이 서버가 다루는 네 개 소스와 각각이 무엇을 줄 수 있는지, 조회 가능한 업종·서비스·테마 코드 목록, " +
        "그리고 인증키 설정 상태를 돌려준다. 어떤 도구를 써야 할지 모르겠을 때 가장 먼저 호출한다. " +
        "키 값 자체는 절대 반환하지 않고 설정 여부(boolean)만 알린다.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok({
          소스: {
            "① 소상공인 상가정보": {
              범위: "전국",
              제공: "점포 위치·상호·업종(대/중/소분류)·주소, WGS84 경위도",
              미제공: "매출, 유동인구",
              도구: ["stores_nearby", "store_industry_mix", "list_industry_codes"],
            },
            "② 행정안전부 인허가 20종": {
              범위: "전국",
              제공: "인허가일자·폐업일자·영업상태·면적 (개·폐업 시계열 분석의 유일한 무료 전국 소스)",
              좌표계: "EPSG:5174 → 서버가 WGS84로 변환해 반환",
              도구: ["search_permits", "permit_open_close_trend"],
              업종: permit.PERMIT_TYPE_NAMES,
            },
            "③ SGIS 통계지리정보": {
              범위: "전국",
              제공: "배후 인구·가구·주택·평균나이·인구밀도, 업종테마별 사업체수·종사자수",
              도구: ["region_demographics", "region_business_stats", "resolve_region"],
              사업체테마: Object.keys(sgis.THEME_CODES),
            },
            "④ 서울 상권분석서비스": {
              범위: "서울시 한정, 2021년 이후 분기",
              제공: "추정매출(요일·시간대·성별·연령대), 유동인구, 상주/직장인구, 점포, 집객시설",
              도구: ["seoul_trade_areas", "seoul_trade_area_stats"],
              서비스: seoul.SEOUL_SERVICES,
            },
            "⑤ 서울 생활인구(250m)": {
              범위: "서울시 행정동 427개",
              제공:
                "행정동 × 일자 × 시간(24) × 성별 × 연령(5세 단위 14구간) 완전 교차. " +
                "④의 유동인구와 달리 '평일 저녁 30대 여성' 처럼 축을 겹쳐 물을 수 있다.",
              도구: ["seoul_dong_codes", "seoul_living_population", "seoul_living_population_trend"],
              구간: {
                OpenAPI: "최근 약 4개월 롤링 (일자·시간을 짚어 조회)",
                아카이브: archiveStatus(),
              },
              주의:
                "구 데이터셋(행정동 단위 서울 생활인구, OA-14991)은 서비스 종료됐고 " +
                "2026년 국가표준 250m 격자 재집계로 대체됐다. 옛 수치와 그대로 이어 붙이지 말 것.",
            },
          },
          좌표계: Object.keys(CRS),
          인증키설정: keyStatus(),
          주의: [
            "인허가 API의 numOfRows 상한은 100이고 넘겨도 에러 없이 잘린다.",
            "서울 열린데이터광장은 1회 1,000행 상한(1,001 요청 시 ERROR-336).",
            "SGIS 호스트는 sgisapi.mods.go.kr 이다(구 kostat.go.kr 은 빈 응답).",
            "생활인구의 행정동코드(H_DNG_CD)에는 공백 패딩이 섞여 온다 — 서버가 trim 해서 돌려준다.",
            "생활인구 OpenAPI는 최근 약 4개월만 보관한다. 그 이전은 seoul_living_population_trend 로 월평균 비교만 가능하다.",
            "생활인구 OpenAPI의 행정동 필터(H_DNG_CD)는 문서에 있으나 실제로는 항상 0건이다 — 서버가 전량을 받아 걸러낸다.",
          ],
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 1. 좌표 변환 ───────────────────────────────────────────────────────────
  server.registerTool(
    "convert_coords",
    {
      title: "좌표계 변환",
      description:
        "좌표를 다른 좌표계로 변환한다. 인허가 데이터의 CRD_INFO_X/Y(EPSG:5174)를 지도에 올릴 때, " +
        "또는 WGS84 경위도를 국가기본도 좌표로 바꿀 때 쓴다. 경위도는 (x=경도, y=위도) 순서다. " +
        "SGIS 좌표변환 API는 EPSG:5174를 지원하지 않아 서버 내부에서 proj4로 계산한다.",
      inputSchema: {
        x: num(),
        y: num(),
        from: z.string().describe("원본 좌표계 (EPSG:5174 / 5181 / 5186 / 5179 / 4326)"),
        to: z.string().default("EPSG:4326").describe("변환할 좌표계"),
      },
    },
    async ({ x, y, from, to }) => {
      try {
        const r = transform(x, y, from, to);
        return ok({ 입력: { x, y, 좌표계: from }, 출력: { x: r.x, y: r.y, 좌표계: to } });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 2. 지역 해석 ───────────────────────────────────────────────────────────
  // SGIS addr/geocodewgs84 의 addr_type — 매칭 수준 (실측 2026-09-05)
  //   1 시도 / 2 시군구 / 3 동 / 5 리 / 6 건물·지번
  //   6 만 지점 단위이고 나머지는 그 행정구역의 대표점 좌표가 돌아온다.
  const ADDR_TYPE = { 1: "시도", 2: "시군구", 3: "동", 5: "리", 6: "건물·지번" };

  server.registerTool(
    "resolve_region",
    {
      title: "지역명·주소 → 행정구역코드·좌표",
      description:
        "지역명이나 주소를 SGIS 행정구역코드(adm_cd)와 WGS84 경위도로 바꾼다. " +
        "다른 도구들이 요구하는 adm_cd(시도 2자리/시군구 5자리/읍면동 8자리)와 중심좌표를 여기서 얻는다. " +
        "adm_cd 를 주면 그 아래 단계 목록을 돌려주고, address 를 주면 지오코딩 결과를 돌려준다. " +
        "지오코딩 응답의 지점단위매칭·매칭수준으로 그 좌표가 건물인지 행정구역 대표점인지 판정한다.",
      inputSchema: {
        adm_cd: z.string().optional().describe("행정구역코드. 생략하면 전국 시도 목록"),
        address: z.string().optional().describe("주소 또는 지역명 (예: 서울특별시 영등포구 여의대로 24)"),
      },
    },
    async ({ adm_cd, address }) => {
      try {
        const out = {};
        if (address) {
          const g = await sgis.geocodeWgs84(address);
          const r = (g.result && g.result.resultdata) || [];
          const nn = (x) => (x && x !== "null" ? x : null);
          out.지오코딩 = r.map((v) => {
            // ★ adm_cd 는 응답에 이미 들어 있다. sido_cd+sgg_cd 를 이어붙이면 안 된다
            //   (SGIS 의 sgg_cd 는 법정 시군구코드가 아니라 자체 코드라 엉뚱한 구가 된다).
            const admCd = nn(v.adm_cd);
            const legCd = nn(v.leg_cd); // 법정동코드 10자리 — 앞 5자리가 법정 시군구코드다
            const at = nn(v.addr_type);
            const level = at ? ADDR_TYPE[at] || `기타(코드 ${at})` : null;
            const pinpoint = at === "6";
            const road = nn(v.road_nm);
            const roadNo = nn(v.road_nm_main_no);
            const roadSub = nn(v.road_nm_sub_no);
            const jibun = nn(v.jibun_main_no);
            const jibunSub = nn(v.jibun_sub_no);
            let matched = null;
            if (road && roadNo) {
              matched = `${road} ${roadNo}${roadSub && roadSub !== "0" ? `-${roadSub}` : ""}`;
            } else if (jibun) {
              matched = `${nn(v.leg_nm) || ""} ${jibun}${jibunSub && jibunSub !== "0" ? `-${jibunSub}` : ""}`.trim();
            }
            const row = {
              매칭수준: level,
              지점단위매칭: pinpoint,
              // ★ 이 필드는 "내가 물은 주소"가 아니라 그 좌표가 속한 행정구역이다.
              //   건물이 정확히 잡혀도 동 이름으로 오므로 폴백 판정에 쓰면 안 된다.
              소재_행정구역:
                [nn(v.sido_nm), nn(v.sgg_nm), nn(v.adm_nm) || nn(v.leg_nm), nn(v.ri_nm)]
                  .filter(Boolean)
                  .join(" ") || null,
              매칭주소: matched,
              건물명: nn(v.bd_main_nm),
              경도: v.x ? Number(v.x) : null,
              위도: v.y ? Number(v.y) : null,
              "adm_cd(SGIS)": admCd,
              법정동코드: legCd,
              "시군구코드(소상공인 signguCd)": legCd ? legCd.slice(0, 5) : null,
              "시도코드(소상공인 ctprvnCd)": legCd ? legCd.slice(0, 2) : null,
            };
            if (!pinpoint) {
              row.경고 =
                `이 좌표는 건물이 아니라 ${level || "행정구역"} 단위 대표점입니다. ` +
                "지점 단위 판단(반경 조회·출점 검토)에 그대로 쓰지 마세요. " +
                "도로명+건물번호 또는 지번까지 넣어 다시 조회하세요.";
            }
            return row;
          });
          out.안내 =
            "SGIS 의 adm_cd 와 소상공인 상가정보의 행정동코드는 서로 다른 체계입니다. " +
            "소상공인 행정동코드(8자리)가 필요하면 stores_nearby 를 그 좌표로 한 번 부른 뒤 " +
            "응답 점포의 '행정동코드' 를 읽으세요. " +
            "★ 경도·위도는 반올림하지 말고 자릿수 그대로 다음 도구에 넘기세요 — " +
            "소수 5자리로 자르면 반경 조회 건수가 달라집니다.";
        }
        if (adm_cd || !address) {
          const s = await sgis.addrStage(adm_cd);
          out.행정구역목록 = (s.result || []).map((v) => ({
            코드: v.cd,
            이름: v.addr_name,
            전체주소: v.full_addr,
          }));
        }
        return ok(out);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 3. 점포 조회 ───────────────────────────────────────────────────────────
  server.registerTool(
    "stores_nearby",
    {
      title: "반경 내 점포 조회 (전국)",
      description:
        "좌표를 중심으로 반경 안의 상가업소를 소상공인시장진흥공단 상가정보에서 조회한다. " +
        "업종 대/중/소분류 코드로 좁힐 수 있고, 중심점으로부터의 거리(m)를 함께 계산해 가까운 순으로 정렬한다. " +
        "'이 자리 반경 500m에 카페가 몇 개인가' 같은 경쟁도 질문의 1차 도구다.",
      inputSchema: {
        lon: num().describe("중심 경도 (WGS84)"),
        lat: num().describe("중심 위도 (WGS84)"),
        radius: num(1, 2000, 500).describe("반경(m). 최대 2000"),
        indsLclsCd: z.string().optional().describe("업종 대분류 코드 (예: I2 음식)"),
        indsMclsCd: z.string().optional().describe("업종 중분류 코드"),
        indsSclsCd: z.string().optional().describe("업종 소분류 코드"),
        maxItems: num(1, 1000, 100).describe("최대 반환 건수 (목록 모드에만 적용. summaryOnly=true면 무시된다)"),
        summaryOnly: bool(false).describe(
          "true면 개별 점포 목록 없이 업종별 집계만 반환한다. 이때 maxItems 를 무시하고 " +
          "페이지를 이어 받아 반경 내 전량(수집 상한 5,000건)을 집계한다."
        ),
      },
    },
    async ({ lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd, maxItems, summaryOnly }) => {
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
        return ok(out);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "store_industry_mix",
    {
      title: "상권 업종 구성 분석 (전국)",
      description:
        "반경 또는 행정구역(시도/시군구/행정동) 단위로 점포를 모아 업종 대/중/소분류별 구성비를 낸다. " +
        "'이 상권은 무슨 업종이 몰려 있는가', '이 구는 무슨 업종이 많은가'를 판단할 때 쓴다. " +
        "반경 조회는 lon/lat/radius, 행정구역 조회는 ctprvnCd(시도 2자리)/signguCd(시군구 5자리)/" +
        "adongCd(행정동 8자리) 중 하나를 준다. 자릿수가 틀리면 에러가 아니라 0건이 온다.",
      inputSchema: {
        lon: num().optional(),
        lat: num().optional(),
        radius: num(1, 2000).optional(),
        ctprvnCd: z.string().optional().describe("시도코드 2자리 (예: 11 서울)"),
        signguCd: z.string().optional().describe("시군구코드 5자리 (예: 11680 강남구)"),
        adongCd: z.string().optional().describe("행정동코드 8자리 (예: 11680640 역삼1동). 10자리를 주면 0건이 온다"),
        level: z.enum(["large", "middle", "small"]).default("middle").describe("집계 단위"),
        maxItems: num(1, 10000, 5000).describe(
          "집계에 사용할 최대 점포 수(수집 상한). 1,000건을 넘으면 페이지를 이어 받는다."
        ),
      },
    },
    async ({ lon, lat, radius, ctprvnCd, signguCd, adongCd, level, maxItems }) => {
      try {
        let c;
        let scope;
        if (adongCd || signguCd || ctprvnCd) {
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
        return ok(out);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_industry_codes",
    {
      title: "소상공인 업종 분류 코드",
      description:
        "상가정보 API가 쓰는 업종 대/중/소분류 코드를 조회한다. stores_nearby 의 indsLclsCd 등에 넣을 값을 찾을 때 쓴다. " +
        "인자를 주지 않으면 대분류, indsLclsCd 를 주면 그 아래 중분류, indsMclsCd 를 주면 소분류를 돌려준다.",
      inputSchema: {
        indsLclsCd: z.string().optional(),
        indsMclsCd: z.string().optional(),
      },
    },
    async ({ indsLclsCd, indsMclsCd }) => {
      try {
        if (indsMclsCd) {
          const r = await sbiz.smallUpjongList(indsMclsCd);
          return ok({ 단위: "소분류", 상위코드: indsMclsCd, 목록: r.items });
        }
        if (indsLclsCd) {
          const r = await sbiz.middleUpjongList(indsLclsCd);
          return ok({ 단위: "중분류", 상위코드: indsLclsCd, 목록: r.items });
        }
        const r = await sbiz.largeUpjongList();
        return ok({ 단위: "대분류", 목록: r.items });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 4. 인허가 ──────────────────────────────────────────────────────────────
  server.registerTool(
    "search_permits",
    {
      title: "업종별 인허가 조회 (전국)",
      description:
        "행정안전부 지방행정 인허가 데이터에서 업종·지역·기간·영업상태로 업소를 조회한다. " +
        "상가정보와 달리 인허가일자와 폐업일자가 있어 개업·폐업 시점을 알 수 있다. " +
        `조회 가능 업종: ${permit.PERMIT_TYPE_NAMES.join(", ")}. ` +
        "★ 지역은 region(지번주소 부분일치)으로 좁힌다. 도로명주소(addrLike)로 좁히면 " +
        "2011년 도로명주소 도입 이전에 폐업한 업소가 통째로 빠져 폐업 이력의 절반 이상이 조용히 사라진다. " +
        "좌표는 원본이 EPSG:5174라 서버가 WGS84로 변환해 돌려준다.",
      inputSchema: {
        type: z.string().describe(`업종명. 하나 선택: ${permit.PERMIT_TYPE_NAMES.join(", ")}`),
        region: z.string().optional().describe("지번주소 부분일치 (예: 영등포구). 지역 필터는 이것을 쓸 것"),
        addrLike: z.string().optional().describe("도로명주소 부분일치. 폐업 이력이 누락되므로 특별한 이유가 없으면 쓰지 말 것"),
        orgCode: z.string().optional().describe("개방자치단체코드 (예: 3170000). 가장 정확하지만 코드를 알아야 한다"),
        salesStatus: z.string().optional().describe("영업상태코드. 01=영업/정상, 03=폐업"),
        licenseFrom: z.string().optional().describe("인허가일자 이상 (YYYY-MM-DD)"),
        licenseTo: z.string().optional().describe("인허가일자 미만 (YYYY-MM-DD)"),
        name: z.string().optional().describe("사업장명 부분일치"),
        maxItems: num(1, 2000, 100).describe("최대 반환 건수 (100건 단위로 페이징)"),
        countOnly: bool(false).describe("true면 건수만 반환(1회 호출로 끝나 빠르다)"),
      },
    },
    async (a) => {
      try {
        const warn = [];
        if (a.addrLike && !a.region && !a.orgCode) {
          warn.push(
            "도로명주소로 지역을 좁혔습니다. 2011년 이전 폐업 업소는 도로명주소가 없어 결과에서 빠집니다 " +
              "— 개·폐업 이력을 볼 목적이라면 region(지번주소)으로 다시 조회하세요."
          );
        }
        if (a.countOnly) {
          const r = await permit.fetchPermits({ ...a, numOfRows: 1, pageNo: 1 });
          return ok({
            업종: a.type,
            조건: { ...a, countOnly: undefined },
            총건수: r.totalCount,
            ...(warn.length ? { 주의: warn } : {}),
          });
        }
        const r = await permit.fetchPermitsPaged(a, a.maxItems);
        return ok({
          업종: a.type,
          총건수: r.totalCount,
          반환건수: r.items.length,
          잘림: r.totalCount > r.items.length,
          영업상태코드표: permit.SALS_STTS,
          ...(warn.length ? { 주의: warn } : {}),
          목록: r.items.map(permit.slimPermit),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "permit_open_close_trend",
    {
      title: "업종 개·폐업 추이 / 생존율",
      description:
        "한 지역·업종에 대해 연도별 신규 인허가(개업) 건수와 현재 영업/폐업 구성을 집계한다. " +
        "인허가일자 범위를 연 단위로 나눠 건수만 조회하므로 호출이 가볍다. " +
        "'이 상권 카페가 늘고 있나 줄고 있나', '이 업종 폐업률이 어느 정도인가'에 답할 때 쓴다. " +
        "★ 지역은 지번주소 기준으로만 집계한다 — 도로명주소 기준으로 하면 옛 폐업 건이 빠져 폐업률이 크게 과소집계된다.",
      inputSchema: {
        type: z.string().describe(`업종명. ${permit.PERMIT_TYPE_NAMES.join(", ")}`),
        region: z.string().describe("지번주소 부분일치 (예: 영등포구)"),
        orgCode: z.string().optional().describe("개방자치단체코드. 주면 지번주소 대신 이것으로 좁힌다(더 정확)"),
        fromYear: num(2000, 2100, 2019).describe("시작 연도"),
        toYear: num(2000, 2100, new Date().getFullYear()).describe("끝 연도"),
      },
    },
    async ({ type, region, orgCode, fromYear, toYear }) => {
      try {
        const scope = orgCode ? { type, orgCode } : { type, region };
        const years = [];
        for (let y = fromYear; y <= toYear; y++) years.push(y);
        const rows = [];
        for (const y of years) {
          const r = await permit.fetchPermits({
            ...scope,
            licenseFrom: `${y}-01-01`,
            licenseTo: `${y + 1}-01-01`,
            numOfRows: 1, pageNo: 1,
          });
          rows.push({ 연도: y, 신규인허가: r.totalCount });
        }
        const [all, active, closed] = await Promise.all([
          permit.fetchPermits({ ...scope, numOfRows: 1, pageNo: 1 }),
          permit.fetchPermits({ ...scope, salesStatus: "01", numOfRows: 1, pageNo: 1 }),
          permit.fetchPermits({ ...scope, salesStatus: "03", numOfRows: 1, pageNo: 1 }),
        ]);
        const 누적 = all.totalCount || 1;
        return ok({
          업종: type,
          지역: orgCode ? `자치단체코드 ${orgCode}` : region,
          지역필터: orgCode ? "OPN_ATMY_GRP_CD" : "LOTNO_ADDR(지번주소)",
          연도별_신규인허가: rows,
          현황: {
            누적등록: all.totalCount,
            영업중: active.totalCount,
            폐업: closed.totalCount,
            영업중_비율: `${((active.totalCount / 누적) * 100).toFixed(1)}%`,
            폐업_비율: `${((closed.totalCount / 누적) * 100).toFixed(1)}%`,
          },
          해석주의: [
            "누적등록은 개설 이래 전체 이력이므로 폐업 비율은 특정 기간의 폐업률이 아니다.",
            "인허가일자 기준이라 실제 개점일과는 차이가 있을 수 있다.",
            "지번주소 부분일치로 좁히므로 동일 명칭의 다른 지역(예: '중구')이 섞일 수 있다. 정확히 하려면 orgCode를 쓴다.",
          ],
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 5. 배후 수요 (SGIS) ────────────────────────────────────────────────────
  server.registerTool(
    "region_demographics",
    {
      title: "배후 인구·가구·주택 통계",
      description:
        "SGIS 총조사 주요지표로 그 지역의 총인구·평균나이·인구밀도·총가구·평균가구원수·총주택·사업체수·종업원수를 조회한다. " +
        "상권의 배후수요 규모를 볼 때 쓴다. adm_cd 는 resolve_region 으로 얻는다. " +
        "low_search 를 1로 주면 하위 행정구역까지 나눠서 돌려준다.",
      inputSchema: {
        adm_cd: z.string().describe("행정구역코드 (시도 2 / 시군구 5 / 읍면동 8자리)"),
        year: num(2015, 2100, 2024),
        low_search: num(0, 2, 0).describe("0=해당 구역만, 1=1단계 하위, 2=2단계 하위"),
        includeAge: bool(false).describe("true면 연령대별 인구도 함께 조회"),
      },
    },
    async ({ adm_cd, year, low_search, includeAge }) => {
      try {
        const r = await sgis.censusIndicators({ year, adm_cd, low_search });
        const out = {
          기준연도: year,
          지표: (r.result || []).map((v) => ({
            행정구역코드: v.adm_cd,
            행정구역명: v.adm_nm,
            총인구: v.tot_ppltn,
            평균나이: v.avg_age,
            "인구밀도(명/km2)": v.ppltn_dnsty,
            노령화지수: v.aged_child_idx,
            총가구: v.tot_family,
            평균가구원수: v.avg_fmember_cnt,
            총주택: v.tot_house,
            사업체수: v.corp_cnt,
            종업원수: v.employee_cnt,
          })),
        };
        if (includeAge) {
          const ages = {};
          for (const [label, code] of [["20대", "32"], ["30대", "33"], ["40대", "34"], ["50대", "35"], ["60대", "36"]]) {
            const a = await sgis.populationByAge({ year, adm_cd, low_search: 0, age_type: code });
            ages[label] = (a.result && a.result[0] && a.result[0].population) || null;
          }
          out.연령대별_인구 = ages;
        }
        return ok(out);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "region_business_stats",
    {
      title: "업종 테마별 사업체·종사자 수",
      description:
        "SGIS 전국사업체조사로 특정 지역의 사업체수와 종사자수를 조회한다. theme 을 주면 업종 테마로 좁힌다. " +
        "소상공인 상가정보가 '개별 점포'라면 이쪽은 '통계 집계값'이라, 두 소스를 대조하면 커버리지 편차를 알 수 있다. " +
        `사용 가능 테마: ${Object.keys(sgis.THEME_CODES).join(", ")}`,
      inputSchema: {
        adm_cd: z.string().describe("행정구역코드"),
        theme: z.string().optional().describe("업종 테마명 (예: 카페, 한식, 편의점, 미용실, PC방)"),
        year: num(2000, 2100, 2024),
        low_search: num(0, 2, 0),
      },
    },
    async ({ adm_cd, theme, year, low_search }) => {
      try {
        let theme_cd;
        if (theme) {
          theme_cd = sgis.THEME_CODES[theme];
          if (!theme_cd) {
            throw new Error(
              `알 수 없는 테마입니다: ${theme}\n사용 가능: ${Object.keys(sgis.THEME_CODES).join(", ")}`
            );
          }
        }
        const r = await sgis.companyStats({ year, adm_cd, low_search, theme_cd });
        return ok({
          기준연도: year,
          테마: theme || "(전체 업종)",
          테마코드: theme_cd || null,
          결과: (r.result || []).map((v) => ({
            행정구역코드: v.adm_cd,
            행정구역명: v.adm_nm,
            사업체수: v.corp_cnt,
            종사자수: v.tot_worker,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 6. 서울 상권 (매출·유동인구) ───────────────────────────────────────────
  server.registerTool(
    "seoul_trade_areas",
    {
      title: "서울 상권 검색 (상권코드 찾기)",
      description:
        "서울시 상권분석서비스의 상권 목록에서 이름으로 상권을 찾아 상권코드를 돌려준다. " +
        "seoul_trade_area_stats 에 넣을 상권코드를 여기서 먼저 얻는다. " +
        "상권 구분은 골목상권·발달상권·전통시장·관광특구로 나뉜다.",
      inputSchema: {
        keyword: z.string().optional().describe("상권명 부분일치 (예: 여의도, 영등포역)"),
        limit: num(1, 100, 30),
      },
    },
    async ({ keyword, limit }) => {
      try {
        return ok(await seoul.findTradeAreas(keyword, { limit }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "seoul_trade_area_stats",
    {
      title: "서울 상권 지표 조회 (추정매출·유동인구 등)",
      description:
        "서울시 상권분석서비스에서 한 상권의 지표를 조회한다. 전국 소스에 없는 추정매출과 유동인구가 여기에 있다. " +
        `service 로 무엇을 볼지 고른다: ${seoul.SEOUL_SERVICE_NAMES.join(", ")}. ` +
        "추정매출은 요일별·시간대별·성별·연령대별로 분해되어 있다. 서울시 한정이며 2021년 이후 분기 자료만 있다. " +
        "quarter 는 기준년분기코드(예: 20254 = 2025년 4분기).",
      inputSchema: {
        service: z.string().describe(`조회할 지표. ${seoul.SEOUL_SERVICE_NAMES.join(", ")}`),
        trdarCd: z.string().optional().describe("상권코드 (seoul_trade_areas 로 조회)"),
        quarter: z.string().optional().describe("기준년분기코드 (예: 20254)"),
        start: num(1, 1000000, 1),
        end: num(1, 1000000, 100),
        maxScan: num(1000, 100000, 20000).describe("상권코드로 필터할 때 훑을 최대 행 수"),
      },
    },
    async ({ service, trdarCd, quarter, start, end, maxScan }) => {
      try {
        if (trdarCd) {
          const r = await seoul.tradeAreaSeries(service, { trdarCd, quarter, maxScan });
          if (r.스캔상한도달) {
            r.안내 =
              r.매칭건수 === 0
                ? `스캔 상한(${maxScan}행)에 걸려 해당 상권을 찾지 못했을 수 있습니다. ` +
                  "quarter 를 지정해 대상 범위를 줄이거나 maxScan 을 올리세요."
                : `스캔 상한(${maxScan}행)에 걸렸습니다. 지금 매칭된 ${r.매칭건수}건 외에 ` +
                  "**아직 훑지 못한 구간에 같은 상권의 다른 행(다른 분기 등)이 남아 있을 수 있습니다.** " +
                  "특정 분기만 필요하면 quarter 를 지정해 그 분기가 매칭됐는지 확인하고, " +
                  "시계열이 필요하면 maxScan 을 올리세요.";
          }
          return ok(r);
        }
        return ok(await seoul.callSeoul(service, { start, end, extra: quarter ? [quarter] : [] }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 6-2. 서울 생활인구 (행정동 × 시간 × 성별 × 연령 교차) ──────────────────
  server.registerTool(
    "seoul_dong_codes",
    {
      title: "서울 행정동 코드 검색",
      description:
        "행정동명이나 자치구명으로 생활인구 조회에 쓸 행정동코드(8자리)를 찾는다. " +
        "seoul_living_population / seoul_living_population_trend 에 넣을 dong 값을 여기서 얻는다. " +
        "이 코드는 SGIS 의 adm_cd 와 다른 체계이므로 서로 바꿔 넣으면 조용히 0건이 된다.",
      inputSchema: {
        keyword: z.string().optional().describe("행정동명 또는 자치구명 부분일치 (예: 영등포, 여의동)"),
        limit: num(1, 200, 50),
      },
    },
    async ({ keyword, limit }) => {
      try {
        const list = findDongs(keyword, { limit });
        if (!list.length) {
          return ok({
            검색어: keyword || "(전체)",
            결과수: 0,
            안내:
              "행정동 매핑이 비어 있거나 일치하는 이름이 없습니다. " +
              "매핑은 data/livingpop/dong_meta.json 에 있고 scripts/build_dong_meta.mjs 로 생성합니다.",
            아카이브: archiveStatus(),
          });
        }
        return ok({ 검색어: keyword || "(전체)", 결과수: list.length, 행정동목록: list });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "seoul_living_population",
    {
      title: "서울 생활인구 조회 (일자·시간·행정동)",
      description:
        "특정 일자와 시간의 행정동별 생활인구를 성별×연령(5세 단위 14구간) 교차로 돌려준다. " +
        "상권분석서비스의 '유동인구'는 성별·연령·시간대가 각각 별도 합계라 겹쳐 물을 수 없지만, " +
        "이 데이터는 교차 집계라 '저녁 6시 30대 여성' 같은 조건이 가능하다. " +
        "OpenAPI는 최근 약 4개월만 보관하므로 그 이전 기간은 seoul_living_population_trend 를 쓴다. " +
        "ymd 는 YYYYMMDD 8자리다 — YYYYMM 6자리를 넣으면 오류 없이 0건이 나온다. " +
        "행정동 필터는 서울시 API가 무시하므로(문서에는 있으나 실제로는 늘 0건) 서버가 전량을 받아 걸러낸다. " +
        "tt 를 함께 주면 1회 호출로 끝나고, 생략하면 24시간 전량이라 호출이 11회로 늘어난다.",
      inputSchema: {
        ymd: z.string().describe("일자 YYYYMMDD (예: 20260731)"),
        tt: z.string().optional().describe("시간 0~23. 생략하면 전 시간"),
        dong: z.string().optional().describe("행정동코드 8자리 (seoul_dong_codes 로 조회). 생략하면 전체 행정동"),
        start: num(1, 1000000, 1),
        end: num(1, 1000000, 100),
      },
    },
    async ({ ymd, tt, dong, start, end }) => {
      try {
        if (!/^\d{8}$/.test(String(ymd || ""))) {
          return ok({
            오류: "ymd 는 YYYYMMDD 8자리여야 합니다.",
            받은값: ymd,
            안내: "6자리(YYYYMM)를 넣으면 서버가 정상 코드로 0건을 돌려주어 '데이터 없음'과 구분되지 않습니다.",
          });
        }
        const r = await lvpop.fetchDay({ ymd, tt, dong });
        if (r.empty || (dong && !r.rows.length && !r.수집행수)) {
          const window = await lvpop.probeApiWindow({});
          return ok({
            조회조건: { 일자: ymd, 시간: tt ?? "전체", 행정동: dong ?? "전체" },
            결과: "데이터 없음",
            사유: r.사유,
            안내:
              "OpenAPI 보관 구간(최근 약 4개월) 밖일 수 있습니다. 아래 실측 창을 확인하고, " +
              "그보다 과거는 seoul_living_population_trend 로 월평균 비교를 쓰세요.",
            보관구간_실측: window,
            아카이브: archiveStatus(),
          });
        }
        if (dong && !r.rows.length) {
          return ok({
            조회조건: { 일자: ymd, 시간: tt ?? "전체", 행정동: dong },
            결과: "그 날짜·시각의 자료는 있으나 해당 행정동코드가 없습니다",
            그날_행정동수: r.수집행수,
            안내: "행정동코드가 맞는지 seoul_dong_codes 로 확인하세요. 이 코드는 SGIS adm_cd 와 다른 체계입니다.",
          });
        }
        const rows = r.rows.slice(Math.max(0, start - 1), Math.max(0, start - 1) + end);
        return ok({
          조회조건: { 일자: ymd, 시간: tt ?? "전체", 행정동: dong ?? "전체" },
          그날_수집행수: r.수집행수,
          필터후_건수: r.rows.length,
          반환건수: rows.length,
          잘림: r.잘림,
          upstream호출수: r.calls,
          단위: "명(추정치라 소수로 제공된다)",
          연령구간: lvpop.AGE_BANDS.map((b) => b.label),
          rows: rows.map(lvpop.normalizeRow),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "seoul_living_population_trend",
    {
      title: "서울 생활인구 월별 추이 (과거 비교)",
      description:
        "한 행정동의 생활인구를 월별로 비교한다. OpenAPI가 최근 4개월만 보관하므로 " +
        "월별 원본 파일을 미리 접어 둔 아카이브(data/livingpop/)에서 읽는다. " +
        "일자는 월평균으로 접히지만 시간(24) × 성별 × 연령(14) 교차는 원자료 그대로 살아 있고, " +
        "평일(월~금)과 주말(토·일)은 나뉘어 있다. " +
        "'작년 이맘때 대비 저녁 시간대 30대가 늘었나' 같은 질문이 이 도구의 용도다.",
      inputSchema: {
        dong: z.string().describe("행정동코드 8자리 (seoul_dong_codes 로 조회)"),
        months: z.string().optional().describe("비교할 월을 쉼표로 (예: 202409,202509). 생략하면 보유 전체"),
        tt: z.string().optional().describe("시간 0~23. 쉼표로 여러 개 가능. 생략하면 전 시간 평균"),
        timeBand: z
          .string()
          .optional()
          .describe(`시간대 묶음 — ${Object.keys(lvpop.TIME_BANDS).join(", ")} (상권분석 유동인구와 같은 6구간)`),
        dayType: z.string().default("평일").describe("평일 또는 주말"),
      },
    },
    async ({ dong, months, tt, timeBand, dayType }) => {
      try {
        const list = months ? months.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        return ok(await lvpop.livingPopTrend({ dong, months: list, tt, timeBand, dayType }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 7. 종합 리포트 ─────────────────────────────────────────────────────────
  server.registerTool(
    "trade_area_report",
    {
      title: "상권 종합 프로파일",
      description:
        "좌표 하나로 그 자리의 상권 프로파일을 한 번에 만든다. " +
        "반경 내 점포 수와 업종 구성(소상공인), 지정 업종의 개·폐업 추이(인허가), " +
        "배후 인구·가구·사업체(SGIS)를 묶어 돌려준다. " +
        "adm_cd 와 region 을 함께 주면 배후수요와 인허가 항목까지 채워진다.",
      inputSchema: {
        lon: num().describe("중심 경도"),
        lat: num().describe("중심 위도"),
        radius: num(1, 2000, 500),
        adm_cd: z.string().optional().describe("배후수요를 볼 행정구역코드"),
        region: z.string().optional().describe("인허가 조회용 지번주소 부분일치 (예: 영등포구)"),
        permitType: z.string().optional().describe(`개·폐업 추이를 볼 업종. ${permit.PERMIT_TYPE_NAMES.join(", ")}`),
      },
    },
    async ({ lon, lat, radius, adm_cd, region, permitType }) => {
      const out = { 기준점: { 경도: lon, 위도: lat, 반경m: radius } };
      // 각 소스는 독립적이므로 하나가 실패해도 나머지는 채운다.
      try {
        // ★ 예전에는 1페이지(1,000건)만 받아 집계했다. 반경이 조금만 넓어도 표본이 되는데,
        //   이 API 의 정렬은 업종군이 몰려 있어 앞부분만 세면 구성이 크게 편향된다
        //   (실측 2026-09-04: 영등포역 500m 전체 2,496건 중 1,000건만 집계하니 소매가 992 → 491).
        const s = await sbiz.collectStoresInRadius({ lon, lat, radius }, { cap: 5000 });
        out.점포 = {
          데이터기준월: s.stdrYm,
          반경내_점포수: s.totalCount,
          집계표본: s.items.length,
          전수집계: !s.capped,
          조회페이지수: s.pages,
          업종대분류_구성: sbiz.aggregateByIndustry(s.items, "large").slice(0, 10),
          업종중분류_상위: sbiz.aggregateByIndustry(s.items, "middle").slice(0, 15),
        };
        if (s.capped) {
          out.점포.경고 =
            `전체 ${s.totalCount}건 중 ${s.items.length}건만 모았습니다. 이 API 의 정렬은 업종군이 ` +
            "몰려 있어 앞부분 표본이 무작위가 아니므로, 위 구성은 구성비로 쓰지 마세요. " +
            '대분류 구성비가 필요하면 store_industry_mix 를 level="large" 로 부르세요(전수 집계).';
        }
      } catch (e) {
        out.점포 = { 오류: e.message };
      }

      if (adm_cd) {
        try {
          const d = await sgis.censusIndicators({ year: 2024, adm_cd, low_search: 0 });
          const v = (d.result || [])[0] || {};
          out.배후수요 = {
            행정구역: v.adm_nm,
            총인구: v.tot_ppltn,
            총가구: v.tot_family,
            평균나이: v.avg_age,
            "인구밀도(명/km2)": v.ppltn_dnsty,
            사업체수: v.corp_cnt,
            종업원수: v.employee_cnt,
          };
        } catch (e) {
          out.배후수요 = { 오류: e.message };
        }
      }

      if (permitType && region) {
        try {
          const [all, active, closed] = await Promise.all([
            permit.fetchPermits({ type: permitType, region, numOfRows: 1, pageNo: 1 }),
            permit.fetchPermits({ type: permitType, region, salesStatus: "01", numOfRows: 1, pageNo: 1 }),
            permit.fetchPermits({ type: permitType, region, salesStatus: "03", numOfRows: 1, pageNo: 1 }),
          ]);
          const y = new Date().getFullYear();
          const recent = await permit.fetchPermits({
            type: permitType, region, licenseFrom: `${y}-01-01`, numOfRows: 1, pageNo: 1,
          });
          out.인허가 = {
            업종: permitType,
            지역: region,
            누적등록: all.totalCount,
            영업중: active.totalCount,
            폐업: closed.totalCount,
            [`${y}년_신규`]: recent.totalCount,
          };
        } catch (e) {
          out.인허가 = { 오류: e.message };
        }
      }

      out.안내 = [
        "매출·유동인구는 서울시만 제공됩니다 — seoul_trade_areas → seoul_trade_area_stats 를 이어서 쓰세요.",
        "점포는 페이지를 이어 받아 전량 집계합니다(전수집계=false 면 수집 상한에 걸린 것이며 그때는 경고가 붙습니다).",
        "배후수요·인허가는 adm_cd / region+permitType 을 주어야 채워집니다 — 안 주면 점포만 나옵니다.",
      ];
      return ok(out);
    }
  );

  return server;
}
