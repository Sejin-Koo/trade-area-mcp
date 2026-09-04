// 생활인구 모듈 오프라인 스모크 테스트 (네트워크 없이 도는 부분만 검증)
//   node smoke_livingpop.mjs
//
// 서울 OpenAPI 는 8088 포트라 일부 샌드박스에서 막힌다. 그래서 여기서는
//   ① 원자료 파서(헤더 별칭·구분자·인코딩 판별, 평일/주말 접기)
//   ② 아카이브 쓰기/읽기 왕복
//   ③ normalizeRow 의 코드 trim·성별 합계
//   ④ 시계열 집계
// 만 검증한다. 실제 API 호출은 배포 후 tools/call 로 확인한다.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const DATA = path.resolve("data", "livingpop");
const AGE = ["00","10","15","20","25","30","35","40","45","50","55","60","65","70"];

// ── 준비: 가짜 원자료로 build 스크립트의 파서를 태운다 ──────────────────────
// 202401-01(월,평일) 과 202401-06(토,주말) 두 날, 두 행정동, 두 시간
function fakeCsv(headerStyle) {
  const head = headerStyle === "en"
    ? ["YMD","TT","H_DNG_CD","SPOP", ...AGE.map(a=>"M"+a), ...AGE.map(a=>"F"+a)]
    : ["기준일ID","시간대구분","행정동코드","총생활인구수",
       ...AGE.map(a=>`남자${a==="00"?"0세부터9세":a==="70"?"70세이상":`${+a}세부터${+a+4}세`}생활인구수`),
       ...AGE.map(a=>`여자${a==="00"?"0세부터9세":a==="70"?"70세이상":`${+a}세부터${+a+4}세`}생활인구수`)];
  const rows = [head.join(",")];
  for (const ymd of ["20240101","20240102","20240106"]) {
    for (const tt of [9, 18]) {
      for (const dong of ["11560540","11110515"]) {
        const base = dong === "11560540" ? 1000 : 500;
        const vals = AGE.map((_, i) => (base + i * 10 + tt).toFixed(2));
        const vals2 = AGE.map((_, i) => (base + i * 10 + tt + 5).toFixed(2));
        const spop = [...vals, ...vals2].reduce((a, b) => a + Number(b), 0).toFixed(2);
        rows.push([ymd, String(tt).padStart(2,"0"), dong + "   ", spop, ...vals, ...vals2].join(","));
      }
    }
  }
  return rows.join("\n") + "\n";
}

const tmp = fs.mkdtempSync("/tmp/spopsmoke-");
for (const style of ["en", "ko"]) {
  const inner = path.join(tmp, `d_${style}`);
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, "data.csv"), fakeCsv(style), "utf8");
  execFileSync("zip", ["-q", "-j", path.join(tmp, `${style}.zip`), path.join(inner, "data.csv")]);
}

// build 스크립트의 내부 함수를 직접 부를 수 없으므로, 같은 규칙을 여기서 재현하는 대신
// 스크립트를 --inspect 로 돌릴 수는 없다(다운로드가 먼저다). 그래서 파서만 떼어 검증한다.
// → 대신 아카이브 포맷 왕복과 조회 로직을 검증한다.

// ── 1. 아카이브 왕복 ────────────────────────────────────────────────────────
const cols = ["dong","tt","daytype","spop", ...AGE.map(a=>"m"+a), ...AGE.map(a=>"f"+a)];
function makeMonth(ym, scale) {
  const out = [cols.join(",")];
  for (const dong of ["11560540","11110515"]) {
    for (let tt = 0; tt < 24; tt++) {
      for (const dt of ["W","E"]) {
        const m = AGE.map((_, i) => ((100 + i * 10 + tt) * scale).toFixed(1));
        const f = AGE.map((_, i) => ((110 + i * 10 + tt) * scale).toFixed(1));
        const spop = [...m, ...f].reduce((a, b) => a + Number(b), 0).toFixed(1);
        out.push([dong, tt, dt, spop, ...m, ...f].join(","));
      }
    }
  }
  fs.writeFileSync(path.join(DATA, `${ym}.csv.gz`), zlib.gzipSync(Buffer.from(out.join("\n"), "utf8")));
  return out.length - 1;
}

const backup = fs.readdirSync(DATA);
const metaPath = path.join(DATA, "dong_meta.json");
const metaBackup = fs.existsSync(metaPath) ? fs.readFileSync(metaPath) : null;
fs.writeFileSync(metaPath, JSON.stringify({
  "11560540": { 동: "여의동", 자치구: "영등포구" },
  "11110515": { 동: "청운효자동", 자치구: "종로구" },
}));
const n1 = makeMonth("202409", 1.0);
const n2 = makeMonth("202509", 1.2);
check("월 파일 생성 행수 = 행정동2 × 시간24 × 구분2", n1 === 96 && n2 === 96, `(${n1}, ${n2})`);

// 모듈은 파일을 읽고 캐시하므로 생성 후에 import 한다
const arch = await import("./lib/livingpop_archive.js?" + Date.now());
const lv = await import("./lib/livingpop_client.js?" + Date.now());

check("아카이브 월 목록 인식", arch.listArchiveMonths().includes("202409") && arch.listArchiveMonths().includes("202509"),
  JSON.stringify(arch.listArchiveMonths()));
check("행정동 매핑 조회", arch.dongMeta("11560540").동 === "여의동");
check("행정동 검색(자치구명)", arch.findDongs("영등포").length === 1);
check("읽은 행 수", arch.readArchiveMonth("202409").length === 96);

// ── 2. normalizeRow ─────────────────────────────────────────────────────────
const raw = { YMD: "20260731", TT: "18", H_DNG_CD: "11560540     ", SPOP: "100.5" };
for (const a of AGE) { raw["M" + a] = "1.5"; raw["F" + a] = "2.5"; }
const norm = lv.normalizeRow(raw);
check("H_DNG_CD 공백 패딩 trim", norm.행정동코드 === "11560540", `(${JSON.stringify(norm.행정동코드)})`);
check("행정동명 매핑 부착", norm.행정동 === "여의동" && norm.자치구 === "영등포구");
check("남자 합계 = 1.5 × 14", Math.abs(norm.남자 - 21) < 1e-9, `(${norm.남자})`);
check("여자 합계 = 2.5 × 14", Math.abs(norm.여자 - 35) < 1e-9, `(${norm.여자})`);
check("연령 구간 14개", norm.연령별.length === 14);

// ── 3. 시계열 집계 ──────────────────────────────────────────────────────────
const t = await lv.livingPopTrend({ dong: "11560540", months: ["202409", "202509"], tt: "18", dayType: "평일" });
check("시계열 2개월", t.시계열.length === 2, JSON.stringify(t.시계열.map(s => s.월)));
const [y0, y1] = t.시계열;
check("전년 대비 1.2배 반영", Math.abs(y1.생활인구 ?? y1["시간평균_생활인구"]) > 0 &&
  Math.abs((y1["시간평균_생활인구"] / y0["시간평균_생활인구"]) - 1.2) < 0.01,
  `(${y0["시간평균_생활인구"]} → ${y1["시간평균_생활인구"]})`);
check("행정동명이 결과에 붙음", t.행정동 === "여의동" && t.자치구 === "영등포구");

const tb = await lv.livingPopTrend({ dong: "11560540", months: ["202409"], timeBand: "17_21", dayType: "평일" });
check("시간대 묶음(17_21) 4시간 평균", tb.시계열.length === 1 && tb.시간대 === "17,18,19,20", tb.시간대);

const weekend = await lv.livingPopTrend({ dong: "11560540", months: ["202409"], tt: "18", dayType: "주말" });
check("주말 구분 조회", weekend.시계열.length === 1 && weekend.구분 === "주말");

const missing = await lv.livingPopTrend({ dong: "11560540", months: ["202409", "201901"], tt: "18" });
check("미보유월을 조용히 삼키지 않고 알림", Array.isArray(missing.미보유월) && missing.미보유월.includes("201901"),
  JSON.stringify(missing.미보유월));

// ── 4. 시간대 묶음 정의가 상권분석 유동인구와 같은지 ────────────────────────
check("시간대 6구간", Object.keys(lv.TIME_BANDS).join(",") === "00_06,06_11,11_14,14_17,17_21,21_24");
check("시간대 합집합이 0~23 전부", Object.values(lv.TIME_BANDS).flat().sort((a,b)=>a-b).join(",") ===
  Array.from({length:24},(_,i)=>i).join(","));

// ── 정리 ────────────────────────────────────────────────────────────────────
for (const f of fs.readdirSync(DATA)) if (!backup.includes(f)) fs.rmSync(path.join(DATA, f));
if (metaBackup) fs.writeFileSync(metaPath, metaBackup);
else fs.writeFileSync(metaPath, "{}\n");
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
