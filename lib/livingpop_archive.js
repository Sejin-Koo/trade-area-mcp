// 생활인구 과거 집계 아카이브 리더
//
// OpenAPI 는 최근 약 4개월만 보관하므로, 그 이전 구간은 서울 열린데이터광장의
// 월별 압축파일(250_LOCAL_RESD_ADMDONG_YYYYMM.zip)을 GitHub Actions 에서 미리
// 집계해 data/livingpop/ 에 커밋해 둔다. 이 파일은 그 결과만 읽는다.
//
// 저장 형식 — data/livingpop/<YYYYMM>.csv.gz
//   dong,tt,daytype,spop,m00..m70,f00..f70   (헤더 포함, 값은 일평균 소수 1자리)
//   daytype: W = 평일(월~금), E = 주말(토·일)
//   한 달 = 427 행정동 × 24시 × 2 = 20,496행 ≈ gzip 0.7MB
//
// 원자료 전량(일별)을 두지 않는 이유는 43개월이 약 1,340만 행 3GB라 저장소에
// 담기지 않기 때문이다. 특정 날짜를 짚어야 하는 질문은 OpenAPI 보관 구간
// 안에서만 답할 수 있고, 그 밖은 월평균 비교로 답한다.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, "..", "data", "livingpop");

const AGE_KEYS = ["00", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55", "60", "65", "70"];

let _months = null;
let _meta = null;
const _cache = new Map();

/** 아카이브가 보유한 월 목록 (YYYYMM 오름차순) */
export function listArchiveMonths() {
  if (_months) return _months;
  try {
    _months = fs
      .readdirSync(DATA_DIR)
      .filter((f) => /^\d{6}\.csv\.gz$/.test(f))
      .map((f) => f.slice(0, 6))
      .sort();
  } catch {
    _months = [];
  }
  return _months;
}

/** 행정동코드 → { 동, 자치구 } */
export function dongMeta(code) {
  if (!_meta) {
    try {
      _meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "dong_meta.json"), "utf8"));
    } catch {
      _meta = {};
    }
  }
  return _meta[String(code || "").trim()] || {};
}

/** 행정동명·자치구명으로 코드 찾기 */
export function findDongs(keyword, { limit = 50 } = {}) {
  if (!_meta) dongMeta("");
  const kw = String(keyword || "").trim();
  const out = [];
  for (const [code, v] of Object.entries(_meta)) {
    const hay = `${v.자치구 || ""} ${v.동 || ""}`;
    if (!kw || hay.includes(kw)) out.push({ 행정동코드: code, 행정동: v.동, 자치구: v.자치구 });
    if (out.length >= limit) break;
  }
  return out;
}

/** 한 달치 집계를 읽어 행 배열로 돌려준다 */
export function readArchiveMonth(ym) {
  if (_cache.has(ym)) return _cache.get(ym);
  const file = path.join(DATA_DIR, `${ym}.csv.gz`);
  let text;
  try {
    text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  } catch {
    _cache.set(ym, []);
    return [];
  }
  const lines = text.split("\n");
  const header = lines[0].split(",").map((s) => s.trim());
  const idx = {};
  header.forEach((h, i) => (idx[h] = i));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(",");
    const r = {
      dong: c[idx.dong],
      tt: Number(c[idx.tt]),
      daytype: c[idx.daytype],
      spop: Number(c[idx.spop]),
    };
    for (const k of AGE_KEYS) {
      r["m" + k] = Number(c[idx["m" + k]] || 0);
      r["f" + k] = Number(c[idx["f" + k]] || 0);
    }
    rows.push(r);
  }
  // 월 파일 하나가 약 20,496행이라 캐시해도 부담이 없다. 함수 인스턴스 수명 동안만 유지된다.
  if (_cache.size > 6) _cache.delete(_cache.keys().next().value);
  _cache.set(ym, rows);
  return rows;
}

export function archiveStatus() {
  const months = listArchiveMonths();
  if (!_meta) dongMeta("");
  return {
    보유월수: months.length,
    최초월: months[0] || null,
    최종월: months[months.length - 1] || null,
    행정동매핑: Object.keys(_meta).length,
    경로: "data/livingpop/",
  };
}
