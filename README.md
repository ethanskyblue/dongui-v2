# 🌿 동의보감 AI 한의사 v2

동의보감(東醫寶鑑) AI 상담 앱 — Cloudtype 배포 버전

---

## 🏗️ 아키텍처

```
[사용자 브라우저]
      ↓ HTTP 요청
[Express 서버 (Cloudtype)]
      ↓ ANTHROPIC_API_KEY (환경변수)
[Anthropic Claude API]
      ↓ 응답
[pdfkit으로 한글 PDF 생성]
```

---

## 🔐 보안 기능

| 기능 | 내용 |
|------|------|
| **API 키 보호** | Cloudtype 환경변수 저장, 코드에 노출 없음 |
| **Rate Limiting** | 채팅: IP당 분당 20회 / PDF: 분당 5회 |
| **CORS 제한** | `ALLOWED_ORIGINS` 환경변수로 허용 도메인 제한 |
| **입력값 제한** | 백엔드에서 300자 초과 요청 강제 차단 |

---

## 🚀 Cloudtype 배포 방법

### 1단계: GitHub 업로드

```bash
git init
git add .
git commit -m "동의보감 AI v2"
git branch -M main
git remote add origin https://github.com/본인ID/dongui-v2.git
git push -u origin main
```

### 2단계: Cloudtype 연결

1. [cloudtype.io](https://cloudtype.io) 접속 → GitHub 로그인
2. **새 프로젝트** → **GitHub 저장소** 선택
3. `dongui-v2` 저장소 선택
4. 런타임: **Node.js** 선택

### 3단계: 환경변수 설정

Cloudtype 대시보드 → **환경변수** 탭:

| 변수명 | 값 | 필수 |
|--------|-----|------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | ✅ 필수 |
| `ALLOWED_ORIGINS` | `https://앱URL.cloudtype.app` | 권장 |
| `PORT` | `3000` | 자동 설정 |

### 4단계: 배포

- **배포** 버튼 클릭 → 자동 빌드 (npm install → node server.js)
- 완료 후 `https://xxx.cloudtype.app` URL로 접속

---

## 📁 파일 구조

```
dongui-v2/
├── server.js              # Express 서버 (API, PDF, Rate Limit, CORS)
├── package.json
├── .cloudtype.yaml        # Cloudtype 설정
├── public/
│   ├── index.html         # 모바일 웹 UI
│   └── home_image.png     # 홈 화면 배경 이미지
├── fonts/
│   ├── NanumGothic.ttf    # 한글 폰트 (PDF용)
│   └── NanumGothicBold.ttf
└── data/
    ├── donguibogam_1.txt  # 동의보감 원문 1~8권
    └── ...
```

---

## 📄 PDF 기능

- 상담 후 우측 하단 **📄 버튼** 클릭
- 서버에서 **pdfkit + NanumGothic** 한글 폰트로 PDF 생성
- 질문/답변이 구분된 깔끔한 레이아웃으로 저장

---

> ⚕️ 이 앱은 교육 목적으로 전통 한의학 지식을 제공합니다.
> 전문 의료진의 진단 및 치료를 대체할 수 없습니다.
