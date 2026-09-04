// 행정안전부 지방행정 인허가 데이터 API 클라이언트 (상권분석 관련 20종)
//   Base: https://apis.data.go.kr/1741000/<업종경로>/{info|history}
//   인증: 공공데이터포털 서비스키 (DATA_PORTAL_KEY)
//
// ★ 배경 (2026-01-25 행정안전부 보도자료)
//   기존 '지방행정 인허가데이터 개방 포털(localdata.go.kr)'은 2026-04-15 병행운영을 끝으로
//   종료됐고, 인허가 195종 + 생활편의 14종이 공공데이터포털로 통합 개방됐다.
//   이때 인허가 195종은 과거 이력(history) 조회가 신규 제공되기 시작했다.
//
// ★ 필터 문법 — cond[필드::연산자] (2026-09-04 실측)
//   문서 표면에는 serviceKey/pageNo/numOfRows/returnType 만 보이지만, 실제 스펙에는
//   아래 조건 파라미터가 있다. 이게 없으면 전국 전수를 페이징해야 하므로 반드시 쓴다.
//     cond[LOTNO_ADDR::LIKE]       지번주소 부분일치    ← 지역 필터의 기본값
//     cond[ROAD_NM_ADDR::LIKE]     도로명주소 부분일치  ← 폐업 이력에서 절반 이상 누락된다
//     cond[OPN_ATMY_GRP_CD::EQ]    개방자치단체코드 일치 ← 가장 정확
//
// ★★ 지역 필터는 반드시 지번주소로 걸 것 (2026-09-04 실측)
//   도로명주소는 2011년 도입이라 그 이전에 폐업한 업소에는 아예 값이 없다. 그래서
//   도로명주소로 지역을 좁히면 폐업 이력이 조용히 절반 넘게 사라진다.
//   영등포구 일반음식점 실측:
//     구분        지번주소LIKE   자치단체코드EQ   도로명주소LIKE
//     전체          28,287        28,301          15,738   (도로명이 44% 누락)
//     영업중         6,772         6,774           6,717   (거의 차이 없음)
//     폐업          21,515        21,527           9,021   (도로명이 58% 누락)
//   영업중만 보면 차이가 없어 보여서 더 위험하다 — 개·폐업 추이·생존율을 낼 때만
//   결과가 크게 틀어진다(폐업률 76% → 57%로 과소집계).
//     cond[SALS_STTS_CD::EQ]       영업상태코드 (01=영업/정상, 03=폐업 등)
//     cond[LCPMT_YMD::GTE|LT]      인허가일자 범위 (YYYY-MM-DD)
//     cond[DAT_UPDT_PNT::GTE|LT]   데이터 갱신시점 범위 (증분 동기화용)
//     cond[BPLC_NM::LIKE]          사업장명 부분일치
//     cond[BASE_DATE::EQ]          (history 전용) 데이터기준일자
//
// ★ numOfRows 상한은 100이고, 넘겨도 에러 없이 잘린다 (2026-09-04 실측)
//   1000을 요청하면 100건만 오고 응답의 numOfRows 자체가 100으로 바뀐다.
//   sys-mcp-server-dev 1-11에서 반복 사고가 났던 유형이라 상수로 못박는다.

import { fetchJson, qs, toArray } from "./http.js";
import { permitCoordToWgs84 } from "./geo.js";

const BASE = "https://apis.data.go.kr/1741000";

export const PERMIT_MAX_ROWS = 100;

/** 상권분석에 실제로 쓰는 20종 (2026-09-04 활용신청·승인 완료) */
export const PERMIT_TYPES = {
  일반음식점: { path: "general_restaurants", group: "외식" },
  휴게음식점: { path: "rest_cafes", group: "외식" },
  제과점: { path: "bakeries", group: "외식" },
  단란주점: { path: "singing_bars", group: "외식" },
  유흥주점: { path: "entertainment_bars", group: "외식" },
  즉석판매제조가공업: { path: "instant_food_processors", group: "외식" },
  미용업: { path: "beauty_salons", group: "생활서비스" },
  이용업: { path: "barber_shops", group: "생활서비스" },
  세탁업: { path: "laundries", group: "생활서비스" },
  목욕장업: { path: "public_baths", group: "생활서비스" },
  체력단련장: { path: "fitness_centers", group: "여가" },
  당구장: { path: "billiard_halls", group: "여가" },
  골프연습장: { path: "golf_practice_ranges", group: "여가" },
  노래연습장: { path: "karaoke_rooms", group: "여가" },
  PC방: { path: "pc_bangs", group: "여가" },
  대규모점포: { path: "large_scale_retail_stores", group: "소매·숙박" },
  담배소매업: { path: "tobacco_retailers", group: "소매·숙박" },
  숙박업: { path: "lodgings", group: "소매·숙박" },
  약국: { path: "pharmacies", group: "의료" },
  의원: { path: "clinics", group: "의료" },
};

export const PERMIT_TYPE_NAMES = Object.keys(PERMIT_TYPES);

/** 영업상태코드 — 실제 데이터에서 관측된 값 */
export const SALS_STTS = {
  "01": "영업/정상",
  "02": "휴업",
  "03": "폐업",
  "04": "취소/말소/만료",
  "05": "폐쇄",
};

function key() {
  const k = process.env.DATA_PORTAL_KEY || process.env.PUBLIC_DATA_PORTAL_KEY;
  if (!k) throw new Error("환경변수 DATA_PORTAL_KEY 가 설정되어 있지 않습니다.");
  return k;
}

function resolvePath(typeName) {
  const t = PERMIT_TYPES[typeName];
  if (!t) {
    throw new Error(
      `지원하지 않는 업종입니다: ${typeName}\n사용 가능: ${PERMIT_TYPE_NAMES.join(", ")}`
    );
  }
  return t.path;
}

/**
 * 인허가 데이터 조회.
 * @param {object} o
 * @param {string} o.type      업종명 (PERMIT_TYPE_NAMES 중 하나)
 * @param {string} [o.region]        지번주소 부분일치 (예: "영등포구) — 지역 필터의 기본값
 * @param {string} [o.addrLike]      도로명주소 부분일치 — 폐업 누락 주의
 * @param {string} [o.orgCode]       개방자치단체코드 (예: "3170000")
 * @param {string} [o.salesStatus]   영업상태코드 (예: "01")
 * @param {string} [o.licenseFrom]   인허가일자 이상 (YYYY-MM-DD)
 * @param {string} [o.licenseTo]     인허가일자 미만 (YYYY-MM-DD)
 * @param {string} [o.updatedFrom]   갱신시점 이상 (YYYY-MM-DD)
 * @param {string} [o.name]          사업장명 부분일치
 * @param {string} [o.baseDate]      history 전용 데이터기준일자
 */
export async function fetchPermits(o) {
  const {
    type, region, addrLike, orgCode, salesStatus, licenseFrom, licenseTo,
    updatedFrom, updatedTo, name, baseDate,
    numOfRows = PERMIT_MAX_ROWS, pageNo = 1, history = false,
  } = o;

  const path = resolvePath(type);
  const op = history ? "history" : "info";

  const params = {
    serviceKey: key(),
    returnType: "json",
    pageNo,
    numOfRows: Math.min(Number(numOfRows) || PERMIT_MAX_ROWS, PERMIT_MAX_ROWS),
  };
  const cond = {
    "cond[LOTNO_ADDR::LIKE]": region,
    "cond[ROAD_NM_ADDR::LIKE]": addrLike,
    "cond[OPN_ATMY_GRP_CD::EQ]": orgCode,
    "cond[SALS_STTS_CD::EQ]": salesStatus,
    "cond[LCPMT_YMD::GTE]": licenseFrom,
    "cond[LCPMT_YMD::LT]": licenseTo,
    "cond[DAT_UPDT_PNT::GTE]": updatedFrom,
    "cond[DAT_UPDT_PNT::LT]": updatedTo,
    "cond[BPLC_NM::LIKE]": name,
    "cond[BASE_DATE::EQ]": baseDate,
  };

  const url = `${BASE}/${path}/${op}?${qs({ ...params, ...cond })}`;
  const json = await fetchJson(url);

  const resp = json.response || {};
  const header = resp.header || {};
  const body = resp.body || {};
  const code = String(header.resultCode ?? "");
  if (code && code !== "0" && code !== "00") {
    throw new Error(`인허가 API 오류 ${code} — ${header.resultMsg || ""}`);
  }

  const items = toArray(body.items && body.items.item);
  const totalCount = Number(body.totalCount || 0);
  const returned = Number(body.numOfRows || items.length);

  return {
    type,
    operation: op,
    items,
    totalCount,
    numOfRows: returned,
    pageNo: Number(body.pageNo || pageNo),
    // 요청한 것보다 적게 왔으면 상한에 잘린 것 — 호출자가 페이징하도록 알린다
    truncated: totalCount > returned * Number(body.pageNo || pageNo),
  };
}

/** 여러 페이지를 모아 최대 maxItems 건까지 가져온다 (일일 한도를 감안해 상한을 둔다) */
export async function fetchPermitsPaged(o, maxItems = 500) {
  const first = await fetchPermits({ ...o, pageNo: 1, numOfRows: PERMIT_MAX_ROWS });
  const all = [...first.items];
  const total = first.totalCount;
  const want = Math.min(maxItems, total);
  let page = 2;
  while (all.length < want) {
    const r = await fetchPermits({ ...o, pageNo: page, numOfRows: PERMIT_MAX_ROWS });
    if (!r.items.length) break;
    all.push(...r.items);
    page += 1;
    if (page > 60) break; // 안전장치 (6,000건)
  }
  return { ...first, items: all.slice(0, want), fetched: Math.min(all.length, want), totalCount: total };
}

/** 인허가 레코드를 보기 좋은 형태로 축약 (좌표는 WGS84로 변환) */
export function slimPermit(it) {
  const c = permitCoordToWgs84(it.CRD_INFO_X, it.CRD_INFO_Y);
  return {
    관리번호: it.MNG_NO,
    사업장명: it.BPLC_NM,
    업태: it.BZSTAT_SE_NM || it.SNTTN_BZSTAT_NM || null,
    영업상태: it.SALS_STTS_NM,
    영업상태코드: it.SALS_STTS_CD,
    상세영업상태: it.DTL_SALS_STTS_NM || null,
    인허가일자: it.LCPMT_YMD || null,
    폐업일자: it.CLSBIZ_YMD || null,
    소재지면적: it.LCTN_AREA ? Number(it.LCTN_AREA) : null,
    시설총규모: it.FCLT_TOTAL_SCL ? Number(it.FCLT_TOTAL_SCL) : null,
    도로명주소: it.ROAD_NM_ADDR || null,
    지번주소: it.LOTNO_ADDR || null,
    전화번호: it.TELNO || null,
    자치단체코드: it.OPN_ATMY_GRP_CD || null,
    경도: c ? c.lon : null,
    위도: c ? c.lat : null,
    데이터갱신: it.DAT_UPDT_PNT || null,
  };
}
