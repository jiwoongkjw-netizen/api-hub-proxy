# api-hub-proxy (Vercel)

api-hub 워커가 직접 호출 못 하는 외부 API를 우회하는 비-Cloudflare 프록시. 현재 **V World 전용**.

## 왜 Vercel인가

`api.vworld.kr`는 Cloudflare 뒤에 있는데:
- Cloudflare Workers → V World: CF↔CF 라우팅에서 502/520 (V World 측 차단)
- Render Singapore → V World: outbound IP 차단으로 502 (V World 측 차단)
- **Vercel (AWS Lambda 기반) → V World**: outbound IP가 광범위·분산이라 차단 회피

## 구조

```
api/
  health.js              GET /api/health           헬스체크 (인증 없음)
  vworld/[service].js    GET /api/vworld/<svc>?... V World 패스스루
                         <svc> ∈ address|search|data|image|identify
                         헤더: Authorization: Bearer <PROXY_TOKEN>
vercel.json              Vercel 빌드 설정 (Serverless Functions 자동 감지)
package.json             dependencies 없음, Node 20
```

## 배포 (Vercel)

1. **GitHub에 push** (이미 되어 있다면 skip)
2. https://vercel.com → **Sign in with GitHub** → **Add New → Project**
3. `api-hub-proxy` repo 선택 → **Import**
4. Framework Preset: **Other**, Root Directory: 기본값
5. **Environment Variables** 추가:
   - `PROXY_TOKEN` — api-hub의 `VWORLD_PROXY_TOKEN`과 동일하게 박을 강한 문자열
   - `VWORLD_REFERER` (선택, 기본 `https://sedamtax.kr/`)
6. **Deploy** 클릭 → 1분 후 URL 받음 (예: `https://api-hub-proxy.vercel.app` 또는 `https://api-hub-proxy-<해시>-<팀>.vercel.app`)

## api-hub와 연결

api-hub 측 secret 갱신:

```powershell
# Vercel 배포 URL을 받은 다음
$payload = @{
  VWORLD_PROXY_BASE = "https://<vercel-url>"
  VWORLD_PROXY_TOKEN = "<위 PROXY_TOKEN과 동일>"
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText("C:\dev\api-hub\.secrets-tmp.json", $payload, [System.Text.UTF8Encoding]::new($false))
npx wrangler secret bulk .secrets-tmp.json
Remove-Item .secrets-tmp.json
```

api-hub의 `src/routes/vworld.ts`가 두 secret을 보고 자동으로 프록시 경유로 호출. proxy URL 패턴은 `${VWORLD_PROXY_BASE}/api/vworld/<service>?<query>`.

## 한계

- Vercel 무료(Hobby) plan: 함수 실행 100GB-Hours/월. V World 호출 같은 경량 트래픽엔 충분
- Cold start: ~300ms. 빈번 호출 시 warm 유지
- 함수 실행 시간 한도: 10초 (Hobby) / 60초 (Pro). V World 응답은 보통 0.2~1초라 안전
