1) 범위(Scope, MVP)

잉크 캡처 → 전처리 → 블록/레이아웃 → OCR(한글·수식) → 후처리/검증 → 결과/미리보기 → 내보내기

수정도구(펜 옵션, 지우개 UI 등)는 제외. OCR 파이프라인 품질만 우선 완성.

2) 모듈 경계(필수)

ink-capture: pointerdown/move/up 수집(좌표 x,y, 시간 t, 압력 p, 색상, 두께)

ink-preprocess: 리샘플(2–3px), One-Euro/Kalman 스무딩, 속도→두께 맵핑(1–5px)

layout: 텍스트/수식 블록화(공간+시간 기준), 라인/토큰 그룹핑, bbox 산출

recognition (OCR 핵심):

A. Ink→Vector 인식기(스트로크 기반)

B. Ink→Raster→OCR(블록별 고해상도 offscreen 렌더 후 엔진 호출)

Ensemble 머저: 블록 타입별 가중치로 A/B 결과 통합

postprocess:

한글: 띄어쓰기 랭킹(형태소), 혼동쌍(1/ㅣ/ℓ, 0/O/θ, −/=) 후보 제시/치환

수식: \frac{..}{..}, ^{}, _{} , 괄호짝 검증·자동 보정 제안

LaTeX 구문 검사(파서 통과 실패=버그)

results-ui: 텍스트/LaTeX/미리보기(KaTeX)·JSON 탭, 저신뢰 하이라이트 토글(기본 0.85)

export: TXT / TEX / JSON(스트로크·블록·토큰·conf 포함)

telemetry: 처리시간(p50/p95), 엔진별 conf, 앙상블 결정 근거, 실패 사유

3) OCR 엔진 명세(구체)
3.1 한글 OCR(필수)

인터페이스:
recognizeKorean({ bitmap?: ImageData, strokes?: Stroke[], hintLayout?: LayoutHint }): KoreanOcrResult

서버 추론 우선(정확도/속도 유리). REST POST /ocr/korean (멱등). 입력: 블록 래스터 base64 + 힌트(라인수 등).

온디바이스 WASM 백엔드 선택 가능(성능 저하 시 서버 폴백).

후처리: 띄어쓰기 재랭킹, 혼동쌍 후보, 사용자 사전 훅.

3.2 수식 OCR(필수)

인터페이스:
recognizeMath({ bitmap?: ImageData, strokes?: Stroke[] }): MathOcrResult /* { latex, ast?, tokens[], conf, bboxes[] } */

출력: LaTeX(블록/인라인 구분 가능), 선택적으로 AST.

정규화: \cdot/\times, 분수/근호 스냅, 지수/첨자 묶음 강제.

LaTeX 파서 통과 100%: 실패 시 자동 보정안 + 경고 코드 반환.

3.3 앙상블 규칙(필수)

가중치(기본값):

수식: Vector 0.7 / Raster 0.3

텍스트: Vector 0.3 / Raster 0.7

충돌 해결 우선순위: (1) LaTeX 유효성 → (2) 평균 token-conf → (3) 도메인 사전 일치도

4) 데이터 스키마(계약)

스트로크 입력 예시

{
  "strokeId":"s_001",
  "points":[{"x":123.4,"y":210.2,"t":1711000123456,"p":0.42}],
  "color":"#000000","thickness":2.0
}


블록(레이아웃)

{"id":"blk_01","type":"text|math","bbox":[x,y,w,h],"strokeIds":["s_001","s_007"],"conf":0.90}


최종 결과(JSON)

{
  "version":"0.2",
  "source":{"type":"ink","dpi":300,"canvas":{"w":1200,"h":800}},
  "blocks":[
    {
      "id":"blk_01","type":"math","bbox":[x,y,w,h],"conf":0.92,
      "lines":[
        {
          "raw":"\\frac{a+b}{c}",
          "render":"latex",
          "tokens":[{"value":"\\frac","conf":0.97,"bbox":[...]},{"value":"a","conf":0.95,"bbox":[...]}],
          "alts":[{"raw":"\\frac{a+b}{e}","reason":"low_conf_token:c"}],
          "conf":0.92
        }
      ]
    }
  ],
  "aggregate":{"avg_conf":0.91,"low_conf_tokens":4,
    "engine":{"korean":"server","math":"vector+raster"}}
}

5) UI/UX 요구

좌측: 원본 잉크(블록 하이라이트 토글)

우측 탭: 텍스트 / LaTeX / 미리보기(KaTeX) / JSON

저신뢰 토글(임계치 0.85), 토큰 hover 툴팁(conf·대안), 블록 선택↔원본 싱크

6) 성능·최적화

필기 렌더: OffscreenCanvas + Worker, 60fps 유지

블록 DPI 기본 300(200–450 조절), 래스터 긴 변 ≤1600px

서버 추론 타임아웃 5s, 재시도 1회, 네트워크 오류 시 로컬 폴백

버퍼/메모리 풀링, 단일 이미지 파이프라인 스트림화

7) 보안·개인정보

서버 전송 시 TLS, 스트로크/이미지 즉시 폐기 옵션 제공

로그에는 PII 금지, 샘플 해시·성능·결정 근거만 저장

8) 테스트·수락 기준

골든 스트로크 세트 자동 평가:

레이아웃 F1, 텍스트 CER/WER(한글), LaTeX 파싱 성공률, 지연 p50/p95

수락 조건:

블록 누락/오탐 < 5%

LaTeX 파싱 오류 0%

지연: p50 ≤ 300ms, p95 ≤ 1s(블록 기준)

저신뢰 하이라이트 동작, TXT/TEX/JSON 다운로드 정상

9) 산출물

디렉터리 구조, 환경변수, 의존성, 빌드/실행 방법

단위/통합/회귀 테스트 코드 + 자동 평가 리포트 스크립트

핵심 함수별 시간측정/로그 지점

예제 스트로크 3건에 대한 E2E 스크립트

10) 권장 디렉터리 구조
apps/web            # 캔버스·결과 UI
packages/ocr-core   # 전처리/레이아웃/후처리/스키마/검증
services/ocr-api    # /ocr/korean, /ocr/math, LaTeX 구문검사
tests               # unit/integration/e2e/regression + 골든셋