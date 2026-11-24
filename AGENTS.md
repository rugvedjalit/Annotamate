# AGENTS.md

Instructions for AI coding agents (and anyone automating work) in this repository. People should
read the same files: [README](README.md), [setup guide](docs/guides/setup.md) and
[CONTRIBUTING](CONTRIBUTING.md). This file is the short version, with every command spelled out.

## What this is

Annotamate is a self-hosted, multi-user web app for drawing bounding-box labels on images (YOLO,
Pascal VOC, COCO). A Python package (`annotamate/`, FastAPI + SQLAlchemy + Alembic) serves a
single-page app (`web/`, React + TypeScript + Vite) and a WebSocket hub for presence, edit locks and
chat. Labels are plain files next to the images; the database (SQLite by default) holds users,
projects, workflow state and conversations.

## Set up and run (non-interactive)

Requirements: Python 3.11+, Node.js 24 (22.12+ or 20.19+ also work), Git. Docker is optional.

```bash
# Install into .venv, build the web app, create an admin, without any prompt. Exit code 0 = success.
ANNOTAMATE_ADMIN_PASSWORD='a-long-password' python3 scripts/bootstrap.py --admin admin --dev
```

On Windows PowerShell: `$env:ANNOTAMATE_ADMIN_PASSWORD='a-long-password'; python scripts\bootstrap.py --admin admin --dev`.

Start the server as a **background** process (it runs in the foreground until stopped), then poll
the health endpoint instead of sleeping:

```bash
.venv/bin/annotamate serve --root "$PWD/datasets" --port 8765    # Windows: .venv\Scripts\annotamate.exe
curl -s http://127.0.0.1:8765/api/health                         # {"status":"ok","version":"2.0.0"}
```

Docker alternative: `mkdir -p datasets && docker compose up -d --build`, then
`printf '%s\n' "$PASSWORD" | docker compose exec -T annotamate annotamate user create admin --admin --password-stdin`.

Details, every option and troubleshooting: [docs/guides/setup.md](docs/guides/setup.md).

## Rules that prevent the usual mistakes

- **Never wait for keyboard input.** Passwords go through `ANNOTAMATE_ADMIN_PASSWORD` (bootstrap) or
  `--password-stdin` (CLI), never as command-line arguments.
- **The web interface must be built** (`cd web && npm run build` writes `annotamate/server/static/`)
  before `annotamate serve` shows the app or the end-to-end tests run. It is generated: never commit it.
- **Every write to the API needs the header** `X-Annotamate-Client: web` (CSRF), plus the
  `annotamate_session` cookie from `POST /api/auth/login`.
- **First-run setup token:** browsers on other machines, behind proxies or using Docker must send the
  token printed as `FIRST-RUN SETUP TOKEN` at start-up. Creating the admin with the CLI avoids it.
- **Folders:** projects can only use folders inside the roots given with `--root` /
  `ANNOTAMATE_ROOTS`. Use absolute paths.
- **Python 3.11 is the minimum.** Do not use syntax or library features newer than 3.11 in
  `annotamate/` (CI tests 3.11 and 3.13).
- **Stop what you start.** Kill the server process tree when done; `docker compose down` for Docker.

## Checks (CI runs the same)

```bash
.venv/bin/python -m ruff check annotamate tests scripts
.venv/bin/python -m pytest -q                      # ~2 min; symlink/POSIX tests skip on Windows
cd web
npm run lint && npm run typecheck && npm test && npm run build
npx playwright install chromium                    # once
PYTHON=../.venv/bin/python E2E_PORT=8799 npx playwright test   # end-to-end, ~2 min, needs the build
cd .. && .venv/bin/python scripts/benchmark.py --images 10000 --check   # performance regressions, ~1 min on Linux
```

On Windows use `..\.venv\Scripts\python.exe` for `PYTHON`. All of these must pass before a commit is
proposed; add or update tests with every behaviour change (every endpoint, permission rule and path
check has tests).

## Where things are

```text
annotamate/core/        pure logic: label formats, scanning, images, safe file writes (no web imports)
annotamate/server/      FastAPI app: routes/, services/, models.py, schemas.py, realtime.py, migrations/
annotamate/cli.py       `annotamate serve | user create|passwd|list | desktop | version`
web/src/                React app; web/src/canvas is the self-contained annotation engine
web/e2e/                Playwright tests
tests/                  pytest suite (conftest.py has fixtures for users, projects and datasets)
scripts/bootstrap.py    one-command setup used above
docs/                   architecture.md, api.md (the API contract), frontend.md, guides/
deploy/                 systemd, Caddy, nginx examples
```

Behaviour is specified in [docs/architecture.md](docs/architecture.md), [docs/api.md](docs/api.md)
and [docs/frontend.md](docs/frontend.md). Read the relevant one before changing behaviour and update
it, `web/src/lib/types.ts` (mirror of the API) and [CHANGELOG.md](CHANGELOG.md) in the same change.

## Conventions

- Conventional Commits: `feat(server): ...`, `fix(web): ...`, `docs: ...` (types: feat, fix, docs,
  refactor, perf, test, build, ci, chore). Work on a branch and open a pull request; never push to `main`.
  `main` is protected (no force pushes; reviews and green checks required) and only maintainers
  create `v*` release tags: see [docs/guides/maintainers.md](docs/guides/maintainers.md).
- UTF-8 with LF line endings (`.gitattributes` enforces it), 4-space Python, 2-space everything else,
  Python line length 120 (`ruff`).
- Database changes need an Alembic migration in `annotamate/server/migrations/versions/`.
- Label files are the source of truth: write them only through the atomic-write helpers in
  `annotamate/core/fsutil.py`, and never drop content the parser does not understand.
- Every path from a request or the database is resolved and checked against the roots before use.
- Do not commit generated files (`annotamate/server/static/`, `node_modules/`, `.venv/`), datasets
  (`datasets/`), databases or secrets.
