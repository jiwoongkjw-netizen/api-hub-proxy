// Vercel Serverless Function — health check.
// 인증 없음. 외부 모니터링/UptimeRobot 등이 호출.

export default function handler(req, res) {
  res.status(200).json({ ok: true, name: "api-hub-proxy", platform: "vercel" });
}
