# air-guitar

웹캠 앞에서 손동작으로 기타 코드를 잡고 스트럼을 하면 소리가 나는 토이 웹앱.
링크만 보내면 친구가 카메라 권한 한 번 주고 바로 칠 수 있게 만든 게 목표.

## 사용법 (3줄)
1. 페이지 열고 **START** → 카메라 권한 허용.
2. **왼손**으로 코드 모양(아래 표) 만들고, **오른손**을 위에서 아래로 휘둘러 스트럼.
3. 손이 거꾸로 잡히면 키보드 **S**를 눌러 양손 매핑 swap.

## Latency 측정 (T1 spike)
`latency spike mode` 체크박스를 켜고 양손으로 박수를 10번 → 우상단 stats 박스에 평균/최댓값/last10 표시.
GATE: `avg < 150ms` PASS.

## Chord ↔ 손모양 매핑

| Chord | 손가락 (T=엄지 I=검지 M=중지 R=약지 P=새끼) | 별명 |
|------|------|------|
| **E**  | · · · · · | 주먹 ✊ |
| **D**  | · I · · · | 검지만 ☝️ |
| **C**  | T · · · · | 엄지만 👍 |
| **Em** | · I M · · | 브이 ✌️ |
| **A**  | · I · · P | 록 사인 🤘 |
| **Am** | · I M R · | 손가락 3개 |
| **Dm** | T I M · · | 권총/총 모양 |
| **G**  | · I M R P | 손가락 4개 (엄지 접음) |
| **F**  | T I M R P | 손바닥 활짝 🖐 |

## Strum
- 오른손 wrist의 vertical velocity가 임계값을 넘으면 발화.
- 아래로 = **down**, 위로 = **up**. Cooldown 110ms.

## 브라우저 권장
- **Chrome (Apple Silicon Mac)**. WebGPU+WebAudio가 가장 안정적.
- Safari (17+)도 동작은 하나 latency가 다소 높을 수 있음.
- HTTPS 필수 (getUserMedia). GitHub Pages는 자동 HTTPS.

## 스택
Vite + TypeScript (vanilla) · [@mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) HandLandmarker · Web Audio API.

## 사운드 출처
모든 chord/ping 사운드는 코드 안에서 **Karplus-Strong 알고리즘**으로 실시간 합성한다 (`src/audio.ts`).
외부 sample 의존성 없음 → 라이센스 이슈 없음, 추가 다운로드 없음.

## 개발
```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # dist/ 산출
npm test             # 합성 landmark/wrist motion 단위 테스트
npm run cold-load    # 배포 URL의 cold path 자산 fetch 시간 측정
```

## 자체 검증 (사용자 환경 의존 게이트 제외)
- `npm test`: idealized 21-landmark 픽스처 9개 → chord classifier 9/9 통과. 합성 wrist y motion → 10 alternating down + 10 up + idle false-pos 0.
- `npm run cold-load`: 배포 URL + Vite bundle + MediaPipe WASM + 모델 시퀀셜 fetch 1초대 (30s 예산의 5% 미만).
- 실제 카메라 latency / 사용자 손 인식률 / 친구 테스트는 사용자가 직접 측정.

## 배포
`master` push → GitHub Actions가 `dist/`를 GitHub Pages로 발행.

## Known limitations
- 손이 카메라에서 잘리면 인식 끊김.
- 9개 코드 매핑은 표준 기타 운지가 아니라 "에어 기타용" 약속된 손동작 (위 표 기준).
- 첫 페이지 진입 직후 첫 frame은 MediaPipe WASM/모델 로딩 때문에 1~2초 느림 → 그 뒤로는 실시간.
