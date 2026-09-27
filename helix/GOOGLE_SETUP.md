# Connecting Gmail and YouTube

Helix never sees your Google password. It sends you to Google, Google asks
you, and the code Google hands back is exchanged for a token. That is the
whole flow, and it is why none of it can be skipped.

**What Helix asks for is read-only.** `gmail.readonly`, `youtube.readonly`,
`yt-analytics.readonly`. It cannot send, delete or change anything, and if a
consent screen ever asks you for more than that, something is wrong — stop.

---

## 1. A Google Cloud project

1. [console.cloud.google.com](https://console.cloud.google.com/) → create a
   project, or pick one.
2. **APIs & Services → Library** → enable the APIs you want:
   - **Gmail API**
   - **YouTube Data API v3** and **YouTube Analytics API**

   An API you have not enabled fails later with `invalid_scope`, which does
   not mention the API.

## 2. The consent screen

**APIs & Services → OAuth consent screen.**

- **User type: External.** Internal only works if you have Google Workspace,
  and picking it with a personal account is the `org_internal` error.
- Fill in the app name and your email. Nothing else is required.
- **Scopes:** you can leave this empty. Helix asks for its scopes at sign-in.
- **Audience → Test users → Add users → your own Gmail address.**

That last step is the one everybody misses. A new app is in **Testing**, and
an app in Testing refuses everyone who is not on that list — including you,
the person who made it. It fails as `access_denied`, which reads like you
pressed Cancel. Helix says so in as many words if it happens.

You do **not** need to publish the app or get it verified. Testing is the
right mode for something only you use. The only cost is that the refresh
token expires after seven days, so you reconnect once a week.

## 3. Credentials

**APIs & Services → Credentials → Create credentials → OAuth client ID.**

Pick **Web application**, and under **Authorised redirect URIs** add exactly:

```
http://localhost:3000/auth/gmail/callback
http://localhost:3000/auth/youtube/callback
```

Scheme, host, port and path all have to match what Helix sends, character for
character. A mismatch is `redirect_uri_mismatch`.

> Reaching Helix from your phone? Add the LAN address too — the redirect has
> to match the address you opened Helix on:
> `http://192.168.1.50:3000/auth/gmail/callback`.

*(A **Desktop app** client also works and needs no registered URI, since
Google allows loopback addresses for those. Use it if you only ever connect
from the machine Helix runs on.)*

Copy the client ID and secret.

## 4. Tell Helix

In `.env` beside `package.json`:

```
GMAIL_CLIENT_ID=...apps.googleusercontent.com
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URL=http://localhost:3000/auth/gmail/callback

YOUTUBE_CLIENT_ID=...apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REDIRECT_URL=http://localhost:3000/auth/youtube/callback
```

The same client can serve both — just use its id and secret twice, and
register both redirect URIs on it.

## 5. Connect

```bash
npm run server
```

Then either open <http://localhost:3000/auth/gmail/start> — it sends you
straight to Google — or press `Ctrl+K` in Helix and run **CONNECT GMAIL**,
which shows you the link rather than following it.

Grant access, and Google returns you to a page that says so. The **Gmail**
light in the corner turns on.

Then `Ctrl+K` → **SYNC GMAIL**.

---

## When it goes wrong

Helix explains these on the page Google returns you to, rather than showing
the code.

| what you see | what to change |
| --- | --- |
| `access_denied` | You are not on the test-user list. Consent screen → Audience → Test users. |
| `redirect_uri_mismatch` | The URI registered is not the one Helix sent. They must match exactly, including port. |
| `invalid_client` | The id and secret are not from the same client, or one has a stray space. |
| `invalid_scope` | The API is not enabled on the project. |
| `org_internal` | The consent screen is Internal. Set it to External. |
| `admin_policy_enforced` | A Workspace administrator blocks the app. |
| "did not come from a sign-in Helix started" | The link was stale or opened out of order. Start again from `/auth/gmail/start`. |
| "Google did not issue a refresh token" | Google only issues one on a first authorisation. Remove Helix at [myaccount.google.com](https://myaccount.google.com/permissions) → Data & privacy → Third-party access, then connect again. |

## Where the tokens live

`.tokens.json` under the data root, written `0600`. It holds an access token
and a refresh token — no password, and nothing about your account beyond
that. It is gitignored.

**To disconnect:** `POST /auth/gmail/disconnect` makes Helix forget its copy.
That is all it can do — the grant itself lives in your Google account, and
you revoke it at
[myaccount.google.com](https://myaccount.google.com/permissions) → Data &
privacy → Third-party access. Helix saying it had "revoked" your grant would
be claiming a reach it does not have.

## Reaching it from your phone

The server refuses to listen beyond loopback without a shared token, because
this process holds tokens to your mail:

```bash
HELIX_TOKEN=$(openssl rand -hex 24) HOST=0.0.0.0 npm run server
```

Open the printed URL on the phone once — the token is remembered in a cookie
— and add that address's callback URI to the OAuth client.
