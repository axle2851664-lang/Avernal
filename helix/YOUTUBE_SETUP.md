# YouTube Integration Setup

Connect your "Black Bear" YouTube channel (registered under YoutubeAxle@gmail.com) to Jarvis and sync videos into the knowledge galaxy.

## Step 1: OAuth Credentials (Reuse or Create)

You can use the **same OAuth 2.0 app** from the Gmail setup, or create a separate one:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your existing project (or create a new one)
3. Enable the **YouTube Data API v3**
4. Credentials are already created from Gmail setup—**reuse them** or create new ones
5. For a new app: Create **Desktop application** OAuth 2.0 Client ID
6. Extract:
   - `client_id` → `YOUTUBE_CLIENT_ID`
   - `client_secret` → `YOUTUBE_CLIENT_SECRET`

## Step 2: Configure Environment

Edit your `.env` file:

```
YOUTUBE_CLIENT_ID=your_client_id.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=your_client_secret_here
YOUTUBE_REDIRECT_URL=http://localhost:3000/auth/youtube/callback
```

**Important:** These credentials will trigger login for the account that owns the YouTube channel. Use `YoutubeAxle@gmail.com` when prompted.

## Step 3: Start the Server

```bash
npm run server
```

## Step 4: Authenticate YouTube

1. Visit: `http://localhost:3000/auth/youtube/start`
2. Click the generated link
3. **Sign in with YoutubeAxle@gmail.com** (Black Bear's account)
4. Authorize "Jarvis" to access your YouTube channel (read-only)
5. Confirmation: "YouTube connected successfully"

## Step 5: Sync Videos

Once authenticated, trigger sync:

- **All channel videos:** `POST http://localhost:3000/sync/youtube/videos`

Response includes video metadata ready to add to the galaxy:
- Title (truncated)
- View count
- Like count
- Comment count
- Channel name
- Publication date
- Description (first 1000 chars)
- Video ID

## Integration with the Artifact

The artifact now has a **▶️ (play)** button alongside 📧 (Gmail):

1. Click **▶️** in the galaxy
2. Artifact calls your local server
3. Pulls videos from Black Bear channel
4. Converts to knowledge notes
5. Adds to galaxy automatically

Each video becomes a searchable note tagged with `youtube` and `video`.

## Next Steps

We can add:
- **Transcript extraction** (requires youtube-transcript-api)
- **Comment scraping** (fetch top comments per video)
- **Analytics time-series** (views/likes over time)
- **Playlist syncing** (other playlists besides uploads)

Let me know what you'd like next!
