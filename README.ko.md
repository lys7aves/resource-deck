# ResourceDeck

[English documentation](README.md)

ResourceDeck은 소수의 Linux 서버를 SSH로 모니터링하는 로컬·읽기 전용 대시보드입니다. 모니터링 대상 서버에 에이전트를 설치하지 않고 시스템, GPU, 사용자, Docker, GPU 프로세스 귀속 정보를 표시합니다.

Docker 수명 주기, 프로세스 제어, 원격 설정 변경 명령은 전송하지 않습니다. 대시보드는 로컬 전용으로 `localhost` 또는 loopback IP bind 주소만 허용하고 로컬 브라우저 요청을 검증하며, SSH 비밀번호나 개인 키를 저장하지 않습니다.

## 요구 사항

- Python 3.12 이상
- 프런트엔드 build용 Node.js 18 이상
- 각 모니터링 대상 Linux 서버의 SSH 계정
- Windows 로그인 자동 실행을 사용할 경우: systemd가 활성화된 WSL 2 및 Windows PowerShell

## 1. 서버 연결 준비

### 설정 파일 만들기

```bash
cp config/servers.example.yaml config/servers.yaml
```

### SSH 키 등록하기

ResourceDeck을 실행할 WSL/Linux 계정에서 다음 명령을 실행합니다. 이미 적절한 키가 있다면 계속 사용해도 됩니다.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "resourcedeck"
```

새 host key를 수락하기 전에 SSH가 보여 주는 지문을 서버 콘솔 또는 신뢰할 수 있는 관리자에게서 받은 지문과 비교합니다. 일치하면 수락하면 되고, SSH가 `~/.ssh/known_hosts`에 기록합니다.

```bash
ssh -o StrictHostKeyChecking=ask remote-user@server.example true
```

그다음 공개 키를 원격 계정에 등록합니다. `ssh-copy-id`는 원격 계정 비밀번호를 한 번 물어볼 수 있습니다.

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub remote-user@server.example
```

`ssh-copy-id`를 사용할 수 없다면, 위에서 host key를 검증한 뒤 다음과 같은 동등한 명령을 사용합니다.

```bash
cat ~/.ssh/id_ed25519.pub | ssh remote-user@server.example 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
```

원격 계정에는 자신의 `~/.ssh/authorized_keys`를 만들고 수정할 권한이 필요합니다. `StrictHostKeyChecking=no` 또는 검증하지 않은 `ssh-keyscan` 결과로 host key 검증을 건너뛰지 마세요.

### 연결 확인하기

`ssh_host`에 넣을 host 이름 또는 SSH alias와 동일한 값을 사용합니다.

```bash
ssh remote-user@server.example
```

원격 계정 비밀번호를 묻지 않고 연결되어야 합니다. 개인 키에 passphrase가 있다면 SSH agent를 통해 사용할 수 있게 설정합니다. ResourceDeck은 신뢰된 `known_hosts` 파일이 필요하며 기본 경로는 `~/.ssh/known_hosts`입니다.

### 서버 설정에 추가하기

`config/servers.yaml`에서 host, 계정, tracked user를 설정합니다.

```yaml
app:
  bind: 127.0.0.1
  port: 8765

servers:
  - id: server-a
    enabled: true
    display_name: Server A
    ssh_host: server.example
    ssh_user: remote-user
    ssh_known_hosts: ~/.ssh/known_hosts
    tracked_users: [remote-user]
    collectors:
      gpu: auto
      docker: auto
```

- `enabled: false`는 서버를 설정에 남겨 두되 수집을 중지하고 대시보드에서 숨깁니다.
- `tracked_users`는 서버 상세 화면의 기본 사용자 목록입니다. 비워 두면 기본으로 모든 사용자를 표시합니다.
- 서버가 GPU 또는 Docker 정보를 제공하지 않는 경우 collector를 `off`로 설정합니다.

## 2. 설치하고 실행하기

Python 환경을 만들고 ResourceDeck을 설치한 뒤, 프런트엔드를 build하고 앱을 실행합니다.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"

cd frontend
npm install
npm run build
cd ..

.venv/bin/resourcedeck
```

브라우저에서 <http://127.0.0.1:8765>을 엽니다. 포그라운드 실행은 `Ctrl+C`로 중지합니다.

## 3. 수동 서비스 실행

systemd user service를 수동 모드로 설치합니다. 설치 스크립트는 현재 checkout, `.venv`, `config/servers.yaml`의 절대 경로를 사용합니다.

```bash
./deploy/service.sh install --manual
./deploy/service.sh start
./deploy/service.sh status
./deploy/service.sh stop
```

수동 모드는 Windows 로그인 시 또는 WSL이 시작될 때 ResourceDeck을 자동으로 시작하지 않습니다.

## 4. Windows 로그인 후 자동 실행

systemd가 활성화된 WSL 2에서는 앞의 설치와 설정을 마친 뒤 자동 실행을 설치합니다.

```bash
./deploy/service.sh install --autostart
```

이 명령은 systemd user service를 enable하고 시작하며, user lingering을 활성화하고 현재 WSL 배포판용 Windows 예약 작업을 만듭니다. 이 작업은 현재 Windows 사용자가 로그인한 뒤에만 WSL을 시작하며, Windows 비밀번호를 저장하지 않고 로그인 전에는 실행되지 않습니다.

자동 실행만 중지하고 수동 서비스 실행은 유지하려면 다음을 사용합니다.

```bash
./deploy/service.sh disable-autostart
```

생성된 systemd unit과 Windows 예약 작업을 제거하려면 다음을 사용합니다.

```bash
./deploy/service.sh uninstall
```

다른 user service가 user lingering을 사용할 수 있으므로 uninstall은 이를 의도적으로 유지합니다. 사용하지 않음을 확인한 뒤에만 해제합니다.

```bash
loginctl disable-linger $USER
```

## 5. 설정 변경하기

ResourceDeck은 약 1초마다 `config/servers.yaml`을 확인합니다. 서버, 수집 주기, collector, tracked user, owner hint, 선택적 Codex provider의 유효한 변경은 서비스를 재시작하지 않아도 적용됩니다. 잘못된 변경이 있어도 마지막 유효 설정은 계속 사용됩니다.

실행 중인 서버가 현재 주소와 포트에 이미 bind되어 있으므로 `app.bind` 또는 `app.port`를 변경한 경우에만 서비스 재시작이 필요합니다. `app.bind`에는 `localhost`, `127.0.0.1`, `::1`처럼 loopback IP 주소만 사용할 수 있으며 외부·와일드카드·LAN 주소는 거부됩니다.

대시보드의 **Manage servers** 페이지에서는 로컬 머신에서 서버를 추가·수정·삭제·순서 변경·활성/비활성 전환할 수 있습니다. 드래그 핸들이나 위/아래 버튼으로 순서를 바꾸면 동일한 설정 파일에 카드 위치가 저장되며, 대시보드 카드에서도 드래그 핸들로 순서를 바꿀 수 있습니다. 이 페이지는 SSH 자격 증명을 저장하지 않습니다.

## 선택 기능: Codex 사용량과 GPU 귀속

로컬에서 로그인한 Codex 계정의 남은 사용량을 표시하려면 다음을 추가합니다. `executable`에는 `command -v codex`가 반환하는 절대 경로를 넣습니다.

```yaml
providers:
  codex:
    enabled: true
    executable: /absolute/path/to/codex
    poll_seconds: 60
    reconnect_seconds: 15
    timeout_seconds: 15
```

ResourceDeck은 사용량만 읽으며 로그인, 크레딧 구매, reset 실행을 하지 않습니다. Codex 사용량을 활성화해도 대시보드는 로컬 연결만 허용합니다.

서버 상세 화면에서는 GPU PID → container → owner 귀속을 표시할 수 있습니다. 근거의 신뢰도를 표시하며 원시 cgroup 내용은 노출하지 않습니다.

## 오류 해결

먼저 다음 명령으로 상태와 로그를 확인합니다.

```bash
systemctl --user is-active resourcedeck.service
journalctl --user -u resourcedeck.service -f
curl http://127.0.0.1:8765/healthz
```

| 증상 | 확인 및 해결 |
| --- | --- |
| 대시보드가 열리지 않거나 서비스가 비활성 상태 | `./deploy/service.sh status`를 실행하고 `./deploy/service.sh start`로 시작합니다. 시작 오류는 service log를 확인합니다. 포그라운드로 실행했다면 `.venv/bin/resourcedeck`을 시작한 터미널을 유지해야 합니다. |
| `/healthz`에 `config_file_missing` 또는 설정 reload 오류가 표시됨 | `config/servers.yaml`이 존재하고 올바른 YAML인지 확인합니다. 잘못된 변경은 현재 활성 설정을 바꾸지 않으므로 파일을 수정한 뒤 약 1초 기다립니다. |
| 서버가 Offline/Degraded이거나 snapshot이 없음 | ResourceDeck을 실행하는 머신에서 설정한 `ssh_host`, 사용자, 키와 정확히 같은 값으로 `ssh`를 실행합니다. 대상 계정, 네트워크 접근, `ssh_known_hosts` 경로, 신뢰한 지문과 host key의 일치를 확인합니다. 대시보드나 로그에서 collector별 오류도 확인합니다. |
| bind 주소 또는 포트를 바꿨는데 반영되지 않음 | 실행 중인 앱을 재시작하거나 `./deploy/service.sh stop` 후 `./deploy/service.sh start`를 실행합니다. 재시작이 필요한 설정은 `app.bind`, `app.port`뿐입니다. |
| 앱이 bind 주소를 거부함 | `localhost`, `127.0.0.1`, `::1`을 사용합니다. ResourceDeck은 와일드카드·LAN·외부 bind 주소를 지원하지 않습니다. |
| Codex 사용량을 볼 수 없음 | `providers.codex.enabled`가 true인지, `executable`이 존재하는 절대 경로인지, 로컬 Codex 계정이 로그인 상태인지 확인합니다. 대시보드는 연결을 재시도하는 동안 사용량을 사용할 수 없다고 표시합니다. |
| Windows 로그인 후 자동 실행되지 않음 | WSL systemd 활성화 여부를 확인하고 `./deploy/service.sh install --autostart`를 다시 실행합니다. `ResourceDeck-<WSL distribution>` 이름의 Windows 예약 작업이 있는지도 확인합니다. |
