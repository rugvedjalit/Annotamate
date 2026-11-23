<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/brand/wordmark-dark.png">
    <img src="web/public/brand/wordmark-light.png" alt="Annotamate" width="440">
  </picture>
</p>

<p align="center">
  <strong>Self-hosted image annotation for teams. Runs on your server, works in any browser, writes YOLO, Pascal VOC and COCO labels straight to disk.</strong>
</p>

<p align="center">
  <a href="https://github.com/rugvedjalit/Annotamate/actions/workflows/ci.yml"><img src="https://github.com/rugvedjalit/Annotamate/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT licence"></a>
  <img src="https://img.shields.io/badge/python-3.10%2B-blue.svg" alt="Python 3.10 or newer">
</p>

---

Annotamate is a multi-user bounding-box annotation server. An administrator installs it on the
machine that holds the image datasets (a GPU box, a NAS, a cloud VM or a container), creates
accounts for the team and creates **projects** that point at image folders on that machine. Team
members sign in from a browser to annotate, review each other's work and talk about it.

Label files are the source of truth and stay next to your images in the format your training
pipeline already reads. The database only holds accounts, statuses and conversations; deleting it
loses no labels.

## Features

**Annotation**

- Keyboard-first annotator: every action has a shortcut, every shortcut can be rebound, and a command palette (`Ctrl/⌘ K`) finds the rest.
- Fast canvas: zoom at the cursor, pan, crosshair, eight resize handles, multi-select, copy and paste, and "paste previous boxes" for video frames.
- Undo and redo for every change; autosave with a visible save state; edit conflicts are shown, never silently overwritten.
- YOLO, Pascal VOC and COCO label files, read and written in place with atomic writes.
- Revision history for every image: preview and restore any of the last 50 saves.
- Handles datasets of 100,000+ images (virtualised lists, server-side search and filters, natural sort).
- Dark and light themes.

**Teamwork**

- Multi-user accounts with roles: viewer, annotator, reviewer, manager, plus server administrators.
- Projects on server folders, chosen with a folder browser that is limited to the roots you allow.
- Assignments: assign images by hand or distribute them evenly across the team.
- Review workflow: submit, approve or reject with a reason, reopen.
- Edit locks and live presence: see who is on which image; one editor per image at a time.
- Project chat, image comments with pins on the picture, direct messages, @mentions and notifications.
- Activity feed and per-member progress for every project.
- Exports as YOLO (with `data.yaml`), Pascal VOC or a dataset-level COCO `annotations.json`.

**Operations**

- Runs on any headless server: one Python process, SQLite by default (PostgreSQL optional), no Node.js needed at run time.
- Works offline: fonts and icons are bundled, nothing is loaded from a CDN.
- Docker image, Compose file, systemd unit and reverse-proxy examples are included.

The interface design is shown in the [annotator mockup](docs/mockups/annotator.html) (open the file in a browser).

## Quick start

Annotamate needs Python 3.10 or newer, or Docker. The first time you open it, the browser asks you
to create the administrator account. When you open it on the same machine no further proof is
needed; from any other machine the page asks for the one-time **setup token** that the server prints
in its console and log (for Docker: `docker compose logs annotamate` or `docker logs annotamate`).

### pip, over an SSH tunnel

Install the wheel from the [latest release](https://github.com/rugvedjalit/Annotamate/releases/latest)
on the server (it already contains the web interface):

```bash
python3 -m venv ~/annotamate-venv
~/annotamate-venv/bin/pip install https://github.com/rugvedjalit/Annotamate/releases/download/v2.0.0/annotamate-2.0.0-py3-none-any.whl

# Listens on 127.0.0.1:8765 only; projects can be created inside /data/datasets
~/annotamate-venv/bin/annotamate serve --root /data/datasets
```

On your laptop, forward the port and open <http://localhost:8765>:

```bash
ssh -N -L 8765:127.0.0.1:8765 you@your-server
```

Nothing is exposed to the network; SSH provides the encryption.

### Docker

```bash
docker run -d --name annotamate --restart unless-stopped \
  -p 127.0.0.1:8765:8765 \
  -v /data/datasets:/data \
  -v annotamate-state:/var/lib/annotamate \
  --user "$(id -u):$(id -g)" \
  ghcr.io/rugvedjalit/annotamate:latest
```

Open <http://localhost:8765> and create the administrator account. The port is published on the
machine itself only; use `-p 8765:8765` to reach it from other machines (then the setup page asks for
the token shown by `docker logs annotamate`). `/data` is where the container sees your datasets;
`--user` makes the label files it writes belong to you. The image is built for `linux/amd64` and `linux/arm64`.

### Docker Compose

```bash
git clone https://github.com/rugvedjalit/Annotamate.git
cd Annotamate
mkdir -p datasets            # or edit the bind mount in docker-compose.yml
docker compose up -d
```

For a team, put Annotamate behind HTTPS. The [deployment guide](docs/guides/deployment.md) covers
systemd, Caddy, nginx, sub-path hosting, backups and upgrades.

## Configuration

Every setting can be given as an environment variable; the common ones also have a command-line
flag, which takes precedence.

| Setting | Flag | Environment variable | Default |
| --- | --- | --- | --- |
| Host | `--host` | `ANNOTAMATE_HOST` | `127.0.0.1` |
| Port | `--port` | `ANNOTAMATE_PORT` | `8765` |
| Dataset roots | `--root` (repeatable) | `ANNOTAMATE_ROOTS` (`:`-separated, `;` on Windows) | current directory |
| Data directory | `--data-dir` | `ANNOTAMATE_DATA_DIR` | platform data directory |
| Database URL | | `ANNOTAMATE_DATABASE_URL` | SQLite file in the data directory |
| Base URL (sub-path behind a proxy) | `--base-url` | `ANNOTAMATE_BASE_URL` | `/` |
| Secure cookies | `--secure-cookies` | `ANNOTAMATE_SECURE_COOKIES` | `false` (set `true` behind HTTPS) |
| Session lifetime, days | | `ANNOTAMATE_SESSION_DAYS` | `14` |
| Maximum upload size, MB per file | | `ANNOTAMATE_MAX_UPLOAD_MB` | `50` |
| Maximum whole upload request, MB | | `ANNOTAMATE_MAX_UPLOAD_REQUEST_MB` | `1024` |
| Maximum request body of other routes, MB | | `ANNOTAMATE_MAX_BODY_MB` | `2` |
| Largest image, megapixels | | `ANNOTAMATE_MAX_IMAGE_MEGAPIXELS` | `150` |
| Log level (`critical`, `error`, `warning`, `info`, `debug`) | `--log-level` | `ANNOTAMATE_LOG_LEVEL` | `info` |

Project folders must be inside one of the roots. The data directory holds the database and caches,
never your labels. Annotamate runs as a single process: do not start several workers or replicas.

## Usage

```text
annotamate                               serve on localhost and open the browser
annotamate serve [options]               run the server (does not open a browser unless --open is given)
annotamate user create NAME [--admin]    create an account (prompts for the password)
annotamate user passwd NAME              reset a password
annotamate user list                     list accounts
annotamate desktop                       start the legacy desktop app
annotamate version                       print the version
```

A typical workflow:

1. **Administrator**: create accounts, then create a project by picking an image folder, a label
   format and the classes. Add members and give each a role.
2. **Manager**: assign or distribute images, and turn on *Require review* in the project settings if work should be checked.
3. **Annotators**: open the project, draw boxes (`W`), pick classes (`1`–`9`), move on (`D`). Work is
   saved automatically. Submit finished images with `Ctrl/⌘ Enter`.
4. **Reviewers**: approve submitted images or reject them with a comment.
5. **Everyone**: discuss in the project chat, comment on images, mention people with `@username`.
6. **Manager**: export the dataset, or simply train on the label files in place.

## Documentation

| Guide | For |
| --- | --- |
| [Deployment](docs/guides/deployment.md) | Installing, HTTPS, reverse proxies, permissions, backups, upgrades, troubleshooting |
| [Administrator](docs/guides/administrator.md) | Accounts, roles, projects, classes, assignments, review, uploads, exports |
| [Annotator](docs/guides/annotator.md) | The workspace, tools, keyboard shortcuts, comments, chat, reviews |
| [Architecture](docs/architecture.md) | How the server is built, the security model, the on-disk formats |
| [API](docs/api.md) | The REST and WebSocket contract |

## Development

You need Python 3.10+ and Node.js 24.

```bash
git clone https://github.com/rugvedjalit/Annotamate.git
cd Annotamate

# Backend: http://127.0.0.1:8765
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
annotamate serve --root /path/to/some/images

# Frontend dev server with hot reload: http://localhost:5173 (proxies /api to the backend)
cd web
npm ci
npm run dev
```

`npm run build` writes the production bundle into `annotamate/server/static/`, from where the
Python server serves it and the wheel picks it up.

Checks, the same ones CI runs:

```bash
ruff check annotamate tests && pytest -q                                  # backend
cd web && npm run lint && npm run typecheck && npm test && npm run build  # frontend
cd web && npx playwright test                                             # end-to-end (needs the build)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and the pull-request checklist, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Desktop app (legacy)

Annotamate 1.x was a single-user Tkinter desktop application. It is still included and reads and
writes the same label files, but new features go into the web app only.

It needs the `desktop` extra and a machine with a display:

```bash
pip install "annotamate[desktop] @ https://github.com/rugvedjalit/Annotamate/releases/download/v2.0.0/annotamate-2.0.0-py3-none-any.whl"
annotamate desktop
```

## Licence

Released under the [MIT License](LICENSE).

---

<p align="center">Created by <strong>Rugved Jalit</strong></p>
