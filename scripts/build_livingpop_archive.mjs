#!/usr/bin/env node
// 서울 생활인구 월별 압축파일 → 월평균 집계 아카이브
//
// 사용법
//   node scripts/build_livingpop_archive.mjs --months 202301,202302
//   node scripts/build_livingpop_archive.mjs --from 202301 --to 202607
//   node scripts/build_livingpop_archive.mjs --months 202601 --inspect   (파싱만 하고 구조를 찍는다)
//
// 이 컨테이너/서버가 아니라 GitHub Actions 러너에서 도는 것을 전제로 한다.
// 서울시 파일 서버는 CORS·프록시 제약이 있어 브라우저나 일부 샌드박스에서는 받을 수 없다.
//
// ★ 원자료 포맷을 눈으로 확인하지 못한 채 작성했으므로, 헤더 이름을 여러 후보로
//   받아들이고 구분자·인코딩을 자동 판별한다. 판별에 실패하면 조용히 0건을 만들지 않고
//   실제로 읽은 첫 줄을 붙여 예외를 던진다(에러 없는 빈 결과가 가장 위험하다).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import { execFileSync } from "node:child_process";

const INF_ID = "OA-23016"; // [내국인] 행정동별 서울 생활인구(250m)
const DOWNLOAD = "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false";
const OUT_DIR = path.resolve("data", "livingpop");

const AGE_KEYS = ["00", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55", "60", "65", "70"];

// 헤더 별칭 — 영문 축약형과 한글 서술형을 모두 받는다
const ALIAS = {
  ymd: ["YMD", "기준일ID", "기준일", "STDR_DE_ID", "일자"],
  tt: ["TT", "시간대구분", "시간", "TMZON_PD_SE"],
  dong: ["H_DNG_CD", "행정동코드", "ADSTRD_CODE_SE", "ADSTRD_CD"],
  spop: ["SPOP", "총생활인구수", "생활인구합계", "TOT_LVPOP_CO"],
};
for (const k of AGE_KEYS) {
  ALIAS["m" + k] = ["M" + k, `남자${tilde(k)}`, `남자${wordy(k)}생활인구수`, `MAN_FLOW_POP_CNT_${k}`];
  ALIAS["f" + k] = ["F" + k, `여자${tilde(k)}`, `여자${wordy(k)}생활인구수`, `WMAN_FLOW_POP_CNT_${k}`];
}

// 2026-09-04 실측 — 202601 원본의 실제 헤더는 "남자 0~9세" 꼴이다(공백 포함).
// 비교는 공백을 모두 지운 뒤 하므로 여기서는 공백 없이 적는다.
function tilde(k) {
  if (k === "00") return "0~9세";
  if (k === "70") return "70세이상";
  const a = Number(k);
  return `${a}~${a + 4}세`;
}
// 구 데이터셋(OA-14991)에서 쓰던 서술형. 후속 포맷 변경에 대비해 남겨 둔다.
function wordy(k) {
  if (k === "00") return "0세부터9세";
  if (k === "70") return "70세이상";
  const a = Number(k);
  return `${a}세부터${a + 4}세`;
}

// ── 인자 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const INSPECT = argv.includes("--inspect");

const LOCAL_FILE = arg("file"); // 다운로드 없이 로컬 파일로 파서만 검증할 때

let months = [];
if (LOCAL_FILE) months = [arg("months") || "TEST"];
else if (arg("months")) months = arg("months").split(",").map((s) => s.trim()).filter(Boolean);
else if (arg("from") && arg("to")) months = monthRange(arg("from"), arg("to"));
else {
  console.error("--months 또는 --from/--to 를 지정하세요.");
  process.exit(1);
}

function monthRange(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(4, 6));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(4, 6));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ── 다운로드 ─────────────────────────────────────────────────────────────────
async function download(ym, dest) {
  const body = new URLSearchParams({ infId: INF_ID, seqNo: "", seq: ym, infSeq: "1" });
  const res = await fetch(DOWNLOAD, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });
  if (!res.ok) throw new Error(`${ym} 다운로드 실패 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) {
    throw new Error(`${ym} 응답이 ${buf.length}바이트로 너무 작습니다 — 본문: ${buf.toString("utf8").slice(0, 300)}`);
  }
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error(`${ym} 응답이 ZIP 이 아닙니다(매직 ${buf[0]},${buf[1]}) — 앞부분: ${buf.toString("utf8").slice(0, 300)}`);
  }
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ── 파싱 ─────────────────────────────────────────────────────────────────────
function decode(buf) {
  const utf8 = buf.toString("utf8");
  // 치환문자가 많으면 EUC-KR(CP949)로 다시 읽는다
  const bad = (utf8.slice(0, 4000).match(/�/g) || []).length;
  if (bad > 3) {
    try {
      return new TextDecoder("euc-kr").decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

// 2026-09-04 실측: 같은 데이터셋인데 2026-07 파일만 세미콜론 구분이었다.
// 달마다 다를 수 있으므로 파일별로 매번 판별한다.
function sniffDelimiter(headerLine) {
  const cands = [",", ";", "\t", "|"];
  let best = ",";
  let bestN = 0;
  for (const c of cands) {
    const n = headerLine.split(c).length;
    if (n > bestN) { bestN = n; best = c; }
  }
  return best;
}

// 공백·따옴표·BOM 을 지우고 비교한다. 원본 헤더에 "남자 0~9세" 처럼 공백이 들어 있고,
// 포맷이 바뀔 때 공백만 달라지는 일이 잦아 처음부터 무시하는 편이 안전하다.
const squash = (h) => String(h).replace(/^\uFEFF/, "").replace(/["']/g, "").replace(/\s+/g, "").toUpperCase();

function buildIndex(headerCells) {
  const norm = headerCells.map((h) => h.replace(/^\uFEFF/, "").replace(/["']/g, "").trim());
  const flat = norm.map(squash);
  const idx = {};
  for (const [field, names] of Object.entries(ALIAS)) {
    let at = -1;
    for (const n of names) {
      at = flat.indexOf(squash(n));
      if (at >= 0) break;
    }
    if (at >= 0) idx[field] = at;
  }
  return { idx, norm };
}

/** 한 달치 텍스트를 평일/주말 × 행정동 × 시간 평균으로 접는다 */
function aggregate(text, ym) {
  const lines = text.split(/\r?\n/);
  let h = 0;
  while (h < lines.length && !lines[h].trim()) h++;
  const headerDelim = sniffDelimiter(lines[h]);
  const { idx, norm } = buildIndex(lines[h].split(headerDelim));

  // ★ 헤더와 데이터의 구분자가 다른 파일이 실제로 있다(2026-09-04 실측: 2026-07).
  //   헤더만 보고 판별하면 컬럼 매칭은 통과하는데 데이터 행이 전부 걸러져
  //   "한 줄도 파싱하지 못했다"로 끝난다. 데이터 구분자는 따로 판별한다.
  let firstData = "";
  for (let i = h + 1; i < lines.length; i++) {
    if (lines[i] && lines[i].trim()) { firstData = lines[i]; break; }
  }
  const delim = firstData ? sniffDelimiter(firstData) : headerDelim;

  const need = ["ymd", "tt", "dong", "spop", "m00", "f70"];
  const missing = need.filter((k) => idx[k] === undefined);
  if (missing.length) {
    throw new Error(
      `${ym} 헤더에서 필수 컬럼을 찾지 못했습니다: ${missing.join(", ")}\n` +
        `실제 헤더(${norm.length}열, 구분자 ${JSON.stringify(headerDelim)}): ${norm.slice(0, 40).join(" | ")}`
    );
  }

  // key = dong|tt|daytype
  const acc = new Map();
  let parsed = 0;
  const days = new Set();

  for (let i = h + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const c = line.split(delim);
    if (c.length < norm.length - 2) continue;

    // ★ 값이 따옴표로 감싸여 온다("20230101","0",...). 어느 칸이든 벗겨서 읽을 것.
    //   2026-09-04 실측 사고: ymd·dong 만 벗기고 tt 를 그대로 Number() 에 넣어
    //   Number('"0"') = NaN 이 되면서 43개월 전부가 0행으로 끝났다.
    const ymd = cell(c, idx.ymd);
    if (ymd.length !== 8) continue;
    const tt = Number(cell(c, idx.tt));
    if (!Number.isFinite(tt)) continue;
    const dong = cell(c, idx.dong);
    if (!dong) continue;

    days.add(ymd);
    const dow = new Date(
      Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))
    ).getDay();
    const daytype = dow === 0 || dow === 6 ? "E" : "W";

    const k = `${dong}|${tt}|${daytype}`;
    let a = acc.get(k);
    if (!a) {
      a = { dong, tt, daytype, n: 0, spop: 0 };
      for (const g of AGE_KEYS) { a["m" + g] = 0; a["f" + g] = 0; }
      acc.set(k, a);
    }
    a.n++;
    a.spop += num(c[idx.spop]);
    for (const g of AGE_KEYS) {
      a["m" + g] += num(c[idx["m" + g]]);
      a["f" + g] += num(c[idx["f" + g]]);
    }
    parsed++;
  }

  if (!parsed) {
    throw new Error(
      `${ym} 데이터 행을 한 줄도 파싱하지 못했습니다. ` +
        `구분자 헤더 ${JSON.stringify(headerDelim)} / 데이터 ${JSON.stringify(delim)}, 헤더 ${norm.length}열. ` +
        `첫 데이터 줄: ${firstData.slice(0, 300)}`
    );
  }

  const dongs = new Set([...acc.values()].map((a) => a.dong)).size;
  const hours = new Set([...acc.values()].map((a) => a.tt)).size;
  return { acc, parsed, days: days.size, dongs, hours, delim, headerDelim, header: norm };
}

/** 한 칸을 읽는다 — 따옴표·공백 패딩·BOM 제거 */
const cell = (arr, i) => String(arr[i] == null ? "" : arr[i]).replace(/^\uFEFF/, "").replace(/["']/g, "").trim();

const num = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/["',\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function writeMonth(ym, acc) {
  const cols = ["dong", "tt", "daytype", "spop", ...AGE_KEYS.map((k) => "m" + k), ...AGE_KEYS.map((k) => "f" + k)];
  const out = [cols.join(",")];
  const keys = [...acc.keys()].sort();
  for (const k of keys) {
    const a = acc.get(k);
    const row = [a.dong, a.tt, a.daytype, r1(a.spop / a.n)];
    for (const g of AGE_KEYS) row.push(r1(a["m" + g] / a.n));
    for (const g of AGE_KEYS) row.push(r1(a["f" + g] / a.n));
    out.push(row.join(","));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const gz = zlib.gzipSync(Buffer.from(out.join("\n"), "utf8"), { level: 9 });
  fs.writeFileSync(path.join(OUT_DIR, `${ym}.csv.gz`), gz);
  return { 행수: out.length - 1, 바이트: gz.length };
}

const r1 = (v) => Math.round(v * 10) / 10;

// ── 실행 ─────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spop-"));
const report = [];

for (const ym of months) {
  const zip = path.join(tmp, `${ym}.zip`);
  try {
    let inner, files, bytes;
    if (LOCAL_FILE) {
      inner = LOCAL_FILE;
      files = [path.basename(LOCAL_FILE)];
      bytes = fs.statSync(LOCAL_FILE).size;
    } else {
      bytes = await download(ym, zip);
      const dir = path.join(tmp, ym);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync("unzip", ["-o", "-q", zip, "-d", dir]);

      files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
      if (!files.length) throw new Error(`${ym} 압축 안에 파일이 없습니다`);
      inner = path.join(dir, files.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0]);
    }

    const text = decode(fs.readFileSync(inner));
    const { acc, parsed, days, dongs, hours, delim, headerDelim, header } = aggregate(text, ym);
    // 조용히 반쪽이 되는 것을 막는 최소 검증. 서울 행정동은 427개, 시간은 24개다.
    if (!LOCAL_FILE && (dongs < 400 || hours < 24)) {
      throw new Error(
        `${ym} 집계 결과가 비정상입니다 — 행정동 ${dongs}개(기대 427), 시간 ${hours}개(기대 24). ` +
          `파싱행 ${parsed}, 일수 ${days}. 구분자 헤더 ${JSON.stringify(headerDelim)} / 데이터 ${JSON.stringify(delim)}. ` +
          `헤더 매칭이나 따옴표 처리를 의심할 것.`
      );
    }

    if (INSPECT) {
      console.log(`[${ym}] zip ${bytes}B / 내부파일 ${files.join(", ")}`);
      console.log(`  구분자 헤더 ${JSON.stringify(headerDelim)} / 데이터 ${JSON.stringify(delim)} / 컬럼 ${header.length}개`);
      console.log(`  헤더: ${header.join(" | ")}`);
      console.log(`  파싱행 ${parsed} / 일수 ${days} / 행정동 ${dongs} / 시간 ${hours} / 집계키 ${acc.size}`);
      continue;
    }

    const w = writeMonth(ym, acc);
    report.push({ 월: ym, 원본행: parsed, 일수: days, 집계행: w.행수, gz바이트: w.바이트 });
    console.log(`[${ym}] 원본 ${parsed}행(${days}일, 행정동 ${dongs}) → 집계 ${w.행수}행, ${(w.바이트 / 1024).toFixed(0)}KB`);
  } catch (e) {
    console.error(`[${ym}] 실패 — ${e.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(path.join(tmp, ym), { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }
}

if (!INSPECT && report.length) {
  const months2 = fs.readdirSync(OUT_DIR).filter((f) => /^\d{6}\.csv\.gz$/.test(f)).map((f) => f.slice(0, 6)).sort();
  fs.writeFileSync(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify(
      {
        데이터셋: "[내국인] 행정동별 서울 생활인구(250m) / OA-23016",
        집계: "월평균 (평일 W = 월~금, 주말 E = 토·일). 시간 24 × 성별 2 × 연령 14 교차는 원자료 그대로 보존",
        보유월: months2,
        보유월수: months2.length,
        최종갱신: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log(`\n총 ${report.length}개월 처리 완료. 아카이브 보유 ${months2.length}개월.`);
}

fs.rmSync(tmp, { recursive: true, force: true });
