// api-hub-proxy — V World OpenAPI 패스스루.
//
// 왜 존재하나: Cloudflare Workers → api.vworld.kr 호출이 차단됨 (Cloudflare↔Cloudflare
// 라우팅 단계에서 502/520). 비-Cloudflare 호스트(Render)에서 돌리면 일반 인터넷 경로로
// 나가 정상 통과. api-hub 워커가 이 프록시를 거쳐 V World 호출.
//
// 인증: Authorization: Bearer <PROXY_TOKEN>
// 라우팅:
//   GET /health
//   GET /vworld/:service?<query>     service ∈ {address, search, data, image, identify}
//
// 응답: V World 응답 본문/상태/Content-Type 패스스루.

import Fastify from "fastify";

const PROXY_TOKEN = process.env.PROXY_TOKEN;
if (!PROXY_TOKEN) {
  console.error("FATAL: PROXY_TOKEN env var required");
  process.exit(1);
}

const VWORLD_BASE = "https://api.vworld.kr/req";
const VWORLD_REFERER = process.env.VWORLD_REFERER || "https://sedamtax.kr/";
const ALLOWED_SERVICES = new Set(["address", "search", "data", "image", "identify"]);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" },
  bodyLimit: 1_048_576, // 1MB
});

app.get("/health", async () => ({ ok: true, name: "api-hub-proxy" }));

app.get("/vworld/:service", async (req, reply) => {
  // 인증
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${PROXY_TOKEN}`) {
    reply.code(401);
    return { ok: false, error: "unauthorized" };
  }

  const { service } = req.params;
  if (!ALLOWED_SERVICES.has(service)) {
    reply.code(404);
    return { ok: false, error: `unknown service: ${service}` };
  }

  // 들어온 쿼리 그대로 V World로 전달
  const qs = req.url.split("?")[1] || "";
  const target = `${VWORLD_BASE}/${service}${qs ? "?" + qs : ""}`;

  let upstream;
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
    req.log.error({ err: err.message }, "vworld fetch failed");
    reply.code(502);
    return { ok: false, error: `upstream fetch error: ${err.message}` };
  }

  // 응답 패스스루 — 본문 buffer로 받아 그대로 전달 (이미지 포함)
  const buf = Buffer.from(await upstream.arrayBuffer());
  reply.code(upstream.status);
  const ct = upstream.headers.get("content-type");
  if (ct) reply.header("content-type", ct);
  return buf;
});

const port = parseInt(process.env.PORT || "3000", 10);
const host = "0.0.0.0";
app.listen({ port, host }).then(() => {
  app.log.info(`api-hub-proxy listening on ${host}:${port}`);
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
