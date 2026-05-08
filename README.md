# api-hub-proxy

api-hub 워커가 직접 호출 못 하는 외부 API를 우회하는 비-Cloudflare 프록시. 현재 **V World 전용**.

## 왜 필요한가

`api.vworld.kr`는 Cloudflare 뒤에 있는데, Cloudflare Workers → Cloudflare 호스트 라우팅에서 502/520이 발생한다. PowerShell 직접 호출, 일반 서버에서의 호출은 정상 — Workers 출구만 막힘. 이 프록시는 Render(비-Cloudflare 인프라)에서 돌면서 일반 인터넷 경로로 V World에 접근한다.

## 배포 (Render)

1. **GitHub에 push** (이미 되어 있다면 skip)
2. https://render.com → New → **Blueprint** → 이 repo 선택 → Apply
3. 환경변수 입력:
   - `PROXY_TOKEN` — 임의 강한 문자열. **api-hub 워커의 `VWORLD_PROXY_TOKEN` secret과 동일하게 박아야 함**
   - `VWORLD_REFERER` (기본 `https://sedamtax.kr/`) — V World 마이페이지 등록 도메인
4. 배포 완료 후 URL 받음 (예: `https://api-hub-proxy.onrender.com`)

## API

```
GET /health
→ { "ok": true, "name": "api-hub-proxy" }

GET /vworld/<service>?<query>
Authorization: Bearer <PROXY_TOKEN>
→ V World 응답 패스스루 (status·content-type 보존)
```

`<service>` ∈ `address | search | data | image | identify`

## api-hub와 연결

api-hub 측에 두 개의 secret 추가:

```bash
# C:\dev\api-hub
echo '{"VWORLD_PROXY_BASE":"https://api-hub-proxy.onrender.com","VWORLD_PROXY_TOKEN":"<위와_동일_토큰>"}' \
  | Set-Content -Encoding utf8 .secrets-tmp.json
npx wrangler secret bulk .secrets-tmp.json
Remove-Item .secrets-tmp.json
```

api-hub의 `src/routes/vworld.ts`가 이 두 시크릿을 보고 자동으로 프록시 경유로 호출.

## 한계

- Render free tier는 15분 idle 후 sleep — 첫 호출 cold start 5-15초
- 트래픽이 항상 발생하면 자동으로 깨어있음. 초기 검증 후 cron으로 1분마다 `/health` 핑하면 깨움 유지 가능 (UptimeRobot 등 외부 모니터링 활용)
- 무료 플랜은 월 750시간 (한 service 24h × 31일 ≈ 744h) 안에서 무제한
