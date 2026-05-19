// api-hub-proxy — standalone Node http server (의존성 0).
//
// 용도: 한국 IDC VM(예: Oracle Cloud 춘천 Always Free)에서 상시 실행.
//   V World가 비-한국 클라우드(Cloudflare/Render Singapore/Vercel AWS Lambda) outbound IP를
//   광범위 차단하므로, 한국 IP에서 호출하면 통과될 가능성. 이 서버가 그 한국 IP 출구.
//
// 환경변수:
//   PROXY_TOKEN     (필수) — api-hub의 VWORLD_PROXY_TOKEN secret과 동일하게
//   VWORLD_REFERER  (선택) — V World 등록 도메인. 기본 https://sedamtax.kr/
//   PORT            (선택) — 기본 8080
//
// 라우팅 (모두 Authorization: Bearer <PROXY_TOKEN> 필요, /health 제외):
//   GET  /health                       → {"ok":true}
//   GET  /vworld/<service>?<query>     → https://api.vworld.kr/req/<service>?<query>
//                                         service ∈ address|search|data|image|identify
//   GET  /ned/<op>?<query>             → https://api.vworld.kr/ned/data/<op>?<query>
//                                         (개별공시지가 getIndividualLandPriceAttr 등 NED 연계 API)
//   GET  /law/<sub>?<query>            → https://law.go.kr/DRF/<lawSearch|lawService>.do?<query>
//                                         sub: search → lawSearch.do, service → lawService.do
//                                         (법제처 API도 동일 TLS 525 문제 — 같은 한국 IDC 경유)
//   POST /voyage/<sub>                 → https://api.voyageai.com/v1/<embeddings|rerank>
//                                         sub: embed → embeddings, rerank → rerank
//                                         (Voyage가 origin IP region에 따라 다른 inference cluster로
//                                          라우팅 → CF Workers와 로컬 PC가 다른 벡터 받음. 한국 IP
//                                          출구로 통일해야 인입·쿼리 벡터 일치)
//                                         프록시는 Authorization 헤더에 Bearer <VOYAGE_API_KEY> 를
//                                         클라이언트가 직접 실어 보내야 함. 본문은 그대로 패스스루.
//
// 실행:  PROXY_TOKEN=xxx node server-standalone.mjs
// systemd 등록 권장 (재부팅 시 자동 시작).

import { createServer } from "node:http";
import { URL } from "node:url";

const PROXY_TOKEN = process.env.PROXY_TOKEN;
if (!PROXY_TOKEN) {
  console.error("FATAL: PROXY_TOKEN env var required");
  process.exit(1);
}
const VWORLD_BASE = "https://api.vworld.kr/req";
const VWORLD_NED_BASE = "https://api.vworld.kr/ned/data";
const LAW_BASE = "https://law.go.kr/DRF";
const VOYAGE_BASE = "https://api.voyageai.com/v1";
const VWORLD_REFERER = process.env.VWORLD_REFERER || "https://sedamtax.kr/";
const PORT = parseInt(process.env.PORT || "8080", 10);
const ALLOWED = new Set(["address", "search", "data", "image", "identify"]);
const LAW_SUBS = { search: "lawSearch.do", service: "lawService.do" };
const VOYAGE_SUBS = { embed: "embeddings", rerank: "rerank" };

function send(res, status, obj, contentType) {
  res.statusCode = status;
  if (Buffer.isBuffer(obj)) {
    if (contentType) res.setHeader("content-type", contentType);
    res.end(obj);
  } else {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
  }
}

const server = createServer(async (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    return send(res, 400, { ok: false, error: "bad url" });
  }
  const path = parsedUrl.pathname;

  if (path === "/health") {
    return send(res, 200, { ok: true, name: "api-hub-proxy", platform: "standalone" });
  }

  const auth = req.headers["authorization"] || "";
  if (auth !== `Bearer ${PROXY_TOKEN}`) return send(res, 401, { ok: false, error: "unauthorized" });

  // POST 라우트 (Voyage) — 본문 패스스루 + 업스트림 Authorization 별도 헤더
  const mVoyage = path.match(/^\/voyage\/([a-z]+)$/);
  if (mVoyage) {
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST only for /voyage/*" });
    const sub = VOYAGE_SUBS[mVoyage[1]];
    if (!sub) return send(res, 404, { ok: false, error: `unknown voyage sub: ${mVoyage[1]} (embed|rerank)` });
    const upstreamAuth = req.headers["x-voyage-authorization"] || "";
    if (!upstreamAuth) return send(res, 400, { ok: false, error: "x-voyage-authorization header required (Bearer <VOYAGE_API_KEY>)" });

    // 본문 수집 (스트림이 아니라 단일 fetch로 보내기 위해 버퍼)
    const chunks = [];
    let total = 0;
    const MAX_BODY = 2_000_000;
    try {
      await new Promise((resolve, reject) => {
        req.on("data", (c) => {
          total += c.length;
          if (total > MAX_BODY) reject(new Error("body too large"));
          else chunks.push(c);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });
    } catch (err) {
      return send(res, 413, { ok: false, error: err.message });
    }
    const reqBuf = Buffer.concat(chunks);

    const target = `${VOYAGE_BASE}/${sub}`;
    const t0 = Date.now();
    let upstream;
    try {
      upstream = await fetch(target, {
        method: "POST",
        headers: {
          authorization: upstreamAuth,
          "content-type": req.headers["content-type"] || "application/json",
          accept: "application/json",
          "user-agent": "Mozilla/5.0 (compatible; api-hub-proxy/1.0)",
        },
        body: reqBuf,
      });
    } catch (err) {
      const cause = err.cause;
      console.error(JSON.stringify({
        tag: "voyage-fetch-threw", err: err.message, errName: err.name,
        causeCode: cause?.code, causeMessage: cause?.message, target,
      }));
      return send(res, 502, {
        ok: false, error: `upstream fetch error: ${err.message}`,
        cause: cause ? { code: cause.code, message: cause.message } : undefined,
      });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get("content-type") || "";
    console.log(JSON.stringify({
      tag: "voyage-response", sub: mVoyage[1], status: upstream.status,
      elapsed: Date.now() - t0, bytesIn: reqBuf.length, bytesOut: buf.length,
    }));
    return send(res, upstream.status, buf, ct || undefined);
  }

  // GET 라우트 (V World / NED / 법제처)
  let target = null;
  let withReferer = false;
  const mVw = path.match(/^\/vworld\/([a-z]+)$/);
  const mNed = path.match(/^\/ned\/([A-Za-z0-9_]+)$/);
  const mLaw = path.match(/^\/law\/([a-z]+)$/);
  const qs = (req.url.split("?")[1]) || "";

  if (req.method !== "GET") return send(res, 405, { ok: false, error: "GET only" });

  if (mVw) {
    const service = mVw[1];
    if (!ALLOWED.has(service)) return send(res, 404, { ok: false, error: `unknown vworld service: ${service}` });
    target = `${VWORLD_BASE}/${service}${qs ? "?" + qs : ""}`;
    withReferer = true;
  } else if (mNed) {
    target = `${VWORLD_NED_BASE}/${mNed[1]}${qs ? "?" + qs : ""}`;
    withReferer = true;
  } else if (mLaw) {
    const sub = LAW_SUBS[mLaw[1]];
    if (!sub) return send(res, 404, { ok: false, error: `unknown law sub: ${mLaw[1]} (search|service)` });
    target = `${LAW_BASE}/${sub}${qs ? "?" + qs : ""}`;
    withReferer = false;
  } else {
    return send(res, 404, { ok: false, error: "not found" });
  }

  let upstream;
  const t0 = Date.now();
  try {
    const headers = {
      accept: "application/json,text/xml,*/*",
      "user-agent": "Mozilla/5.0 (compatible; api-hub-proxy/1.0)",
    };
    if (withReferer) headers.referer = VWORLD_REFERER;
    upstream = await fetch(target, { method: "GET", headers });
  } catch (err) {
    const cause = err.cause;
    console.error(JSON.stringify({
      tag: "vworld-fetch-threw", err: err.message, errName: err.name,
      causeCode: cause?.code, causeMessage: cause?.message, target,
    }));
    return send(res, 502, {
      ok: false, error: `upstream fetch error: ${err.message}`,
      cause: cause ? { code: cause.code, message: cause.message } : undefined,
    });
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") || "";
  console.log(JSON.stringify({
    tag: "vworld-response", status: upstream.status, elapsed: Date.now() - t0,
    contentType: ct, cfRay: upstream.headers.get("cf-ray") || "",
    bodyPrefix: buf.toString("utf8", 0, Math.min(200, buf.length)),
  }));
  send(res, upstream.status, buf, ct || undefined);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`api-hub-proxy (standalone) listening on 0.0.0.0:${PORT}`);
});
