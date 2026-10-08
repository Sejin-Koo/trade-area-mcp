// 네이버 지도 도구 4종(naver_geocode / naver_reverse_geocode / naver_directions / naver_static_map)과
// resolve_region 의 '두번째의견' 힌트를 MCP 클라이언트로 실제 호출해 검증하는 스모크 테스트.
//   NAVER_MAPS_CLIENT_ID=... NAVER_MAPS_CLIENT_SECRET=... node smoke_naver.mjs
//   또는 KEY=VALUE 줄로 된 파일을 KEYS_ENV_FILE 로 지정 (값은 출력하지 않는다)
//
// ★ 네이버 API 를 30회 남짓 실제로 호출한다. 대표 계정이 아니면 호출마다 과금된다.
// resolve_region 은 SGIS 키가 없으면 SGIS 응답을 가짜로 꾸며(fetch 대체) 힌트 분기만 검증한다.

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

if (process.env.KEYS_ENV_FILE) {
  for (const line of fs.readFileSync(process.env.KEYS_ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
const ID = process.env.NAVER_MAPS_CLIENT_ID;
const SECRET = process.env.NAVER_MAPS_CLIENT_SECRET;
if (!ID || !SECRET) {
  console.log("NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET 가 없어 실행할 수 없습니다.");
  process.exit(1);
}

// ── SGIS 가짜 응답 (SGIS 키가 없을 때만) ─────────────────────────────────────
const SGIS_MOCK = !process.env.SGIS_SERVICE_ID || !process.env.SGIS_SECURITY_KEY;
if (SGIS_MOCK) {
  process.env.SGIS_SERVICE_ID = "mock";
  process.env.SGIS_SECURITY_KEY = "mock";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes("sgisapi.mods.go.kr")) return realFetch(url, opts);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/auth/authentication.json")) {
      return json({ errCd: 0, result: { accessToken: "mock-token", accessTimeout: String(Date.now() + 3600e3) } });
    }
    if (u.includes("/addr/geocodewgs84.json")) {
      const q = decodeURIComponent(new URL(u).searchParams.get("address") || "");
      const dongOnly = !/\d/.test(q); // 숫자(건물번호·지번)가 없으면 동 대표점으로 폴백하는 것으로 흉내
      return json({
        errCd: 0,
        result: {
          resultdata: [
            dongOnly
              ? { addr_type: "3", sido_nm: "서울특별시", sgg_nm: "강남구", adm_nm: "역삼동", x: "127.03921493540328", y: "37.49927696992212", adm_cd: "11230650", leg_cd: "1168010100" }
              : { addr_type: "6", sido_nm: "서울특별시", sgg_nm: "강남구", adm_nm: "역삼1동", road_nm: "강남대로", road_nm_main_no: "396", bd_main_nm: "강남역", x: "127.02832263883478", y: "37.49817007074474", adm_cd: "11230640", leg_cd: "1168010100" },
          ],
        },
      });
    }
    return json({ errCd: -100, errMsg: "mock: 지원하지 않는 경로" });
  };
}

fs.mkdirSync("smoke_out", { recursive: true }); // 이미지 확인용 (gitignore 대상)
const { buildServer, SERVER_VERSION } = await import("./lib/server.js");

async function connect() {
  const server = buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "smoke-naver", version: "1.0.0" });
  await client.connect(ct);
  return client;
}
const client = await connect();

let pass = 0;
let fail = 0;
const allTexts = [];
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name} ${extra}`);
  }
};
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const texts = (r.content || []).filter((c) => c.type === "text").map((c) => c.text);
  allTexts.push(...texts);
  let json = null;
  if (!r.isError && texts[0]) {
    try {
      json = JSON.parse(texts[0]);
    } catch (_) {
      /* 텍스트 오류 */
    }
  }
  return { r, text: texts.join("\n"), json };
}
const BILL = "대표 계정 1개에만 적용";

// ── 0. 도구 목록 ────────────────────────────────────────────────────────────
{
  const t = await client.listTools();
  const names = t.tools.map((x) => x.name);
  for (const n of ["naver_geocode", "naver_reverse_geocode", "naver_directions", "naver_static_map"]) {
    const tool = t.tools.find((x) => x.name === n);
    check(`도구 등록: ${n}`, !!tool);
    check(`설명에 과금안내: ${n}`, tool && tool.description.includes(BILL) && tool.description.includes("ncloud.com"));
  }
  check("기존 도구 유지(resolve_region·stores_nearby)", names.includes("resolve_region") && names.includes("stores_nearby"));
  check(`서버 버전 ${SERVER_VERSION}`, client.getServerVersion().version === SERVER_VERSION && SERVER_VERSION === "1.1.0");
}

// ── 1. naver_geocode ────────────────────────────────────────────────────────
{
  const { json } = await call("naver_geocode", { query: "서울특별시 강남구 강남대로 396" });
  const c = json && json.후보 && json.후보[0];
  check("geocode 정상: 1건", json && json.반환건수 === 1, JSON.stringify(json).slice(0, 300));
  check("geocode 지점단위매칭=true, 매칭수준 건물", c && c.지점단위매칭 === true && c.매칭수준.startsWith("건물"));
  check("geocode 좌표 원값(반올림 없음) 127.0283079 / 37.4981647", c && c.경도 === 127.0283079 && c.위도 === 37.4981647);
  check(
    "geocode stores_nearby_인자 {lon,lat} 동일값",
    c && c.stores_nearby_인자.lon === c.경도 && c.stores_nearby_인자.lat === c.위도
  );
  check("geocode 응답에 과금안내", json && json.과금안내 && json.과금안내.안내.includes(BILL) && json.과금안내.이번응답_네이버API_호출수 === 1);
}

console.log("\n── 5개 입력 비교 (SGIS 가 동 대표점으로 폴백하는 사례 포함) ──");
const COMPARE = [
  "서울특별시 강남구 역삼동 강남역",
  "서울특별시 강남구 역삼동",
  "역삼동 819-2",
  "서울특별시 강남구 강남대로 396",
  "서울특별시 강남구 테헤란로 340",
];
const table = [];
for (const q of COMPARE) {
  const { json } = await call("naver_geocode", { query: q });
  const c = (json && json.후보) || [];
  table.push({
    입력: q,
    건수: json ? json.전체건수 : "오류",
    지점단위: c[0] ? c[0].지점단위매칭 : "-",
    매칭수준: c[0] ? c[0].매칭수준 : "-",
    도로명: c[0] ? c[0].도로명주소 : "-",
    지번: c[0] ? c[0].지번주소 : "-",
    경도: c[0] ? c[0].경도 : "-",
    위도: c[0] ? c[0].위도 : "-",
  });
}
console.table(table);
check("비교: '강남역' 포함 입력은 0건(주소 전용)", table[0].건수 === 0);
check("비교: '역삼동'은 동 대표점(지점단위=false)", table[1].지점단위 === false);
check("비교: 지번·도로명 3건은 지점단위=true", table.slice(2).every((t) => t.지점단위 === true));
{
  const { json } = await call("naver_geocode", { query: "서울특별시 강남구 역삼동 강남역" });
  check("geocode 0건 안내(장소명 불가)", json && json.안내.some((s) => s.includes("장소명")));
  const d = await call("naver_geocode", { query: "서울특별시 강남구 역삼동" });
  check("geocode 동 대표점 경고 + 도로명주소 null", d.json && d.json.후보[0].경고 && d.json.후보[0].도로명주소 === null);
}
{
  // 문자열로 들어온 숫자 인자(z.coerce)
  const { json } = await call("naver_geocode", { query: "역삼동 819-2", near_lon: "127.0276", near_lat: "37.4979", count: "3" });
  check("geocode 기준점(문자열 인자) → 기준점거리m", json && typeof json.후보[0].기준점거리m === "number", JSON.stringify(json).slice(0, 200));
}
{
  const { r, text } = await call("naver_geocode", { query: "역삼동", near_lon: 127.0 });
  check("geocode near_lon 단독 → 파라미터 오류 + 과금안내", r.isError && text.includes("함께") && text.includes(BILL));
}

// ── 2. naver_reverse_geocode ────────────────────────────────────────────────
{
  const { json } = await call("naver_reverse_geocode", { lon: 127.028833, lat: 37.4993968 });
  check("reverse 법정동 1168010100", json && json.법정동 && json.법정동.코드 === "1168010100", JSON.stringify(json).slice(0, 300));
  check("reverse 행정동 8자리 11680640 (소상공인 adongCd)", json && json.행정동["행정동코드8자리(소상공인 adongCd)"] === "11680640");
  check("reverse signguCd 11680", json && json.법정동["시군구코드(소상공인 signguCd)"] === "11680");
  check("reverse 지번주소", json && json.지번주소 === "서울특별시 강남구 역삼동 819-2", json && json.지번주소);
  check("reverse 도로명주소", json && json.도로명주소 === "서울특별시 강남구 강남대로94길 18", json && json.도로명주소);
  check("reverse 우편번호", json && json.우편번호 === "06134");
  check("reverse 과금안내", json && json.과금안내 && json.과금안내.요금페이지.includes("ncloud.com"));
}
{
  const { json } = await call("naver_reverse_geocode", { lon: "125", lat: "35" });
  check("reverse 바다 → 주소 없음 (오류 아님)", json && json.결과 === "주소 없음");
}
{
  const { r, json, text } = await call("naver_reverse_geocode", { lon: 37.4993968, lat: 127.028833 });
  check(
    "reverse 경위도 뒤바뀜 → 경고(또는 오류 안내)",
    (json && json.경고 && json.경고[0].includes("뒤바뀐")) || (r.isError && text.length > 0),
    text.slice(0, 200)
  );
}

// ── 3. naver_directions ─────────────────────────────────────────────────────
const GANGNAM = "127.0283079,37.4981647";
const YDP = "126.9074,37.5154";
{
  const { json } = await call("naver_directions", { start: GANGNAM, goal: YDP });
  const p = json && json.경로 && json.경로[0];
  check("directions 좌표 입력 → Directions 5", json && json.엔진 === "Directions 5", JSON.stringify(json).slice(0, 300));
  check("directions km·분·원 단위", p && typeof p.총거리km === "number" && typeof p.소요시간분 === "number" && typeof p.택시요금원 === "number");
  check("directions 경로좌표 기본 제외", p && p.경로좌표 === undefined);
  check("directions 과금안내 호출수 1", json && json.과금안내.이번응답_네이버API_호출수 === 1);
  if (p) console.log("    ", JSON.stringify({ 총거리km: p.총거리km, 소요시간: p.소요시간, 통행료원: p.통행료원, 택시요금원: p.택시요금원, 유류비원: p.유류비원 }));
}
{
  const { json } = await call("naver_directions", {
    start: "서울특별시 강남구 강남대로 396",
    goal: "서울특별시 영등포구 여의대로 24",
    waypoints: "역삼동 819-2",
    option: "trafast,traavoidtoll",
    includePath: "true",
    pathMaxPoints: "50",
  });
  check("directions 주소 입력 → 지오코딩 해석 보고", json && json.지점해석.출발지.해석방법 === "지오코딩" && json.지점해석.경유지[0].해석주소, JSON.stringify(json).slice(0, 400));
  check("directions 옵션 2개 비교", json && json.경로.length === 2 && json.경로.every((x) => x.총거리km > 0));
  check("directions 구간별(경유지)", json && json.경로[0].구간별 && json.경로[0].구간별.length === 2);
  check("directions 경로좌표 50점으로 솎음", json && json.경로[0].경로좌표 && json.경로[0].경로좌표.좌표.length === 50);
  check("directions 호출수 = 지오코딩 3 + 길찾기 1", json && json.과금안내.이번응답_네이버API_호출수 === 4);
}
{
  const wps = ["127.02,37.51", "127.01,37.51", "127.00,37.51", "126.99,37.51", "126.98,37.51", "126.97,37.52"];
  const { json } = await call("naver_directions", { start: GANGNAM, goal: YDP, waypoints: wps });
  check("directions 경유지 6개 → Directions 15", json && json.엔진 === "Directions 15", JSON.stringify(json).slice(0, 200));
}
{
  const wps = Array.from({ length: 16 }, (_, i) => `${(127.02 - i * 0.006).toFixed(3)},37.51`).join("|");
  const { r, text } = await call("naver_directions", { start: GANGNAM, goal: YDP, waypoints: wps });
  check("directions 경유지 16개 → 호출 전 차단", r.isError && text.includes("최대 15") && !text.includes("호출했습니다"));
}
{
  const { r, text } = await call("naver_directions", { start: GANGNAM, goal: YDP, option: "fastest" });
  check("directions 잘못된 option → 호출 전 차단", r.isError && text.includes("알 수 없는 option"));
}
{
  const { r, text } = await call("naver_directions", { start: GANGNAM, goal: GANGNAM });
  check("directions 출발=도착 → 400 사유 전달", r.isError && text.includes("동일") && text.includes(BILL), text.slice(0, 300));
}
{
  const { r, text } = await call("naver_directions", { start: "125.0,35.0", goal: YDP });
  check("directions 도로 아닌 좌표 → 사유 전달", r.isError && text.includes("도로"), text.slice(0, 300));
}
{
  const { r, text } = await call("naver_directions", { start: "강남역", goal: YDP });
  check("directions 장소명 → 지오코딩 0건 안내", r.isError && text.includes("0건") && text.includes("1회"), text.slice(0, 300));
}
{
  const { json } = await call("naver_directions", { start: "37.4981647,127.0283079", goal: YDP });
  check("directions 위도,경도 순서 자동 교정", json && json.지점해석.출발지.경고 && json.지점해석.출발지.경도 === 127.0283079);
}

// ── 4. naver_static_map ─────────────────────────────────────────────────────
function imgOf(r) {
  return (r.content || []).find((c) => c.type === "image");
}
{
  const { r, json } = await call("naver_static_map", { center_lon: 127.0283079, center_lat: 37.4981647 });
  const img = imgOf(r);
  check("static 이미지 content (jpeg)", img && img.mimeType === "image/jpeg" && img.data.length > 1000);
  check("static 기본 600×400", json && json.지도.실제픽셀 === "600×400", json && json.지도.실제픽셀);
  check("static 텍스트에 과금안내", json && json.과금안내.안내.includes(BILL));
  if (img) fs.writeFileSync("smoke_out/naver_static_center.jpg", Buffer.from(img.data, "base64"));
}
{
  const { r, json } = await call("naver_static_map", {
    markers: "127.0283079,37.4981647,1;127.028833,37.4993968,분데스강남;127.0270,37.4970",
    width: "400",
    height: "300",
  });
  const img = imgOf(r);
  check("static 마커만(문자열) → 자동 범위", img && json && json.지도.중심 === "마커에 맞춰 자동" && json.마커.length === 3);
  check("static 마커 표시형식 n/t/d", json && json.마커.map((m) => m.표시형식).join("") === "ntd");
  if (img) fs.writeFileSync("smoke_out/naver_static_markers.jpg", Buffer.from(img.data, "base64"));
}
{
  const { r, json } = await call("naver_static_map", {
    center_lon: "127.0283079",
    center_lat: "37.4981647",
    level: "15",
    format: "png",
    scale: "2",
    width: 300,
    height: 200,
    markers: JSON.stringify([{ lon: 127.0283079, lat: 37.4981647, color: "red", size: "small" }]),
  });
  const img = imgOf(r);
  check("static png + scale=2 → 600×400 PNG", img && img.mimeType === "image/png" && json.지도.실제픽셀 === "600×400", json && json.지도.실제픽셀);
}
{
  const { r, text } = await call("naver_static_map", { width: 300 });
  check("static center·markers 없음 → 호출 전 차단", r.isError && text.includes("markers"));
}
{
  const { r, text } = await call("naver_static_map", { center_lon: 127.0283079, center_lat: 37.4981647, markers: [{ lon: 127.0283079, lat: 37.4981647, color: "red;x" }] });
  check("static 색상 형식 오류 → 차단", r.isError && text.includes("색상"));
}
{
  const r = await client.callTool({ name: "naver_static_map", arguments: { center_lon: 127.0283079, center_lat: 37.4981647, width: 5000 } });
  check("static 크기 1024 초과 → 입력 검증 오류", r.isError === true);
}
{
  const { json } = await call("naver_static_map", { center_lon: 125.0, center_lat: 30.0, width: 100, height: 100 });
  check("static 범위 밖 중심 → 경고", json && json.경고 && json.경고.length === 1);
}
{
  // 도구는 level 을 0~21 로 막으므로 클라이언트를 직접 불러 403(빈 본문, ENDPOINT) 분류를 확인한다.
  const naver = await import("./lib/naver_maps_client.js");
  try {
    await naver.staticMap({ w: 100, h: 100, center: "127.0283079,37.4981647", level: 22 });
    check("client level 22 → 403 파라미터 분류", false, "예외가 나지 않음");
  } catch (e) {
    check("client level 22 → 403 파라미터 분류", e.status === 403 && e.kind === "파라미터", `${e.status} ${e.kind} ${e.message}`);
  }
}

// ── 5. 인증 오류·키 누락 ────────────────────────────────────────────────────
{
  process.env.NAVER_MAPS_CLIENT_ID = "invalid-id-for-smoke";
  process.env.NAVER_MAPS_CLIENT_SECRET = "invalid-secret-for-smoke";
  const { r, text } = await call("naver_geocode", { query: "역삼동 819-2" });
  check("401 → 인증 안내(키·Application API 선택)", r.isError && text.includes("401") && text.includes("Application"), text.slice(0, 300));
  const s = await call("naver_static_map", { center_lon: 127.0283079, center_lat: 37.4981647, width: 100, height: 100 });
  check("static 401 → 인증 안내", s.r.isError && s.text.includes("401"));
  check("오류 메시지에 가짜 키 값 미노출", !text.includes("invalid-secret-for-smoke") && !text.includes("invalid-id-for-smoke"));
  delete process.env.NAVER_MAPS_CLIENT_ID;
  delete process.env.NAVER_MAPS_CLIENT_SECRET;
  const m = await call("naver_reverse_geocode", { lon: 127.028833, lat: 37.4993968 });
  check("키 누락 → 설정 안내", m.r.isError && m.text.includes("NAVER_MAPS_CLIENT_ID"));
  process.env.NAVER_MAPS_CLIENT_ID = ID;
  process.env.NAVER_MAPS_CLIENT_SECRET = SECRET;
}

// ── 6. resolve_region 두번째의견 힌트 ───────────────────────────────────────
{
  const a = await call("resolve_region", { address: "서울특별시 강남구 역삼동" });
  const row = a.json && a.json.지오코딩 && a.json.지오코딩[0];
  check(
    `resolve_region 동 대표점 → naver_geocode 힌트${SGIS_MOCK ? " (SGIS 가짜 응답)" : ""}`,
    row && row.지점단위매칭 === false && row.두번째의견 && row.두번째의견.includes("naver_geocode"),
    a.text.slice(0, 300)
  );
  const b = await call("resolve_region", { address: "서울특별시 강남구 강남대로 396" });
  const row2 = b.json && b.json.지오코딩 && b.json.지오코딩[0];
  check(`resolve_region 건물 매칭 → 힌트 없음${SGIS_MOCK ? " (SGIS 가짜 응답)" : ""}`, row2 && row2.지점단위매칭 === true && row2.두번째의견 === undefined);
}

// ── 7. 키 유출 검사 ─────────────────────────────────────────────────────────
check("모든 응답 텍스트에 실제 키 값 미노출", !allTexts.some((t) => t.includes(ID) || t.includes(SECRET)));

console.log(`\n─────────── 요약 ───────────\n${pass}/${pass + fail} 통과`);
await client.close();
process.exit(fail ? 1 : 0);
