// 좌표계 변환 · 거리 계산 유틸
//
// ★ 왜 필요한가
//   행정안전부 인허가 데이터(apis.data.go.kr/1741000/*)의 CRD_INFO_X / CRD_INFO_Y 는
//   "보정계수 안 들어간 Bessel 중부원점TM(EPSG:5174)" 좌표다. 반면 소상공인시장진흥공단
//   상가정보는 WGS84 경위도이고, 서울 열린데이터광장은 좌표가 아예 없다.
//   세 소스를 한 지도 위에 올리려면 이 변환이 반드시 들어가야 한다.
//
// ★ SGIS 좌표변환 API는 쓸 수 없다 (2026-09-04 실측)
//   sgisapi.mods.go.kr/OpenAPI3/transformation/transcoord.json 에 src=5174 를 주면
//   {"errCd":-200,"errMsg":"정의된 EPSG 코드값이 아닙니다"} 를 돌려준다.
//   SGIS가 지원하는 코드표에 5174가 없다. 그래서 proj4로 로컬 변환한다.
//
// ★ 검증 (2026-09-04)
//   인허가 데이터의 (190838.324818618, 439761.362000391) → (126.897236, 37.459972)
//   같은 건물(서울 금천구 시흥대로 291)의 소상공인 상가정보 WGS84 좌표는
//   (126.897211, 37.460048). 오차 약 9m로 일치.

import proj4 from "proj4";

export const CRS = {
  // 인허가 데이터 좌표계
  "EPSG:5174":
    "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 " +
    "+ellps=bessel +units=m +no_defs " +
    "+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43",
  // GRS80 중부원점 (국가기본도)
  "EPSG:5181":
    "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs",
  "EPSG:5186":
    "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs",
  // UTM-K (SGIS 기본 좌표계)
  "EPSG:5179":
    "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs",
  "EPSG:4326": "+proj=longlat +datum=WGS84 +no_defs",
};

export function normalizeCrs(code) {
  if (!code) return "EPSG:4326";
  const s = String(code).trim().toUpperCase();
  return s.startsWith("EPSG:") ? s : `EPSG:${s}`;
}

/** [x, y] 를 src 좌표계에서 dst 좌표계로 변환. 경위도는 [경도, 위도] 순. */
export function transform(x, y, src, dst) {
  const s = normalizeCrs(src);
  const d = normalizeCrs(dst);
  if (!CRS[s]) throw new Error(`지원하지 않는 좌표계입니다: ${src} (지원: ${Object.keys(CRS).join(", ")})`);
  if (!CRS[d]) throw new Error(`지원하지 않는 좌표계입니다: ${dst} (지원: ${Object.keys(CRS).join(", ")})`);
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  const [ox, oy] = proj4(CRS[s], CRS[d], [nx, ny]);
  return { x: ox, y: oy };
}

/** 인허가 레코드의 CRD_INFO_X/Y(EPSG:5174) → {lon, lat}. 값이 없으면 null. */
export function permitCoordToWgs84(crdX, crdY) {
  if (crdX == null || crdY == null || crdX === "" || crdY === "") return null;
  const r = transform(crdX, crdY, "EPSG:5174", "EPSG:4326");
  if (!r) return null;
  // 대한민국 범위를 벗어나면 좌표가 깨진 레코드로 보고 버린다.
  if (r.x < 124 || r.x > 132 || r.y < 33 || r.y > 39) return null;
  return { lon: Number(r.x.toFixed(7)), lat: Number(r.y.toFixed(7)) };
}

const R_EARTH = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/**
 * 두 경위도 사이의 대권거리(m). 소수 둘째 자리까지 남긴다.
 * ★ 예전에는 정수로 반올림했다. 도심 반경 조회는 수십 cm 차이가 결과를 바꾸므로
 *   (좌표를 소수 5자리로 자르면 강남역 반경 300m 점포가 3,182 → 3,118),
 *   미터 미만을 버리면 그 차이를 잴 수 없다. 표시용 반올림은 호출부에서 한다.
 */
export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R_EARTH * Math.asin(Math.sqrt(a)) * 100) / 100;
}
