# Oracle Cloud 춘천 VM 배포 절차 (api-hub-proxy standalone)

V World가 비-한국 클라우드 IP를 차단하므로, 한국 IDC(Oracle Cloud 춘천) Always Free VM에서 프록시를 돌린다.

## 1. Oracle Cloud 계정 + VM 생성

1. https://www.oracle.com/cloud/free/ → **Start for free**
   - 이메일/카드 인증 (Always Free는 과금 안 됨, 카드는 본인확인용)
   - **Home Region: `South Korea Central (Chuncheon)`** 선택 — ⚠️ 가입 후 변경 불가, 반드시 춘천으로
2. 콘솔 → **Compute → Instances → Create instance**
   - Name: `api-hub-proxy`
   - Image: **Canonical Ubuntu 22.04** (또는 24.04)
   - Shape: **Ampere (ARM) VM.Standard.A1.Flex** — 1 OCPU / 6GB (Always Free 범위)
     - ARM "Out of capacity" 뜨면: **VM.Standard.E2.1.Micro** (x86, 1GB, Always Free)
   - **SSH keys**: "Generate a key pair for me" → **private key 다운로드** (잃어버리면 접속 불가)
   - **Create**
3. 인스턴스 페이지에서 **Public IP** 확인 (예: `152.x.x.x`) — 이게 한국 IDC IP

## 2. 방화벽 (Security List) — 포트 8080 열기

콘솔 → Networking → Virtual Cloud Networks → (VCN 클릭) → Security Lists → Default Security List → **Add Ingress Rules**:
- Source CIDR: `0.0.0.0/0`
- IP Protocol: TCP
- Destination Port Range: `8080`
- (api-hub만 호출하므로 인증 토큰으로 보호됨. 더 좁히려면 Cloudflare IP 대역으로 제한 가능)

## 3. VM에 SSH 접속 + 배포

로컬에서 (다운로드한 private key 경로 사용):

```bash
chmod 600 ~/Downloads/ssh-key-*.key       # Windows면 권한 무시 가능
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP>
```

VM 안에서:

```bash
# Node 20 설치
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 코드 가져오기
git clone https://github.com/jiwoongkjw-netizen/api-hub-proxy.git
cd api-hub-proxy

# 토큰 설정 + 테스트 실행
PROXY_TOKEN='i22ieM54E9Tj5IflCXUjKiQtC_gtEQDd3iicceCWwGetOZiTE34ulqDZ-B0kMmCw' node server-standalone.mjs &
sleep 2
curl -s localhost:8080/health
# V World 직접 테스트:
curl -s -H "Authorization: Bearer i22ieM54E9Tj5IflCXUjKiQtC_gtEQDd3iicceCWwGetOZiTE34ulqDZ-B0kMmCw" \
  "localhost:8080/vworld/address?service=address&request=getcoord&address=서울 강남구 테헤란로 152&type=ROAD&format=json&key=0C82545C-FF71-330D-8EC9-8B7143A1D088"
# → {"response":{"status":"OK",...}} 나오면 V World 통과 성공!
kill %1
```

## 4. systemd 등록 (재부팅 시 자동 시작)

```bash
sudo tee /etc/systemd/system/api-hub-proxy.service > /dev/null <<'EOF'
[Unit]
Description=api-hub-proxy (V World pass-through)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/api-hub-proxy
Environment=PROXY_TOKEN=i22ieM54E9Tj5IflCXUjKiQtC_gtEQDd3iicceCWwGetOZiTE34ulqDZ-B0kMmCw
Environment=VWORLD_REFERER=https://sedamtax.kr/
Environment=PORT=8080
ExecStart=/usr/bin/node /home/ubuntu/api-hub-proxy/server-standalone.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now api-hub-proxy
sudo systemctl status api-hub-proxy --no-pager

# Ubuntu 자체 방화벽도 열기 (Oracle 이미지 기본 iptables)
sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo iptables-save | sudo tee /etc/iptables/rules.v4
```

## 5. 외부에서 접속 확인

로컬에서:
```bash
curl -s http://<PUBLIC_IP>:8080/health
# → {"ok":true,"name":"api-hub-proxy","platform":"standalone"}
```

## 6. api-hub 연결

api-hub 측에서 (Claude가 처리):
```powershell
$payload = @{
  VWORLD_PROXY_BASE  = "http://<PUBLIC_IP>:8080"
  VWORLD_PROXY_TOKEN = "i22ieM54E9Tj5IflCXUjKiQtC_gtEQDd3iicceCWwGetOZiTE34ulqDZ-B0kMmCw"
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText("C:\dev\api-hub\.secrets-tmp.json", $payload, [System.Text.UTF8Encoding]::new($false))
npx wrangler secret bulk .secrets-tmp.json
Remove-Item .secrets-tmp.json
# 그 다음 vworld.* enabled=1 토글 + smoke-test
```

## 비용

Always Free 범위 내 영구 무료. ARM A1.Flex 1 OCPU/6GB 또는 E2.1.Micro 1GB 둘 다 Always Free. 트래픽도 월 10TB egress 무료라 V World 호출 정도는 무료.

## 주의

- **Home Region을 춘천으로 안 했으면** Always Free VM이 다른 나라 IDC에 생성됨 → V World 또 막힘. 가입 시점에 반드시 South Korea Central 선택.
- Oracle은 60일간 인스턴스 미사용 시 회수할 수 있음 (Free Tier 정책). api-hub가 주기적으로 호출하면 사용 중으로 간주되어 회수 안 됨.
