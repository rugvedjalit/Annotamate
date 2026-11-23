# Setup guide

This guide takes you from nothing to a running Annotamate server you can sign in to. Every step has a
command to run and the result to expect, so it works the same for a person at a terminal and for an AI
agent running commands. Nothing in it asks for keyboard input unless you choose an interactive option.

- **Time:** about 3 minutes with the setup script, or a few minutes for the first Docker build.
- **Result:** the web app on <http://127.0.0.1:8765/>, an administrator account, and a folder for your datasets.
- **Afterwards:** [administrator guide](administrator.md) to create projects and invite people,
  [deployment guide](deployment.md) to serve a team over HTTPS, [annotator guide](annotator.md) for
  everyday labelling.

## Contents

1. [Choose a path](#1-choose-a-path)
2. [Check the prerequisites](#2-check-the-prerequisites)
3. [Get the code](#3-get-the-code)
4. [Path A: setup script (recommended)](#4-path-a-setup-script-recommended)
5. [Path B: Docker Compose](#5-path-b-docker-compose)
6. [Path C: step by step from source](#6-path-c-step-by-step-from-source)
7. [Path D: development mode](#7-path-d-development-mode)
8. [Create the administrator](#8-create-the-administrator)
9. [Verify the installation](#9-verify-the-installation)
10. [Create your first project](#10-create-your-first-project)
11. [Everyday operations](#11-everyday-operations)
12. [Use it from other machines](#12-use-it-from-other-machines)
13. [Troubleshooting](#13-troubleshooting)
14. [Notes for AI agents and automation](#14-notes-for-ai-agents-and-automation)

## 1. Choose a path

| Path | Use it when | You need | Time |
| --- | --- | --- | --- |
| **A. Setup script** | You want it running on this machine with the least effort (Linux, macOS, Windows) | Python 3.11+, Node.js 24 (or 22.12+), Git | ~3 min |
| **B. Docker Compose** | The machine has Docker, or you want an isolated install for a server | Docker with Compose v2, Git | ~2–5 min first build |
| **C. Step by step** | You want to see or adapt each step that path A automates | same as A | ~5 min |
| **D. Development mode** | You change the code and want live reload | same as A | ~5 min |

All paths start the same server. Paths A and C put it in a virtual environment inside the checkout
(`.venv`); path B runs it in a container. Released wheels and container images (see the
[README](../../README.md#quick-start)) skip the web build entirely once a version has been published.

## 2. Check the prerequisites

Run the checks for your path. The expected output is shown after `#`.

```bash
git --version            # git version 2.x
python3 --version        # Python 3.11.x or newer (Windows: python --version, or py -3 --version)
node --version           # v24.x (v22.12+ or v20.19+ also work)
npm --version            # 10.x or newer
docker compose version   # Docker Compose version v2.x   (path B only)
```

Install what is missing:

| Tool | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Python 3.11+ | `sudo apt install python3 python3-venv` (Debian/Ubuntu), `sudo dnf install python3` (Fedora) | `brew install python@3.13` | `winget install Python.Python.3.13` |
| Node.js 24 | <https://nodejs.org/> or `nvm install 24` | `brew install node@24` | `winget install OpenJS.NodeJS.LTS` |
| Git | `sudo apt install git` | `xcode-select --install` | `winget install Git.Git` |
| Docker | <https://docs.docker.com/engine/install/> | Docker Desktop | Docker Desktop |

On Debian and Ubuntu the `python3-venv` package is required, otherwise creating the virtual
environment fails with "ensurepip is not available".

## 3. Get the code

```bash
git clone https://github.com/rugvedjalit/Annotamate.git
cd Annotamate
```

All later commands run in this folder unless stated otherwise.

## 4. Path A: setup script (recommended)

One command checks Python and Node.js, creates `.venv`, installs Annotamate into it, builds the web
interface and verifies the result:

```bash
python3 scripts/bootstrap.py          # Windows: python scripts\bootstrap.py
```

It prints numbered steps and ends with:

```text
[4/4] Verifying the installation
      ok: annotamate 2.0.0
      ok: web interface present

Setup complete.
```

Options (all can be combined; every run is safe to repeat):

| Option | Effect |
| --- | --- |
| `--admin NAME` | Also create an administrator. The password comes from the environment variable `ANNOTAMATE_ADMIN_PASSWORD`, or is asked for twice when that is not set. |
| `--start` | Start the server when setup is done and wait until it answers (Ctrl+C stops it). |
| `--root PATH` | Folder that projects may use (repeatable). With `--start` and no `--root`, a `datasets` folder in the checkout is created and used. |
| `--port N`, `--host ADDR` | Where `--start` listens (default `127.0.0.1:8765`). |
| `--data-dir PATH` | Where the database and caches go (default: see [where data lives](#where-data-lives)). Pass the same value to every later `annotamate` command. |
| `--dev` | Also install the development tools (pytest, ruff). |
| `--skip-web` | Do not rebuild the web interface (it is already built). |

Everything at once, without any prompt:

```bash
# Linux / macOS
ANNOTAMATE_ADMIN_PASSWORD='choose-a-long-password' python3 scripts/bootstrap.py --admin admin --start --root ~/datasets
```

```powershell
# Windows PowerShell
$env:ANNOTAMATE_ADMIN_PASSWORD = 'choose-a-long-password'
python scripts\bootstrap.py --admin admin --start --root $HOME\datasets
Remove-Item Env:ANNOTAMATE_ADMIN_PASSWORD
```

When the server is up the script prints
`Annotamate is up: open http://127.0.0.1:8765/ (health check ... answered 200)`.
Open that address and sign in. If you did not pass `--start`, start the server as shown in
[everyday operations](#start-and-stop).

## 5. Path B: Docker Compose

```bash
mkdir -p datasets               # your images go here; the container sees this folder as /data
docker compose up -d --build    # builds the image from this checkout and starts it
```

Expected: `Container annotamate-annotamate-1  Started`. The server answers within a few seconds; the
container's health status turns to `healthy` after its first check, about 30 seconds after the start:

```bash
docker compose ps               # STATUS shows "Up ... (healthy)"
curl -s http://127.0.0.1:8765/api/health   # {"status":"ok","version":"2.0.0"}
```

The port is published on this machine only (`127.0.0.1:8765`). Then
[create the administrator](#8-create-the-administrator). With Docker the browser always asks for the
**setup token**, even on the same machine, because requests reach the container through Docker's
network. Print it with:

```bash
docker compose logs annotamate | grep "SETUP TOKEN"
#   FIRST-RUN SETUP TOKEN: oFDVdQR3z-FT_MYIwGEAToQt
```

Or skip the browser step and create the account in the container:

```bash
printf '%s\n' 'choose-a-long-password' | docker compose exec -T annotamate annotamate user create admin --admin --password-stdin
# Created administrator 'admin'.
```

Notes:

- **Datasets:** put image folders inside `./datasets`. In the app they appear under `/data`.
- **File ownership:** the container runs as UID/GID 1000 by default, so label files it writes belong
  to that user. If your user has another ID (`id -u`, `id -g`), create a `.env` file next to
  `docker-compose.yml` with `UID=1001` and `GID=1001` (your values) before `docker compose up`.
- **App data:** the database lives in the Docker volume `annotamate-state` and survives
  `docker compose down` and rebuilds. `docker compose down -v` deletes it.
- **The startup warning** "listening on a non-loopback address without --secure-cookies" is expected
  in a container: the server listens on all interfaces *inside* the container, while the published
  port is still local only. Follow the [deployment guide](deployment.md#7-https-with-a-reverse-proxy)
  before you open it to a network.
- **Without `--build`:** `docker compose up -d` pulls the published image
  `ghcr.io/rugvedjalit/annotamate:latest` and builds it from the checkout when it is not available.
  After `git pull`, always use `--build` so the container runs the new code.

## 6. Path C: step by step from source

This is what the setup script does.

**Linux and macOS**

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --editable .
(cd web && npm ci && npm run build)      # writes annotamate/server/static/
.venv/bin/annotamate --version           # annotamate 2.0.0
mkdir -p datasets
.venv/bin/annotamate serve --root "$PWD/datasets"
```

**Windows PowerShell**

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install --editable .
Push-Location web; npm ci; npm run build; Pop-Location
.\.venv\Scripts\annotamate.exe --version       # annotamate 2.0.0
New-Item -ItemType Directory -Force datasets | Out-Null
.\.venv\Scripts\annotamate.exe serve --root "$PWD\datasets"
```

`serve` prints a banner with the address, the data folder and the roots, and keeps running in the
foreground. You do not need to activate the virtual environment; calling the programs in `.venv`
directly is enough. Without the web build the server still starts, but the page only says
"the web interface has not been built".

## 7. Path D: development mode

For working on the code: the API server and the Vite dev server with live reload, in two terminals.

```bash
python3 scripts/bootstrap.py --dev --skip-web       # once: Python package plus test tools
(cd web && npm ci)                                  # once: web dependencies

# terminal 1: API on 127.0.0.1:8765
.venv/bin/annotamate serve --root "$PWD/datasets"
# terminal 2: web app with live reload on http://localhost:5173 (proxies /api to port 8765)
cd web && npm run dev
```

Open <http://localhost:5173>. Set `ANNOTAMATE_API=http://127.0.0.1:9000` before `npm run dev` when the
API runs on another port. Tests and checks are listed in [CONTRIBUTING.md](../../CONTRIBUTING.md#checks).

## 8. Create the administrator

The first account is the administrator. There are three ways; use one.

| Situation | How |
| --- | --- |
| Browser on the **same machine** as the server (paths A, C, D) | Open <http://127.0.0.1:8765/>, fill in **Create the administrator account**. No token is needed. |
| Browser on **another machine**, through a reverse proxy or tunnel service, or **Docker** | The same screen also asks for the **setup token**. It is printed in the server's console and log at start-up as `FIRST-RUN SETUP TOKEN: ...` (Docker: `docker compose logs annotamate`; systemd: `journalctl -u annotamate`). |
| **Command line** (no browser, scripts, agents) | `annotamate user create admin --admin` asks for the password twice. Non-interactive: `printf '%s\n' "$PASSWORD" \| .venv/bin/annotamate user create admin --admin --password-stdin` |

Use the same `--data-dir` for `user create` as for `serve` if you set one. The token is a one-time
value: it stops working as soon as the first account exists, and it is new after every restart
until then. Usernames are 3–32 characters of `a-z 0-9 _ . -`; passwords need at least 8 characters.

## 9. Verify the installation

```bash
curl -s http://127.0.0.1:8765/api/health
# {"status":"ok","version":"2.0.0"}

curl -s http://127.0.0.1:8765/api/auth/state
# before the first account: {"setup_required":true,"setup_token_required":false,"user":null}
# after it:                 {"setup_required":false,"setup_token_required":false,"user":null}

curl -s -X POST http://127.0.0.1:8765/api/auth/login \
  -H 'Content-Type: application/json' -H 'X-Annotamate-Client: web' \
  -d '{"username":"admin","password":"choose-a-long-password"}'
# {"id":1,"username":"admin",...,"is_admin":true,...}
```

On Windows PowerShell use `curl.exe` (not the `curl` alias) or
`Invoke-RestMethod http://127.0.0.1:8765/api/health`.

In the browser: sign in, and the projects page appears with the Annotamate logo in the sidebar.

## 10. Create your first project

1. Copy an image folder into a dataset root, for example `datasets/cats/` (Docker: `./datasets/cats/`).
   Supported files: `.jpg`, `.jpeg`, `.png`, `.bmp`, `.webp`, `.tif`, `.tiff`.
2. In the app choose **New project**, pick the folder in the folder browser (Docker: under `/data`),
   choose the label format (YOLO, Pascal VOC or COCO) and the classes, and add members.
3. Open the project and start annotating. Existing label files in the chosen format are used as they
   are.

Projects can only use folders inside a root (`--root`, or `ANNOTAMATE_ROOTS` with several folders
separated by `:`, or `;` on Windows). The [administrator guide](administrator.md#4-creating-a-project)
explains every option.

## 11. Everyday operations

### Start and stop

| | Setup script / from source | Docker Compose |
| --- | --- | --- |
| Start | `.venv/bin/annotamate serve --root /path/to/datasets` (Windows: `.\.venv\Scripts\annotamate.exe serve --root C:\path\to\datasets`) | `docker compose up -d` |
| Stop | Ctrl+C in its terminal | `docker compose stop` |
| Logs | the terminal running `serve` | `docker compose logs -f annotamate` |
| Run at boot | systemd unit in the [deployment guide](deployment.md#6-systemd-service) | `restart: unless-stopped` is already set |

### Update

```bash
git pull
python3 scripts/bootstrap.py          # path A (or repeat the steps of path C), then restart serve
docker compose up -d --build          # path B
```

Database migrations run automatically at start-up. Back up first for important data
([backups](deployment.md#11-backups)).

### Where data lives

| What | Where |
| --- | --- |
| Images and label files | your dataset folders; Annotamate writes labels next to the images or into the label folder you chose |
| Database, caches | `--data-dir` / `ANNOTAMATE_DATA_DIR`, default `%LOCALAPPDATA%\Annotamate` (Windows), `$XDG_DATA_HOME/annotamate` or `~/.local/share/annotamate` (Linux, macOS); Docker: the `annotamate-state` volume |

### Accounts from the command line

```bash
.venv/bin/annotamate user list
.venv/bin/annotamate user passwd admin                          # asks for the new password
printf '%s\n' "$NEW_PASSWORD" | .venv/bin/annotamate user passwd admin --password-stdin
docker compose exec annotamate annotamate user list             # the same inside Docker
```

### Uninstall

Stop the server, then delete the checkout (it contains `.venv` and the web build) and the data
folder. Docker: `docker compose down -v` removes the container and its database volume. Your
dataset folders and label files are never deleted by these steps.

## 12. Use it from other machines

The server listens on `127.0.0.1` by default, so only this machine can reach it. To use it from
elsewhere:

- **Just you, on a remote server:** keep it on `127.0.0.1` and forward the port over SSH:
  `ssh -N -L 8765:127.0.0.1:8765 you@server`, then open <http://localhost:8765> on your laptop.
- **A team:** put it behind HTTPS with Caddy or nginx, turn on `ANNOTAMATE_SECURE_COOKIES=true`, and
  follow the [deployment guide](deployment.md), which covers systemd, Docker, reverse proxies and
  backups.

Do not serve it on a public network over plain HTTP: passwords and session cookies would travel
unencrypted.

## 13. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Python 3.11 or newer is required` | An older Python ran the script | Run it with a newer one: `python3.13 scripts/bootstrap.py`, or on Windows `py -3.13 scripts\bootstrap.py`. |
| `ensurepip is not available` while creating `.venv` | Debian/Ubuntu without the venv module | `sudo apt install python3-venv`, delete `.venv`, run again. |
| `Node.js (with npm) is needed` or `Node.js ... is too old` | Node.js is missing or older than 20.19 / 22.12 | Install Node.js 24 LTS and run again. |
| The page says "the web interface has not been built" | The web build was skipped or failed | `cd web && npm ci && npm run build`, or the setup script without `--skip-web`; reload the page. |
| `address already in use` / `[Errno 10048]` on start | Port 8765 is taken | Stop the other process, or `serve --port 8780` (Docker: change the left side of `127.0.0.1:8765:8765`). |
| The setup screen asks for a token on the same machine | You use Docker, a reverse proxy or a tunnel | Take the token from the log (`FIRST-RUN SETUP TOKEN`), or create the account on the command line ([section 8](#8-create-the-administrator)). |
| Setup token is "missing or wrong" | The server restarted (new token) or the value was mistyped | Use the token from the latest start in the log. |
| `The folder is outside the folders this server may access` | The dataset is not under a root | Restart `serve` with `--root` pointing at a parent folder (Docker: place it under `./datasets`). |
| Docker: label files cannot be written (`Permission denied`) | The container's UID/GID does not own `./datasets` | Set `UID` and `GID` in `.env` ([path B](#5-path-b-docker-compose)) and run `docker compose up -d`. |
| `403 {"code":"csrf"}` from your own API calls | Writes need the CSRF header | Send `X-Annotamate-Client: web` with every POST/PUT/PATCH/DELETE. |
| `429 rate_limited` on sign-in | Too many wrong passwords | Wait for the time in `Retry-After`, or reset the password on the command line. |
| `503 busy` on sign-in | Many sign-ins at the same moment | Retry after `Retry-After` (2 s). |
| Forgot the administrator password | – | `annotamate user passwd admin` on the server (Docker: `docker compose exec annotamate annotamate user passwd admin`). |

More cases, including proxies, sub-paths and PostgreSQL, are in the
[deployment guide's troubleshooting section](deployment.md#14-troubleshooting).

## 14. Notes for AI agents and automation

Agents working on the code should also read [AGENTS.md](../../AGENTS.md). For setting the app up:

- **Never block on a prompt.** Use `scripts/bootstrap.py --admin NAME` with `ANNOTAMATE_ADMIN_PASSWORD`
  set, or `annotamate user create NAME --admin --password-stdin` with the password on standard input.
  Do not pass passwords as command-line arguments: other users can see them in the process list.
- **Long-running server.** `annotamate serve` and `bootstrap.py --start` run in the foreground. Start
  them as a background process and poll `GET /api/health` until it returns
  `{"status":"ok",...}` (usually within 2–5 seconds) instead of sleeping for a fixed time.
- **Success checks.** `bootstrap.py` exits with 0 on success and 1 with a `Setup failed: ...` line on
  stderr otherwise. `annotamate --version` prints `annotamate 2.0.0`. The files
  `annotamate/server/static/index.html` and `.venv` exist after a successful setup.
- **API calls.** Sign in with `POST /api/auth/login` and keep the `annotamate_session` cookie; every
  write needs the `X-Annotamate-Client: web` header. The full API is in [docs/api.md](../api.md).
- **Stopping.** Stop the server process you started (Ctrl+C, or kill its process tree). Docker:
  `docker compose stop` (keeps data) or `docker compose down` (removes the container, keeps the
  `annotamate-state` volume).
- **Paths.** Use absolute paths for `--root` and `--data-dir`. On Windows the programs are in
  `.venv\Scripts\`, elsewhere in `.venv/bin/`.
