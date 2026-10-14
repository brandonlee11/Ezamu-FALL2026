# Aloud

Unmoderated user testing. You write a few tasks, share a link, and people record their screen and voice while they try your website and think out loud. You review the videos with timestamped notes and a cross-session summary.

No dependencies to install: it runs on Node's built-in modules and SQLite.

## Run it

Requires **Node 22.13 or newer**.

```bash
node server.js
# open http://localhost:3000
```

Options (environment variables):

| Variable     | Default   | Purpose                                      |
|--------------|-----------|----------------------------------------------|
| `PORT`       | `3000`    | Port to listen on                            |
| `ALOUD_DATA` | `./data`  | Where the database and recordings are stored |
| `ALOUD_ALLOW_SIGNUP` | `true` | Set to `false` on a public server. After the first account exists, nobody else can register |

You'll see an "SQLite is an experimental feature" warning on startup. That comes from Node and is harmless.

## How it works

**Researcher** (`/app`): create an account, create a test (site address, welcome message, tasks, follow-up questions), copy the share link. Each test has three tabs: Sessions, Summary (task completion, average times, ratings, written answers, note counts) and Setup.

**Tester** (`/t/<link>`, no account): reads the welcome message, consents, shares their screen and microphone, and works through the tasks from a floating panel. Recording uploads in small pieces while they work, so a closed tab doesn't lose the session. Afterwards they answer your questions.

**Review** (`/app#/session/<id>`): video player with markers on the timeline for task starts and notes. Add notes at the current second, tag them as Problem, Insight or Positive, and click any timestamp to jump there.

**Export** (button on a test's page, once it has sessions):
- **Excel report (.xlsx)** has five tabs. *Summary* is the page for a project sponsor: sessions, average length, task completion rates and times, rating averages, note counts. *Sessions* has one row per tester. *Task results*, *Answers* and *Notes* have one row per item, ready for filtering or pivot tables.
- **CSV** is the Sessions tab on its own, for any other tool. Text a tester typed that starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe so spreadsheets never run it as a formula.
- Videos are not embedded in the spreadsheet (they are tens of megabytes each). Instead, each session row has a **Video file name** that matches the downloaded file, and a **Video link** that opens the recording wherever your team keeps it.

**Recordings** (session page → *Recording*):
- **⬇ Download video** saves that session's recording, named like `checkout-round-1-session-2-rita.webm`.
- **Shared drive link:** upload the downloaded file to your team's shared drive, paste its link into the box and press *Save link*. It is stored in Aloud, so it appears as a clickable "Watch recording" cell in every future Excel export (and as a plain address in the CSV).
- Recordings are **WebM**. They play in Chrome, Edge, Firefox and VLC. For PowerPoint, QuickTime or other tools that dislike WebM, convert with [ffmpeg](https://ffmpeg.org): `ffmpeg -i input.webm output.mp4`.

## Putting it online

`localhost` only works on your own computer, so to send tests to other people Aloud has to run somewhere they can reach, over HTTPS. Two things it needs from any host: **Node 22.13+** and a **persistent disk** (the database and recordings live in `ALOUD_DATA`, so a host that wipes its disk on every restart will lose them).

- **Trying it with a few people today:** keep it running on your computer and use a free tunnel, for example `cloudflared tunnel --url http://localhost:3000`. It prints an `https://…` address to put in front of testers. It works only while your computer is on and the tunnel is running.
- **A small server (most control):** rent a basic VPS, install Node 22, run `ALOUD_ALLOW_SIGNUP=false node server.js` under a process manager such as systemd or pm2, and put Caddy in front of it. Caddy gets the HTTPS certificate for your domain automatically.
- **A platform that runs Docker:** the included `Dockerfile` works on hosts such as Fly.io, Railway or Render. Attach a persistent volume at `/data`, set `ALOUD_ALLOW_SIGNUP=false` after creating your account, and use the HTTPS address the platform gives you.

The share link shown in the dashboard always uses the address you opened it from, so open the dashboard through your public address before copying links.

## Files

```
server.js        HTTP server, routes, auth, video upload and streaming
export.js        Excel and CSV report builder (no dependencies)
db.js            SQLite schema
Dockerfile       For hosts that run containers
public/          Pages and scripts: index.html, app.html/app.js, run.html/run.js, styles.css
data/            Created on first run: aloud.db and videos/
```

## Things to know before real use

- **HTTPS is required in production.** Browsers only allow screen recording on `https://` pages (and `localhost`). Put Aloud behind a reverse proxy such as Caddy or nginx. Behind a proxy, make sure it sends `X-Forwarded-Proto: https` so login cookies are marked Secure. Caddy does this by default.
- **Testers need a desktop browser.** Phones and tablets can't share their screen. Chrome and Edge give the best experience, including a pop-out task panel that floats above the website.
- **Consent matters.** The tester page asks for it, but you are responsible for telling people how recordings are used and complying with the privacy laws that apply to you.
- **Videos are WebM.** The browser doesn't write a duration into the file, so the player works around that, but seeking can be slightly coarse on long sessions.
- **No webcam, recruiting panel, email or team accounts yet.** You bring your own testers. These are natural next additions.
- **Hardening for public deployment:** add rate limiting on signup, login and uploads, and set a maximum recording length that suits you.
- **Back up `data/`.** It holds everything.
