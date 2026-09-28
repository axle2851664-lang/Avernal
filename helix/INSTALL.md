# Installing Helix as an app

Helix is a web app, so "installing" means telling your browser to keep it:
its own window, its own icon, no address bar. The catch is that browsers only
offer that over **HTTPS**, or on **localhost**. A bare LAN address —
`http://192.168.1.4:3000` — is not enough, and it is the same rule that stops
the microphone opening.

On your own machine that is free. On your phone it takes one command, because
you already have Tailscale.

---

## On the computer Helix runs on

```bash
cd helix
npm run server
```

Open <http://localhost:3000>. `localhost` counts as secure, so everything
works: install, microphone, the lot.

- **Chrome / Edge** — an install icon appears at the right-hand end of the
  address bar. Or ⋮ → *Cast, save and share* → *Install page as app*.
- **Safari** — File → *Add to Dock*.
- **Firefox** — does not install web apps. Helix still runs in a tab.

---

## On your phone, over Tailscale

Tailscale can put real HTTPS in front of Helix with a certificate for your
machine's `.ts.net` name. Nothing is published to the internet — only your own
devices can reach it.

**1. Start Helix as normal.** Leave it on localhost; Tailscale does the
exposing, so there is no reason to bind it to anything wider:

```bash
npm run server
```

**2. Put Tailscale in front of it**, on the machine Helix runs on:

```bash
tailscale serve --bg 3000
```

It prints the address, something like
`https://your-machine.your-tailnet.ts.net/`. That is a real certificate, so it
is a secure context, so the phone will install it and the microphone will
open.

**3. On the phone**, open that address:

- **iPhone (Safari)** — Share → *Add to Home Screen*. It must be Safari;
  Chrome on iOS cannot install web apps.
- **Android (Chrome)** — ⋮ → *Add to Home screen* → *Install*.

To stop sharing it later: `tailscale serve --bg --https=443 off`, or
`tailscale serve status` to see what is running.

### Do not use `tailscale funnel`

`funnel` is the same command's public sibling, and it puts Helix on the open
internet. Helix holds your notes, your Google tokens and your API keys behind
nothing but a check that the caller is on a private network — which everyone
on the internet would then pass. `serve` keeps it to your tailnet. Use
`serve`.

### If other people are on your tailnet

A tailnet you share with anyone else is not the same as your own laptop. Two
things worth doing:

- Set a token, and Helix will demand it:

  ```bash
  HELIX_TOKEN=$(openssl rand -hex 24) npm run server
  ```

  Visit `https://…ts.net/?token=THAT_VALUE` once on each device. Helix sets a
  year-long cookie and drops the token from the URL, so you install and use it
  normally afterwards. *On iPhone, do this inside the installed app as well as
  in Safari* — a home-screen web app has its own cookie jar and does not
  inherit Safari's.

- Or restrict it in your Tailscale ACLs, which keeps it off devices that have
  no business reaching it at all.

---

## Connecting Gmail or YouTube from the tailnet

Helix sends Google whichever address you started from, so one OAuth client
serves both localhost and your phone — but Google only accepts a redirect it
has been told about. Register both:

```
http://localhost:3000/auth/gmail/callback
https://your-machine.your-tailnet.ts.net/auth/gmail/callback
```

Open `/auth/status` on the device you are actually using and it prints the
exact callback Helix will send from there. Paste that into the Google console
and the mismatch goes away. Full walkthrough in GOOGLE_SETUP.md.

## What you get

| | |
| --- | --- |
| Its own window | No tabs, no address bar. The sphere gets the whole screen. |
| Its own icon | On the dock, the home screen, the app switcher. |
| Opens offline | You get the screen and an honest *"The vault could not be read"* rather than the browser's error page. |

Offline is deliberately shallow. The screen is cached; **nothing that answers
with data ever is**. A cached `/galaxy` would have Helix reporting a vault it
had not read, which is worse than saying it could not reach the server.

## When you change Helix

The service worker asks the network first and only falls back to its cache
when the server is unreachable, so an edit shows up on the next reload — there
is no stale-cache dance. If you change which files make up the screen, bump
`SHELL` in `public/sw.js` so the offline copy does not outlive the version it
belonged to.

## If the install option never appears

In order of likelihood:

1. **Not a secure context.** `http://` on anything but `localhost`. The
   console says so on load. This is nearly always it.
2. **Firefox**, or **Chrome on iOS** — neither installs web apps.
3. **Already installed.** Browsers stop offering once it is.
4. Open DevTools → *Application* → *Manifest*, which lists whatever is
   missing.
