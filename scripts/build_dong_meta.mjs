#!/usr/bin/env node
// 행정동코드 → { 동, 자치구 } 매핑 생성
//
//   node scripts/build_dong_meta.mjs        (SEOUL_OPENAPI_KEY 필요)
//
// 생활인구 데이터의 H_DNG_CD 는 행정안전부 행정동코드 10자리의 앞 8자리다.
// 앞 5자리가 자치구 코드이고, 뒤 3자리가 동 일련번호다. 동 이름은 서울 상권분석서비스의
// 행정동추정매출(VwsmAdstrdSelngW)이 ADSTRD_CD / ADSTRD_CD_NM 로 같은 코드체계를 쓰므로
// 거기서 끌어온다(2026-09-04 실측: ADSTRD_CD "11710720" = 잠실7동).
//
// 자치구 코드는 법정 고시값이라 바뀌지 않으므로 표로 박아 둔다.

import fs from "node:fs";
import path from "node:path";

const GU = {
  11110: "종로구", 11140: "중구", 11170: "용산구", 11200: "성동구", 11215: "광진구",
  11230: "동대문구", 11260: "중랑구", 11290: "성북구", 11305: "강북구", 11320: "도봉구",
  11350: "노원구", 11380: "은평구", 11410: "서대문구", 11440: "마포구", 11470: "양천구",
  11500: "강서구", 11530: "구로구", 11545: "금천구", 11560: "영등포구", 11590: "동작구",
  11620: "관악구", 11650: "서초구", 11680: "강남구", 11710: "송파구", 11740: "강동구",
};

const KEY = process.env.SEOUL_OPENAPI_KEY;
if (!KEY) {
  console.error("환경변수 SEOUL_OPENAPI_KEY 가 필요합니다.");
  process.exit(1);
}

const BASE = "http://openapi.seoul.go.kr:8088";
const OUT = path.resolve("data", "livingpop", "dong_meta.json");
const PAGE = 1000;
const MAX_CALLS = 40; // 한 분기가 약 1.7만 행이라 이 정도면 전 행정동을 훑는다

const map = {};
let calls = 0;
let start = 1;
let total = Infinity;

while (calls < MAX_CALLS && start <= total) {
  const end = start + PAGE - 1;
  const url = `${BASE}/${KEY}/json/VwsmAdstrdSelngW/${start}/${end}/`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const root = json.VwsmAdstrdSelngW;
  if (!root) throw new Error(`응답 이상 — ${JSON.stringify(json).slice(0, 300)}`);
  total = Number(root.list_total_count || 0);
  const rows = Array.isArray(root.row) ? root.row : root.row ? [root.row] : [];
  if (!rows.length) break;

  for (const r of rows) {
    const code = String(r.ADSTRD_CD || "").trim();
    const nm = String(r.ADSTRD_CD_NM || "").trim();
    if (code.length === 8 && nm && !map[code]) {
      map[code] = { 동: nm, 자치구: GU[code.slice(0, 5)] || null };
    }
  }
  calls++;
  start = end + 1;
  const known = Object.keys(map).length;
  console.log(`  ${calls}회 호출 / 누적 ${known}개 행정동`);
  // 서울 행정동은 427개다. 그 이상 늘지 않으면 더 훑을 이유가 없다.
  if (known >= 420 && calls >= 3) break;
}

const unknownGu = Object.entries(map).filter(([, v]) => !v.자치구).map(([k]) => k);
if (unknownGu.length) {
  console.warn(`자치구를 못 붙인 코드 ${unknownGu.length}건: ${unknownGu.slice(0, 10).join(", ")}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(map, null, 0));
console.log(`행정동 ${Object.keys(map).length}개를 ${OUT} 에 저장했습니다.`);
