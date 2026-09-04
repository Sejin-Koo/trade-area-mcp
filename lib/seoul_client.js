// 서울 열린데이터광장 — 서울시 상권분석서비스 (제공기관 서울신용보증재단)
//   Base: http://openapi.seoul.go.kr:8088/{인증키}/{json|xml}/{서비스명}/{시작}/{끝}/{추가인자...}
//   인증: 열린데이터광장 개인 인증키 (SEOUL_OPENAPI_KEY)
//
// ★ 전국 소스에는 없는 "추정매출"과 "유동인구"가 여기에만 있다.
//   요일별·시간대별·성별·연령대별 매출까지 분해되어 있어 상권분석의 핵심 축이다.
//   단, 서울시 한정이고 2021년 이후 분기 자료만 제공된다(2026-07-03 축소).
//
// ★ 실측 제약 (2026-09-04)
//   - 1회 요청 최대 1,000행. 1,001을 요청하면 ERROR-336.
//   - 최신 기준년분기: 20254 (2025년 4분기)
//   - 서비스명은 대소문자를 구분한다.
//   - 추가 인자는 경로 세그먼트로 붙는다. 비워야 할 자리에는 %20 을 넣는다.

import { fetchJson, toArray } from "./http.js";

const BASE = "http://openapi.seoul.go.kr:8088";

export const SEOUL_MAX_ROWS = 1000;

/** 2026-09-04 실호출로 동작을 확인한 서비스만 등록한다. */
export const SEOUL_SERVICES = {
  추정매출: { svc: "VwsmTrdarSelngQq", desc: "상권별 분기 추정매출 (요일·시간대·성별·연령대 분해)" },
  유동인구: { svc: "VwsmTrdarFlpopQq", desc: "상권별 길단위인구(유동인구)" },
  점포: { svc: "VwsmTrdarStorQq", desc: "상권별 업종 점포수·개업·폐업" },
  상주인구: { svc: "VwsmTrdarRepopQq", desc: "상권별 상주인구" },
  직장인구: { svc: "VwsmTrdarWrcPopltnQq", desc: "상권별 직장인구" },
  집객시설: { svc: "VwsmTrdarFcltyQq", desc: "상권별 집객시설(관공서·학교·교통시설 등)" },
  상권영역: { svc: "TbgisTrdarRelm", desc: "상권 코드·명칭·구분(골목/발달/전통시장/관광특구)" },
  행정동추정매출: { svc: "VwsmAdstrdSelngW", desc: "행정동별 추정매출" },
};

export const SEOUL_SERVICE_NAMES = Object.keys(SEOUL_SERVICES);

function key() {
  const k = process.env.SEOUL_OPENAPI_KEY;
  if (!k) throw new Error("환경변수 SEOUL_OPENAPI_KEY 가 설정되어 있지 않습니다.");
  return k;
}

/**
 * @param {string} name  SEOUL_SERVICE_NAMES 중 하나
 * @param {object} o
 * @param {number} o.start 시작 인덱스 (1부터)
 * @param {number} o.end   끝 인덱스 (start+999 이하)
 * @param {string[]} [o.extra] 경로에 덧붙일 추가 인자 (예: ["20254"] = 기준년분기코드)
 */
export async function callSeoul(name, { start = 1, end = 100, extra = [] } = {}) {
  const meta = SEOUL_SERVICES[name];
  if (!meta) {
    throw new Error(`지원하지 않는 서비스입니다: ${name}\n사용 가능: ${SEOUL_SERVICE_NAMES.join(", ")}`);
  }
  const s = Math.max(1, Number(start) || 1);
  let e = Number(end) || s + 99;
  if (e - s + 1 > SEOUL_MAX_ROWS) e = s + SEOUL_MAX_ROWS - 1;

  const segs = extra.map((v) => (v === null || v === undefined || v === "" ? "%20" : encodeURIComponent(v)));
  const url = `${BASE}/${key()}/json/${meta.svc}/${s}/${e}/${segs.length ? segs.join("/") + "/" : ""}`;

  const json = await fetchJson(url);
  const root = json[meta.svc];
  if (!root) {
    const err = json.RESULT || {};
    throw new Error(`서울 열린데이터광장 오류 ${err.CODE || "?"} — ${err.MESSAGE || JSON.stringify(json).slice(0, 200)}`);
  }
  const code = root.RESULT && root.RESULT.CODE;
  if (code && code !== "INFO-000") {
    if (code === "INFO-200") return { service: meta.svc, rows: [], totalCount: 0, empty: true };
    throw new Error(`서울 열린데이터광장 오류 ${code} — ${root.RESULT.MESSAGE || ""}`);
  }
  const rows = toArray(root.row);
  const totalCount = Number(root.list_total_count || rows.length);
  return {
    service: meta.svc,
    설명: meta.desc,
    rows,
    totalCount,
    returned: rows.length,
    truncated: totalCount > e,
  };
}

/** 상권명으로 상권코드를 찾는다 (TbgisTrdarRelm 전량을 훑어 이름 부분일치) */
export async function findTradeAreas(keyword, { limit = 30 } = {}) {
  const out = [];
  let start = 1;
  const first = await callSeoul("상권영역", { start: 1, end: 1 });
  const total = first.totalCount;
  while (start <= total && out.length < limit) {
    const end = Math.min(start + SEOUL_MAX_ROWS - 1, total);
    const r = await callSeoul("상권영역", { start, end });
    for (const row of r.rows) {
      const nm = row.TRDAR_CD_NM || row.TRDAR_NM || "";
      if (!keyword || nm.includes(keyword)) {
        out.push({
          상권코드: row.TRDAR_CD,
          상권명: nm,
          상권구분: row.TRDAR_SE_CD_NM || row.TRDAR_SE_CD,
          자치구: row.SIGNGU_CD_NM || null,
          행정동: row.ADSTRD_CD_NM || null,
          면적: row.RELM_AR ? Number(row.RELM_AR) : null,
        });
        if (out.length >= limit) break;
      }
    }
    start = end + 1;
    if (start > total) break;
  }
  return { 검색어: keyword || "(전체)", 전체상권수: total, 결과수: out.length, 상권목록: out };
}

/** 특정 상권코드의 지표를 한 서비스에서 뽑는다 (기준년분기 필터 + 상권코드 매칭) */
export async function tradeAreaSeries(name, { trdarCd, quarter, maxScan = 20000 } = {}) {
  const hits = [];
  let start = 1;
  const first = await callSeoul(name, { start: 1, end: 1, extra: quarter ? [quarter] : [] });
  const total = first.totalCount;
  const cap = Math.min(total, maxScan);
  while (start <= cap) {
    const end = Math.min(start + SEOUL_MAX_ROWS - 1, cap);
    const r = await callSeoul(name, { start, end, extra: quarter ? [quarter] : [] });
    for (const row of r.rows) {
      if (!trdarCd || String(row.TRDAR_CD) === String(trdarCd)) hits.push(row);
    }
    start = end + 1;
  }
  return { service: name, 전체건수: total, 스캔건수: cap, 매칭건수: hits.length, rows: hits, 스캔상한도달: total > cap };
}
