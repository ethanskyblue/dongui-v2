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

// 증상 키워드 → 한자 매핑
function searchDonguibogam(symptoms) {
  const keywordMap = {
    '두통': ['頭痛', '頭疼', '腦痛', '頭風'],
    'headache': ['頭痛', '頭疼', '頭風'],
    '복통': ['腹痛', '肚痛', '腹疼', '胃痛'],
    '기침': ['咳嗽', '咳逆', '嗽', '肺咳'],
    'cough': ['咳嗽', '咳逆', '肺咳'],
    '소화': ['消化', '脾胃', '食積', '不食', '脾虛'],
    '감기': ['傷風', '傷寒', '感冒', '風寒'],
    'cold': ['傷風', '傷寒', '感冒', '風寒'],
    '발열': ['發熱', '熱症', '壯熱', '潮熱'],
    'fever': ['發熱', '熱症', '壯熱'],
    '설사': ['泄瀉', '下利', '腹瀉'],
    '변비': ['便秘', '大便難', '大便秘'],
    '불면': ['不眠', '失眠', '不得眠', '不寐'],
    'insomnia': ['不眠', '失眠', '不寐'],
    '어지러움': ['眩暈', '頭暈', '眩冒'],
    '요통': ['腰痛', '腰疼', '腎虛'],
    'back': ['腰痛', '腰疼'],
    '피로': ['虛勞', '氣虛', '精力'],
    'fatigue': ['虛勞', '氣虛'],
    '관절': ['關節', '痺症', '痛痺'],
    '피부': ['皮膚', '瘡', '疥'],
    '월경': ['月經', '月事', '婦人'],
    '심장': ['心臟', '心痛', '心悸'],
    '간': ['肝臟', '肝氣', '肝病'],
    '신장': ['腎臟', '腎虛', '腰腎'],
  };

  const lowerSymptoms = symptoms.toLowerCase();
  let searchTerms = [];
  for (const [keyword, chinese] of Object.entries(keywordMap)) {
    if (lowerSymptoms.includes(keyword)) {
      searchTerms.push(...chinese);
    }
  }

  let relevantPassages = [];
  if (searchTerms.length === 0) return relevantPassages;

  for (const vol of donguibogamTexts) {
    const lines = vol.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const hasMatch = searchTerms.some(term => line.includes(term));
      if (hasMatch) {
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length - 1, i + 8);
        const passage = lines.slice(start, end + 1).join('\n');
        relevantPassages.push({ volume: vol.volume, passage: passage.trim() });
        i = end;
      }
    }
  }
  return relevantPassages.slice(0, 15);
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

  const systemPrompt = `You are an AI expert in Dongeuibogam (東醫寶鑑), a classic Korean medicine encyclopedia written by physician Heo Jun in 1613. You kindly guide users based on the wisdom of traditional Korean medicine.

Role:
- Listen to the user's symptoms and explain from a traditional Korean medicine perspective
- Interpret Chinese characters from the original text in modern language
- Suggest traditional remedies (herbal medicines, acupuncture, lifestyle treatments)
- Always recommend visiting a modern medical institution for serious symptoms

Response format:
1. 📋 **증상 분석** - Symptom interpretation
2. 📜 **동의보감 처방** - Original text reference and interpretation
3. 🌿 **추천 처방** - Recommended herbs, foods, lifestyle remedies
4. ⚠️ **주의사항** - Medical precautions

CRITICAL: Always respond in the SAME language the user used.
- Korean message → Korean response
- English message → English response
- French message → French response
- Japanese message → Japanese response

Maintain a warm, friendly, and professional tone.
When citing Dongeuibogam text, provide Chinese characters with modern interpretation.

⚕️ Disclaimer: Educational purposes only. Not a substitute for professional medical diagnosis.${contextText}`;

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
        model: 'claude-opus-4-5',
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
