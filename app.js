/* =========================
   0) 전역 상태 & 유틸
========================= */
const state = {
  strokes: [],     // {strokeId, points:[{x,y,t,p}], color, thickness}
  isDrawing: false,
  currentStroke: null,
  pen: { color: '#000000', size: 3 },
  mode: 'pen',     // 'pen' | 'eraser' (MVP: eraser는 stroke 제거 대신 clear만 제공)
  dpi: 300,
  results: {
    blocks: [],    // 지금은 단일 블록: [{id,type,bbox,strokeIds,conf,lines:[...]}]
    aggregate: {}
  },
  lowConfThreshold: 0.85
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const ink = $('#ink');
const ctx = ink.getContext('2d');
const statusEl = $('#status');

/* 캔버스 좌표 변환 */
function getPos(evt) {
  const rect = ink.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (ink.width / rect.width);
  const y = (evt.clientY - rect.top) * (ink.height / rect.height);
  const t = performance.now();
  const p = evt.pressure ?? 0.5;
  return { x, y, t, p };
}

/* 간단 스무딩: 인접선 보간 */
function drawSegment(prev, curr, stroke) {
  const size = stroke.thickness;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(prev.x, prev.y);
  ctx.lineTo(curr.x, curr.y);
  ctx.stroke();
}

/* 전체 다시 그리기 (향후 eraser 대비) */
function redrawAll() {
  ctx.save();
  ctx.clearRect(0, 0, ink.width, ink.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ink.width, ink.height);
  for (const s of state.strokes) {
    for (let i = 1; i < s.points.length; i++) {
      drawSegment(s.points[i - 1], s.points[i], s);
    }
  }
  ctx.restore();
}

/* =========================
   1) Ink Capture
========================= */
function startStroke(evt) {
  state.isDrawing = true;
  const pt = getPos(evt);
  const stroke = {
    strokeId: 's_' + (state.strokes.length + 1).toString().padStart(3, '0'),
    color: state.pen.color,
    thickness: state.pen.size,
    points: [pt]
  };
  state.currentStroke = stroke;
  state.strokes.push(stroke);
}

function moveStroke(evt) {
  if (!state.isDrawing || !state.currentStroke) return;
  const prev = state.currentStroke.points[state.currentStroke.points.length - 1];
  const curr = getPos(evt);
  state.currentStroke.points.push(curr);
  drawSegment(prev, curr, state.currentStroke);
}

function endStroke() {
  state.isDrawing = false;
  state.currentStroke = null;
}

/* =========================
   2) 블록 추출 (MVP: 단일 블록)
========================= */
function getBlockBBoxFromStrokes(strokes) {
  if (strokes.length === 0) return [0, 0, 0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(ink.width, maxX + pad);
  maxY = Math.min(ink.height, maxY + pad);
  return [minX, minY, maxX - minX, maxY - minY];
}

/* 수식 후보 간단 감지: 연산자/괄호 밀도 */
function isLikelyMath(text) {
  const ops = (text.match(/[+\-*/=^(){}\[\]√∑∫π%]/g) || []).length;
  const digits = (text.match(/[0-9]/g) || []).length;
  return (ops + digits) >= Math.max(4, text.length * 0.25);
}

/* =========================
   3) 오프스크린 렌더 → OCR
========================= */
async function rasterizeBlockAndOCR() {
  if (state.strokes.length === 0) {
    setStatus('필기가 없습니다. 먼저 캔버스에 써 주세요.');
    return;
  }
  setStatus('블록 추출 중…');
  const bbox = getBlockBBoxFromStrokes(state.strokes);
  const [x, y, w, h] = bbox;

  // 오프스크린 렌더 (흰 배경, 고해상도)
  const scale = Math.max(1, Math.floor(state.dpi / 96));
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.floor(w * scale));
  off.height = Math.max(1, Math.floor(h * scale));
  const octx = off.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, off.width, off.height);
  octx.save();
  octx.scale(scale, scale);
  octx.drawImage(ink, -x, -y);
  octx.restore();

  // Tesseract 설정(한글)
  setStatus('한글 OCR 중… (Tesseract.js)');
  const worker = Tesseract.create({
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@2/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@2/tesseract-core.wasm.js',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0' // kor 데이터
  });

  let textResult = '';
  let tokens = [];
  try {
    const { data } = await worker.recognize(off, 'kor+eng', {
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK
    });
    textResult = data.text.trim();
    tokens = (data.words || []).map(w => ({
      value: w.text,
      conf: w.conf / 100,
      bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0]
    }));
  } catch (e) {
    console.error(e);
    setStatus('OCR 오류: ' + e.message);
  } finally {
    // v2 API에서는 terminate() 없음. worker.reinitialize 방지: noop
  }

  // 수식/텍스트 분기 + MVP LaTeX 규칙 변환
  const blockType = isLikelyMath(textResult) ? 'math' : 'text';
  let latex = '';
  if (blockType === 'math') {
    latex = toLatexMVP(textResult);
  }

  // 결과 조립
  const block = {
    id: 'blk_001',
    type: blockType,
    bbox: [x, y, w, h],
    strokeIds: state.strokes.map(s => s.strokeId),
    conf: avgConf(tokens),
    lines: [
      blockType === 'math'
        ? { raw: latex, render: 'latex', tokens, conf: avgConf(tokens) }
        : { raw: textResult, render: 'text', tokens, conf: avgConf(tokens) }
    ]
  };

  state.results.blocks = [block];
  state.results.aggregate = {
    avg_conf: avgConf(tokens),
    low_conf_tokens: tokens.filter(t => t.conf < state.lowConfThreshold).length,
    engine: { korean: 'tesseract.js', math: 'mvp-rules' }
  };

  // UI 반영
  renderOutputs();
  setStatus('완료');
}

/* 평균 confidence */
function avgConf(tokens) {
  if (!tokens || !tokens.length) return 0;
  const s = tokens.reduce((a, b) => a + (b.conf ?? 0), 0);
  return +(s / tokens.length).toFixed(3);
}

/* MVP: 간단 LaTeX 변환기 (정교한 수식 OCR 엔진 대체용) */
function toLatexMVP(s) {
  let t = s;

  // 공백/특수문자 정리
  t = t.replace(/[“”]/g, '"').replace(/[’‘]/g, "'").trim();

  // 분수 패턴 a/b -> \frac{a}{b} (간단)
  t = t.replace(/([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)/g, '\\frac{$1}{$2}');

  // 지수: a^2 -> a^{2}
  t = t.replace(/([A-Za-z0-9\)\]])\^([A-Za-z0-9(]+)/g, '$1^{ $2 }');

  // 루트: sqrt( ) → \sqrt{ }
  t = t.replace(/sqrt\s*\(\s*(.*?)\s*\)/g, '\\\\sqrt{$1}');

  // 곱점: . → \cdot (숫자 사이)
  t = t.replace(/(\d)\.(\d)/g, '$1. $2'); // 실수 소수점 보호
  t = t.replace(/([A-Za-z0-9])\s*\*\s*([A-Za-z0-9])/g, '$1 \\\\cdot $2');

  // 괄호 정리
  t = t.replace(/\(/g, '(').replace(/\)/g, ')');

  // 등호 주변 공백
  t = t.replace(/\s*=\s*/g, ' = ');

  // 최종 래핑(블록 수식)
  return t;
}

/* =========================
   4) UI: 결과/탭/저장/복사
========================= */
function setStatus(msg) {
  statusEl.textContent = msg;
}

function renderOutputs() {
  const textOut = $('#textOut');
  const latexOut = $('#latexOut');
  const jsonOut = $('#jsonOut');
  const previewOut = $('#previewOut');
  const lowConf = $('#lowConfToggle').checked;

  // 텍스트 합본
  const textBlocks = state.results.blocks
    .filter(b => b.type === 'text')
    .map(b => b.lines.map(l => l.raw).join('\n'));
  textOut.innerHTML = highlightLowConf(
    textBlocks.join('\n\n') || '(텍스트 블록 없음)',
    lowConf
  );

  // LaTeX 합본
  const latexBlocks = state.results.blocks
    .filter(b => b.type === 'math')
    .map(b => b.lines.map(l => l.raw).join('\n'));
  latexOut.textContent = latexBlocks.join('\n\n') || '(수식 블록 없음)';

  // 미리보기: KaTeX 렌더
  previewOut.innerHTML = '';
  for (const b of state.results.blocks) {
    const div = document.createElement('div');
    div.style.marginBottom = '12px';
    if (b.type === 'math') {
      try {
        katex.render(b.lines[0].raw, div, { throwOnError: true, displayMode: true });
      } catch (e) {
        div.innerHTML = `<div class="low-conf">LaTeX 구문 오류: ${e.message}</div><pre>${b.lines[0].raw}</pre>`;
      }
    } else {
      div.textContent = b.lines[0].raw;
    }
    previewOut.appendChild(div);
  }

  // JSON
  jsonOut.textContent = JSON.stringify({
    version: '0.2',
    source: { type: 'ink', dpi: state.dpi, canvas: { w: ink.width, h: ink.height } },
    blocks: state.results.blocks,
    aggregate: state.results.aggregate
  }, null, 2);
}

/* 신뢰도 낮은 토큰 간이 표시 (문자열 기반) */
function highlightLowConf(text, enabled) {
  if (!enabled || !state.results.blocks.length) return escapeHTML(text);
  const b = state.results.blocks[0];
  if (!b || !b.lines[0] || !b.lines[0].tokens) return escapeHTML(text);
  // 간단히 평균 conf가 낮으면 전체 강조 (MVP)
  if (b.lines[0].conf < state.lowConfThreshold) {
    return `<span class="low-conf">${escapeHTML(text)}</span>`;
  }
  return escapeHTML(text);
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

/* 저장/복사 */
function download(filename, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* =========================
   5) 이벤트 바인딩
========================= */
function bindEvents() {
  // 펜 입력
  ink.addEventListener('pointerdown', (e) => { ink.setPointerCapture(e.pointerId); startStroke(e); });
  ink.addEventListener('pointermove', moveStroke);
  ink.addEventListener('pointerup', endStroke);
  ink.addEventListener('pointercancel', endStroke);
  ink.addEventListener('contextmenu', (e) => e.preventDefault());

  // UI
  $('#clearBtn').addEventListener('click', () => { state.strokes = []; redrawAll(); setStatus('지웠습니다.'); });
  $('#penSize').addEventListener('input', (e) => state.pen.size = +e.target.value);
  $('#penColor').addEventListener('input', (e) => state.pen.color = e.target.value);
  $('#recognizeBtn').addEventListener('click', rasterizeBlockAndOCR);
  $('#recognizeAllBtn').addEventListener('click', rasterizeBlockAndOCR); // 현재는 단일 블록

  // 탭
  $$('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $$('.panel').forEach(p => p.classList.add('hidden'));
      $('#panel-' + tab).classList.remove('hidden');
    });
  });

  // 복사/저장
  $('#copyBtn').addEventListener('click', () => {
    const btn = $$('.tabs button.active')[0];
    const tab = btn?.dataset.tab ?? 'text';
    const map = { text: '#textOut', latex: '#latexOut', preview: '#previewOut', json: '#jsonOut' };
    const el = $(map[tab]);
    const text = (tab === 'preview') ? el.innerText : el.textContent;
    navigator.clipboard.writeText(text || '').then(() => setStatus('복사 완료')).catch(()=>setStatus('복사 실패'));
  });
  $('#saveTxt').addEventListener('click', () => {
    const text = $('#textOut').innerText;
    download('result.txt', text);
  });
  $('#saveTex').addEventListener('click', () => {
    const tex = $('#latexOut').innerText;
    download('result.tex', tex);
  });
  $('#saveJson').addEventListener('click', () => {
    const json = $('#jsonOut').innerText;
    download('result.json', json);
  });

  // 신뢰도 토글
  $('#lowConfToggle').addEventListener('change', renderOutputs);

  // 단축키
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#clearBtn').click(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#recognizeBtn').click(); }
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); $('#recognizeAllBtn').click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); $('#copyBtn').click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('#saveJson').click(); }
    if (e.key.toLowerCase() === 'p') { state.mode = 'pen'; setStatus('펜 모드'); }
    if (e.key.toLowerCase() === 'e') { setStatus('지우기는 전체 지우기 버튼 사용(MVP)'); }
    if (['1','2','3'].includes(e.key)) { setStatus('탭 전환: 상단 버튼 사용 (MVP)'); }
  });
}

/* 초기화: 흰 배경 */
function initCanvas() {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ink.width, ink.height);
}

/* =========================
   6) 시작
========================= */
window.addEventListener('load', () => {
  initCanvas();
  bindEvents();
  setStatus('대기 중 — 캔버스에 손글씨를 작성하세요.');
});
