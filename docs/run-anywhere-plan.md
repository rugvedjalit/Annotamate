# Plan: run anywhere, share easily, stay lightweight

Status: proposal (2026-11-23). Builds on [web-app-plan.md](web-app-plan.md) and the measurements in
[Appendix A](#appendix-a-measured-baseline).

## 1. Goal

One small program that the owner installs on whatever machine holds the images (a laptop, a desktop
or a server) and that the whole team then uses from their browsers:

| Mode | Who uses it | How they reach it |
| --- | --- | --- |
| **Personal** | the owner, on the same machine | `http://localhost:8765` |
| **Local network** | colleagues on the same Wi-Fi or office LAN | the machine's private IP, e.g. `http://192.168.1.23:8765` |
| **Internet** | anyone with an account, anywhere | a domain (`https://annotate.example.com`) or the server's public IP |

The same installation moves between modes with one setting; data, accounts and projects stay. No extra
services (database server, cache, workers) are needed in any mode.

**Principles**

- **Lightweight:** one process, SQLite, about 100 MB of RAM when idle, about 70 MB on disk. This must hold
  on a laptop with 1 lakh images.
- **Safe by default:** the default is the most private mode. Opening up is one deliberate switch, and
  the app explains what it means.
- **The same app everywhere:** no "lite" edition. Every mode has the same features.

## 2. Where we are

| Need | Today | Gap |
| --- | --- | --- |
| Install on a laptop or desktop | `pip install` of the release wheel (Python 3.11+), Docker, or the setup script from a checkout (needs Node.js too) | No release is published yet. Every option needs Python or Docker. |
| Start it | `annotamate` starts the server and opens the browser | The default dataset folder is the current directory, so a double-clicked app has no sensible default. |
| Share on the local network | `annotamate serve --host 0.0.0.0` works. Colleagues get a setup-token-protected first run, and the WebSocket Origin check accepts the IP. | It prints the machine name instead of the IP colleagues need, and a warning written for internet exposure. No firewall guidance, nothing keeps the laptop awake, and no "share" screen in the app. |
| Internet with a domain | Caddy/nginx examples and HTTPS guidance in `deploy/` | Several manual steps. No built-in TLS, no "public URL" setting, and the Caddy service in Compose is commented out. |
| Lightweight at 1 lakh images | 93 MB idle, 345 MB peak, 49 s to index on Linux | The thread pool causes 1.5 s waits under 20 parallel users. A class delete blocks saves for 10 min. Counts are recomputed per request. ([Appendix A](#appendix-a-measured-baseline)) |

The PyPI name `annotamate` already belongs to this project (1.0.0 is the desktop app), and the release
workflow has a ready but switched-off PyPI job.

## 3. Installation channels

All channels install the same package, which already contains the built web interface.

| Channel | For | Command | Needs |
| --- | --- | --- | --- |
| **uv** (recommended for laptops and desktops) | Windows, macOS, Linux | `uv tool install annotamate`, then `annotamate` | Only [uv](https://docs.astral.sh/uv/), a single small binary that downloads its own Python |
| **pipx / pip** | people who already have Python 3.11+ | `pipx install annotamate` | Python 3.11+ |
| **Standalone download** (phase 6) | people who install nothing technical | Download `Annotamate-<version>-windows.exe`, `-macos`, `-linux`, then double-click | Nothing |
| **Docker** | servers, NAS boxes | `docker compose up -d` or `docker run ghcr.io/rugvedjalit/annotamate` | Docker |
| **From source** | contributors | `python3 scripts/bootstrap.py` | Python, Node.js |

Work:

- **First release.** Tag `v2.0.0` once the lightweight phases are merged. The existing workflow then
  publishes the wheel, the GitHub release and the multi-arch image.
- **PyPI publishing.** You enable trusted publishing for `annotamate` on pypi.org (environment `pypi`)
  and set the repository variable `PUBLISH_TO_PYPI=true`. This is a one-time step in the PyPI and
  GitHub settings that only the owner can do.
- **Standalone executables (phase 6).** PyInstaller one-file builds per OS in the release workflow,
  estimated at 35–45 MB.
  - Double-clicking starts the server, opens the browser and shows a small console with the share
    address and a Stop hint.
  - The first builds are unsigned, so Windows SmartScreen and macOS Gatekeeper ask for confirmation. The
    guide explains how to proceed; signing certificates can come later.

## 4. Mode: Personal (laptop or desktop)

- `annotamate` with no arguments starts on `127.0.0.1:8765`, opens the browser, and asks for the
  administrator account on first run (no token: same machine).
- **Default dataset folder.** When no root is configured, use `~/Annotamate/Datasets` (created on first
  start) instead of the current directory. Command-line and environment roots still win.
- **Dataset folders in the app.** Administrators can add or remove dataset folders under
  **Settings → Storage**.
  - Only requests made on the machine itself may change them, which reuses the "local request" rule of
    first-run setup.
  - Folders set by `--root` / `ANNOTAMATE_ROOTS` are shown read-only, so a server's configuration stays
    in charge.
- Nothing listens on the network in this mode.

## 5. Mode: Local network (share with colleagues)

### Starting

```bash
annotamate --share            # or: annotamate serve --share
```

- **Listening.** It listens on all IPv4 interfaces (`0.0.0.0`) on the same port.
- **Share address.** At start-up it prints the address to give colleagues, for example:

  ```text
  Annotamate is shared on your network. Colleagues open:
      http://192.168.1.23:8765
  ```

  The private IPv4 addresses come from the machine's interfaces (standard library only: the primary
  route plus the host's addresses, filtered to private ranges). Loopback, link-local and virtual
  adapters such as Docker or WSL are left out; when it is unclear which address colleagues should use,
  all candidates are listed.
- **Turning it on in the app.** The owner can also switch sharing on from the app (**Settings →
  Sharing**), and the choice is remembered for the next start.
  - The switch adds or removes a second listener on the machine's private addresses next to the
    loopback one, so it takes effect without a restart.
  - Where an OS does not allow that, it applies at the next start, and the panel says so.
- **Remembering the choice.** It is stored in the data folder, and `ANNOTAMATE_SHARE=true` /
  `--no-share` override it.
- **Docker.** Publish `8765:8765` instead of `127.0.0.1:8765:8765`. Compose gets a commented "share on
  the network" line, as it has today, plus a one-line explanation.

### Inviting people

- **Share panel.** A **Share** panel, for administrators, shows:
  - the current network addresses, with copy buttons;
  - the public URL if one is set (section 6);
  - whether colleagues can currently reach the app.

  Addresses are re-detected whenever the panel opens, because DHCP can change the IP.
- **Invite links.** Instead of choosing a password for each colleague:
  - The admin creates the account with **Invite** and gets a one-time link, valid for 7 days.
  - The colleague opens it and sets their own password.
  - Links are stored hashed and are single use, like session tokens.
  - The existing "set a password" flow stays.
- **Joining.** The sign-in page needs no changes. Colleagues open the address, sign in, and see the
  projects they are members of.

### Making it work on real laptops

- **Firewalls.** The first time the app listens on the network, Windows and macOS ask whether to allow
  incoming connections.
  - The app prints, and the Share panel shows, what to choose: on Windows, "Private networks"; on macOS,
    "Allow". It also says what to check when a colleague cannot connect: on Windows the network must be
    set to *Private*; on Linux, run `sudo ufw allow 8765/tcp`.
  - We do not change firewall rules ourselves, which would need administrator rights.
- **Keep awake.** While sharing, the app asks the OS not to sleep (`--no-keep-awake` turns this off). A
  closed lid on battery may still sleep, and the guide says so.
  - Windows: `SetThreadExecutionState` via `ctypes`.
  - macOS: `caffeinate -i -w <pid>`.
  - Linux: `systemd-inhibit` when available.
  - The Share panel shows a notice while the host is on battery, where the OS exposes it.
- **Bandwidth.** Phase 3 serves resized working images, so a dozen colleagues on Wi-Fi do not each pull
  7 MB originals.

### Security on a local network

- **The connection is plain HTTP.** Anyone who can watch the network can see passwords and sessions.
  This is acceptable on a trusted office or home network and not on public Wi-Fi.
  - The start-up message and the Share panel say this in one sentence, replacing today's
    internet-oriented warning.
  - The existing protections stay on: first-run setup token for other machines, rate limits, CSRF and
    Origin checks, and HttpOnly + SameSite cookies.
- **Optional HTTPS on the LAN** (`--tls-cert/--tls-key`, see section 6): for teams that want encryption
  inside the office, for example with certificates from their IT department or from `mkcert`.
- **Sharing outside the office without opening ports.** The guide covers Tailscale (private network
  between team devices, with HTTPS names) and Cloudflare Tunnel as optional extras. The setup-token
  rules already treat their forwarded requests correctly.

## 6. Mode: Internet (public IP or domain)

### With a domain (recommended)

- **Docker with automatic HTTPS:**

  ```bash
  ANNOTAMATE_DOMAIN=annotate.example.com docker compose --profile https up -d
  ```

  The Caddy service becomes a Compose profile instead of commented-out lines. It gets certificates from
  Let's Encrypt automatically and renews them. Ports 80 and 443 must be open.
- **Without Docker.** The existing systemd + Caddy/nginx guides stay; the guide gets a shorter "domain in
  10 minutes" path.
- **New settings:**
  - `ANNOTAMATE_PUBLIC_URL=https://annotate.example.com` is used for invite links and the Share panel.
    When it starts with `https://`, secure cookies and HSTS switch on automatically.
  - `ANNOTAMATE_ALLOWED_HOSTS=annotate.example.com` (optional, defaults to the host of
    `ANNOTAMATE_PUBLIC_URL`) rejects requests for other host names, a second line of defence against
    Host-header tricks.

### Built-in HTTPS (no reverse proxy)

- **Options.** `annotamate serve --tls-cert fullchain.pem --tls-key privkey.pem --port 443` passes the
  files to uvicorn, so certificates from certbot, an IT department or `mkcert` work without nginx or
  Caddy.
- **Effect on cookies.** Secure cookies and HSTS switch on automatically. A plain-HTTP listener on port
  80 redirects to HTTPS when `--http-redirect` is set.

### With only a public IP

- **Plain HTTP over the internet is refused unless explicitly confirmed.** When the server would accept
  connections on a public (globally routable) address without HTTPS, it starts only with
  `--allow-insecure-public`, and the start-up message explains why.
  - Laptops with only private addresses are not affected.
  - Neither are servers that listen on `127.0.0.1` behind a reverse proxy.
- **The guide recommends instead:**
  - a free dynamic-DNS name, for example DuckDNS, plus the Compose `https` profile;
  - or a tunnel (Tailscale, Cloudflare).
- **Operational guidance:** port forwarding on the router, the firewall, and keeping the database
  backed up (the existing backup section).

## 7. Lightweight and scale (from the benchmark)

Order follows impact. The numbers are measured on Linux at 1 lakh images ([Appendix A](#appendix-a-measured-baseline)).

| # | Change | Expected effect |
| --- | --- | --- |
| L1 | **Worker threads 40 → 4**, configurable as `ANNOTAMATE_WORKER_THREADS` | 20 parallel users: 12.9 → about 70–110 requests/s; median wait 1.5 s → about 0.2–0.3 s |
| L2 | **Class delete/merge as a background job** in batches, resumable like renames, with progress over WebSocket | No 10-minute request, no blocked saves |
| L3 | **Per-project counters** (status, missing, per assignee), stats cached for a few seconds, and the client patches counts from events instead of refetching | Project page and list 125–137 ms → a few ms; stats no longer recomputed by every open page on every save |
| L4 | **Indexes and SQLite settings**: `(project_id, missing, status, sort_index)`, `(project_id, assignee_id, sort_index)`, `image_id` indexes on activity, notifications and chat; `cache_size` 64 MB, `mmap_size`, `temp_store=MEMORY`, `PRAGMA optimize` after indexing | Filters and project delete/prune no longer scan whole tables |
| L5 | **Rescan only changed label files**, by stored size and mtime | Rescan 17 s → about 2 s |
| L6 | **Count only on the first page; cheaper prev/next** | Deep pages and navigation no longer grow with the project |
| L7 | **Streamed COCO export** | Memory flat instead of +370 MB at 1 lakh (about 2 GB at 5 lakh) |
| L8 | **Uploads without renumbering the whole project** | Upload time independent of project size |
| L9 | **Retention**: last 10 revisions per image (identical saves skipped); optional activity retention | Database stays small over months of work |
| L10 | **Smaller install**: drop the unused `uvicorn[standard]` extras (keep `uvloop` on Linux, `httptools`, `websockets`); Latin-only fonts and a system monospace stack | About −2 MB installed; web build about −300 KB; about −90 KB on first load |

## 8. Image handling

| # | Change | Why |
| --- | --- | --- |
| I1 | **Working copies for annotation**: longest side 2,560 px by default, as JPEG/WebP, cached; the original is used when the image is already small or when the user zooms past the working copy. Boxes always use original pixel coordinates, so label files do not change. | A 24 MP, 7 MB photo becomes well under 1 MB on the wire. This matters most when a laptop shares over Wi-Fi. |
| I2 | **Browser memory budget by bytes** (about 400 MB) instead of 8 decoded images; decode only the previous and next image ahead. | 8 × 48 MP is about 1.5 GB in the browser today. |
| I3 | **Thumbnail cache maintenance off the request path**, least-recently-used eviction, no fsync for cache files, optional pre-generation after indexing, `?v=` cache-busting in client URLs. | No random slow requests; stale thumbnails cannot occur. |
| I4 | **EXIF orientation in the browser** instead of re-encoding on the server. | Phone photos no longer cost a full decode and a second cached copy. |

## 9. Delivery: pull requests, one at a time

Each PR is independently useful and ships with tests, docs (`docs/api.md`, guides) and a changelog
entry. Each is merged only after its checks pass, as before.

| Phase | PR | Contents |
| --- | --- | --- |
| 1 | `perf: worker threads, background class jobs, counters, indexes` | L1–L4 |
| 2 | `perf: incremental rescan, cheaper paging, streamed exports, retention` | L5–L9 |
| 3 | `feat: lighter image delivery` | I1–I4, L10 |
| 4 | `feat: share on the local network` | Section 5: `--share`, address detection, Share panel, invites, keep-awake, firewall guidance, new start-up messages, default dataset folder, dataset folders in Settings (section 4) |
| 5 | `feat: internet deployment made simple` | Section 6: public URL, allowed hosts, built-in TLS, HTTP redirect, the public-HTTP guard, Compose `https` profile, guide |
| 6 | `build: release 2.0.0 and installers` | PyPI publishing (needs the owner's one-time PyPI step), uv/pipx instructions, standalone executables, tag `v2.0.0` |

## 10. Acceptance criteria

Checked on a fresh machine for each mode, plus automated tests:

- **Personal:**
  - `uv tool install annotamate && annotamate` opens the app.
  - Data lives in the per-user data folder, and datasets live in `~/Annotamate/Datasets` by default.
- **Local network:**
  - With `annotamate --share`, a second device on the same network opens the printed address, signs in
    through an invite link and annotates; edits appear live for both.
  - Turning sharing off makes the address unreachable.
- **Internet:**
  - `docker compose --profile https up -d` with a domain serves HTTPS with a valid certificate,
    secure cookies and HSTS.
  - Plain HTTP on a public address refuses to start without the explicit flag.
- **Lightweight, Linux, 1 lakh images:**
  - Idle RAM ≤ 120 MB; peak ≤ 400 MB during indexing, rescan and export.
  - 20 parallel users: image-list p95 ≤ 400 ms.
  - Class delete returns at once and never blocks saves.
  - Project page ≤ 30 ms.
  - Installed size ≤ 80 MB.
- **Benchmark in CI:** the benchmark script moves into the repository (`scripts/benchmark.py`) and runs
  at 10k images in CI to catch regressions; 1 lakh runs on demand.

## 11. Decisions for the owner

| Question | Recommendation |
| --- | --- |
| Default network mode | Personal (localhost). Sharing is one switch (`--share` or Settings → Sharing). |
| HTTPS on the LAN | Plain HTTP with a clear notice by default. Optional certificates (`--tls-cert`) for teams that want it. |
| Invite links | Yes. Easier than handing out passwords, and nobody else learns a colleague's password. |
| Standalone executables | Yes, in phase 6, unsigned at first. Code-signing certificates cost money and can follow. |
| PyPI | Publish 2.0.0 under the existing `annotamate` project (needs the owner's one-time trusted-publisher setup). |
| Plain HTTP on a public IP | Refuse without `--allow-insecure-public`. |

## Appendix A: measured baseline

Measured on 2026-11-23, Linux container (14 CPUs, 8 GB), 100,000 images (50,000 YOLO label files, 3
boxes each), real HTTP requests.

| Measure | 1,000 | 10,000 | 100,000 |
| --- | --- | --- | --- |
| First indexing | 0.56 s | 5.6 s | 49 s |
| Peak memory while indexing | 102 MB | 142 MB | 345 MB |
| Rescan, nothing changed | 0.17 s | 2.7 s | 17 s |
| Image list page | 15 ms | 19 ms | 50–76 ms |
| Project page / projects list | 18 / 12 ms | 38 / 31 ms | 125 / 137 ms |
| Statistics | 17 ms | 47 ms | 299 ms |
| Save boxes (round trip) | 46 ms | 57 ms | 51 ms |
| Export YOLO / COCO | 0.3 / 0.6 s | 5.5 / 6.2 s | 37 / 57 s (COCO peak 493 MB) |
| Delete a class used everywhere | 5 s | 48 s | 581 s |
| Database size | 1.2 MB | 7.4 MB | 52 MB |

- **Idle memory:** 93 MB.
- **Restart with 1.1 lakh images loaded:** 1.3 s.
- **Thumbnails:** 23 ms the first time (55–90 ms for 12–24 MP JPEGs, about 1 s for a 48 MP PNG), 5–9 ms
  cached.
- **20 parallel users on the image list:** 12.9 requests/s with 40 worker threads; 70.2 with 4; 110.9
  with 2.
- **Windows laptop:** indexing 10,000 images took 133 s. Windows Defender scans each newly created file
  on first open: about 20 ms, against 0.27 ms on the second open.
