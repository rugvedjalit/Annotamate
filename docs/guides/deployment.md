# Deployment guide

This guide explains how to install and run Annotamate 2 on a server, from a one-person setup over
SSH to a team installation behind HTTPS.

**Contents**

1. [How Annotamate runs](#1-how-annotamate-runs)
2. [Choosing a setup](#2-choosing-a-setup)
3. [Single user over an SSH tunnel](#3-single-user-over-an-ssh-tunnel)
4. [Docker](#4-docker)
5. [Docker Compose](#5-docker-compose)
6. [systemd service](#6-systemd-service)
7. [HTTPS with a reverse proxy](#7-https-with-a-reverse-proxy)
8. [Hosting under a sub-path](#8-hosting-under-a-sub-path)
9. [File permissions and user IDs](#9-file-permissions-and-user-ids)
10. [Configuration reference](#10-configuration-reference)
11. [Backups](#11-backups)
12. [Upgrades](#12-upgrades)
13. [PostgreSQL](#13-postgresql)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. How Annotamate runs

A few facts shape every deployment:

- **One process.** `annotamate serve` is a single Python process with a single worker. It serves the
  web interface, the API and the WebSocket. Presence and edit locks are kept in the memory of that
  process, so you must not run several workers, replicas or load-balanced copies against the same data.
- **Dataset roots.** You tell the server which folders it may use (`--root`, `ANNOTAMATE_ROOTS`).
  Every project folder must be inside one of them, after symbolic links are resolved. Nothing
  outside the roots can be browsed, read or written through the application.
- **Label files are the source of truth.** Labels are written as YOLO `.txt`, Pascal VOC `.xml` or
  COCO `.json` files inside the dataset folders, together with `classes.txt`.
- **The data directory holds application state** (`--data-dir`, `ANNOTAMATE_DATA_DIR`): the database
  (`annotamate.db` for SQLite) with accounts, projects, image statuses, assignments, chat, comments,
  notifications, activity and revisions, plus a `cache/` folder with thumbnails and re-encoded
  images. Losing it loses no labels, but it does lose everything in that list.
- **No Node.js on the server.** The web interface is built ahead of time and shipped inside the
  Python wheel and the container image.
- **No outbound connections.** Fonts and icons are bundled; the application works on an air-gapped network.

Requirements: Python 3.11 or newer (or Docker), on Linux, macOS or Windows. Resource needs are
modest; disk space for the cache grows with the number of images that have been viewed.

## 2. Choosing a setup

| Situation | Recommended setup |
| --- | --- |
| One person, datasets on a remote machine | [SSH tunnel](#3-single-user-over-an-ssh-tunnel) |
| Trying it out, or a small team on a trusted LAN or VPN | [Docker](#4-docker) or [Docker Compose](#5-docker-compose) |
| A permanent team server | [systemd](#6-systemd-service) or Compose, behind an [HTTPS reverse proxy](#7-https-with-a-reverse-proxy) |
| Reachable from the internet | HTTPS reverse proxy, always; see the [hardening checklist](../../SECURITY.md#hardening-checklist) |

Passwords and session cookies travel in clear text over plain HTTP. Use plain HTTP only through an
SSH tunnel or inside a network you trust.

## 3. Single user over an SSH tunnel

This is the quickest way to annotate images that live on a remote machine. Nothing is exposed to
the network.

**On the server**

Download the wheel from the [releases page](https://github.com/rugvedjalit/Annotamate/releases)
or let pip fetch it:

```bash
python3 -m venv ~/annotamate-venv
~/annotamate-venv/bin/pip install https://github.com/rugvedjalit/Annotamate/releases/download/v2.0.0/annotamate-2.0.0-py3-none-any.whl

~/annotamate-venv/bin/annotamate serve --root /data/datasets
```

The server listens on `127.0.0.1:8765` by default, which only the server itself can reach. Leave
it running (in `tmux` or `screen`, or install it as a [service](#6-systemd-service)).

**On your computer**

```bash
ssh -N -L 8765:127.0.0.1:8765 you@your-server
```

Open <http://localhost:8765>. On the first visit the *Create the administrator account* screen asks for a user
name and a password; after that you sign in normally. The tunnel arrives on the server as a local
connection, so no setup token is asked for.

If port 8765 is taken on your computer, forward another one (`-L 9000:127.0.0.1:8765`) and open
`http://localhost:9000`.

**Running it on your own computer.** `annotamate` with no arguments starts the server on localhost
and opens the browser. The current directory is the dataset root unless you pass `--root`.

## 4. Docker

The image is published as `ghcr.io/rugvedjalit/annotamate` for `linux/amd64` and `linux/arm64`.
Tags: `latest`, and for each release `2.0.0`, `2.0` and `2`.

```bash
docker run -d --name annotamate --restart unless-stopped \
  -p 8765:8765 \
  -v /data/datasets:/data \
  -v annotamate-state:/var/lib/annotamate \
  --user "$(id -u):$(id -g)" \
  ghcr.io/rugvedjalit/annotamate:latest
```

| Part | Meaning |
| --- | --- |
| `-p 8765:8765` | Publish the web interface on port 8765 of the host. Use `-p 127.0.0.1:8765:8765` when a reverse proxy on the same host is in front. |
| `-v /data/datasets:/data` | Your datasets. Inside the container the dataset root is `/data`; projects are created in its sub-folders. |
| `-v annotamate-state:/var/lib/annotamate` | A named volume for the database and caches. Without it, accounts and project settings are lost when the container is removed. |
| `--user "$(id -u):$(id -g)"` | Run as your user so that label files written into the datasets belong to you. See [file permissions](#9-file-permissions-and-user-ids). |

Defaults set by the image: `ANNOTAMATE_HOST=0.0.0.0`, `ANNOTAMATE_PORT=8765`,
`ANNOTAMATE_ROOTS=/data`, `ANNOTAMATE_DATA_DIR=/var/lib/annotamate`. Add more settings with `-e`,
for example `-e ANNOTAMATE_SECURE_COOKIES=true`.

Several dataset folders: mount each one below `/data` (`-v /mnt/a:/data/a -v /mnt/b:/data/b`), or
mount them anywhere and list them in `ANNOTAMATE_ROOTS` separated by `:`.

Command-line tools run inside the container:

```bash
docker exec -it annotamate annotamate user list
docker exec -it annotamate annotamate user create alice
docker exec -it annotamate annotamate user passwd alice
```

The image has a health check on `/api/health`; `docker ps` shows `healthy` once the server is up.

**Building the image yourself**

```bash
git clone https://github.com/rugvedjalit/Annotamate.git
cd Annotamate
docker build -t annotamate .
```

## 5. Docker Compose

The repository contains a ready-to-use [`docker-compose.yml`](../../docker-compose.yml).

```bash
git clone https://github.com/rugvedjalit/Annotamate.git
cd Annotamate
mkdir -p datasets          # or change the bind mount to where your datasets are
docker compose up -d
docker compose logs -f annotamate
```

Open <http://localhost:8765> and create the administrator account. The Compose file publishes the port
on `127.0.0.1` only (`"127.0.0.1:8765:8765"`). To reach the app from other machines, switch to the
commented `"8765:8765"` line, which exposes plain HTTP: do it on a trusted network only, or put a
[reverse proxy](#7-https-with-a-reverse-proxy) in front.

**The setup token.** Docker's port mapping makes every request look like it comes from a remote
address, so the first-run screen asks for a one-time *setup token*. The server prints it, in a framed
block, when it starts without any account:

```bash
docker compose logs annotamate
```

Copy the `FIRST-RUN SETUP TOKEN` value into the token field. It only works until the first account
exists and is generated again at every start while there is none.

What to adapt:

- **Datasets.** Replace `./datasets:/data` by the folder that holds your images, for example
  `/srv/datasets:/data`.
- **User.** The service runs as `${UID:-1000}:${GID:-1000}`. If the owner of the dataset folder is
  not user 1000, create a file named `.env` next to `docker-compose.yml`:

  ```ini
  UID=1001
  GID=1001
  ```

  (Shells usually do not export `UID` and `GID`, so setting them in `.env` is the reliable way.)
- **HTTPS.** Uncomment the `caddy` service and its volumes, set `ANNOTAMATE_DOMAIN`, remove the
  `ports` entry of the `annotamate` service, set `ANNOTAMATE_SECURE_COOKIES: "true"` and enable
  `FORWARDED_ALLOW_IPS: "*"` (see [client addresses](#client-addresses-and-the-sign-in-limit)).
  Caddy then obtains a certificate for the domain and proxies to the application. Details in
  [section 7](#7-https-with-a-reverse-proxy).

The Compose file runs the container with a read-only root file system, without Linux capabilities
and with `no-new-privileges`. The application only writes to the state volume, the dataset mount
and `/tmp`.

Never scale the service (`--scale annotamate=2`): only one instance may run.

## 6. systemd service

For a permanent installation without Docker. The example files are in [`deploy/`](../../deploy).

**1. Create a service user and install the package**

```bash
sudo useradd --system --home-dir /var/lib/annotamate --shell /usr/sbin/nologin annotamate

sudo python3 -m venv /opt/annotamate/venv
sudo /opt/annotamate/venv/bin/pip install \
  https://github.com/rugvedjalit/Annotamate/releases/download/v2.0.0/annotamate-2.0.0-py3-none-any.whl
```

**2. Give the service user access to the datasets**

The service must be able to read images and to create and replace label files. One way, keeping
the files usable by the people who train on them:

```bash
sudo chgrp -R annotamate /data/datasets
sudo chmod -R g+rwX /data/datasets
sudo find /data/datasets -type d -exec chmod g+s {} +      # new files inherit the group
sudo usermod -aG annotamate your-user                      # people who also need write access
```

**3. Configure**

```bash
sudo install -d -m 0750 -o root -g annotamate /etc/annotamate
sudo install -m 0640 -o root -g annotamate deploy/annotamate.env.example /etc/annotamate/annotamate.env
sudoedit /etc/annotamate/annotamate.env
```

Set at least `ANNOTAMATE_ROOTS`. Keep `ANNOTAMATE_HOST=127.0.0.1` if a reverse proxy runs on the
same machine; use `0.0.0.0` only to serve a trusted network directly.

**4. Install and start the unit**

```bash
sudo install -m 0644 deploy/annotamate.service /etc/systemd/system/annotamate.service
sudoedit /etc/systemd/system/annotamate.service     # adjust ReadWritePaths, see below
sudo systemctl daemon-reload
sudo systemctl enable --now annotamate
systemctl status annotamate
journalctl -u annotamate -f
```

The unit is hardened: the service cannot gain privileges, has a private `/tmp`, and sees the whole
file system read-only (`ProtectSystem=strict`) except the paths in `ReadWritePaths=`. That line
must list the data directory **and every dataset root**:

```ini
ReadWritePaths=/var/lib/annotamate /data/datasets /mnt/more-datasets
```

Two more things to know about the sandbox:

- `ProtectHome=true` hides `/home`. If your datasets are below `/home`, change it to
  `ProtectHome=read-only` and add the dataset folder to `ReadWritePaths=`.
- Paths in `ReadWritePaths=` must exist when the service starts.

**5. Create the first administrator**

Either open the web interface and fill in the *Create the administrator account* screen (from another
machine it asks for the one-time setup token that the service prints in its log: `journalctl -u annotamate`),
or do it on the command line. The command must run as the service user with the same settings, so that it uses the
same database:

```bash
sudo -u annotamate env $(grep -v '^#' /etc/annotamate/annotamate.env | xargs) \
  /opt/annotamate/venv/bin/annotamate user create admin --admin
```

## 7. HTTPS with a reverse proxy

Put a reverse proxy in front of Annotamate whenever people connect over anything but an SSH tunnel
or a trusted network. The proxy terminates TLS and forwards requests to `127.0.0.1:8765`.

On the Annotamate side:

| Setting | Value | Why |
| --- | --- | --- |
| `ANNOTAMATE_HOST` | `127.0.0.1` | Only the proxy can reach the application. |
| `ANNOTAMATE_SECURE_COOKIES` | `true` | The session cookie is only sent over HTTPS. |

What the proxy must do:

- **Forward WebSockets.** The live features (presence, edit locks, chat, notifications) use a
  WebSocket at `/api/ws`. The proxy must pass the `Upgrade` and `Connection` headers and must not
  close the connection after a short idle time.
- **Keep the `Host` header.** Annotamate accepts a WebSocket only when its `Origin` matches the
  host of the request. If the proxy rewrites `Host`, the page loads but live updates never connect.
- **Forward the path unchanged.** No rewriting and no prefix stripping, also when hosting under a
  [sub-path](#8-hosting-under-a-sub-path).
- **Allow large request bodies only for image uploads** (`/api/projects/<id>/upload`). Annotamate
  limits each file to `ANNOTAMATE_MAX_UPLOAD_MB` (50 by default) and a whole upload request to
  `ANNOTAMATE_MAX_UPLOAD_REQUEST_MB` (1024 by default); every other request body to
  `ANNOTAMATE_MAX_BODY_MB` (2 by default). The example configurations in `deploy/` use a 2 MB default
  and a 1 GB limit on the upload path only.
- **Use generous timeouts** for exports of large datasets.
- **Send `X-Forwarded-For`**, and tell Annotamate to trust it (next section).

### Client addresses and the sign-in limit

Annotamate limits failed sign-ins to 10 per address and user name in 10 minutes and, so that one
address cannot try many user names, to 30 per public address in total (`ANNOTAMATE_LOGIN_IP_LIMIT`;
`0` turns it off). Loopback and private addresses only get the first limit, because many users can share
one of them. Behind a proxy
the address of the TCP connection is the proxy's, so the limit only sees real client addresses if
the server trusts the `X-Forwarded-For` header sent by the proxy. The server runs uvicorn with proxy
headers enabled and trusts them only from the addresses in the `FORWARDED_ALLOW_IPS` environment
variable (a comma-separated list; default `127.0.0.1`).

| Setup | What to do |
| --- | --- |
| Proxy on the same host (systemd, Caddy or nginx on `127.0.0.1`) | Nothing: the default already trusts it. |
| Proxy on another host, or a Docker network | Set `FORWARDED_ALLOW_IPS` to the proxy's address, for example `FORWARDED_ALLOW_IPS=10.0.0.5`. |
| Docker Compose with the Caddy service | Set `FORWARDED_ALLOW_IPS: "*"`. This is safe only when the application port is not published, so that nothing but the proxy can connect. |

Without it every visitor appears to come from the proxy, and failed sign-ins of one person count
against everyone who uses the same user name. Never use `*` when clients can reach the application
directly, because they could then forge the header. The proxy must also replace, not extend, a header
sent by the client: the nginx example sets `X-Forwarded-For $remote_addr`, and Caddy ignores incoming
values by default.

While no account exists, a request that carries proxy headers (`X-Forwarded-For`, `Forwarded`,
`X-Real-IP`, `Via`) always needs the setup token, even when the proxy runs on the same machine.

### Caddy

[Caddy](https://caddyserver.com) obtains and renews certificates automatically. You need a DNS
name that points at the server and ports 80 and 443 open.

[`deploy/Caddyfile`](../../deploy/Caddyfile) is a complete example. The essential part is:

```caddyfile
annotate.example.com {
	reverse_proxy 127.0.0.1:8765
}
```

`reverse_proxy` forwards WebSockets, keeps the `Host` header and adds `X-Forwarded-*` headers
without further configuration. The example file reads the domain and the upstream address from the
environment variables `ANNOTAMATE_DOMAIN` and `ANNOTAMATE_UPSTREAM`, which is how the Compose file
uses it.

Without a public DNS name (a LAN), `tls internal` makes Caddy sign the certificate with its own
local authority; browsers then need to trust Caddy's root certificate.

### nginx

[`deploy/nginx.conf`](../../deploy/nginx.conf) is a complete server configuration: HTTP to HTTPS
redirect, TLS, WebSocket upgrade headers, `client_max_body_size`, timeouts and the `X-Forwarded-*`
headers. Copy it to `/etc/nginx/conf.d/annotamate.conf`, replace the server name and the
certificate paths, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Certificates can come from Let's Encrypt, for example with certbot:

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt -d annotate.example.com
```

Points that are easy to get wrong in a hand-written nginx configuration:

- `proxy_http_version 1.1` plus the `Upgrade` and `Connection` headers are required for the WebSocket.
- `proxy_set_header Host $http_host;` keeps the host exactly as the browser sent it.
- `proxy_pass http://annotamate;` has no trailing slash, so the path is forwarded unchanged.
- nginx's default `client_max_body_size` is 1 MB, which rejects almost every image upload with
  `413 Request Entity Too Large`.

## 8. Hosting under a sub-path

To serve Annotamate at `https://example.com/annotamate/` instead of its own host name:

1. Tell Annotamate its prefix:

   ```ini
   ANNOTAMATE_BASE_URL=/annotamate/
   ```

   (or `annotamate serve --base-url /annotamate/`). The application then serves its pages, its API
   (`/annotamate/api/...`) and its WebSocket (`/annotamate/api/ws`) below that prefix.

2. Configure the proxy to forward the prefix **unchanged**. The proxy must not strip it.

   Caddy: use `handle`, not `handle_path`:

   ```caddyfile
   example.com {
   	redir /annotamate /annotamate/ 308
   	handle /annotamate/* {
   		reverse_proxy 127.0.0.1:8765
   	}
   }
   ```

   nginx: `proxy_pass` without a path:

   ```nginx
   location /annotamate/ {
       proxy_pass http://127.0.0.1:8765;      # no trailing slash, no path
       # plus the headers from deploy/nginx.conf
   }
   ```

   With `proxy_pass http://127.0.0.1:8765/;` (trailing slash) nginx would replace `/annotamate/`
   by `/`, and the application would answer with "not found" pages or a blank screen.

3. Health checks move with the prefix: `/annotamate/api/health`. The health check built into the
   container image follows `ANNOTAMATE_BASE_URL` by itself; the one in `docker-compose.yml` has the
   URL written out and needs the prefix added.

Both example files in `deploy/` contain a commented sub-path section.

## 9. File permissions and user IDs

Annotamate writes into your dataset folders: label files, `classes.txt` and uploaded images. Files
are created by the user the server runs as, so that user decides who owns your labels.

**What the server needs**

| Path | Access |
| --- | --- |
| Dataset roots (image folders) | read; write if labels are stored next to the images or images are uploaded |
| Label folders | read and write, including creating files in the folder (saves are atomic: a temporary file is written next to the label file and then renamed over it) |
| Data directory | read and write |

Because a save writes a new file and renames it over the old one, the label folder itself must be
writable, and a label file that another user created is owned by the server's user after its next
save (its permission bits are kept).

**Docker**

The image runs as user and group `1000:1000` by default. If your datasets belong to another user,
pass that user's IDs with `--user "$(id -u):$(id -g)"` (or `user:` in Compose, see
[section 5](#5-docker-compose)). Otherwise you get one of two symptoms: the server cannot save
(read-only images, errors on save), or it can, and the new label files belong to a user your
training jobs cannot work with.

The state volume at `/var/lib/annotamate` accepts any user ID. If you bind-mount a host folder
there instead of using a named volume, make that folder writable for the chosen user.

**systemd**

The unit runs as the `annotamate` user with `UMask=0002`, so new files are writable by the
`annotamate` group. Add the people and service accounts that work with the datasets to that group
(step 2 in [section 6](#6-systemd-service)).

**Network file systems.** On NFS or SMB mounts, check that the server's user ID maps to a user with
write access on the file server, and that `root_squash` or similar options do not get in the way.

**Read-only datasets.** If the server may read but not write a label folder, images still open but
saving fails. Give write access, or point the project's label folder at a writable location.

## 10. Configuration reference

Flags override environment variables.

| Setting | Flag | Environment variable | Default |
| --- | --- | --- | --- |
| Host | `--host` | `ANNOTAMATE_HOST` | `127.0.0.1` |
| Port | `--port` | `ANNOTAMATE_PORT` | `8765` |
| Dataset roots | `--root` (repeatable) | `ANNOTAMATE_ROOTS` | current directory |
| Data directory | `--data-dir` | `ANNOTAMATE_DATA_DIR` | see below |
| Database URL | | `ANNOTAMATE_DATABASE_URL` | `sqlite:///<data-dir>/annotamate.db` |
| Base URL | `--base-url` | `ANNOTAMATE_BASE_URL` | `/` |
| Secure cookies | `--secure-cookies` | `ANNOTAMATE_SECURE_COOKIES` | `false` |
| Session lifetime (days) | | `ANNOTAMATE_SESSION_DAYS` | `14` |
| Maximum upload size (MB per file) | | `ANNOTAMATE_MAX_UPLOAD_MB` | `50` |
| Maximum whole upload request (MB) | | `ANNOTAMATE_MAX_UPLOAD_REQUEST_MB` | `1024` |
| Maximum request body, other routes (MB) | | `ANNOTAMATE_MAX_BODY_MB` | `2` |
| Largest image accepted (megapixels) | | `ANNOTAMATE_MAX_IMAGE_MEGAPIXELS` | `150` |
| Failed sign-ins per public address in 10 minutes (0 = no limit) | | `ANNOTAMATE_LOGIN_IP_LIMIT` | `30` |
| Open the browser | `--open` / `--no-open` | | off for `serve`, on for bare `annotamate` |
| Log level | `--log-level` | `ANNOTAMATE_LOG_LEVEL` | `info` |

Notes:

- Values are case-insensitive for the log level (`debug`, `info`, `warning`, `error`, `critical`)
  and booleans accept `true` or `false`.
- `FORWARDED_ALLOW_IPS` is read by uvicorn, not by Annotamate; see
  [client addresses](#client-addresses-and-the-sign-in-limit).

- `ANNOTAMATE_ROOTS` separates several folders with the path separator of the operating system:
  `:` on Linux and macOS, `;` on Windows.
- The default data directory is `$XDG_DATA_HOME/annotamate` or `~/.local/share/annotamate` on Linux
  and macOS, and `%LOCALAPPDATA%\Annotamate` on Windows. The container image and the systemd
  example use `/var/lib/annotamate`.
- Sessions use a sliding expiry: the lifetime counts from the last activity.
- `ANNOTAMATE_SECURE_COOKIES=true` over plain HTTP makes signing in impossible, because browsers
  do not send `Secure` cookies over HTTP.

Command-line reference:

```text
annotamate serve [--host H] [--port P] [--root PATH ...] [--data-dir D] [--base-url /x] [--secure-cookies]
                 [--log-level L] [--open | --no-open]
annotamate user create USERNAME [--admin] [--display-name NAME] [--password PW]
annotamate user passwd USERNAME
annotamate user list
annotamate desktop
annotamate version
```

The `user` commands work on the database of the data directory, so run them with the same
`ANNOTAMATE_DATA_DIR` (and `ANNOTAMATE_DATABASE_URL`, if set) and as the same operating-system user
as the server.

Health endpoint for monitoring: `GET /api/health` returns `{"status": "ok", "version": "..."}`
without authentication.

## 11. Backups

There are two things to back up, and they are independent.

### Label files and images

These are ordinary files in your dataset folders. Back them up with the tools you already use
(`rsync`, `restic`, `borg`, file-system snapshots). Label files are replaced atomically, so a copy
taken while people are working never contains a half-written file.

If a project uses a separate label folder, make sure it is part of the backup, along with its
`classes.txt`. In YOLO projects the class list gives the numbers in the label files their meaning.

### The database

The database holds accounts, projects, statuses, assignments, chat, comments, notifications,
activity and annotation revisions.

**SQLite** runs in WAL mode, so do not simply copy `annotamate.db` while the server is running; the
copy can be inconsistent. Use SQLite's online backup instead, which is safe while the server runs:

```bash
sqlite3 /var/lib/annotamate/annotamate.db ".backup '/backups/annotamate-$(date +%F).db'"
```

If the `sqlite3` tool is not installed, Python can do the same:

```bash
python3 - /var/lib/annotamate/annotamate.db "/backups/annotamate-$(date +%F).db" <<'EOF'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()
EOF
```

With Docker, run the backup inside the container and write it to the dataset mount or another
mounted folder:

```bash
docker exec annotamate python -c "import sqlite3; s = sqlite3.connect('/var/lib/annotamate/annotamate.db'); d = sqlite3.connect('/data/annotamate-backup.db'); s.backup(d); d.close(); s.close()"
```

Alternatively, stop the server and copy `annotamate.db` together with `annotamate.db-wal` and
`annotamate.db-shm` if they exist.

**PostgreSQL**: use `pg_dump` as for any other database.

The `cache/` folder in the data directory does not need a backup; it is rebuilt on demand.

### Restoring

1. Stop the server.
2. Put the database backup in place as `<data-dir>/annotamate.db` and delete any leftover
   `annotamate.db-wal` and `annotamate.db-shm` files.
3. Restore dataset folders if needed.
4. Start the server.

If only the database is lost, nothing happens to the labels: create an administrator, create the
projects again on the same folders and the existing label files are picked up. Images that already
have a label file start with the status *done*.

## 12. Upgrades

Database migrations run automatically when the server starts. The procedure is the same for every
installation method:

1. Read the [changelog](../../CHANGELOG.md) for the versions you are skipping.
2. [Back up the database](#the-database).
3. Install the new version and restart.

**pip / systemd**

```bash
sudo /opt/annotamate/venv/bin/pip install --upgrade \
  https://github.com/rugvedjalit/Annotamate/releases/download/vX.Y.Z/annotamate-X.Y.Z-py3-none-any.whl
sudo systemctl restart annotamate
```

**Docker**

```bash
docker pull ghcr.io/rugvedjalit/annotamate:latest
docker stop annotamate && docker rm annotamate
docker run ...        # the same command as before
```

**Docker Compose**

```bash
docker compose pull
docker compose up -d
```

For predictable upgrades, pin a version tag (`ghcr.io/rugvedjalit/annotamate:2.0.0`) instead of
`latest` and change it deliberately.

During a restart, connected browsers show that the connection is lost and reconnect by themselves.
Edit locks are released by the restart and taken again when the clients reconnect.

**Rolling back.** A newer version may have changed the database schema. To go back to an older
version, restore the database backup taken before the upgrade. Label files do not depend on the
application version.

**Coming from Annotamate 1.x (desktop).** There is nothing to migrate. Create a project on the
folder you annotated with the desktop app, choose the same label format and, if you used one, the
same label folder. The existing labels and `classes.txt` are read as they are.

## 13. PostgreSQL

SQLite is the default and is enough for most teams. PostgreSQL is an option if you prefer to
operate a database server, for example to use your existing backup and monitoring.

1. Install the driver with the `postgres` extra:

   ```bash
   /opt/annotamate/venv/bin/pip install "annotamate[postgres] @ https://github.com/rugvedjalit/Annotamate/releases/download/v2.0.0/annotamate-2.0.0-py3-none-any.whl"
   ```

   For Docker, build the image with the extra: `docker build --build-arg ANNOTAMATE_EXTRAS=postgres -t annotamate .`

2. Create a database and a user:

   ```sql
   CREATE USER annotamate WITH PASSWORD 'change-me';
   CREATE DATABASE annotamate OWNER annotamate;
   ```

3. Point Annotamate at it:

   ```ini
   ANNOTAMATE_DATABASE_URL=postgresql+psycopg://annotamate:change-me@127.0.0.1:5432/annotamate
   ```

The tables are created on the first start. The data directory is still needed for the cache.
Existing data is not copied from SQLite to PostgreSQL automatically; choose the database before the
team starts working.

Even with PostgreSQL, run a single Annotamate process.

## 14. Troubleshooting

**The page does not load from another computer.**
The server listens on `127.0.0.1` by default. Use an SSH tunnel or a reverse proxy, or set
`ANNOTAMATE_HOST=0.0.0.0` on a trusted network. Check the firewall for the port.

**Signing in "works" but the sign-in page comes back.**
`ANNOTAMATE_SECURE_COOKIES=true` while the site is opened over plain HTTP: the browser discards
the cookie. Use HTTPS, or set it to `false` for HTTP-only setups.

**Pages load, but presence, chat and locks do not update; the editor stays read-only.**
The WebSocket does not connect. Behind a proxy, check that the upgrade headers are forwarded for
`/api/ws`, that the `Host` header is passed through unchanged, and that the address in the browser
is the one the proxy forwards (same host and port). The browser's developer tools show the failed
WebSocket request in the network tab.

**Blank page or missing styles under a sub-path.**
`ANNOTAMATE_BASE_URL` does not match the path in the proxy, or the proxy strips the prefix. See
[section 8](#8-hosting-under-a-sub-path).

**`413` when uploading images.**
Either a file is larger than `ANNOTAMATE_MAX_UPLOAD_MB`, the request is larger than
`ANNOTAMATE_MAX_UPLOAD_REQUEST_MB`, or the proxy's body limit is too small
(`client_max_body_size` in nginx, `request_body max_size` in Caddy). The proxy examples allow large
bodies on the upload path only; any other request over 2 MB is refused with `413 too_large`.

**Too many sign-in attempts (`429`).**
After 10 failed attempts for the same user name from the same address, sign-in is blocked for up to
10 minutes. Wait and try again; if the password is forgotten, an administrator can set a new one.

**A folder does not appear in the folder browser, or a project cannot be created on it.**
The folder is not inside a dataset root, or it is a symbolic link pointing outside the roots. Add
the real location to `ANNOTAMATE_ROOTS` (and, with systemd, to `ReadWritePaths=`; with Docker,
mount it into the container).

**Saving fails, or everything is read-only.**
Check [file permissions](#9-file-permissions-and-user-ids): the server's user must be able to create
files in the label folder. With systemd, check `ReadWritePaths=`; a path missing there is read-only
for the service even when the file permissions allow writing.

**One image is read-only with a notice about the label file.**
The label file contains something Annotamate does not edit, such as YOLO segmentation polygons or
oriented boxes (lines with more than five values), or it cannot be parsed. The file is protected
from being overwritten. This is a property of that file, not a deployment problem.

**Boxes are shifted or rotated compared with another tool.**
The image carries an EXIF orientation tag and the two tools treat it differently. Check the
project's EXIF setting in the [administrator guide](administrator.md#exif-orientation-step-3-details).

**The systemd service fails immediately.**
`journalctl -u annotamate -e` shows the reason. Common causes: a path in `ReadWritePaths=` does not
exist; the environment file is missing or not readable; the port is in use.

**The container is `unhealthy`.**
`docker logs annotamate` shows the start-up output. If you changed `ANNOTAMATE_PORT` or
`ANNOTAMATE_BASE_URL` and use the Compose file, update the health check URL there as well.

**Forgotten administrator password.**
`annotamate user passwd NAME` on the server sets a new one (see the note on running `user` commands
in [section 10](#10-configuration-reference)). `annotamate user create NAME --admin` creates
another administrator.

**Where are the logs?**
On standard output: `journalctl -u annotamate` with systemd, `docker logs annotamate` or
`docker compose logs annotamate` with Docker. Set `ANNOTAMATE_LOG_LEVEL=debug` for more detail.
