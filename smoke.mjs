// 실제 인증키로 각 클라이언트를 호출하는 스모크 테스트.
//   node smoke.mjs
// 환경변수: DATA_PORTAL_KEY, SGIS_SERVICE_ID, SGIS_SECURITY_KEY, SEOUL_OPENAPI_KEY

import * as sbiz from "./lib/sbiz_client.js";
import * as permit from "./lib/permit_client.js";
import * as sgis from "./lib/sgis_client.js";
import * as seoul from "./lib/seoul_client.js";
import { permitCoordToWgs84, transform, haversine } from "./lib/geo.js";

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, out });
    console.log(`✅ ${name} (${Date.now() - t0}ms)`);
    console.log("   ", JSON.stringify(out).slice(0, 400));
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, err: e.message });
    console.log(`❌ ${name} — ${e.message}`);
  }
}

// 영등포역 좌표
const LON = 126.9074;
const LAT = 37.5154;

await step("geo: EPSG:5174 → WGS84 (금천구 시흥대로 291 실측 대조)", async () => {
  const c = permitCoordToWgs84("190838.324818618", "439761.362000391");
  // 소상공인 상가정보가 같은 건물에 부여한 좌표
  const truth = { lon: 126.897211052232, lat: 37.4600484884486 };
  return { 변환결과: c, 대조: truth, 오차m: haversine(c.lon, c.lat, truth.lon, truth.lat) };
});

await step("geo: WGS84 → EPSG:5181", async () => transform(LON, LAT, "EPSG:4326", "EPSG:5181"));

await step("sbiz: 반경 300m 점포", async () => {
  const r = await sbiz.storeListInRadius({ lon: LON, lat: LAT, radius: 300, numOfRows: 1000 });
  return {
    기준월: r.stdrYm,
    전체: r.totalCount,
    반환: r.items.length,
    상위업종: sbiz.aggregateByIndustry(r.items, "middle").slice(0, 5),
  };
});

await step("sbiz: numOfRows 상한 실측(1000 요청)", async () => {
  const r = await sbiz.storeListInRadius({ lon: LON, lat: LAT, radius: 1000, numOfRows: 1000 });
  return { 요청: 1000, 반환: r.items.length, 응답numOfRows: r.numOfRows, 전체: r.totalCount };
});

await step("sbiz: 업종 대분류 코드", async () => {
  const r = await sbiz.largeUpjongList();
  return { 건수: r.items.length, 예시: r.items.slice(0, 3) };
});

await step("permit: 영등포구 일반음식점 건수", async () => {
  const r = await permit.fetchPermits({ type: "일반음식점", addrLike: "영등포구", numOfRows: 1 });
  return { 총건수: r.totalCount };
});

await step("permit: 영등포구 일반음식점 2026년 개업 영업중", async () => {
  const r = await permit.fetchPermits({
    type: "일반음식점", addrLike: "영등포구", salesStatus: "01", licenseFrom: "2026-01-01", numOfRows: 3,
  });
  return { 총건수: r.totalCount, 표본: r.items.slice(0, 2).map(permit.slimPermit) };
});

await step("permit: numOfRows 상한 실측(1000 요청 → 100 기대)", async () => {
  const r = await permit.fetchPermits({ type: "일반음식점", addrLike: "영등포구", numOfRows: 1000 });
  return { 요청: 1000, 반환: r.items.length, 응답numOfRows: r.numOfRows };
});

await step("permit: 20개 업종 경로 전수 확인 (각 1건 조회)", async () => {
  const bad = [];
  const okList = [];
  for (const t of permit.PERMIT_TYPE_NAMES) {
    try {
      const r = await permit.fetchPermits({ type: t, addrLike: "영등포구", numOfRows: 1 });
      okList.push(`${t}:${r.totalCount}`);
    } catch (e) {
      bad.push(`${t} → ${e.message.slice(0, 80)}`);
    }
  }
  return { 정상: okList, 실패: bad };
});

await step("sgis: 토큰 발급", async () => ({ token: (await sgis.getAccessToken()).slice(0, 8) + "…" }));

await step("sgis: 영등포구 총조사 주요지표", async () => {
  const r = await sgis.censusIndicators({ year: 2024, adm_cd: "11190", low_search: 0 });
  const v = r.result[0];
  return { 지역: v.adm_nm, 총인구: v.tot_ppltn, 총가구: v.tot_family, 사업체수: v.corp_cnt };
});

await step("sgis: 영등포구 카페 사업체", async () => {
  const r = await sgis.companyStats({ year: 2024, adm_cd: "11190", low_search: 0, theme_cd: sgis.THEME_CODES["카페"] });
  return r.result[0];
});

await step("sgis: 행정구역 단계 조회(서울 하위)", async () => {
  const r = await sgis.addrStage("11");
  return { 건수: r.result.length, 예시: r.result.slice(0, 3).map((v) => `${v.cd}:${v.addr_name}`) };
});

await step("seoul: 상권 검색 '영등포'", async () => {
  const r = await seoul.findTradeAreas("영등포", { limit: 5 });
  return { 전체상권수: r.전체상권수, 결과: r.상권목록 };
});

await step("seoul: 추정매출 최신분기 1건", async () => {
  const r = await seoul.callSeoul("추정매출", { start: 1, end: 1, extra: ["20254"] });
  const row = r.rows[0] || {};
  return { 전체: r.totalCount, 분기: row.STDR_YYQU_CD, 상권: row.TRDAR_CD_NM, 업종: row.SVC_INDUTY_CD_NM, 매출: row.THSMON_SELNG_AMT };
});

await step("seoul: 1000행 상한 확인", async () => {
  const r = await seoul.callSeoul("유동인구", { start: 1, end: 1000 });
  return { 요청: 1000, 반환: r.returned, 전체: r.totalCount };
});

console.log("\n─────────── 요약 ───────────");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 통과`);
for (const r of results.filter((x) => !x.ok)) console.log(` - 실패: ${r.name} → ${r.err}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
