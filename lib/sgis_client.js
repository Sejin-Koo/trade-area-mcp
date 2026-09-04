// 국가데이터처(구 통계청) SGIS 통계지리정보 OpenAPI 클라이언트
//   Base: https://sgisapi.mods.go.kr/OpenAPI3
//   인증: 서비스ID(consumer_key) + 보안Key(consumer_secret) → accessToken 발급 후 사용
//
// ★ 호스트가 이전됐다 (2026-09-04 실측)
//   구 주소 sgisapi.kostat.go.kr 는 빈 응답을 돌려준다. 반드시 sgisapi.mods.go.kr 를 쓸 것.
//   통계청이 국가데이터처로 개편되면서 도메인이 mods.go.kr 로 바뀌었다.
//
// ★ 좌표변환 API는 EPSG:5174 를 지원하지 않는다
//   transformation/transcoord.json 에 src=5174 → errCd -200 "정의된 EPSG 코드값이 아닙니다".
//   인허가 좌표 변환은 lib/geo.js 의 proj4 로컬 변환을 쓴다.

import { fetchJson, qs } from "./http.js";

const BASE = "https://sgisapi.mods.go.kr/OpenAPI3";

let tokenCache = { token: null, expiresAt: 0 };

function creds() {
  const id = process.env.SGIS_SERVICE_ID;
  const secret = process.env.SGIS_SECURITY_KEY;
  if (!id || !secret) {
    throw new Error("환경변수 SGIS_SERVICE_ID / SGIS_SECURITY_KEY 가 설정되어 있지 않습니다.");
  }
  return { id, secret };
}

export async function getAccessToken(force = false) {
  const now = Date.now();
  if (!force && tokenCache.token && now < tokenCache.expiresAt - 60000) return tokenCache.token;
  const { id, secret } = creds();
  const url = `${BASE}/auth/authentication.json?${qs({ consumer_key: id, consumer_secret: secret })}`;
  const json = await fetchJson(url);
  if (json.errCd !== 0 || !json.result || !json.result.accessToken) {
    throw new Error(`SGIS 인증 실패 (errCd=${json.errCd}) — ${json.errMsg || ""}`);
  }
  tokenCache = {
    token: json.result.accessToken,
    // accessTimeout 은 ms epoch. 4시간 남짓 유효.
    expiresAt: Number(json.result.accessTimeout) || now + 3 * 3600 * 1000,
  };
  return tokenCache.token;
}

async function call(path, params) {
  let token = await getAccessToken();
  let json = await fetchJson(`${BASE}/${path}?${qs({ ...params, accessToken: token })}`);
  // 토큰 만료(-401 등)면 한 번 재발급해 재시도
  if (json && json.errCd !== 0 && String(json.errMsg || "").includes("인증")) {
    token = await getAccessToken(true);
    json = await fetchJson(`${BASE}/${path}?${qs({ ...params, accessToken: token })}`);
  }
  if (!json || json.errCd !== 0) {
    if (json && json.errCd === -100) return { result: [], empty: true };
    throw new Error(`SGIS ${path} 오류 (errCd=${json && json.errCd}) — ${(json && json.errMsg) || ""}`);
  }
  return json;
}

/** 행정구역 단계별 목록 (adm_cd 미지정 시 전국 시도) */
export const addrStage = (adm_cd) => call("addr/stage.json", { cd: adm_cd });

/** 주소 → WGS84 경위도 */
export const geocodeWgs84 = (address) => call("addr/geocodewgs84.json", { address });

/**
 * 총조사 주요지표 — 총인구·평균나이·인구밀도·총가구·총주택·사업체수·종업원수
 * @param {string} adm_cd 2자리(시도)/5자리(시군구)/8자리(읍면동)
 * @param {number} low_search 0=해당 구역만, 1=1단계 하위, 2=2단계 하위
 */
export const censusIndicators = ({ year = 2024, adm_cd, low_search = 0 }) =>
  call("stats/population.json", { year, adm_cd, low_search });

/** 인구통계 — 연령대/성별 인구 */
export const populationByAge = ({ year = 2024, adm_cd, low_search = 0, age_type, gender = 0 }) =>
  call("stats/searchpopulation.json", { year, adm_cd, low_search, age_type, gender });

/** 가구통계 */
export const householdStats = ({ year = 2024, adm_cd, low_search = 0 }) =>
  call("stats/household.json", { year, adm_cd, low_search });

/** 주택통계 */
export const houseStats = ({ year = 2024, adm_cd, low_search = 0, house_type, const_year, house_area_cd }) =>
  call("stats/house.json", { year, adm_cd, low_search, house_type, const_year, house_area_cd });

/**
 * 사업체통계 — 사업체수(corp_cnt)·종사자수(tot_worker)
 * theme_cd 로 업종 테마를 좁힐 수 있다. class_code 와 동시 사용 불가.
 */
export const companyStats = ({ year = 2024, adm_cd, low_search = 0, theme_cd, class_code }) =>
  call("stats/company.json", { year, adm_cd, low_search, theme_cd, class_code });

/** 산업분류 코드 조회 */
export const industryCodes = ({ class_deg = 11, class_code }) =>
  call("stats/industrycode.json", { class_deg, class_code });

/**
 * 사업체통계 테마코드 — 상권분석에 자주 쓰는 것만 추렸다.
 * (SGIS OpenAPI 정의서 8. 사업체통계 API 의 테마 코드표)
 */
export const THEME_CODES = {
  // 음식 (H)
  한식: "5001", 중식: "5002", 일식: "5003", 분식: "5004", 서양식: "5005",
  제과점: "5006", 패스트푸드: "5007", 치킨: "5008", "호프/간이주점": "5009",
  카페: "5010", 기타외국식: "5011",
  // 여가생활 (F)
  PC방: "1010", 노래방: "1011", "극장/영화관": "9004", "도서관/박물관": "9005",
  생활체육시설: "F001", 여행사: "F002",
  // 소매업 (C)
  인테리어: "1001", 문구점: "2001", 서점: "2002", 편의점: "2003", 식료품점: "2004",
  휴대폰점: "2005", 의류: "2006", "화장품/방향제": "2007", 철물점: "2008",
  주유소: "2009", 꽃집: "2010", 슈퍼마켓: "2011", "백화점/중대형마트": "9001",
  가구: "C001", 가전제품: "C002", 통신판매: "C003", 신발: "C004",
  // 생활서비스 (D)
  목욕탕: "1002", 이발소: "1007", 부동산중개업: "1006", 미용실: "1008", 세탁소: "1009",
  은행: "9002", 생활용품임대: "D001", 독서실: "D002", 생활용품수리: "D003",
  카센터: "D004", "피부/미용": "D005", 마사지: "D006", "택배/배달": "D007",
  // 숙박 (G)
  호텔: "4001", "여관(모텔포함)및여인숙": "4002", 펜션: "4003", 민박: "G001", 야영장: "G002",
  // 교육 (I)
  교습학원: "1003", 어학원: "1004", 예체능학원: "1005", 초등학교: "7001",
  중학교: "7002", 고등학교: "7003", 전문대학: "7004", 대학교: "7005",
  대학원: "7006", 어린이보육업: "7007", 기술직업훈련: "I001",
  // 의료 (J)
  병원: "9003", 동물병원: "J001", 약국: "J002", 한방병원: "J003", 기타의료업: "8007",
  // 교통 (E)
  지하철역: "3001", 터미널: "3002",
  // 공공 (K)
  우체국: "6001", 행정기관: "6002", "경찰/지구대": "6003", 소방서: "6004",
};
