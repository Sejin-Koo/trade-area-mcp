// 네이버 클라우드 플랫폼(NCP) Maps API 클라이언트
//   Base: https://maps.apigw.ntruss.com
//   인증: 요청 헤더 x-ncp-apigw-api-key-id / x-ncp-apigw-api-key (소문자로 보내도 된다)
//   환경변수: NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET
//
// ★ 좌표계 — 지오코딩·역지오코딩·길찾기·정적지도 모두 WGS84(EPSG:4326) 경위도, (x=경도, y=위도) 순서다.
//   소상공인 상가정보(stores_nearby 의 lon/lat)와 같은 좌표계라 변환 없이 그대로 넘기면 된다.
//
// ★ 과금 (네이버 클라우드 요금 페이지, 2026-10-08 확인)
//   무료 이용량은 회원당 "대표 계정" 1개에만 적용되고, 대표 계정이 아닌 계정은 호출마다 과금된다.
//   상품별 무료 이용량 수치는 2025-07 에 바뀐 적이 있어 코드에 박지 않는다 — 요금 페이지를 보도록 안내만 한다.
//   이 서버는 호출 상한을 두지 않는 대신 모든 응답에 과금안내와 이번 응답의 upstream 호출 수를 싣는다.
//
// ★ 실측으로 확인한 오류 형태 (2026-10-08)
//   - 키가 틀리거나 빠지면 401 + {"error":{"errorCode":"200","message":"Authentication Failed",...}}
//     (응답헤더 x-ncp-apigw-response-origin=APIGW — 게이트웨이가 막은 것)
//   - 지오코딩: 빈 query 는 HTTP 200 + {"status":"INVALID_REQUEST","errorMessage":"query is INVALID"}
//   - 역지오코딩: 결과 없음(바다 등)은 HTTP 200 + status.code=3, 좌표 형식 오류는 400
//   - 길찾기: 400 + {"error":{"errorCode":400,"code":1|2,"message":"..."}} — message 가 한국어/영어로 사유를 준다
//   - 정적지도: 파라미터 오류(크기 초과·level 22·scale 3·maptype 오타·마커 문법 오류)는 403 + **빈 본문**
//     (x-ncp-apigw-response-origin=ENDPOINT). 인증 403 과 구분하려면 이 헤더를 봐야 한다.

const BASE = "https://maps.apigw.ntruss.com";
const TIMEOUT_MS = 20000;

export const PRICING_URL = "https://www.ncloud.com/product/applicationService/maps";

export const BILLING_NOTICE_TEXT =
  "네이버 지도 API의 무료 이용량은 대표 계정 1개에만 적용되며, 대표 계정이 아닌 계정으로 호출하면 " +
  "호출마다 과금됩니다. 상품별 무료 이용량은 네이버 클라우드 요금 페이지에서 확인하십시오.";

/** 응답마다 붙이는 과금 안내 블록. calls = 이번 응답을 만드느라 네이버 API 를 부른 횟수 */
export function billingNotice(calls) {
  const out = { 안내: BILLING_NOTICE_TEXT, 요금페이지: PRICING_URL };
  if (calls !== undefined) out.이번응답_네이버API_호출수 = calls;
  return out;
}

/** 네이버 Maps 호출 오류. 사용자에게 보여줄 한국어 안내를 message 에 담는다(키 값은 절대 넣지 않는다). */
export class NaverMapsError extends Error {
  constructor(message, { status = null, kind = "기타", api = null } = {}) {
    super(message);
    this.name = "NaverMapsError";
    this.status = status;
    this.kind = kind; // 인증 / 권한 / 한도초과 / 파라미터 / 서버 / 네트워크 / 설정
    this.api = api;
  }
}

export function keyStatus() {
  return {
    NAVER_MAPS_CLIENT_ID: !!process.env.NAVER_MAPS_CLIENT_ID,
    NAVER_MAPS_CLIENT_SECRET: !!process.env.NAVER_MAPS_CLIENT_SECRET,
  };
}

function headers() {
  const id = process.env.NAVER_MAPS_CLIENT_ID;
  const secret = process.env.NAVER_MAPS_CLIENT_SECRET;
  if (!id || !secret) {
    throw new NaverMapsError(
      "환경변수 NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET 가 설정되어 있지 않습니다. " +
        "네이버 클라우드 콘솔 > Maps > Application 에서 Client ID 와 Client Secret 을 확인해 서버 환경변수에 넣으세요.",
      { kind: "설정" }
    );
  }
  return { "x-ncp-apigw-api-key-id": id, "x-ncp-apigw-api-key": secret };
}

/** 응답 본문에서 사람이 읽을 사유만 뽑는다. 본문에 키가 실릴 일은 없지만 길이는 자른다. */
function reasonOf(text) {
  if (!text) return "";
  try {
    const j = JSON.parse(text);
    const e = j.error || j;
    const parts = [e.message, e.details, e.errorMessage].filter((v) => v && typeof v === "string");
    if (parts.length) return parts.join(" — ").slice(0, 300);
  } catch (_) {
    /* JSON 이 아니면 원문 앞부분 */
  }
  return String(text).slice(0, 300);
}

function classify(status, origin, text, api) {
  const reason = reasonOf(text);
  const why = reason ? ` (네이버 응답: ${reason})` : "";
  if (status === 401) {
    return new NaverMapsError(
      `네이버 지도 API 인증에 실패했습니다(HTTP 401)${why}. ` +
        "① NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET 값이 맞는지, " +
        `② 네이버 클라우드 콘솔 > Maps > Application 에서 이 Application 에 '${api}' API 가 선택(사용 설정)되어 있는지 확인하세요. ` +
        "키가 맞아도 해당 API 를 Application 에 추가하지 않았으면 401 이 납니다.",
      { status, kind: "인증", api }
    );
  }
  if (status === 429) {
    return new NaverMapsError(
      `네이버 지도 API 호출 한도(할당량 또는 초당 호출 수)를 넘었습니다(HTTP 429)${why}. ` +
        "자동 재시도하지 않습니다 — 재시도는 과금 호출만 늘립니다. " +
        "네이버 클라우드 콘솔에서 이용량·한도 설정을 확인한 뒤 잠시 후 다시 호출하세요.",
      { status, kind: "한도초과", api }
    );
  }
  if (status === 403) {
    // 정적지도는 파라미터 오류를 403 + 빈 본문으로 돌려준다(origin=ENDPOINT). 게이트웨이 403 은 권한 문제.
    if (origin === "ENDPOINT" && !text) {
      return new NaverMapsError(
        `${api} 가 요청을 거부했습니다(HTTP 403, 빈 응답). 실측상 이것은 인증이 아니라 파라미터 오류입니다 — ` +
          "크기(w 최대 4096·h 최대 2048 실측, 이 도구는 1024 로 제한), level(0~21), scale(1|2), maptype, 마커 문법을 확인하세요.",
        { status, kind: "파라미터", api }
      );
    }
    return new NaverMapsError(
      `네이버 지도 API 접근이 거부됐습니다(HTTP 403)${why}. ` +
        `이 Application 에 '${api}' API 이용 권한(구독)이 있는지 네이버 클라우드 콘솔에서 확인하세요.`,
      { status, kind: "권한", api }
    );
  }
  if (status >= 400 && status < 500) {
    return new NaverMapsError(`${api} 요청 파라미터 오류(HTTP ${status})${why}.`, { status, kind: "파라미터", api });
  }
  return new NaverMapsError(`${api} 서버 오류(HTTP ${status})${why}. 잠시 후 다시 시도하세요.`, {
    status,
    kind: "서버",
    api,
  });
}

/**
 * 네이버 Maps API 호출.
 * - 4xx(429 포함)는 재시도하지 않는다 — 같은 결과에 과금 호출만 는다.
 * - 네트워크 오류·5xx 만 한 번 재시도한다.
 * @returns {{ status:number, buf:Buffer, contentType:string, calls:number }}
 */
async function request(path, params, api) {
  const h = headers();
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.append(k, String(v));
  }
  const url = `${BASE}${path}?${sp.toString()}`;
  let lastErr = null;
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      calls++;
      const res = await fetch(url, { headers: h, signal: ctrl.signal });
      const buf = Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      const contentType = res.headers.get("content-type") || "";
      if (res.ok) return { status: res.status, buf, contentType, calls };
      const origin = res.headers.get("x-ncp-apigw-response-origin");
      const err = classify(res.status, origin, buf.toString("utf8"), api);
      err.calls = calls;
      if (res.status < 500) throw err;
      lastErr = err;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof NaverMapsError && e.status && e.status < 500) throw e;
      lastErr =
        e instanceof NaverMapsError
          ? e
          : new NaverMapsError(
              `${api} 호출 중 네트워크 오류: ${e && e.name === "AbortError" ? `${TIMEOUT_MS / 1000}초 시간 초과` : e.message}`,
              { kind: "네트워크", api }
            );
      lastErr.calls = calls;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
  }
  throw lastErr;
}

function parseJson(buf, api) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new NaverMapsError(`${api} 응답 JSON 파싱 실패 — 앞부분: ${buf.toString("utf8").slice(0, 200)}`, {
      kind: "서버",
      api,
    });
  }
}

// ── 지오코딩 ────────────────────────────────────────────────────────────────

/**
 * 주소 → 좌표. 결과 addresses[] 의 x(경도)·y(위도)는 **문자열**로 온다(소수 7자리).
 * ★ 주소 전용이다 — '강남역' 같은 장소명(POI)은 0건(실측 2026-10-08).
 * @param {object} o { query, coordinate:"lon,lat", count, page, filter }
 */
export async function geocode({ query, coordinate, count, page, filter }) {
  const api = "Geocoding";
  const r = await request("/map-geocode/v2/geocode", { query, coordinate, count, page, filter }, api);
  const j = parseJson(r.buf, api);
  if (j.status && j.status !== "OK") {
    const err = new NaverMapsError(
      `Geocoding 요청 오류 (status=${j.status}${j.errorMessage ? `, ${j.errorMessage}` : ""}). 검색할 주소(query)를 확인하세요.`,
      { status: r.status, kind: "파라미터", api }
    );
    err.calls = r.calls;
    throw err;
  }
  return { ...j, _calls: r.calls };
}

// ── 역지오코딩 ──────────────────────────────────────────────────────────────

/**
 * 좌표 → 법정동/행정동 코드와 지번·도로명 주소.
 * status.code: 0 정상, 3 결과 없음(바다 등) — 결과 없음은 예외가 아니라 빈 results 로 돌려준다.
 */
export async function reverseGeocode({ lon, lat, orders = "legalcode,admcode,addr,roadaddr" }) {
  const api = "Reverse Geocoding";
  const r = await request(
    "/map-reversegeocode/v2/gc",
    { coords: `${lon},${lat}`, output: "json", orders },
    api
  );
  const j = parseJson(r.buf, api);
  const code = j.status && j.status.code;
  if (code !== 0 && code !== 3) {
    const err = new NaverMapsError(
      `Reverse Geocoding 오류 (status.code=${code}, ${(j.status && j.status.message) || ""})`,
      { status: r.status, kind: "파라미터", api }
    );
    err.calls = r.calls;
    throw err;
  }
  return { ...j, _calls: r.calls };
}

// ── 길찾기 ──────────────────────────────────────────────────────────────────

export const DIRECTION_OPTIONS = {
  trafast: "실시간 빠른길",
  tracomfort: "실시간 편한길",
  traoptimal: "실시간 최적",
  traavoidtoll: "무료 우선",
  traavoidcaronly: "자동차 전용도로 회피 우선",
};

// 길찾기 응답 code (공식 문서 + 실측). 0 만 성공이고 나머지는 400 본문이나 200 본문으로 온다.
const DIRECTION_CODES = {
  1: "출발지와 도착지가 같거나 요청 형식이 잘못됐습니다",
  2: "출발지 또는 도착지가 도로 주변이 아닙니다 — 좌표를 도로 가까이로 옮기세요",
  3: "자동차 길찾기 결과를 제공할 수 없습니다",
  4: "경유지가 도로 주변이 아닙니다 — 경유지 좌표를 도로 가까이로 옮기세요",
  5: "요청 경로가 너무 깁니다(경유지 포함 직선거리 합이 상한을 넘음)",
};

/** 경유지 수로 엔진을 고른다. Directions 5 는 경유지 5개, Directions 15 는 15개까지(실측: 초과 시 400). */
export function pickDirectionEngine(waypointCount) {
  if (waypointCount <= 5) return { name: "Directions 5", path: "/map-direction/v1/driving", max: 5 };
  if (waypointCount <= 15) return { name: "Directions 15", path: "/map-direction-15/v1/driving", max: 15 };
  return null;
}

/**
 * @param {object} o { start:"lon,lat", goal:"lon,lat", waypoints:["lon,lat",...], option:"trafast:traoptimal", cartype, fueltype, mileage }
 */
export async function directions({ start, goal, waypoints = [], option, cartype, fueltype, mileage }) {
  const engine = pickDirectionEngine(waypoints.length);
  if (!engine) {
    throw new NaverMapsError(`경유지는 최대 15개입니다(받은 개수 ${waypoints.length}).`, { kind: "파라미터" });
  }
  const api = engine.name;
  let r;
  try {
    r = await request(
      engine.path,
      {
        start,
        goal,
        waypoints: waypoints.length ? waypoints.join("|") : undefined,
        option,
        cartype,
        fueltype,
        mileage,
      },
      api
    );
  } catch (e) {
    // 길찾기 400 본문의 code 를 한국어 사유로 보강
    if (e instanceof NaverMapsError && e.kind === "파라미터") e.message += " 좌표는 '경도,위도' 순서인지도 확인하세요.";
    throw e;
  }
  const j = parseJson(r.buf, api);
  if (j.code !== 0) {
    const err = new NaverMapsError(
      `${api} 실패 (code=${j.code}): ${DIRECTION_CODES[j.code] || j.message || "알 수 없는 사유"}`,
      { status: r.status, kind: "파라미터", api }
    );
    err.calls = r.calls;
    throw err;
  }
  return { ...j, _engine: engine.name, _calls: r.calls };
}

// ── 정적 지도 ───────────────────────────────────────────────────────────────

/** 바이트 시그니처로 이미지 형식을 판별한다(응답 헤더는 'image/jpeg;charset=UTF-8' 처럼 군더더기가 붙는다). */
export function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let width = null;
    let height = null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xc3) {
        height = buf.readUInt16BE(i + 5);
        width = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
    return { mimeType: "image/jpeg", width, height };
  }
  return null;
}

/**
 * 정적 지도 이미지.
 * @param {object} o { w, h, center:"lon,lat", level, scale, maptype, format, lang, markers:[string] }
 *   markers 는 'type:d|size:mid|color:red|pos:<경도> <위도>|label:1' 형식 문자열 배열(마커 하나당 1개)
 */
export async function staticMap({ w, h, center, level, scale, maptype, format, lang, markers = [] }) {
  const api = "Static Map";
  const r = await request(
    "/map-static/v2/raster",
    { w, h, center, level, scale, maptype, format, lang, markers },
    api
  );
  const img = sniffImage(r.buf);
  if (!img) {
    const err = new NaverMapsError(
      `Static Map 응답이 이미지가 아닙니다 (content-type=${r.contentType}, 앞부분: ${r.buf.toString("utf8").slice(0, 200)})`,
      { status: r.status, kind: "서버", api }
    );
    err.calls = r.calls;
    throw err;
  }
  return { buf: r.buf, ...img, bytes: r.buf.length, _calls: r.calls };
}
