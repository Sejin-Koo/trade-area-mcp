// 공통 HTTP 유틸 — 타임아웃 · 재시도 · JSON 파싱

const DEFAULT_TIMEOUT_MS = 20000;

export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, headers } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers });
      const body = await res.text();
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} — ${body.slice(0, 300)}`);
        // 4xx는 재시도해도 같으므로 즉시 중단
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastErr;
        continue;
      }
      return body;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr || new Error("요청에 실패했습니다");
}

export async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 파싱 실패 — 응답 앞부분: ${text.slice(0, 300)}`);
  }
}

export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.append(k, String(v));
  }
  return sp.toString();
}

/** 배열이 아닐 수 있는 값을 배열로 정규화 (공공 API 응답의 단건/다건 혼용 대응) */
export function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
