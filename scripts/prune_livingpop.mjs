// 생활인구 아카이브 보존기간 정리.
// 보유한 가장 최근 월을 기준으로 보존개월(기본 36개월 = 3년)보다 오래된 월 파일을 지우고
// index.json 의 보유월·불완전한월·월별 기록을 맞춘다. 보존개월은 index.json 에도 남겨
// 도구 응답(archiveStatus)이 그 값을 그대로 보여 준다.
//
//   node scripts/prune_livingpop.mjs              (보존개월: LIVINGPOP_RETAIN_MONTHS 또는 36)
//   node scripts/prune_livingpop.mjs --keep 36 --dry-run
//
// 2026-10-30 사용자 결정: 보존기간 3년. 그 전에는 2023-01 이후 전량을 유지했다.
// git 이력에는 지운 달이 남는다. 이 정리는 배포 묶음과 앞으로의 증가를 줄이기 위한 것이다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "livingpop");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = argv.includes("--dry-run");
const KEEP = Number(arg("keep") || process.env.LIVINGPOP_RETAIN_MONTHS || 36);
if (!Number.isInteger(KEEP) || KEEP < 12) {
  console.error(`보존개월이 올바르지 않습니다: ${KEEP} (12 이상의 정수)`);
  process.exit(1);
}

const months = fs.readdirSync(DIR).filter((f) => /^\d{6}\.csv\.gz$/.test(f)).map((f) => f.slice(0, 6)).sort();
if (!months.length) { console.log("아카이브가 비어 있습니다"); process.exit(0); }

const last = months[months.length - 1];
const idx = Number(last.slice(0, 4)) * 12 + Number(last.slice(4, 6)) - 1 - (KEEP - 1);
const cutoff = `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
const drop = months.filter((m) => m < cutoff);
const keep = months.filter((m) => m >= cutoff);
console.log(`최종월 ${last}, 보존 ${KEEP}개월 → ${cutoff} 이후 유지. 삭제 ${drop.length}개월${drop.length ? " (" + drop[0] + "~" + drop[drop.length - 1] + ")" : ""}`);

const idxPath = path.join(DIR, "index.json");
let index = {};
try { index = JSON.parse(fs.readFileSync(idxPath, "utf8")); } catch {}
if (!drop.length && index.보존개월 === KEEP) { console.log("변경 없음"); process.exit(0); }
if (DRY) process.exit(0);

for (const m of drop) fs.rmSync(path.join(DIR, `${m}.csv.gz`));
const 월별 = index.월별 || {};
for (const m of Object.keys(월별)) if (m < cutoff) delete 월별[m];
index.보유월 = keep;
index.보유월수 = keep.length;
index.불완전한월 = (index.불완전한월 || []).filter((m) => m >= cutoff);
index.월별 = 월별;
index.보존개월 = KEEP;
index.보존기준 = `보유한 최종월부터 거슬러 ${KEEP}개월. 그보다 오래된 달은 월간 갱신 때 지운다`;
fs.writeFileSync(idxPath, JSON.stringify(index, null, 2));
console.log(`정리 완료. 보유 ${keep.length}개월 (${keep[0]}~${keep[keep.length - 1]})`);
