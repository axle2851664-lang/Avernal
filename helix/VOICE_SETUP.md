# Giving Helix a voice

Speech goes through [ElevenLabs](https://elevenlabs.io). Two environment
variables and he talks.

## 1. Get a key

Sign in at elevenlabs.io, open your profile, copy the API key.

## 2. Find a voice id

Any voice on your account works. Either copy the id from their **Voices** page,
or ask Helix once the key is set:

```bash
curl -s localhost:3000/voice/voices | python3 -m json.tool
```

## 3. Start Helix with both

```bash
ELEVENLABS_API_KEY=your-key \
ELEVENLABS_VOICE_ID=your-voice-id \
npm run server
```

On Windows PowerShell:

```powershell
$env:ELEVENLABS_API_KEY = "your-key"
$env:ELEVENLABS_VOICE_ID = "your-voice-id"
npm run server
```

Or put them in `.env` beside `package.json`, which is already gitignored and
already how the Gmail and YouTube credentials are supplied:

```
ELEVENLABS_API_KEY=your-key
ELEVENLABS_VOICE_ID=your-voice-id
```

`ELEVENLABS_MODEL_ID` is optional and defaults to `eleven_multilingual_v2`.

## 4. Check it

The **Voice** light in the corner of the main screen reads *on* once both are
set. Then open the console with `Ctrl+K` and type:

```
SPEAK Good evening, sir.
```

## Where the key goes

Into one HTTP header on an outbound request, and nowhere else. It is not
returned by any route, not written into any error, not logged, and not stored —
the memory layer refuses key-shaped text, so Helix will decline to remember it
even if you ask him to. If you want a different key, change the environment and
restart.

`/voice/status` tells you whether Helix can speak and which variable is
missing if he cannot. It never includes the key.

## Limits

- 800 characters per line. These are spoken replies; ElevenLabs bills per
  character and a wall of text is not a remark.
- Audio comes back in the response and is played once. Nothing is written to
  disk — a folder slowly filling with every sentence Helix has ever said is a
  transcript nobody asked for.

## When it will not speak

| what you see | what it means |
| --- | --- |
| `Set ELEVENLABS_API_KEY…` | the variables are not set, or not visible to the server |
| `ElevenLabs rejected the API key` | the key is wrong or revoked |
| `not allowed to use this voice` | the key is fine; the voice id is not on that account |
| `no voice with that id` | the voice id is wrong |
| `quota reached` | the account's character budget for this period is spent |
| `Could not reach ElevenLabs` | no network path out |
