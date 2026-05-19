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

실제 기타 운지 (open-position) 그대로 인식. 왼손을 카메라 쪽으로 들고 진짜 코드 잡는 모양 만들면 됨.

| Chord | 운지 (open position) | 인식 단서 |
|------|------|------|
| **Em** | 중지 5번줄(A) 2번 / 약지 4번줄(D) 2번 | 손가락 2개 (검지·새끼 안 씀) |
| **F**  | 검지 1번 barre / 중지 3번줄 2번 / 약지 5번줄 3번 / 새끼 4번줄 3번 | 손가락 4개 모두 |
| **A**  | 검지·중지·약지 모두 2번 (4·3·2번줄) | 3개 손끝이 한 줄 |
| **D**  | 검지 3번줄 2번 / 중지 1번줄 2번 / 약지 2번줄 3번 | I=M y, R 더 위 (삼각형) |
| **Am** | 검지 2번줄 1번 / 중지 4번줄 2번 / 약지 3번줄 2번 | I y < M=R y, 손은 가운데 |
| **E**  | 검지 3번줄 1번 / 중지 5번줄 2번 / 약지 4번줄 2번 | Am과 같은 패턴 + 손이 왼쪽(낮은 줄) |
| **C**  | 검지 2번줄 1번 / 중지 4번줄 2번 / 약지 5번줄 3번 | 계단 I<M<R, 약지 leftmost |
| **Dm** | 검지 1번줄 1번 / 중지 3번줄 2번 / 약지 2번줄 3번 | 계단 I<M<R, 중지 leftmost |
| **G**  | 중지 6번줄 3번 / 검지 5번줄 2번 / 약지 1번줄 3번 | 가장 넓은 spread (저음·고음 끝) |

권장 자세: 왼손을 가슴 앞에 들고 손등이 카메라 쪽으로 향하게. 진짜 기타를 잡는 듯이 PIP(중간 마디)에서 운지 fingers를 굽힘. 안 쓰는 손가락은 펴거나 접음.

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
npm run cold-load    # 배포 URL cold path 자산 fetch 시간
npm run boot         # 시스템 Chrome으로 headless boot smoke (puppeteer-core)
```

## 자체 검증 (사용자 환경 의존 게이트 제외)
- `npm test`: idealized 21-landmark 픽스처 9개 → chord classifier 9/9 통과. 합성 wrist y motion → 10 alternating down + 10 up + idle false-pos 0.
- `npm run cold-load`: 배포 URL + Vite bundle + MediaPipe WASM + 모델 시퀀셜 fetch 1초대 (30s 예산의 5% 미만).
- `npm run boot`: 시스템 Chrome으로 nav→running 1.3s (헤드리스 fake 카메라).
- `npm run perf`: `?perf-test=1` 모드를 헤드리스로 돌려 audio baseLatency/outputLatency + MediaPipe inference time 실측.
- 실제 손 인식률 / 친구 테스트는 사용자가 직접 측정.

## Latency 직접 측정 (사용자 setup)
`/?perf-test=1` URL로 들어가서 버튼 한 번 누르면 화면에 표시:
- `audio baseLatency` / `outputLatency` — 사용자의 오디오 디바이스가 보고하는 출력 지연
- `mediapipe inference` — 사용자 머신에서 GPU 추론 시간
- `total end-to-end ≈ audio + mediapipe + 35ms 카메라 가정` — < 150ms면 PASS

**중요**: outputLatency는 디바이스마다 크게 다름.
- 빌트인 스피커 / 유선 헤드셋: 보통 5–30ms → 전체 50–80ms (PASS)
- Bluetooth (AirPods 등): 100–250ms → 전체 150–300ms (FAIL 가능)
- HDMI 모니터 스피커: 보통 100–200ms (FAIL 가능)

게이트 측정 시 빌트인 스피커 / 유선 헤드셋 사용 권장.

## 배포
`master` push → GitHub Actions가 `dist/`를 GitHub Pages로 발행.

## Known limitations
- 손이 카메라에서 잘리면 인식 끊김.
- 9개 코드 매핑은 표준 기타 운지가 아니라 "에어 기타용" 약속된 손동작 (위 표 기준).
- 첫 페이지 진입 직후 첫 frame은 MediaPipe WASM/모델 로딩 때문에 1~2초 느림 → 그 뒤로는 실시간.
