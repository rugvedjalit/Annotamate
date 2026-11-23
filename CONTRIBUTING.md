# Contributing to Annotamate

Thank you for your interest in improving Annotamate. This document explains how to set up a
development environment, the conventions the project follows and what a pull request should contain.

Bug reports and feature ideas are welcome through the
[issue tracker](https://github.com/rugvedjalit/Annotamate/issues). Please report security problems
privately, as described in [SECURITY.md](SECURITY.md).

## Project layout

```text
annotamate/          Python package
  core/              pure logic: boxes, label formats, scanning, images, safe file access
  server/            FastAPI application: routes, services, models, migrations, realtime hub
  server/static/     built web interface (generated, not committed)
  desktop/           the legacy Tkinter desktop app
web/                 React + TypeScript single-page app (Vite)
  src/canvas/        the annotation canvas engine
  e2e/               Playwright end-to-end tests
tests/               pytest suite
deploy/              systemd, Caddy and nginx examples
docs/                architecture, API contract, frontend specification, guides
```

Three documents define how the application is supposed to behave. Read the relevant one before
changing behaviour, and update it in the same pull request when the behaviour changes:

- [`docs/architecture.md`](docs/architecture.md): components, configuration, permissions, workflow, security model
- [`docs/api.md`](docs/api.md): the REST and WebSocket contract
- [`docs/frontend.md`](docs/frontend.md): routes, design system, behaviour rules of the annotator

## Development setup

Requirements: Python 3.11 or newer, Node.js 24, Git.

The quickest way is `python3 scripts/bootstrap.py --dev` (Windows: `python scripts\bootstrap.py --dev`):
it creates `.venv`, installs the package with the development tools and builds the web interface. The
[setup guide](docs/guides/setup.md) explains each step; the manual equivalent is:

```bash
git clone https://github.com/rugvedjalit/Annotamate.git
cd Annotamate

# Backend
python -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

# Frontend
cd web
npm ci
```

Run the two development servers in separate terminals:

```bash
# Terminal 1: API on http://127.0.0.1:8765
annotamate serve --root /path/to/some/images --data-dir .annotamate

# Terminal 2: web interface with hot reload on http://localhost:5173
cd web
npm run dev
```

Open <http://localhost:5173>. The Vite dev server proxies `/api`, including the WebSocket, to the
backend. On the first visit, create the administrator account.

To try the production bundle the way users get it, run `npm run build` in `web/`. It writes the
bundle to `annotamate/server/static/`, and `annotamate serve` then serves the whole application on
port 8765. Without a build, the server still starts and the API works; `/` shows a hint to build the
web interface.

The `--data-dir .annotamate` above keeps the development database inside the checkout (the folder
is git-ignored). Delete it to start from scratch.

## Checks

Run these before opening a pull request. CI runs the same commands.

**Backend**

```bash
ruff check annotamate tests
pytest -q
```

**Frontend** (in `web/`)

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

**End-to-end** (in `web/`; needs the built web interface and starts the backend by itself with
`python -m annotamate serve`, using a temporary data directory)

```bash
npm run build
npx playwright install chromium     # once
npx playwright test
```

Set `PYTHON` to choose the interpreter (default `python`) and `E2E_PORT` to change the port
(default 8765). Reports are written to `web/playwright-report/` and `web/test-results/`.

CI additionally builds the sdist and the wheel, checks that both contain the web interface and the
migrations, installs the wheel into a fresh virtual environment, starts the server and checks
`/api/health` and `/`, and builds the container image and runs it once.

## Branches

Create a branch from `main` and name it after the kind of change:

| Prefix | For | Example |
| --- | --- | --- |
| `feat/…` | a new capability | `feat/polygon-tool` |
| `fix/…` | a bug fix | `fix/voc-truncated-flag` |
| `chore/…` | maintenance, dependencies, CI, documentation | `chore/update-vite` |

Keep a branch focused on one topic. Small pull requests are reviewed faster.

## Commit messages

The project uses [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <summary in the imperative, lower case, no full stop>

<optional body: what changed and why>

<optional footer: Closes #123, BREAKING CHANGE: ...>
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
Useful scopes: `core`, `server`, `web`, `canvas`, `deploy`, `docs`.

```text
feat(canvas): snap box edges to image border while resizing
fix(server): reject uploads whose extension is not an image
docs: describe sub-path hosting behind nginx
```

A change that breaks compatibility (API shape, configuration, on-disk format) is marked with `!`
after the type (`feat(server)!: ...`) and explained in a `BREAKING CHANGE:` footer.

## Coding guidelines

**General**

- Follow `.editorconfig` (UTF-8, LF line endings, final newline; 4 spaces for Python, 2 for
  everything else).
- Do not commit generated files (`annotamate/server/static/`, `node_modules/`), datasets, databases
  or secrets.

**Python**

- Code must pass `ruff check`.
- `annotamate/core/` stays free of FastAPI, SQLAlchemy and Tk imports. It is plain logic that can
  be tested without a server.
- Label files are the source of truth. Anything that writes them must go through the atomic-write
  helper and must never drop data it does not understand.
- Every path that comes from a request or from the database is resolved and checked against the
  dataset roots before it is used.
- Every API endpoint has at least one test. Permission rules and path handling have dedicated tests;
  add to them when you touch either.
- Database changes need an Alembic migration.

**TypeScript**

- Strict mode; no `any` without a comment that explains why.
- `web/src/lib/types.ts` mirrors `docs/api.md`. Change both together with the backend schemas.
- `web/src/canvas` is self-contained: it imports nothing from the rest of the app, and the rest of
  the app imports it only through `@/canvas`.
- Pure logic (geometry, history, key map, save state machine) is covered by Vitest tests.
- The interface must work offline: no CDN links, no remote fonts.
- Every icon button has an `aria-label` and a tooltip; colour is never the only signal.

## Pull requests

Before asking for review, check that:

- [ ] the branch name and the commits follow the conventions above;
- [ ] all checks listed under [Checks](#checks) pass locally;
- [ ] new behaviour has tests, and bug fixes come with a test that fails without the fix;
- [ ] API changes are reflected in `docs/api.md`, the backend schemas and `web/src/lib/types.ts`;
- [ ] user-visible changes are noted under *Unreleased* in [CHANGELOG.md](CHANGELOG.md) and, where
      relevant, in the guides under `docs/guides/`;
- [ ] UI changes include a screenshot or a short recording in the description, in both themes if
      colours are involved;
- [ ] the description says what changed, why, and how you tested it.

A maintainer reviews every pull request. CI must be green before a merge.

## Releases

Maintainers release by:

1. updating the version in `annotamate/__init__.py` and in `web/package.json`, and moving the *Unreleased*
   entries in `CHANGELOG.md` under the new version with the date;
2. tagging the commit on `main`: `git tag v2.1.0 && git push origin v2.1.0`.

The release workflow builds the web interface, the sdist and the wheel, checks that the tag matches
the version, creates the GitHub release with generated notes and publishes the container image
(`linux/amd64` and `linux/arm64`) to `ghcr.io/rugvedjalit/annotamate`. Publishing to PyPI is
optional: set the repository variable `PUBLISH_TO_PYPI` to `true` once trusted publishing is
configured.

## Licence

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
