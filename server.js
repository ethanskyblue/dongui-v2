const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================
// 환경변수에서 API 키 로드 (Cloudtype 환경변수로 설정)
// =============================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
}

// =============================================================
// CORS 설정 - Cloudtype 도메인만 허용
// =============================================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// 개발환경 허용
ALLOWED_ORIGINS.push('http://localhost:3000');
ALLOWED_ORIGINS.push('http://127.0.0.1:3000');

app.use(cors({
  origin: (origin, callback) => {
    // 동일 출처(origin 없음) 또는 허용 목록에 있으면 허용
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS 차단: ${origin}`);
      callback(new Error('CORS 정책에 의해 차단된 요청입니다.'));
    }
  },
  credentials: true
}));

// =============================================================
// Rate Limiting - IP당 분당 최대 20회 요청
// =============================================================
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1분
  max: 20,                    // 최대 20회
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 1분 후 다시 시도해 주세요.' },
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress
});

const pdfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'PDF 생성 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =============================================================
// 동의보감 원문 로딩
// =============================================================
let donguibogamTexts = [];

function loadDonguibogamTexts() {
  const dataDir = path.join(__dirname, 'data');
  for (let i = 1; i <= 8; i++) {
    const filePath = path.join(dataDir, `donguibogam_${i}.txt`);
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      donguibogamTexts.push({ volume: i, text });
      console.log(`📖 제${i}권 로드: ${text.length.toLocaleString()}자`);
    } catch (e) {
      console.warn(`제${i}권 로드 실패:`, e.message);
    }
  }
  console.log(`✅ 총 ${donguibogamTexts.length}권 로드 완료`);
}

// 증상 키워드 → 한자 매핑 (한국어·영어 지원, 증상별 풍부한 원문 검색)
const KEYWORD_MAP = {
  // 두통·머리
  '두통': ['頭痛', '頭疼', '腦痛', '頭風', '偏頭痛'],
  '머리': ['頭痛', '頭風', '腦'],
  '편두통': ['偏頭痛', '頭風'],
  'headache': ['頭痛', '頭疼', '頭風'],
  // 소화·위장
  '소화': ['消化', '脾胃', '食積', '不食', '脾虛'],
  '위': ['胃痛', '脾胃', '胃'],
  '복통': ['腹痛', '肚痛', '腹疼', '胃痛'],
  '배': ['腹痛', '腹疼', '脾胃'],
  '체함': ['食積', '脾虛', '消食'],
  '더부룩': ['食積', '脾胃', '痞'],
  '구토': ['嘔吐', '惡心', '嘔逆'],
  '메스꺼움': ['惡心', '嘔吐', '嘔逆'],
  'stomach': ['胃痛', '脾胃', '腹痛'],
  // 호흡기
  '기침': ['咳嗽', '咳逆', '嗽', '肺咳', '咳'],
  '가래': ['痰', '痰嗽', '痰飮'],
  '천식': ['哮喘', '氣喘', '喘息'],
  '감기': ['傷風', '傷寒', '感冒', '風寒', '外感'],
  '콧물': ['鼻涕', '鼻淵', '傷風'],
  '코막힘': ['鼻塞', '鼻淵'],
  '목아픔': ['咽喉', '喉痛', '咽痛'],
  'cough': ['咳嗽', '咳逆', '肺咳'],
  'cold': ['傷風', '傷寒', '感冒', '風寒'],
  // 발열·한열
  '발열': ['發熱', '熱症', '壯熱', '潮熱'],
  '열': ['發熱', '熱症', '壯熱'],
  '오한': ['惡寒', '惡風', '寒熱'],
  '냉증': ['寒冷', '冷症', '惡寒'],
  '손발냉': ['手足冷', '四肢冷'],
  'fever': ['發熱', '熱症', '壯熱'],
  // 배변
  '설사': ['泄瀉', '下利', '腹瀉', '洞泄'],
  '변비': ['便秘', '大便難', '大便秘', '燥結'],
  '혈변': ['便血', '下血'],
  'diarrhea': ['泄瀉', '下利'],
  'constipation': ['便秘', '大便難'],
  // 수면
  '불면': ['不眠', '失眠', '不得眠', '不寐'],
  '잠': ['不眠', '失眠', '不寐'],
  '수면': ['不眠', '失眠'],
  'insomnia': ['不眠', '失眠', '不寐'],
  // 어지러움
  '어지러움': ['眩暈', '頭暈', '眩冒', '頭眩'],
  '어지럼': ['眩暈', '頭暈', '眩冒'],
  '현기증': ['眩暈', '頭暈'],
  'dizziness': ['眩暈', '頭暈'],
  // 근골격
  '요통': ['腰痛', '腰疼', '腎虛', '腰脊'],
  '허리': ['腰痛', '腰疼', '腰脊'],
  '관절': ['關節', '痺症', '痛痺', '骨痛'],
  '무릎': ['膝痛', '膝關節', '痺症'],
  '어깨': ['肩痛', '肩背'],
  '근육': ['筋肉', '筋痛', '拘攣'],
  'back pain': ['腰痛', '腰疼'],
  'joint': ['關節', '痺症'],
  // 피로·기력
  '피로': ['虛勞', '氣虛', '精力', '疲勞', '倦怠'],
  '기력': ['氣虛', '虛勞', '元氣'],
  '무기력': ['氣虛', '虛勞', '倦怠'],
  '허약': ['虛弱', '氣虛', '虛勞'],
  'fatigue': ['虛勞', '氣虛'],
  'weakness': ['虛弱', '氣虛'],
  // 피부
  '피부': ['皮膚', '瘡', '疥', '癬'],
  '가려움': ['瘙癢', '痒', '風癢'],
  '두드러기': ['風疹', '癮疹'],
  '여드름': ['面瘡', '面疱'],
  'skin': ['皮膚', '瘡', '癬'],
  // 순환기·심장
  '심장': ['心臟', '心痛', '心悸'],
  '가슴': ['胸痛', '胸悶', '心痛'],
  '두근거림': ['心悸', '怔忡', '驚悸'],
  '혈압': ['血壓', '肝陽'],
  'heart': ['心臟', '心痛', '心悸'],
  // 간·신장
  '간': ['肝臟', '肝氣', '肝病'],
  '신장': ['腎臟', '腎虛', '腰腎'],
  // 부인과
  '월경': ['月經', '月事', '婦人', '經'],
  '생리': ['月經', '月事', '月水'],
  '냉대하': ['帶下', '白帶'],
  'menstruation': ['月經', '月事'],
  // 정신·신경
  '스트레스': ['鬱', '氣鬱', '肝鬱'],
  '우울': ['憂鬱', '鬱症', '氣鬱'],
  '불안': ['驚悸', '恐悸'],
  '건망증': ['健忘'],
  'stress': ['鬱', '氣鬱'],
  // 당뇨·대사
  '당뇨': ['消渴', '糖尿'],
  '갈증': ['消渴', '口渴', '渴'],
  // 눈·귀·코
  '눈': ['目', '眼', '目痛'],
  '귀': ['耳', '耳鳴', '耳聾'],
  '이명': ['耳鳴', '耳'],
  '코': ['鼻', '鼻淵', '鼻塞'],
};

function searchDonguibogam(symptoms) {
  const lowerSymptoms = symptoms.toLowerCase();
  let searchTerms = new Set();

  // 키워드 매핑으로 한자 검색어 수집
  for (const [keyword, chineseTerms] of Object.entries(KEYWORD_MAP)) {
    if (lowerSymptoms.includes(keyword.toLowerCase())) {
      chineseTerms.forEach(t => searchTerms.add(t));
    }
  }

  // 매핑 실패 시: 사용자 입력에서 직접 한자 추출
  if (searchTerms.size === 0) {
    const chineseChars = symptoms.match(/[一-鿿]+/g);
    if (chineseChars) chineseChars.forEach(c => searchTerms.add(c));
  }

  // 여전히 없으면 일반 처방 키워드로 검색
  const generalTerms = searchTerms.size === 0
    ? ['治', '方', '藥', '湯', '丸', '散']
    : [...searchTerms];

  let relevantPassages = [];

  for (const vol of donguibogamTexts) {
    const lines = vol.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.length < 3) continue;

      const matchCount = generalTerms.filter(t => line.includes(t)).length;
      if (matchCount > 0) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length - 1, i + 12);
        const passage = lines.slice(start, end + 1)
          .filter(l => l.trim().length > 0)
          .join('\n');
        if (passage.length > 10) {
          relevantPassages.push({
            volume: vol.volume,
            passage: passage.trim(),
            score: matchCount
          });
        }
        i = end;
      }
    }
  }

  // 관련도 높은 순 정렬 후 상위 10개 반환
  return relevantPassages
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// =============================================================
// Chat API
// =============================================================
app.post('/api/chat', apiLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API 키가 서버에 설정되지 않았습니다. 관리자에게 문의하세요.' });
  }

  const { messages, userMessage } = req.body;

  // ── 입력값 검증 ──────────────────────────────────────────
  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ error: '메시지가 없습니다.' });
  }

  const trimmed = userMessage.trim();
  if (trimmed.length === 0) {
    return res.status(400).json({ error: '메시지를 입력해 주세요.' });
  }

  // 최대 300자 제한 (백엔드 강제)
  if (trimmed.length > 300) {
    return res.status(400).json({ error: '메시지는 최대 300자까지 입력할 수 있습니다.' });
  }

  // 대화 이력 검증
  if (messages && (!Array.isArray(messages) || messages.length > 50)) {
    return res.status(400).json({ error: '대화 이력이 너무 깁니다.' });
  }

  // ── 동의보감 원문 검색 ───────────────────────────────────
  const passages = searchDonguibogam(trimmed);
  let contextText = '';
  if (passages.length > 0) {
    contextText = '\n\n[동의보감 관련 원문 발췌]\n';
    passages.slice(0, 8).forEach(p => {
      contextText += `\n--- 제${p.volume}권 ---\n${p.passage}\n`;
    });
  }

  const systemPrompt = `당신은 조선시대 명의 허준이 1613년에 저술한 동의보감(東醫寶鑑)을 깊이 연구한 전통 한의학 전문 AI입니다.

사용자가 건강 상태나 아픈 증상을 말하면, 동의보감 원문을 직접 인용하고 해석하여 처방을 제시합니다.

[역할]
- 사용자의 증상을 듣고 동의보감 원문을 찾아 한의학적으로 해석합니다
- 원문의 한자를 현대어로 풀어 누구나 이해하기 쉽게 설명합니다
- 약재, 음식, 생활요법 등 실천 가능한 처방을 구체적으로 제시합니다
- 심각한 증상은 반드시 현대 의료기관 방문을 권고합니다

[응답 형식 - 반드시 이 순서로 작성]
1. 📋 **증상 분석**
   - 한의학 관점에서 해당 증상의 원인과 의미를 설명합니다
   - 어떤 장기나 기(氣)·혈(血)·음양(陰陽)과 관련이 있는지 설명합니다

2. 📜 **동의보감 원문 처방**
   - 관련 원문을 한자로 인용하고 바로 아래에 현대어 해석을 제공합니다
   - 예: 原文: "頭痛者 風熱上攻也" → 해석: "두통은 풍열이 위로 치솟는 것이다"
   - 어느 권(내경편·외형편·잡병편 등)에서 인용했는지 명시합니다

3. 🌿 **추천 처방**
   - 약재: 구체적인 약재명과 복용법 (예: 인삼 10g, 황기 15g을 물에 달여 하루 2회)
   - 음식: 도움이 되는 식이요법
   - 생활요법: 침구, 마사지, 운동, 수면 등

4. ⚠️ **주의사항**
   - 이 처방에서 피해야 할 음식이나 행동
   - 현대 의학적 관점에서의 추가 조언
   - 증상이 지속되면 병원 방문 권고

[언어 규칙]
- 사용자가 한국어로 쓰면 → 한국어로 답변
- 사용자가 영어로 쓰면 → 영어로 답변 (섹션 헤더도 영어로)
- 사용자가 일본어로 쓰면 → 일본어로 답변
- 사용자가 사용한 언어로 반드시 답변할 것

항상 따뜻하고 친절한 어조를 유지하며, 전문적이면서도 이해하기 쉽게 설명합니다.

⚕️ 면책 고지: 이 정보는 전통 한의학 교육 목적으로 제공되며, 전문 의료진의 진단을 대체할 수 없습니다.${contextText}`;

  try {
    const apiMessages = messages && messages.length > 0
      ? messages
      : [{ role: 'user', content: trimmed }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: apiMessages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText.slice(0, 200));
      if (response.status === 401) {
        return res.status(500).json({ error: 'API 키가 유효하지 않습니다.' });
      }
      return res.status(500).json({ error: 'AI 응답 오류가 발생했습니다.' });
    }

    const data = await response.json();
    const assistantMessage = data.content[0]?.text || '';

    res.json({ message: assistantMessage, passagesFound: passages.length });

  } catch (error) {
    console.error('Server error:', error.message);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// =============================================================
// PDF 생성 API (pdfkit + 한글 NanumGothic 폰트)
// =============================================================
app.post('/api/pdf', pdfLimiter, async (req, res) => {
  const { conversations, title } = req.body;

  if (!conversations || !Array.isArray(conversations) || conversations.length === 0) {
    return res.status(400).json({ error: '저장할 대화 내용이 없습니다.' });
  }

  const fontPath = path.join(__dirname, 'fonts', 'NanumGothic.ttf');
  const fontBoldPath = path.join(__dirname, 'fonts', 'NanumGothicBold.ttf');

  if (!fs.existsSync(fontPath)) {
    return res.status(500).json({ error: '한글 폰트 파일을 찾을 수 없습니다.' });
  }

  try {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 60, bottom: 60, left: 60, right: 60 },
      info: {
        Title: '동의보감 AI 한의사 상담 기록',
        Author: 'Dongui Bogam AI',
        Subject: '전통 한의학 AI 상담',
        Creator: 'Dongui Bogam AI v2'
      }
    });

    // 폰트 등록
    doc.registerFont('NanumGothic', fontPath);
    doc.registerFont('NanumGothicBold', fontBoldPath);

    // 응답 헤더
    const now = new Date();
    const dateStr = now.toLocaleDateString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).replace(/\. /g, '-').replace('.', '');
    const filename = encodeURIComponent(`동의보감_상담기록_${dateStr}.pdf`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    doc.pipe(res);

    const pageWidth = doc.page.width - 120; // 좌우 여백 제외
    const GREEN = '#2D5016';
    const GOLD  = '#8B6914';
    const GRAY  = '#666666';
    const LIGHT_GREEN_BG = '#F0F7E8';

    // ── 헤더 ──────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 100).fill(GREEN);
    doc.font('NanumGothicBold').fontSize(22).fillColor('#FFFFFF')
      .text('🌿 동의보감 AI 한의사', 60, 28, { align: 'center', width: pageWidth });
    doc.font('NanumGothic').fontSize(11).fillColor('rgba(255,255,255,0.8)')
      .text('東醫寶鑑 · 전통 한의학 AI 상담 기록', 60, 58, { align: 'center', width: pageWidth });

    // 날짜
    const fullDate = now.toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    doc.font('NanumGothic').fontSize(9).fillColor('rgba(255,255,255,0.7)')
      .text(`출력일시: ${fullDate}`, 60, 78, { align: 'center', width: pageWidth });

    doc.y = 120;

    // ── 제목 (있을 경우) ──────────────────────────────────
    if (title) {
      doc.font('NanumGothicBold').fontSize(14).fillColor(GREEN)
        .text(title, 60, doc.y, { width: pageWidth });
      doc.moveDown(0.5);
      doc.moveTo(60, doc.y).lineTo(60 + pageWidth, doc.y).stroke(GREEN);
      doc.moveDown(0.8);
    }

    // ── 대화 내용 ─────────────────────────────────────────
    conversations.forEach((conv, idx) => {
      // 페이지 넘김 여부 체크
      if (doc.y > doc.page.height - 150) {
        doc.addPage();
        doc.y = 60;
      }

      if (conv.role === 'user') {
        // 사용자 질문 박스
        const boxY = doc.y;
        const textHeight = doc.heightOfString(conv.content, {
          font: 'NanumGothic', fontSize: 10, width: pageWidth - 80
        }) + 20;

        doc.roundedRect(60, boxY, pageWidth, textHeight + 20, 6)
          .fill('#E8F5D8');
        doc.font('NanumGothicBold').fontSize(9).fillColor(GREEN)
          .text('나 (질문)', 75, boxY + 8, { width: pageWidth - 30 });
        doc.font('NanumGothic').fontSize(10).fillColor('#1a1a1a')
          .text(conv.content, 75, boxY + 22, { width: pageWidth - 30, lineGap: 2 });
        doc.y = boxY + textHeight + 28;

      } else if (conv.role === 'assistant') {
        // AI 답변 박스
        const boxY = doc.y;

        // 마크다운 제거하여 순수 텍스트 추출
        const cleanText = conv.content
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/^#{1,3} /gm, '')
          .replace(/^[\-\*] /gm, '• ');

        const textHeight = doc.heightOfString(cleanText, {
          font: 'NanumGothic', fontSize: 10, width: pageWidth - 80
        });

        doc.roundedRect(60, boxY, pageWidth, textHeight + 40, 6)
          .fill('#FAFFFE');
        doc.moveTo(60, boxY).lineTo(60, boxY + textHeight + 40).lineWidth(3).stroke(GREEN);

        doc.font('NanumGothicBold').fontSize(9).fillColor(GREEN)
          .text('🌿 동의보감 AI 처방', 75, boxY + 8, { width: pageWidth - 30 });
        doc.font('NanumGothic').fontSize(10).fillColor('#1a1a1a')
          .text(cleanText, 75, boxY + 24, { width: pageWidth - 30, lineGap: 3 });
        doc.y = boxY + textHeight + 50;
      }

      // 구분선 (마지막 제외)
      if (idx < conversations.length - 1) {
        if (doc.y > doc.page.height - 100) {
          doc.addPage();
          doc.y = 60;
        }
        doc.moveTo(60, doc.y - 5).lineTo(60 + pageWidth, doc.y - 5)
          .lineWidth(0.5).stroke('#DDDDDD');
        doc.moveDown(0.3);
      }
    });

    // ── 푸터 ──────────────────────────────────────────────
    if (doc.y > doc.page.height - 80) doc.addPage();

    const footerY = doc.page.height - 60;
    doc.moveTo(60, footerY - 10).lineTo(60 + pageWidth, footerY - 10)
      .lineWidth(0.5).stroke('#CCCCCC');
    doc.font('NanumGothic').fontSize(8).fillColor(GRAY)
      .text(
        '⚕️ 이 내용은 전통 한의학 교육 목적으로 제공되며, 전문 의료진의 진단 및 치료를 대체할 수 없습니다.',
        60, footerY, { align: 'center', width: pageWidth }
      );

    doc.end();

  } catch (error) {
    console.error('PDF 생성 오류:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF 생성 중 오류가 발생했습니다.' });
    }
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    volumes: donguibogamTexts.length,
    apiKeySet: !!ANTHROPIC_API_KEY
  });
});

// 시작
loadDonguibogamTexts();
app.listen(PORT, () => {
  console.log(`🌿 동의보감 AI v2 서버 실행 중 (포트: ${PORT})`);
  console.log(`🔑 API 키: ${ANTHROPIC_API_KEY ? '✅ 설정됨' : '❌ 미설정'}`);
  console.log(`🌐 CORS 허용 도메인: ${ALLOWED_ORIGINS.join(', ') || '전체'}`);
});
