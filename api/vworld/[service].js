// Vercel Serverless Function — V World OpenAPI 패스스루.
//
// 왜 Vercel인가: Cloudflare Workers → V World(CF 뒤) 라우팅이 차단됨. Render Singapore도
// outbound가 차단됨. Vercel은 AWS Lambda 기반으로 outbound IP가 분산되어 V World가 단일
// 대역을 차단하기 어려움.
//
// 인증: Authorization: Bearer <PROXY_TOKEN>
// 라우팅: GET /api/vworld/[service]?<query>  (service ∈ address|search|data|image|identify)
//   - Vercel의 dynamic route `[service]` 가 폴더명/파일명 매칭으로 service 추출
//   - 응답: V World status/content-type 그대로 패스스루

const VWORLD_BASE = "https://api.vworld.kr/req";
const VWORLD_REFERER = process.env.VWORLD_REFERER || "https://sedamtax.kr/";
const ALLOWED_SERVICES = new Set(["address", "search", "data", "image", "identify"]);

export default async function handler(req, res) {
  const PROXY_TOKEN = process.env.PROXY_TOKEN;
  if (!PROXY_TOKEN) {
    return res.status(500).json({ ok: false, error: "PROXY_TOKEN env var not set" });
  }
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "GET only" });
  }
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${PROXY_TOKEN}`) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const { service } = req.query;
  if (!ALLOWED_SERVICES.has(service)) {
    return res.status(404).json({ ok: false, error: `unknown service: ${service}` });
  }

  // req.url은 "/api/vworld/address?service=..." 형태. ? 이후만 추출.
  const qs = (req.url || "").split("?")[1] || "";
  const target = `${VWORLD_BASE}/${service}${qs ? "?" + qs : ""}`;

  let upstream;
  const t0 = Date.now();
  try {
    upstream = await fetch(target, {
      method: "GET",
      headers: {
        accept: "application/json,*/*",
        "user-agent": "Mozilla/5.0 (compatible; api-hub-proxy/1.0)",
        referer: VWORLD_REFERER,
      },
    });
  } catch (err) {
    const cause = err.cause;
    console.error(JSON.stringify({
      tag: "vworld-fetch-threw",
      err: err.message,
      errName: err.name,
      causeCode: cause?.code,
      causeMessage: cause?.message,
      target,
    }));
    return res.status(502).json({
      ok: false,
      error: `upstream fetch error: ${err.message}`,
      cause: cause ? { code: cause.code, message: cause.message } : undefined,
    });
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const elapsed = Date.now() - t0;
  const ct = upstream.headers.get("content-type") || "";
  console.log(JSON.stringify({
    tag: "vworld-response",
    status: upstream.status,
    elapsed,
    contentType: ct,
    cfRay: upstream.headers.get("cf-ray") || "",
    server: upstream.headers.get("server") || "",
    bodyPrefix: buf.toString("utf8", 0, Math.min(200, buf.length)),
  }));
  res.status(upstream.status);
  if (ct) res.setHeader("content-type", ct);
  res.send(buf);
}
