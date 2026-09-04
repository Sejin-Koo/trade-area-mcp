// 소상공인시장진흥공단 상가(상권)정보 API 클라이언트
//   Base: http://apis.data.go.kr/B553077/api/open/sdsc2
//   인증: 공공데이터포털 서비스키 (DATA_PORTAL_KEY)
//   좌표: WGS84 경위도 (lon/lat)
//
// 이 소스는 "전국 어디에 어떤 업종 점포가 있는가"를 가장 넓게 커버한다.
// 매출·유동인구는 없다(서울은 seoul_client, 배후인구는 sgis_client 참조).

import { fetchJson, qs, toArray } from "./http.js";

const BASE = "http://apis.data.go.kr/B553077/api/open/sdsc2";

// ★ 실측(2026-09-04): 반경 조회에서 numOfRows=1000 을 주면 그대로 1000건이 온다.
//   다만 공공데이터포털 계열은 상한을 넘겨도 조용히 잘리는 API가 흔하므로(man-public-data),
//   응답의 numOfRows/totalCount 를 항상 되읽어 truncated 표시를 만든다.
const MAX_ROWS = 1000;

function key() {
  const k = process.env.DATA_PORTAL_KEY || process.env.PUBLIC_DATA_PORTAL_KEY;
  if (!k) throw new Error("환경변수 DATA_PORTAL_KEY 가 설정되어 있지 않습니다.");
  return k;
}

async function call(op, params) {
  const url = `${BASE}/${op}?${qs({ serviceKey: key(), type: "json", ...params })}`;
  const json = await fetchJson(url);
  const header = json.header || (json.response && json.response.header) || {};
  const body = json.body || (json.response && json.response.body) || {};
  const code = String(header.resultCode ?? "");
  if (code && code !== "00") {
    if (code === "03" || header.resultMsg === "NODATA_ERROR") {
      return { items: [], totalCount: 0, numOfRows: 0, pageNo: params.pageNo || 1, stdrYm: header.stdrYm || null, noData: true };
    }
    throw new Error(`상가정보 API 오류 ${code} — ${header.resultMsg || ""}`);
  }
  return {
    items: toArray(body.items),
    totalCount: Number(body.totalCount || 0),
    numOfRows: Number(body.numOfRows || 0),
    pageNo: Number(body.pageNo || params.pageNo || 1),
    stdrYm: header.stdrYm || null,
    noData: false,
  };
}

/** 반경 내 상가업소 */
export function storeListInRadius({ lon, lat, radius, indsLclsCd, indsMclsCd, indsSclsCd, numOfRows = 100, pageNo = 1 }) {
  return call("storeListInRadius", {
    cx: lon,
    cy: lat,
    radius,
    indsLclsCd,
    indsMclsCd,
    indsSclsCd,
    numOfRows: Math.min(numOfRows, MAX_ROWS),
    pageNo,
  });
}

/** 사각형(범위) 내 상가업소 */
export function storeListInRectangle({ minx, miny, maxx, maxy, indsLclsCd, indsMclsCd, indsSclsCd, numOfRows = 100, pageNo = 1 }) {
  return call("storeListInRectangle", {
    minx, miny, maxx, maxy,
    indsLclsCd, indsMclsCd, indsSclsCd,
    numOfRows: Math.min(numOfRows, MAX_ROWS),
    pageNo,
  });
}

/** 행정동 단위 상가업소 (key = 행정동코드 10자리) */
export function storeListInDong({ adongCd, indsLclsCd, indsMclsCd, indsSclsCd, numOfRows = 100, pageNo = 1 }) {
  return call("storeListInDong", {
    divId: "adongCd",
    key: adongCd,
    indsLclsCd, indsMclsCd, indsSclsCd,
    numOfRows: Math.min(numOfRows, MAX_ROWS),
    pageNo,
  });
}

/** 업종 분류 코드 */
export const largeUpjongList = () => call("largeUpjongList", {});
export const middleUpjongList = (indsLclsCd) => call("middleUpjongList", { divId: "indsLclsCd", key: indsLclsCd });
export const smallUpjongList = (indsMclsCd) => call("smallUpjongList", { divId: "indsMclsCd", key: indsMclsCd });

/** 반경 내 상권 영역 */
export function storeZoneInRadius({ lon, lat, radius, numOfRows = 100, pageNo = 1 }) {
  return call("storeZoneInRadius", { cx: lon, cy: lat, radius, numOfRows: Math.min(numOfRows, MAX_ROWS), pageNo });
}

/** 응답 레코드를 보기 좋은 형태로 축약 */
export function slimStore(it) {
  return {
    상가업소번호: it.bizesId,
    상호명: it.bizesNm,
    지점명: it.brchNm || null,
    업종대분류: it.indsLclsNm,
    업종중분류: it.indsMclsNm,
    업종소분류: it.indsSclsNm,
    표준산업분류: it.ksicNm || null,
    시도: it.ctprvnNm,
    시군구: it.signguNm,
    행정동: it.adongNm,
    행정동코드: it.adongCd,
    도로명주소: it.rdnmAdr,
    지번주소: it.lnoAdr,
    건물명: it.bldNm || null,
    층: it.flrNo || null,
    경도: it.lon ? Number(it.lon) : null,
    위도: it.lat ? Number(it.lat) : null,
  };
}

/** 점포 목록을 업종 분류별로 집계 */
// ── 집계용 전량 수집 ────────────────────────────────────────────────────────
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

/**
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
}

export function aggregateByIndustry(items, level = "middle") {
  const nameKey = level === "large" ? "indsLclsNm" : level === "small" ? "indsSclsNm" : "indsMclsNm";
  const codeKey = level === "large" ? "indsLclsCd" : level === "small" ? "indsSclsCd" : "indsMclsCd";
  const map = new Map();
  for (const it of items) {
    const nm = it[nameKey] || "(미분류)";
    const cd = it[codeKey] || "";
    const cur = map.get(nm) || { 업종: nm, 코드: cd, 점포수: 0 };
    cur.점포수 += 1;
    map.set(nm, cur);
  }
  return [...map.values()].sort((a, b) => b.점포수 - a.점포수);
}

export { MAX_ROWS as SBIZ_MAX_ROWS };
