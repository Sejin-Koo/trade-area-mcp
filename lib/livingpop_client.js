// 서울 열린데이터광장 — [내국인] 행정동별 서울 생활인구(250m)
//   데이터셋 ID: OA-23016 / 서비스명: Spop250mLocalResdDong
//   Base: http://openapi.seoul.go.kr:8088/{인증키}/json/Spop250mLocalResdDong/{시작}/{끝}/{YMD}/{TT}/{H_DNG_CD}
//
// ★ 상권분석서비스의 "유동인구"와 다른 데이터다. 헷갈리지 말 것.
//   - 유동인구(VwsmTrdarFlpopQq): 상권 단위 · 분기 · 성/연령/시간대가 각각 별도 합계(교차 불가)
//   - 생활인구(이 파일)        : 행정동 단위 · 일별 시간별 · 성별×연령 완전 교차
//
// ★ 실측 제약 (2026-09-04)
//   - OpenAPI는 최근 약 123일(≈4개월)만 보관하는 롤링 창이다.
//     2026-05-01 조회 성공 / 2025-07-31 은 INFO-200 "해당하는 데이터가 없습니다".
//     그보다 과거는 월별 압축파일을 미리 집계해 둔 data/livingpop/ 아카이브에서 읽는다.
//   - 한 (YMD, TT) 조합의 list_total_count 는 427 — 서울 행정동 수다.
//   - H_DNG_CD 에 공백 패딩이 섞여 온다("11110515     "). 반드시 trim 할 것.
//     같은 서비스인데 요청에 따라 패딩이 있기도 없기도 하다(둘 다 실측).
//   - ★★ 문서에 선택 인자로 적혀 있는 H_DNG_CD 필터는 실제로 동작하지 않는다.
//     2026-09-04 실측: 같은 날·시각을 필터 없이 부르면 427행이 오고 그 안에 11560540 이
//     분명히 들어 있는데, 세 번째 경로 인자에 그 코드를 넣으면 8자리·13자리(공백 패딩)·
//     10자리·다른 자치구 코드·다른 날짜 어느 조합으로도 INFO-200 "해당하는 데이터가
//     없습니다"가 돌아온다. YMD·TT 필터는 정상 동작하므로 인자 자리 문제도 아니다.
//     그래서 이 클라이언트는 행정동 코드를 요청에 싣지 않고 YMD(+TT)로 받아 와서
//     서버에서 직접 걸러낸다. 코드를 그대로 실어 보내면 "그 동은 데이터가 없다"는
//     정반대 결론이 조용히 나온다.
//   - 값은 정수가 아니라 소수다(추정치). "18194.65" 처럼 문자열로 온다.
//   - 구 데이터셋 "행정동 단위 서울 생활인구(내국인)"(OA-14991)은 서비스 종료됐다.
//     2026년 국가표준 250m 격자 재집계로 대체됐으므로 옛 수치와 그대로 잇지 말 것.

import { fetchJson, toArray } from "./http.js";
import { readArchiveMonth, listArchiveMonths, dongMeta } from "./livingpop_archive.js";

const BASE = "http://openapi.seoul.go.kr:8088";
const SERVICE = "Spop250mLocalResdDong";

export const LIVINGPOP_MAX_ROWS = 1000;

/** 연령 구간 — 첫 구간만 10세 폭이고 나머지는 5세 폭, 마지막은 70세 이상 */
export const AGE_BANDS = [
  { key: "00", label: "0~9세" },
  { key: "10", label: "10~14세" },
  { key: "15", label: "15~19세" },
  { key: "20", label: "20~24세" },
  { key: "25", label: "25~29세" },
  { key: "30", label: "30~34세" },
  { key: "35", label: "35~39세" },
  { key: "40", label: "40~44세" },
  { key: "45", label: "45~49세" },
  { key: "50", label: "50~54세" },
  { key: "55", label: "55~59세" },
  { key: "60", label: "60~64세" },
  { key: "65", label: "65~69세" },
  { key: "70", label: "70세이상" },
];

/** 상권분석서비스 유동인구와 축을 맞출 때 쓰는 10세 단위 묶음 */
export const AGE_DECADE = {
  "10대": ["10", "15"],
  "20대": ["20", "25"],
  "30대": ["30", "35"],
  "40대": ["40", "45"],
  "50대": ["50", "55"],
  "60대이상": ["60", "65", "70"],
  "10세미만": ["00"],
};

/** 상권분석서비스 추정매출·유동인구와 같은 6구간 시간대 */
export const TIME_BANDS = {
  "00_06": [0, 1, 2, 3, 4, 5],
  "06_11": [6, 7, 8, 9, 10],
  "11_14": [11, 12, 13],
  "14_17": [14, 15, 16],
  "17_21": [17, 18, 19, 20],
  "21_24": [21, 22, 23],
};

function key() {
  const k = process.env.SEOUL_OPENAPI_KEY;
  if (!k) throw new Error("환경변수 SEOUL_OPENAPI_KEY 가 설정되어 있지 않습니다.");
  return k;
}

const seg = (v) => (v === null || v === undefined || v === "" ? "%20" : encodeURIComponent(String(v)));

/** 응답 한 행을 정규화한다 — 코드 trim, 숫자 변환, 성·연령 분해 */
export function normalizeRow(row) {
  const dong = String(row.H_DNG_CD || "").trim();
  const m = {};
  const f = {};
  for (const b of AGE_BANDS) {
    m[b.key] = Number(row["M" + b.key] || 0);
    f[b.key] = Number(row["F" + b.key] || 0);
  }
  const 남자 = Object.values(m).reduce((a, b) => a + b, 0);
  const 여자 = Object.values(f).reduce((a, b) => a + b, 0);
  return {
    일자: String(row.YMD || "").trim(),
    시간: Number(row.TT),
    행정동코드: dong,
    행정동: dongMeta(dong).동 || null,
    자치구: dongMeta(dong).자치구 || null,
    생활인구: Number(row.SPOP || 0),
    남자,
    여자,
    연령별: AGE_BANDS.map((b) => ({ 구간: b.label, 남자: m[b.key], 여자: f[b.key], 계: m[b.key] + f[b.key] })),
  };
}

/**
 * OpenAPI 원 호출. 추가 인자는 경로 세그먼트로 붙고 순서는 YMD → TT → H_DNG_CD 로 고정이다.
 * 앞자리를 비우려면 %20 을 넣어야 뒤 인자가 밀리지 않는다.
 */
export async function callLivingPop({ ymd, tt, start = 1, end = 100 } = {}) {
  const s = Math.max(1, Number(start) || 1);
  let e = Number(end) || s + 99;
  if (e - s + 1 > LIVINGPOP_MAX_ROWS) e = s + LIVINGPOP_MAX_ROWS - 1;

  // 행정동은 일부러 싣지 않는다(위 헤더의 실측 주석 참고). YMD → TT 순서만 쓴다.
  const parts = [ymd, tt === undefined || tt === null || tt === "" ? "" : String(tt).padStart(2, "0")];
  while (parts.length && (parts[parts.length - 1] === "" || parts[parts.length - 1] === undefined || parts[parts.length - 1] === null)) {
    parts.pop();
  }
  const tail = parts.length ? parts.map(seg).join("/") + "/" : "";
  const url = `${BASE}/${key()}/json/${SERVICE}/${s}/${e}/${tail}`;

  const json = await fetchJson(url);
  const root = json[SERVICE];
  if (!root) {
    const err = json.RESULT || {};
    if (err.CODE === "INFO-200") {
      return { rows: [], totalCount: 0, empty: true, 사유: "해당 조건에 데이터가 없습니다" };
    }
    throw new Error(`서울 열린데이터광장 오류 ${err.CODE || "?"} — ${err.MESSAGE || JSON.stringify(json).slice(0, 200)}`);
  }
  const code = root.RESULT && root.RESULT.CODE;
  if (code && code !== "INFO-000") {
    if (code === "INFO-200") return { rows: [], totalCount: 0, empty: true, 사유: root.RESULT.MESSAGE };
    throw new Error(`서울 열린데이터광장 오류 ${code} — ${root.RESULT.MESSAGE || ""}`);
  }
  const rows = toArray(root.row);
  const totalCount = Number(root.list_total_count || rows.length);
  return { rows, totalCount, returned: rows.length, truncated: totalCount > e };
}

/**
 * 한 날짜(+시각)의 전량을 페이지네이션으로 받아 행정동으로 걸러낸다.
 * 서버가 행정동 필터를 무시하므로 걸러내기는 여기서 한다.
 *   (YMD, TT) 한 조합 = 427행 → 1회 호출로 끝난다.
 *   TT 생략 = 427 × 24 = 10,248행 → 11회 호출. maxDuration 60초 안에 들도록 상한을 둔다.
 */
export async function fetchDay({ ymd, tt, dong, maxCalls = 12 } = {}) {
  const all = [];
  let start = 1;
  let total = Infinity;
  let calls = 0;
  while (calls < maxCalls && start <= total) {
    const end = start + LIVINGPOP_MAX_ROWS - 1;
    const r = await callLivingPop({ ymd, tt, start, end });
    if (r.empty) return { rows: [], totalCount: 0, empty: true, 사유: r.사유, calls };
    total = r.totalCount;
    all.push(...r.rows);
    calls++;
    // 받은 행이 요청한 페이지 크기보다 적으면 끝이다(totalCount 를 종료 판정에 쓰지 않는다)
    if (r.returned < LIVINGPOP_MAX_ROWS) break;
    start = end + 1;
  }
  const truncated = all.length < total;
  const want = String(dong || "").trim();
  const rows = want ? all.filter((x) => String(x.H_DNG_CD || "").trim() === want) : all;
  return { rows, totalCount: total, 수집행수: all.length, 잘림: truncated, calls, 필터: want || null };
}

/** OpenAPI 보관 구간을 실측으로 확인한다 — "과거 자료가 없다"를 추측으로 적지 않기 위한 도구 */
export async function probeApiWindow({ probes } = {}) {
  const list = probes && probes.length ? probes : defaultProbes();
  const out = [];
  for (const ymd of list) {
    try {
      const r = await callLivingPop({ ymd, tt: 12, start: 1, end: 1 });
      out.push({ 일자: ymd, 조회: r.empty ? "없음" : "있음", 행정동수: r.totalCount || 0 });
    } catch (e) {
      out.push({ 일자: ymd, 조회: "오류", 오류: e.message });
    }
  }
  return out;
}

function defaultProbes() {
  const now = new Date();
  const out = [];
  for (const back of [1, 30, 90, 120, 150, 200, 365]) {
    const d = new Date(now.getTime() - back * 86400000);
    out.push(
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
    );
  }
  return out;
}

// ── 과거 아카이브 조회 ────────────────────────────────────────────────────────

/**
 * 월별 집계 아카이브에서 한 행정동의 시계열을 뽑는다.
 * 아카이브는 일자를 월평균으로 접되 시간(24) × 성별(2) × 연령(14) 교차는 그대로 보존한다.
 * 평일/주말은 나눠서 저장돼 있다.
 */
export async function livingPopTrend({ dong, months, tt, timeBand, dayType = "평일" } = {}) {
  const available = listArchiveMonths();
  if (!available.length) {
    throw new Error(
      "과거 집계 아카이브(data/livingpop/)가 비어 있습니다. " +
        "GitHub Actions 의 livingpop-backfill 워크플로를 먼저 실행해 월별 집계를 생성하세요."
    );
  }
  const want = months && months.length ? months.filter((m) => available.includes(m)) : available;
  const missing = (months || []).filter((m) => !available.includes(m));

  const hours = resolveHours({ tt, timeBand });
  const series = [];
  const 자료없음 = [];
  for (const ym of want) {
    const rows = readArchiveMonth(ym).filter(
      (r) => r.dong === dong && r.daytype === (dayType === "주말" ? "E" : "W") && hours.includes(r.tt)
    );
    // 조용히 건너뛰지 않는다. 원본이 그 달을 일부만 공개해 평일 또는 주말이 통째로
    // 비어 있는 경우가 있다(2026-09-04 실측: 2026-07 은 토요일 하루뿐이라 평일이 없다).
    if (!rows.length) { 자료없음.push(ym); continue; }
    const agg = { 생활인구: 0, 남자: 0, 여자: 0, 연령별: {} };
    for (const b of AGE_BANDS) agg.연령별[b.key] = { 남자: 0, 여자: 0 };
    for (const r of rows) {
      agg.생활인구 += r.spop;
      for (const b of AGE_BANDS) {
        agg.연령별[b.key].남자 += r["m" + b.key];
        agg.연령별[b.key].여자 += r["f" + b.key];
        agg.남자 += r["m" + b.key];
        agg.여자 += r["f" + b.key];
      }
    }
    const n = hours.length;
    series.push({
      월: ym,
      "시간평균_생활인구": round1(agg.생활인구 / n),
      남자: round1(agg.남자 / n),
      여자: round1(agg.여자 / n),
      연령별: AGE_BANDS.map((b) => ({
        구간: b.label,
        남자: round1(agg.연령별[b.key].남자 / n),
        여자: round1(agg.연령별[b.key].여자 / n),
        계: round1((agg.연령별[b.key].남자 + agg.연령별[b.key].여자) / n),
      })),
    });
  }

  const meta = dongMeta(dong);
  return {
    행정동코드: dong,
    행정동: meta.동 || null,
    자치구: meta.자치구 || null,
    구분: dayType,
    시간대: hours.length === 24 ? "전체(0~23시)" : hours.join(","),
    집계방식: "해당 월의 일자를 평균한 값 (시간대를 여러 개 고르면 그 시간들의 평균)",
    아카이브보유월: available.length,
    조회월수: series.length,
    미보유월: missing.length ? missing : undefined,
    자료없는월: 자료없음.length ? 자료없음 : undefined,
    안내: 자료없음.length
      ? `아카이브에 있으나 이 조건(${dayType})으로는 자료가 없는 달이 있습니다: ${자료없음.join(", ")}. ` +
        "원본이 그 달을 일부만 공개한 경우이며, 다음 월간 갱신에서 다시 받습니다."
      : undefined,
    시계열: series,
  };
}

function resolveHours({ tt, timeBand }) {
  if (timeBand && TIME_BANDS[timeBand]) return TIME_BANDS[timeBand];
  if (tt !== undefined && tt !== null && tt !== "") {
    return String(tt)
      .split(",")
      .map((v) => Number(String(v).trim()))
      .filter((v) => Number.isFinite(v) && v >= 0 && v <= 23);
  }
  return Array.from({ length: 24 }, (_, i) => i);
}

const round1 = (v) => Math.round(v * 10) / 10;

export { listArchiveMonths, dongMeta };
