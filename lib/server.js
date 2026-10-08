// trade-area-mcp — 상권분석 MCP 서버
//
// 네 갈래 소스를 하나로 묶는다.
//   ① 소상공인시장진흥공단 상가(상권)정보 — 전국 점포·업종 (WGS84)
//   ② 행정안전부 지방행정 인허가 20종     — 전국 개·폐업 이력 (EPSG:5174)
//   ③ 국가데이터처 SGIS                    — 배후 인구·가구·주택·사업체
//   ④ 서울 열린데이터광장 상권분석서비스   — 추정매출·유동인구 (서울 한정)
//   ⑤ 네이버 클라우드 Maps (유료 가능)       — 지오코딩·역지오코딩·길찾기·정적지도 (lib/naver_maps_client.js)
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
import * as naver from "./naver_maps_client.js";

// 서버 버전 — package.json 의 version 과 함께 올린다.
export const SERVER_VERSION = "1.1.0";

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

// ── 네이버 지도 공통 헬퍼 ────────────────────────────────────────────────────

/** 네이버 지도 응답 — 모든 응답에 과금안내를 싣는다(호출 상한을 두지 않는 대신). */
const naverOk = (obj, calls) => ok({ ...obj, 과금안내: naver.billingNotice(calls) });
const naverFail = (e) => {
  const msg = e && e.message ? e.message : String(e);
  const kind = e && e.kind ? `(${e.kind})` : "";
  const calls = e && e.calls ? ` 이번 요청에서 네이버 API 를 ${e.calls}회 호출했습니다.` : "";
  return {
    content: [
      {
        type: "text",
        text:
          `오류${kind}: ${msg}\n\n` +
          `과금안내: ${naver.BILLING_NOTICE_TEXT} 요금 페이지: ${naver.PRICING_URL}.${calls}`,
      },
    ],
    isError: true,
  };
};

// 대한민국 대략 범위 — 경위도 순서가 뒤바뀐 입력을 잡는 데 쓴다.
const inKorea = (lon, lat) => lon >= 124 && lon <= 132 && lat >= 33 && lat <= 39.5;

/** 네이버 지오코딩 addresses[] 한 건을 이 서버 형식으로 정리한다. 좌표는 절대 반올림하지 않는다. */
function slimNaverAddress(a, withDistance) {
  const el = {};
  for (const e of a.addressElements || []) {
    if (e && e.types && e.types[0]) el[e.types[0]] = e.longName || "";
  }
  // 매칭 수준 판정 (실측 2026-10-08): '역삼동' 처럼 동까지만 준 입력은 BUILDING_NUMBER·LAND_NUMBER 가
  // 비어 있고 좌표가 동 대표점(역지오코딩의 area3 중심과 같은 값)이다. 둘 중 하나라도 있으면 지점 단위다.
  const pinpoint = !!(el.BUILDING_NUMBER || el.LAND_NUMBER);
  const level = el.BUILDING_NUMBER
    ? "건물(도로명+건물번호)"
    : el.LAND_NUMBER
    ? "지번"
    : el.ROAD_NAME
    ? "도로명(건물번호 없음)"
    : el.RI
    ? "리"
    : el.DONGMYUN
    ? "읍면동"
    : el.SIGUGUN
    ? "시군구"
    : "시도";
  // x·y 는 소수 7자리 문자열로 온다. Number() 변환은 자릿수를 잃지 않는다(반올림 아님).
  const lon = Number(a.x);
  const lat = Number(a.y);
  const row = {
    지점단위매칭: pinpoint,
    매칭수준: level,
    // 동 단위 결과는 roadAddress 에도 '서울특별시 강남구 역삼동' 이 들어와 도로명주소로 오인되므로 비운다.
    도로명주소: el.ROAD_NAME ? a.roadAddress || null : null,
    지번주소: a.jibunAddress || null,
    건물명: el.BUILDING_NAME || null,
    우편번호: el.POSTAL_CODE || null,
    경도: lon,
    위도: lat,
    좌표계: "WGS84(EPSG:4326)",
    stores_nearby_인자: { lon, lat },
  };
  if (withDistance) row.기준점거리m = a.distance;
  if (!pinpoint) {
    row.경고 =
      `이 좌표는 건물이 아니라 ${level} 단위 대표점입니다. 지점 단위 판단(반경 조회·출점 검토)에 그대로 쓰지 마세요. ` +
      "도로명+건물번호 또는 지번까지 넣어 다시 조회하세요.";
  }
  return row;
}

/** 길찾기 경로 좌표를 처음·끝을 살린 채 고르게 솎아낸다. */
function downsamplePath(path, n) {
  if (!Array.isArray(path) || path.length <= n) return path || [];
  const out = [];
  const step = (path.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(path[Math.round(i * step)]);
  return out;
}

const km = (m) => (typeof m === "number" ? Math.round(m / 10) / 100 : null);
const minutes = (ms) => (typeof ms === "number" ? Math.round(ms / 6000) / 10 : null);
const hhmm = (ms) => {
  if (typeof ms !== "number") return null;
  const t = Math.round(ms / 60000);
  return t >= 60 ? `${Math.floor(t / 60)}시간 ${t % 60}분` : `${t}분`;
};

function keyStatus() {
  return {
    DATA_PORTAL_KEY: !!(process.env.DATA_PORTAL_KEY || process.env.PUBLIC_DATA_PORTAL_KEY),
    SGIS_SERVICE_ID: !!process.env.SGIS_SERVICE_ID,
    SGIS_SECURITY_KEY: !!process.env.SGIS_SECURITY_KEY,
    SEOUL_OPENAPI_KEY: !!process.env.SEOUL_OPENAPI_KEY,
  };
}

export function buildServer() {
  const server = new McpServer({ name: "trade-area-mcp", version: SERVER_VERSION });

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
              // 두 번째 의견 — 네이버 지오코딩. 다만 실측(2026-10-08)상 네이버도 동 이름만 준 입력은
              // 동 대표점을, 역·상호 같은 장소명은 0건을 돌려주므로 폴백의 해법이라고 안내하지 않는다.
              row.두번째의견 =
                "naver_geocode 로 같은 주소를 조회해 건물 단위 좌표(지점단위매칭=true)가 나오는지 대조할 수 있습니다. " +
                "단, 실측상 네이버도 '역삼동'처럼 동 이름까지만 준 입력은 동 대표점을, '강남역' 같은 장소명은 0건을 " +
                "돌려줍니다 — 근본 해법은 도로명+건물번호 또는 지번을 넣는 것입니다. naver_geocode 는 호출마다 과금될 수 있습니다.";
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
        "업종 대/중/소분류 코드로 좁힐 수 있고, 반경 내 전수를 모은 뒤 중심점으로부터의 거리(m)로 정렬해 " +
        "가까운 순으로 maxItems 건을 돌려준다. " +
        "'이 자리 반경 500m에 카페가 몇 개인가' 같은 경쟁도 질문의 1차 도구다.",
      inputSchema: {
        lon: num().describe("중심 경도 (WGS84)"),
        lat: num().describe("중심 위도 (WGS84)"),
        radius: num(1, 2000, 500).describe("반경(m). 최대 2000"),
        indsLclsCd: z.string().optional().describe("업종 대분류 코드 (예: I2 음식)"),
        indsMclsCd: z.string().optional().describe("업종 중분류 코드"),
        indsSclsCd: z.string().optional().describe("업종 소분류 코드"),
        maxItems: num(1, 1000, 100).describe(
          "최대 반환 건수 (목록 모드에만 적용. summaryOnly=true면 무시된다). " +
            "반경 내 전수를 모은 뒤 가까운 순으로 정렬해 앞에서 이만큼 돌려주므로, 값을 줄여도 최근접 목록이 바뀌지 않는다."
        ),
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

        // ★ 예전에는 API 앞부분 maxItems 건만 받아 그 안에서만 거리순 정렬했다.
        //   이 API 의 정렬은 업종군이 몰려 있어 앞부분이 "가까운 것들" 이 아니므로
        //   (실측: maxItems=3 이면 172·256·262m 가 오는데 실제 최근접은 119·153·172m),
        //   반경 내 전수를 모은 뒤 정렬해 앞에서 maxItems 건을 돌려준다.
        const c = await sbiz.collectStoresInRadius(
          { lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd },
          { cap: 5000 }
        );
        const all = c.items
          .map((it) => {
            const s = sbiz.slimStore(it);
            const d = s.경도 && s.위도 ? haversine(lon, lat, s.경도, s.위도) : null;
            s.거리m = d === null ? null : Math.round(d); // 표시용 정수
            s._d = d === null ? Infinity : d; // 정렬용 정밀값
            return s;
          })
          .sort((x, y) => x._d - y._d);
        const rows = all.slice(0, maxItems).map((s) => {
          delete s._d;
          return s;
        });

        const 잘림 = rows.length < c.totalCount;
        const out = {
          기준점,
          데이터기준월: c.stdrYm,
          전체건수: c.totalCount,
          수집건수: c.items.length,
          반환건수: rows.length,
          잘림,
          조회페이지수: c.pages,
          정렬: c.capped
            ? `수집 상한 ${c.items.length}건 안에서 가까운 순 — 반경 내 최근접 ${rows.length}건이라고 보장할 수 없습니다`
            : "반경 내 전수를 모아 중심점에서 가까운 순",
        };
        if (c.capped) {
          // 표본이 편향되어 있으므로 업종 집계를 내보내지 않는다(2-1절과 같은 이유).
          out.업종집계_미제공_사유 =
            `반경 내 전체 ${c.totalCount}건 중 수집 상한까지인 ${c.items.length}건만 모았고, ` +
            `이 API 의 정렬은 업종군이 몰려 있어 표본이 무작위가 아닙니다.`;
        } else {
          out["업종중분류별_집계(반경 전수)"] = sbiz.aggregateByIndustry(c.items, "middle");
        }
        out.점포목록 = rows;
        if (잘림) {
          out.안내 =
            `반경 내 전체 ${c.totalCount}건 중 가까운 순으로 ${rows.length}건만 반환했습니다. ` +
            (c.capped
              ? "수집 상한에 걸렸으므로 반경을 좁히거나 업종코드를 지정해 다시 조회하세요."
              : "업종 구성이 목적이면 summaryOnly=true 또는 store_industry_mix 를 쓰세요.");
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
        // ★ 이 API 는 divId/key 를 정확히 보내도 상위코드를 무시하고 전체 목록을 돌려준다
        //   (실측 2026-09-05: indsMclsCd=G204 로 소분류를 물으면 1,255건 전건이 온다).
        //   그대로 내보내면 응답이 토큰 상한을 넘기므로 서버가 걸러서 준다.
        const narrow = (items, field, key) => {
          const hit = items.filter((v) => v[field] === key);
          return hit.length ? hit : items;
        };
        if (indsMclsCd) {
          const r = await sbiz.smallUpjongList(indsMclsCd);
          const items = narrow(r.items, "indsMclsCd", indsMclsCd);
          return ok({
            단위: "소분류",
            상위코드: indsMclsCd,
            건수: items.length,
            목록: items,
            ...(items.length === r.items.length && r.items.length > 100
              ? { 경고: "상위코드에 해당하는 항목을 찾지 못해 전체 목록을 그대로 돌려줍니다. 코드를 확인하세요." }
              : {}),
          });
        }
        if (indsLclsCd) {
          const r = await sbiz.middleUpjongList(indsLclsCd);
          const items = narrow(r.items, "indsLclsCd", indsLclsCd);
          return ok({
            단위: "중분류",
            상위코드: indsLclsCd,
            건수: items.length,
            목록: items,
            ...(items.length === r.items.length && r.items.length > 100
              ? { 경고: "상위코드에 해당하는 항목을 찾지 못해 전체 목록을 그대로 돌려줍니다. 코드를 확인하세요." }
              : {}),
          });
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
            // maxScan 을 올리는 것은 해법이 아니다 — 몇 개가 빠졌는지 알 수 없기 때문이다.
            // 완전성은 quarter 를 하나씩 지정해 반복 호출해야만 보장된다 (실측 2026-09-05).
            r.안내 =
              r.매칭건수 === 0
                ? `스캔 상한(${maxScan}행)에 걸려 해당 상권을 찾지 못했을 수 있습니다. ` +
                  "quarter 를 지정해 다시 부르세요 — 분기를 지정하면 그 분기 행수만 훑으므로 상한에 걸리지 않습니다."
                : `스캔 상한(${maxScan}행)에 걸렸습니다. 지금 매칭된 ${r.매칭건수}건이 전부가 아닙니다 — ` +
                  "**아직 훑지 못한 구간에 같은 상권의 다른 분기 행이 남아 있습니다.** " +
                  "★ **maxScan 을 올리지 마세요. 몇 개가 빠졌는지 알 수 없습니다.** " +
                  "quarter 를 하나씩 지정해 반복 호출하는 것이 완전성을 보장하는 유일한 방법입니다 " +
                  "(분기를 지정하면 그 분기 행수만 훑으므로 상한에 걸리지 않습니다). " +
                  `있어야 할 분기 수는 산술로 확인합니다 — 분기를 하나 지정해 부르면 그 응답의 전체건수가 ` +
                  `분기당 행 수(= 상권 수)이고, 지금 이 응답의 전체건수 ${r.전체건수}를 그 값으로 나누면 됩니다. ` +
                  "★ 불완전한 표본에 최댓값·최솟값을 붙이지 마세요.";
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

  // ── 8. 네이버 지도 (NCP Maps) ──────────────────────────────────────────────
  // 지오코딩·역지오코딩·길찾기·정적지도. 모두 WGS84 경위도라 stores_nearby 와 좌표를 그대로 주고받는다.
  // ★ 호출 상한은 두지 않는다. 대신 설명과 모든 응답에 과금안내를 싣는다(무료 이용량은 대표 계정 1개에만 적용).
  const BILLING_DESC =
    ` ★ 과금: ${naver.BILLING_NOTICE_TEXT} (${naver.PRICING_URL})`;

  server.registerTool(
    "naver_geocode",
    {
      title: "네이버 지오코딩 (주소 → 좌표)",
      description:
        "네이버 지도 Geocoding 으로 주소를 WGS84 경위도로 바꾼다. 후보마다 도로명·지번 주소, 경도·위도(반올림하지 않은 원값), " +
        "건물 단위로 잡혔는지(지점단위매칭)와 매칭수준을 돌려주고, stores_nearby 에 그대로 넣을 {lon, lat} 를 함께 준다. " +
        "resolve_region(SGIS)이 동 대표점으로 폴백했을 때 대조용 두 번째 의견으로 쓸 수 있다. " +
        "주소 전용이라 '강남역' 같은 장소·상호명은 찾지 못하고(0건), '역삼동'처럼 동까지만 주면 동 대표점이 온다(실측). " +
        "near_lon/near_lat 를 주면 그 지점을 기준으로 후보를 정렬하고 거리(m)를 붙인다." +
        BILLING_DESC,
      inputSchema: {
        query: z.string().min(1).describe("검색할 주소 (예: 서울특별시 강남구 강남대로 396, 역삼동 819-2)"),
        near_lon: num(-180, 180).describe("기준점 경도 — 동명이 주소가 여럿일 때 가까운 후보를 앞으로 (선택)"),
        near_lat: num(-90, 90).describe("기준점 위도 (선택, near_lon 과 함께)"),
        count: num(1, 100, 10).describe("한 번에 받을 후보 수"),
        page: num(1, 1000, 1).describe("페이지 번호"),
      },
    },
    async ({ query, near_lon, near_lat, count, page }) => {
      try {
        if ((near_lon === undefined) !== (near_lat === undefined)) {
          throw new naver.NaverMapsError("near_lon 과 near_lat 는 함께 주어야 합니다.", { kind: "파라미터" });
        }
        const hasNear = near_lon !== undefined;
        const g = await naver.geocode({
          query,
          coordinate: hasNear ? `${near_lon},${near_lat}` : undefined,
          count,
          page,
        });
        const list = (g.addresses || []).map((a) => slimNaverAddress(a, hasNear));
        const total = (g.meta && g.meta.totalCount) || 0;
        const 안내 = [];
        if (!list.length) {
          안내.push(
            "결과 0건. 네이버 지오코딩은 주소 전용이라 역·상호·건물 같은 장소명(예: '강남역')은 찾지 못합니다(실측 2026-10-08). " +
              "도로명+건물번호(예: 강남대로 396) 또는 지번(예: 역삼동 858)으로 다시 조회하세요."
          );
        } else {
          if (list.length > 1) {
            안내.push(
              `후보가 ${list.length}개입니다. 시도·시군구까지 넣어 좁히거나 near_lon/near_lat 로 기준점을 주세요.`
            );
          }
          if (total > list.length * page) {
            안내.push(`전체 ${total}건 중 일부입니다 — page 를 넘겨 나머지를 받으세요.`);
          }
          if (list.some((r) => !r.지점단위매칭)) {
            안내.push("지점단위매칭=false 인 후보는 행정구역 대표점입니다 — 반경 조회의 중심으로 쓰지 마세요.");
          }
          안내.push(
            "★ 경도·위도는 반올림하지 말고 그대로 stores_nearby 의 lon/lat 에 넘기세요 — 소수 5자리로 자르면 반경 조회 건수가 달라집니다. " +
              "좌표계가 같은 WGS84 라 변환이 필요 없습니다."
          );
          안내.push("행정동코드·법정동코드가 필요하면 이 좌표를 naver_reverse_geocode 에 넣으세요.");
        }
        return naverOk(
          {
            검색어: query,
            ...(hasNear ? { 기준점: { 경도: near_lon, 위도: near_lat } } : {}),
            전체건수: total,
            페이지: page,
            반환건수: list.length,
            후보: list,
            안내,
          },
          g._calls
        );
      } catch (e) {
        return naverFail(e);
      }
    }
  );

  server.registerTool(
    "naver_reverse_geocode",
    {
      title: "네이버 역지오코딩 (좌표 → 법정동·행정동 코드·주소)",
      description:
        "네이버 지도 Reverse Geocoding 으로 WGS84 경위도가 속한 법정동·행정동 코드(10자리)와 지번·도로명 주소를 돌려준다. " +
        "행정동 코드의 앞 8자리는 소상공인 상가정보의 행정동코드(store_industry_mix 의 adongCd)와 같은 체계이고, " +
        "법정동 코드 앞 5자리는 시군구코드(signguCd)다. SGIS adm_cd 와는 다른 체계이므로 region_demographics 에 넣지 않는다." +
        BILLING_DESC,
      inputSchema: {
        lon: num(-180, 180).describe("경도 (WGS84)"),
        lat: num(-90, 90).describe("위도 (WGS84)"),
      },
    },
    async ({ lon, lat }) => {
      try {
        if (lon === undefined || lat === undefined) {
          throw new naver.NaverMapsError("lon 과 lat 를 모두 주어야 합니다.", { kind: "파라미터" });
        }
        const 경고 = [];
        if (!inKorea(lon, lat) && inKorea(lat, lon)) {
          경고.push("경도·위도 순서가 뒤바뀐 것 같습니다 — lon=경도(124~132), lat=위도(33~39) 입니다.");
        }
        const r = await naver.reverseGeocode({ lon, lat });
        const res = r.results || [];
        if (!res.length) {
          return naverOk(
            {
              입력좌표: { 경도: lon, 위도: lat },
              결과: "주소 없음",
              사유: (r.status && r.status.message) || null,
              안내: "바다·산간 등 주소가 없는 좌표이거나 국외 좌표입니다. 경도·위도 순서도 확인하세요.",
              ...(경고.length ? { 경고 } : {}),
            },
            r._calls
          );
        }
        const by = Object.fromEntries(res.map((v) => [v.name, v]));
        const areaName = (v) =>
          v && v.region
            ? ["area1", "area2", "area3", "area4"]
                .map((k) => v.region[k] && v.region[k].name)
                .filter(Boolean)
                .join(" ")
            : null;
        const legal = by.legalcode;
        const adm = by.admcode;
        const legalCd = legal && legal.code ? legal.code.id : null;
        const admCd = adm && adm.code ? adm.code.id : null;

        let 지번주소 = null;
        if (by.addr && by.addr.land) {
          const l = by.addr.land;
          const san = l.type === "2" ? "산 " : "";
          const no = l.number1 ? `${san}${l.number1}${l.number2 ? `-${l.number2}` : ""}` : "";
          지번주소 = [areaName(by.addr), no].filter(Boolean).join(" ");
        }
        let 도로명주소 = null;
        let 건물명 = null;
        let 우편번호 = null;
        if (by.roadaddr && by.roadaddr.land) {
          const l = by.roadaddr.land;
          const no = l.number1 ? `${l.number1}${l.number2 ? `-${l.number2}` : ""}` : "";
          // 도로명주소는 시도·시군구 + 도로명 + 건물번호 (읍면은 붙이지만 동은 붙이지 않는다)
          const r1 = by.roadaddr.region || {};
          const a3 = r1.area3 && r1.area3.name;
          const head = [r1.area1 && r1.area1.name, r1.area2 && r1.area2.name, a3 && /[읍면]$/.test(a3) ? a3 : null]
            .filter(Boolean)
            .join(" ");
          도로명주소 = [head, l.name, no].filter(Boolean).join(" ");
          const adds = [l.addition0, l.addition1, l.addition2, l.addition3, l.addition4].filter(Boolean);
          건물명 = (adds.find((x) => x.type === "building") || {}).value || null;
          우편번호 = (adds.find((x) => x.type === "zipcode") || {}).value || null;
        }

        return naverOk(
          {
            입력좌표: { 경도: lon, 위도: lat },
            법정동: legalCd
              ? {
                  코드: legalCd,
                  이름: areaName(legal),
                  "시군구코드(소상공인 signguCd)": legalCd.slice(0, 5),
                  "시도코드(소상공인 ctprvnCd)": legalCd.slice(0, 2),
                }
              : null,
            행정동: admCd
              ? {
                  코드: admCd,
                  "행정동코드8자리(소상공인 adongCd)": admCd.slice(0, 8),
                  이름: areaName(adm),
                }
              : null,
            지번주소,
            도로명주소,
            건물명,
            우편번호,
            ...(경고.length ? { 경고 } : {}),
            안내: [
              "행정동코드8자리는 행정동 10자리 코드의 앞 8자리로, 소상공인 상가정보의 행정동코드와 같은 체계입니다 " +
                "(실측: 역삼동 819-2 → 11680640, stores_nearby 응답 점포의 행정동코드와 일치). " +
                "SGIS adm_cd(예: 역삼1동 11230640)와는 다른 체계라 region_demographics 에 넣으면 안 됩니다.",
              "행정구역 경계 부근에서는 지오코딩의 지번주소와 같은 좌표의 역지오코딩 법정동이 다를 수 있습니다 " +
                "(실측: 테헤란로 340 지오코딩은 '삼성동 172-66', 같은 좌표 역지오코딩 법정동은 '역삼동').",
            ],
          },
          r._calls
        );
      } catch (e) {
        return naverFail(e);
      }
    }
  );

  // 지점 입력 해석 — "경도,위도" 좌표면 그대로, 아니면 주소로 보고 지오코딩한다.
  const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
  async function resolvePoint(input, label, counter) {
    const s = String(input || "").trim();
    if (!s) throw new naver.NaverMapsError(`${label} 가 비어 있습니다.`, { kind: "파라미터" });
    const m = s.match(COORD_RE);
    if (m) {
      let lon = Number(m[1]);
      let lat = Number(m[2]);
      const out = { 구분: label, 입력: s, 해석방법: "좌표 입력" };
      if (!inKorea(lon, lat) && inKorea(lat, lon)) {
        [lon, lat] = [lat, lon];
        out.경고 = "위도,경도 순서로 보여 경도,위도로 바꿔 썼습니다.";
      } else if (!inKorea(lon, lat)) {
        out.경고 = "대한민국 범위 밖 좌표입니다 — 길찾기가 실패할 수 있습니다.";
      }
      return { ...out, 경도: lon, 위도: lat };
    }
    let g;
    try {
      g = await naver.geocode({ query: s, count: 5 });
    } catch (e) {
      counter.calls += (e && e.calls) || 0;
      throw e;
    }
    counter.calls += g._calls;
    const list = (g.addresses || []).map((a) => slimNaverAddress(a, false));
    if (!list.length) {
      throw new naver.NaverMapsError(
        `${label} '${s}' 를 주소로 찾지 못했습니다(지오코딩 0건). 네이버 지오코딩은 주소 전용이라 역·상호 같은 장소명은 찾지 못합니다 — ` +
          "도로명+건물번호, 지번, 또는 '경도,위도' 좌표로 다시 주세요.",
        { kind: "파라미터" }
      );
    }
    const top = list[0];
    const out = {
      구분: label,
      입력: s,
      해석방법: "지오코딩",
      해석주소: top.도로명주소 || top.지번주소,
      지점단위매칭: top.지점단위매칭,
      매칭수준: top.매칭수준,
      후보수: (g.meta && g.meta.totalCount) || list.length,
      경도: top.경도,
      위도: top.위도,
    };
    const warn = [];
    if (out.후보수 > 1) warn.push(`후보 ${out.후보수}개 중 첫 번째를 썼습니다 — 의도와 다르면 시도·시군구를 붙이거나 좌표로 주세요.`);
    if (!top.지점단위매칭) warn.push(`건물이 아니라 ${top.매칭수준} 대표점으로 길찾기했습니다.`);
    if (warn.length) out.경고 = warn.join(" ");
    return out;
  }

  server.registerTool(
    "naver_directions",
    {
      title: "네이버 자동차 길찾기 (거리·소요시간·통행료)",
      description:
        "네이버 지도 Directions 로 출발지→(경유지)→도착지 자동차 경로의 거리(km)·소요시간(분)·통행료·택시요금·유류비(원)를 구한다. " +
        "지점은 '경도,위도' 좌표 또는 주소로 줄 수 있고, 주소는 먼저 지오코딩해 무엇으로 해석했는지 함께 돌려준다(지오코딩도 별도 과금 호출). " +
        "경유지 0~5개는 Directions 5, 6~15개는 Directions 15 엔진을 자동으로 고른다(실측: 각각 5·15개 초과 시 400). " +
        "소요시간은 조회 시각의 실시간 교통 기준이다. 경로 좌표는 기본으로 빼고 includePath=true 일 때만 솎아서 준다. " +
        "Directions 15 는 Directions 5 와 별도 상품이고 대표 계정 무료 이용량도 더 작다." +
        BILLING_DESC,
      inputSchema: {
        start: z.string().describe("출발지 — '경도,위도' (예: 127.0283079,37.4981647) 또는 주소"),
        goal: z.string().describe("도착지 — '경도,위도' 또는 주소"),
        waypoints: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe("경유지(최대 15) — 배열 또는 '|' 로 구분한 문자열. 각 항목은 '경도,위도' 또는 주소"),
        option: z
          .string()
          .default("traoptimal")
          .describe(
            `경로 옵션. 쉼표로 여러 개를 주면 한 번의 호출로 비교한다. ` +
              Object.entries(naver.DIRECTION_OPTIONS)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")
          ),
        cartype: num(1, 6).describe("차종(통행료 계산용) 1=소형 승용·승합(기본) ~ 6=경형. 생략하면 1"),
        fueltype: z.enum(["gasoline", "highgradegasoline", "diesel", "lpg"]).optional().describe("유종(유류비 계산용)"),
        includePath: bool(false).describe("true 면 경로 좌표를 솎아서 함께 준다(기본 false — 원본은 수백~수천 점)"),
        pathMaxPoints: num(2, 2000, 200).describe("includePath=true 일 때 남길 최대 좌표 수"),
      },
    },
    async ({ start, goal, waypoints, option, cartype, fueltype, includePath, pathMaxPoints }) => {
      const counter = { calls: 0 };
      try {
        let wps = [];
        if (Array.isArray(waypoints)) wps = waypoints;
        else if (typeof waypoints === "string" && waypoints.trim()) {
          const t = waypoints.trim();
          if (t.startsWith("[")) {
            try {
              wps = JSON.parse(t);
            } catch (_) {
              throw new naver.NaverMapsError("waypoints 를 JSON 배열로 읽지 못했습니다.", { kind: "파라미터" });
            }
          } else wps = t.split("|");
        }
        wps = wps.map((v) => String(v).trim()).filter(Boolean);
        const engine = naver.pickDirectionEngine(wps.length);
        if (!engine) {
          throw new naver.NaverMapsError(`경유지는 최대 15개입니다(받은 개수 ${wps.length}).`, { kind: "파라미터" });
        }
        const opts = String(option || "traoptimal")
          .split(/[,:\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const bad = opts.filter((o) => !naver.DIRECTION_OPTIONS[o]);
        if (bad.length) {
          throw new naver.NaverMapsError(
            `알 수 없는 option: ${bad.join(", ")}. 사용 가능: ${Object.keys(naver.DIRECTION_OPTIONS).join(", ")}`,
            { kind: "파라미터" }
          );
        }

        // 지점 해석(주소면 지오코딩). 순서대로 불러 호출 수를 정확히 센다.
        const s = await resolvePoint(start, "출발지", counter);
        const w = [];
        for (let i = 0; i < wps.length; i++) w.push(await resolvePoint(wps[i], `경유지${i + 1}`, counter));
        const gl = await resolvePoint(goal, "도착지", counter);

        const pt = (p) => `${p.경도},${p.위도}`;
        let d;
        try {
          d = await naver.directions({
            start: pt(s),
            goal: pt(gl),
            waypoints: w.map(pt),
            option: opts.join(":"),
            cartype,
            fueltype,
          });
        } catch (e) {
          counter.calls += (e && e.calls) || 0;
          throw e;
        }
        counter.calls += d._calls;

        const 경로 = opts.map((o) => {
          const r0 = d.route && d.route[o] && d.route[o][0];
          if (!r0) return { 옵션: o, 옵션설명: naver.DIRECTION_OPTIONS[o], 결과: "이 옵션의 경로가 응답에 없습니다" };
          const sm = r0.summary || {};
          const row = {
            옵션: o,
            옵션설명: naver.DIRECTION_OPTIONS[o],
            총거리km: km(sm.distance),
            소요시간분: minutes(sm.duration),
            소요시간: hhmm(sm.duration),
            통행료원: sm.tollFare ?? null,
            택시요금원: sm.taxiFare ?? null,
            유류비원: sm.fuelPrice ?? null,
            교통기준시각: sm.departureTime || null,
          };
          // 경유지가 있으면 구간별 거리·시간 (각 경유지/도착지의 distance·duration 은 직전 지점부터의 구간 값)
          if (Array.isArray(sm.waypoints) && sm.waypoints.length) {
            const names = ["출발지", ...w.map((p) => p.구분), "도착지"];
            const legs = [...sm.waypoints, sm.goal || {}];
            row.구간별 = legs.map((v, i) => ({
              구간: `${names[i]} → ${names[i + 1]}`,
              거리km: km(v.distance),
              소요시간분: minutes(v.duration),
            }));
          }
          if (includePath) {
            const p = r0.path || [];
            row.경로좌표 = {
              원본점수: p.length,
              반환점수: Math.min(p.length, pathMaxPoints),
              형식: "[경도, 위도] 배열",
              좌표: downsamplePath(p, pathMaxPoints),
            };
          }
          return row;
        });

        const first = d.route && d.route[opts[0]] && d.route[opts[0]][0];
        const fs = (first && first.summary) || {};
        return naverOk(
          {
            엔진: d._engine,
            엔진선택: `경유지 ${wps.length}개 → ${d._engine} (0~5개는 Directions 5, 6~15개는 Directions 15)`,
            지점해석: { 출발지: s, ...(w.length ? { 경유지: w } : {}), 도착지: gl },
            도로보정좌표: {
              출발지: fs.start && fs.start.location ? fs.start.location : null,
              도착지: fs.goal && fs.goal.location ? fs.goal.location : null,
              설명: "네이버가 경로 계산에 쓴 도로 위 좌표 [경도, 위도]",
            },
            단위: "거리 km, 시간 분, 요금 원",
            경로,
            안내: [
              "소요시간은 조회 시각의 실시간 교통 기준이라 시각에 따라 달라집니다.",
              "택시요금·유류비는 네이버의 추정치입니다. 통행료는 cartype(기본 1=소형) 기준입니다.",
            ],
          },
          counter.calls
        );
      } catch (e) {
        // 지오코딩·길찾기 호출을 모두 합친 수로 덮어쓴다.
        if (e && typeof e === "object") e.calls = counter.calls;
        return naverFail(e);
      }
    }
  );

  // 정적 지도 마커 — 실측(2026-10-08): type:n 은 한 자리 숫자 라벨만 그려지고('12'·'A' 는 라벨 없이 그려짐),
  // type:t 는 임의 텍스트 라벨, type:d 는 기본 핀. size 는 tiny|small|mid (large·big 은 403).
  const markerSchema = z.object({
    lon: z.coerce.number().min(-180).max(180),
    lat: z.coerce.number().min(-90).max(90),
    label: z.string().optional(),
    color: z.string().optional(),
    size: z.enum(["tiny", "small", "mid"]).optional(),
  });

  function parseMarkers(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    let arr = raw;
    if (typeof raw === "string") {
      const t = raw.trim();
      if (t.startsWith("[") || t.startsWith("{")) {
        try {
          arr = JSON.parse(t);
        } catch (_) {
          throw new naver.NaverMapsError("markers 를 JSON 으로 읽지 못했습니다.", { kind: "파라미터" });
        }
        if (!Array.isArray(arr)) arr = [arr];
      } else {
        // "경도,위도[,라벨]" 을 ';' 또는 줄바꿈으로 구분
        arr = t
          .split(/[;\n]+/)
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => {
            const [lon, lat, ...rest] = x.split(",").map((y) => y.trim());
            return { lon, lat, ...(rest.length ? { label: rest.join(",") } : {}) };
          });
      }
    }
    return arr.map((m, i) => {
      const p = markerSchema.safeParse(m);
      if (!p.success) {
        throw new naver.NaverMapsError(
          `markers[${i}] 형식 오류 — {lon, lat, label?, color?, size?(tiny|small|mid)} 이어야 합니다.`,
          { kind: "파라미터" }
        );
      }
      return p.data;
    });
  }

  function markerParam(m) {
    // 마커 문법의 구분자('|')가 라벨에 섞이면 요청이 깨지므로 지운다.
    const label = m.label !== undefined ? String(m.label).replace(/\|/g, " ").trim() : "";
    const type = !label ? "d" : /^\d$/.test(label) ? "n" : "t";
    const parts = [`type:${type}`, `size:${m.size || "mid"}`];
    if (m.color) {
      const c = String(m.color).trim();
      if (!/^([A-Za-z]+|0x[0-9A-Fa-f]{6})$/.test(c)) {
        throw new naver.NaverMapsError(`마커 색상 형식 오류: ${c} — red 같은 이름이나 0xRRGGBB 로 주세요.`, {
          kind: "파라미터",
        });
      }
      parts.push(`color:${c}`);
    }
    parts.push(`pos:${m.lon} ${m.lat}`);
    if (label) parts.push(`label:${label}`);
    return { type, param: parts.join("|") };
  }

  server.registerTool(
    "naver_static_map",
    {
      title: "네이버 정적 지도 이미지",
      description:
        "네이버 지도 Static Map 으로 지도 이미지를 만들어 MCP 이미지로 돌려준다. center_lon/center_lat + level 로 범위를 정하거나, " +
        "center 없이 markers 만 주면 마커가 모두 보이게 자동으로 맞춘다. 마커는 여러 개 가능하며 " +
        "라벨이 한 자리 숫자면 번호 핀, 그 밖의 글자면 말풍선 라벨, 없으면 기본 핀으로 그린다. " +
        "크기는 기본 600×400, 도구 상한 1024×1024(scale=2 면 실제 픽셀은 두 배)." +
        BILLING_DESC,
      inputSchema: {
        center_lon: num(-180, 180).describe("중심 경도 (WGS84)"),
        center_lat: num(-90, 90).describe("중심 위도 (WGS84)"),
        level: num(0, 21).describe("확대 레벨 0~21 (16 ≈ 골목 단위, 14 ≈ 동 단위). center 를 주고 생략하면 16"),
        width: num(1, 1024, 600).describe("이미지 너비(px), 최대 1024"),
        height: num(1, 1024, 400).describe("이미지 높이(px), 최대 1024"),
        scale: z.coerce
          .number()
          .refine((v) => v === 1 || v === 2, "scale 은 1 또는 2")
          .default(1)
          .describe("1 또는 2 (2 면 고해상도 — 픽셀 수가 두 배)"),
        maptype: z
          .enum(["basic", "traffic", "satellite", "satellite_base", "terrain"])
          .default("basic")
          .describe("지도 종류"),
        format: z.enum(["jpg", "png", "png8"]).default("jpg").describe("이미지 형식 (기본 jpg — 가장 작다)"),
        lang: z.enum(["ko", "en", "ja", "zh"]).optional().describe("지도 라벨 언어"),
        markers: z
          .union([z.array(markerSchema), z.string()])
          .optional()
          .describe(
            "마커 목록 — [{lon, lat, label?, color?, size?}] 배열, 또는 '경도,위도[,라벨]' 을 ';' 로 구분한 문자열. " +
              "color 는 red 같은 이름이나 0xRRGGBB, size 는 tiny|small|mid"
          ),
      },
    },
    async ({ center_lon, center_lat, level, width, height, scale, maptype, format, lang, markers }) => {
      try {
        if ((center_lon === undefined) !== (center_lat === undefined)) {
          throw new naver.NaverMapsError("center_lon 과 center_lat 는 함께 주어야 합니다.", { kind: "파라미터" });
        }
        const ms = parseMarkers(markers);
        const hasCenter = center_lon !== undefined;
        if (!hasCenter && !ms.length) {
          throw new naver.NaverMapsError(
            "center_lon/center_lat 또는 markers 중 하나는 있어야 합니다(둘 다 없으면 네이버가 403 을 돌려줍니다).",
            { kind: "파라미터" }
          );
        }
        const 경고 = [];
        if (hasCenter && !inKorea(center_lon, center_lat)) {
          경고.push(
            inKorea(center_lat, center_lon)
              ? "중심 좌표의 경도·위도 순서가 뒤바뀐 것 같습니다."
              : "중심이 대한민국 범위 밖입니다 — 실측상 이런 좌표는 오류 없이 빈 바다 이미지가 옵니다."
          );
        }
        const mp = ms.map(markerParam);
        const lv = level !== undefined ? level : hasCenter ? 16 : undefined;
        const img = await naver.staticMap({
          w: width,
          h: height,
          center: hasCenter ? `${center_lon},${center_lat}` : undefined,
          level: lv,
          scale: scale === 2 ? 2 : undefined,
          maptype,
          format,
          lang,
          markers: mp.map((m) => m.param),
        });
        const meta = {
          지도: {
            중심: hasCenter ? { 경도: center_lon, 위도: center_lat } : "마커에 맞춰 자동",
            level: lv ?? "자동",
            요청크기: `${width}×${height}${scale === 2 ? " (scale=2)" : ""}`,
            실제픽셀: img.width && img.height ? `${img.width}×${img.height}` : null,
            maptype,
            형식: img.mimeType,
            바이트: img.bytes,
          },
          마커: ms.map((m, i) => ({ 경도: m.lon, 위도: m.lat, 라벨: m.label ?? null, 표시형식: mp[i].type })),
          ...(경고.length ? { 경고 } : {}),
          과금안내: naver.billingNotice(img._calls),
        };
        return {
          content: [
            { type: "text", text: JSON.stringify(meta, null, 2) },
            { type: "image", data: img.buf.toString("base64"), mimeType: img.mimeType },
          ],
        };
      } catch (e) {
        return naverFail(e);
      }
    }
  );

  return server;
}
