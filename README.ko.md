# ResourceDeck

[English documentation](README.md)

ResourceDeck은 소수의 Linux 서버를 SSH로 모니터링하는 에이전트리스·읽기 전용 리소스 대시보드입니다. 시스템, GPU, 사용자, Docker, GPU 프로세스 귀속 정보를 수집하며 Docker 수명 주기, 프로세스 제어, 원격 서버 설정 변경 명령은 전송하지 않습니다.

## 주요 기능

- Server-Sent Events 기반의 실시간 서버 snapshot 제공
- 서버 정의, 수집 주기, collector, `tracked_users`, owner hint를 `config/servers.yaml` 변경만으로 자동 reload
- 기본 tracked user 화면과 전체 사용자 보기 토글
- 서버 상세 화면에서 GPU PID → container → owner 매핑 근거 표시
- GPU Docker 귀속을 읽기 전용으로 검증하는 live 확인 명령 제공

## 요구 사항

- Python 3.12 이상
- `$HOME/.ssh/known_hosts`에 신뢰된 host key가 있는 SSH alias 또는 서버별 `ssh_known_hosts` 경로
- 프런트엔드 build·test용 Node.js 18 이상
- 선택 사항: Windows 로그인 자동 실행을 위한 systemd 활성 WSL 2 및 Windows PowerShell

## 빠른 시작

1. 로컬 서버 설정 파일을 만듭니다.

   ```bash
   cp config/servers.example.yaml config/servers.yaml
   ```

2. SSH host, 사용자, tracked user, collector, owner hint를 설정합니다. `tracked_users`가 Users 화면의 기본 목록이며, 비어 있으면 전체 사용자를 기본 표시합니다.

3. 가상환경을 만들고 백엔드를 설치합니다.

   ```bash
   python3.12 -m venv .venv
   .venv/bin/pip install -e ".[dev]"
   ```

4. 프런트엔드를 build하고 앱을 실행합니다.

   ```bash
   cd frontend
   npm install
   npm run build
   cd ..
   .venv/bin/resourcedeck
   ```

브라우저에서 <http://127.0.0.1:8765>을 엽니다.

## 설정 자동 reload와 진단

`config/servers.yaml`은 약 1초마다 확인합니다. 유효한 변경은 API 프로세스 재시작 없이 적용됩니다. 파일에 추가하거나 변경한 서버에는 새 poller가 적용되고, 삭제한 서버는 snapshot stream에서도 제거됩니다.

Uvicorn이 이미 현재 주소와 포트에 bind되어 있으므로 `app.bind`, `app.port` 변경은 service 재시작이 필요합니다. 다음 명령으로 reload 상태를 확인합니다.

```bash
curl http://127.0.0.1:8765/healthz
```

응답에는 마지막 정상 reload 시각, reload 오류, 재시작이 필요한 필드가 포함됩니다.

## Codex 사용량

로컬 Codex 계정의 남은 한도를 대시보드 상단에 표시하려면 `config/servers.yaml`에 다음을 추가합니다. `executable`에는 `command -v codex`의 절대 경로를 사용합니다.

```yaml
providers:
  codex:
    enabled: true
    executable: /absolute/path/to/codex
    reconnect_seconds: 15
    timeout_seconds: 15
```

이 수집기는 App Server 연결을 유지하고 한도 변경 알림으로 대시보드를 갱신합니다. 연결 직후와 재연결 때만 초기 상태를 읽으며, `reconnect_seconds`는 연결이 끊겼을 때의 재시도 간격입니다. 로그인·크레딧 구매·한도 reset은 수행하지 않습니다. Codex 사용량은 ChatGPT Work 등과 공유될 수 있습니다. 기본 bind 주소인 `127.0.0.1`을 외부에 공개하면 이 사용량 정보도 함께 노출될 수 있습니다.

## Users와 GPU 귀속

서버 상세 화면은 `tracked_users`만 먼저 표시합니다. **All users**를 누르면 시스템 계정과 untracked 계정을 포함한 전체 목록을 볼 수 있습니다. tracked user가 현재 실행 중이지 않은 경우에도 시스템 계정을 기본 표시하지 않고 빈 목록을 보여줍니다.

GPU 프로세스 귀속에는 다음 근거와 신뢰도를 표시합니다.

| Source | 의미 | 신뢰도 |
| --- | --- | --- |
| `proc_cgroup` | GPU 프로세스 cgroup에서 container ID 확인 | 높음 |
| `init_pid_ppid_chain` | GPU PID의 부모 체인이 container init PID에 도달 | 중간 |
| `docker_top` | GPU PID가 `docker top` 결과에 존재 | 낮음 |
| `unmapped` | container 근거를 찾지 못함 | 없음 |

원시 cgroup 내용은 UI에 노출하지 않습니다.

## Service 설치와 자동 실행

`deploy/service.sh`는 현재 checkout과 가상환경의 절대 경로를 사용해 user unit을 생성합니다. 공유 checkout에 적합한 기본값은 수동 모드입니다.

```bash
./deploy/service.sh install --manual
./deploy/service.sh start
./deploy/service.sh status
./deploy/service.sh stop
```

선택적 자동 실행 모드는 user unit을 enable하고 linger를 활성화하며, 현재 WSL 배포판을 위한 Windows 예약 작업을 등록합니다. 이 작업은 현재 Windows 사용자가 로그인한 뒤 WSL을 시작합니다. Windows 비밀번호를 저장하지 않으며 로그인 전에는 실행되지 않습니다.

```bash
./deploy/service.sh install --autostart
```

자동 실행만 끄고 수동 실행 가능한 unit은 유지하려면 다음을 실행합니다.

```bash
./deploy/service.sh disable-autostart
```

생성된 unit과 Windows 예약 작업을 모두 제거하려면 다음을 실행합니다.

```bash
./deploy/service.sh uninstall
```

다른 user service가 linger를 사용 중일 수 있으므로 uninstall은 linger를 유지합니다. 안전을 확인한 뒤에만 별도로 해제합니다.

```bash
loginctl disable-linger $USER
```

유용한 service 진단 명령입니다.

```bash
systemctl --user is-active resourcedeck.service
journalctl --user -u resourcedeck.service -f
curl http://127.0.0.1:8765/healthz
```

## 검증

```bash
.venv/bin/pytest -q -s
cd frontend && npm test && npm run build && npm audit --audit-level=moderate
```

GPU workload가 Docker container 내부에서 실행 중일 때 다음 명령으로 GPU PID → container → owner 귀속을 확인합니다.

```bash
./scripts/verify_live_mapping.py
```

현재 매핑이 없으면 exit code 2를 반환합니다. 이 명령은 container나 workload를 시작하지 않습니다.
