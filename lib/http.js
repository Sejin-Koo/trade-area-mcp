// 공통 HTTP 유틸 — 타임아웃 · 재시도 · JSON 파싱

const DEFAULT_TIMEOUT_MS = 20000;

// deadline(절대 시각 ms)을 주면 남은 시간 안에서만 기다리고 재시도한다. 남은 시간이 없으면 timeLimited 오류.
// Vercel 함수 한도(60초)에 걸려 응답 없이 끊기는 대신 호출자가 받은 만큼과 안내를 돌려주게 하기 위함(2026-11-16).
export function timeLimitError(msg) {
  const e = new Error(msg || "제한 시간 소진");
  e.timeLimited = true;
  return e;
}

export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, headers, deadline } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const rem = deadline ? deadline - Date.now() : Infinity;
    if (rem < 2500) throw timeLimitError(lastErr ? `${lastErr.message} — 제한 시간 소진` : "제한 시간 소진");
    const tmo = Math.min(timeoutMs, rem - 500);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), tmo);
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
      if (deadline && deadline - Date.now() < 3000) throw timeLimitError(`${e.message} — 제한 시간 소진`);
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
