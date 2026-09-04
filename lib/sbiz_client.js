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
