# Gmail Integration Setup

Connect your Gmail account to Jarvis so emails and messages become knowledge galaxy notes.

## Step 1: Get Gmail OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable the **Gmail API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose **Desktop application**
6. Download the JSON credentials
7. Extract:
   - `client_id` → `GMAIL_CLIENT_ID`
   - `client_secret` → `GMAIL_CLIENT_SECRET`

## Step 2: Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and paste your credentials:

```
GMAIL_CLIENT_ID=your_client_id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your_secret_here
GMAIL_REDIRECT_URL=http://localhost:3000/auth/gmail/callback
```

## Step 3: Start the Server

```bash
npm run server
```

Output: `Helix server running on http://localhost:3000`

## Step 4: Authenticate Gmail

1. Visit: `http://localhost:3000/auth/gmail/start`
2. Click the generated link
3. Authorize Jarvis to access Gmail (read-only)
4. You'll be redirected with confirmation

## Step 5: Sync Emails

Once authenticated, trigger syncs:

- **Unread emails:** `POST http://localhost:3000/sync/gmail/unread`
- **From specific sender:** `POST http://localhost:3000/sync/gmail/from/someone@example.com`

Response includes notes ready to add to the galaxy.

## Integration with the Artifact

The artifact (https://claude.ai/code/artifact/39db6862-1427-400b-88e9-ef7030e23cd1) can now:

1. Call your local server: `POST http://localhost:3000/sync/gmail/unread`
2. Convert emails to knowledge notes
3. Feed them into the galaxy automatically

## Private Network Only

The server accepts connections **only from private networks** (RFC1918, link-local, CGNAT). This keeps your credentials and emails secure when accessing from your phone via Tailscale or local WiFi.

## Next: Messages, Calendar, Slack

We can add:
- **SMS/WhatsApp** syncing
- **Google Calendar** events
- **Slack** messages
- **Twitter/social** mentions

Let me know what else you want connected.
