# Giving Helix a voice — and something to say

**The short version: start Helix, press `Ctrl K`, type `SETTINGS`, paste your
keys in.** They are written to a `.env` beside the package that only you can
read, and the Anthropic and ElevenLabs keys take effect immediately — no
restart. Everything below is the same thing done by hand, and what each key
buys.

Two separate keys, and he needs both to hold a conversation:

| what | variable | gives him |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | the answer |
| ElevenLabs | `ELEVENLABS_API_KEY` | ears |
| ElevenLabs | `ELEVENLABS_VOICE_ID` | the voice to answer in |

With only the Anthropic key he answers in text and cannot hear you. With only
the ElevenLabs key he can hear you and speak a line you give him, but cannot
think of one himself.

Note the split: **listening needs the key alone**. Set `ELEVENLABS_API_KEY`
and the microphone works even before you have chosen a voice — he will just
answer on screen instead of out loud.

## Talking to him

Press **Voice** at the foot of the screen and say it. Helix records, stops on
his own when you stop talking, transcribes the clip through ElevenLabs, and
answers. Press it again to cut a recording short, or `Esc`. Nothing is
recorded until you press it, and nothing is written to disk — the clip exists
for the length of one request.

Two things the browser insists on:

- **A secure page.** `http://localhost` counts; a bare LAN address like
  `http://192.168.1.4` does not, and the microphone will refuse to open.
- **Permission**, once, per browser. If you refuse it, the control disables
  itself and says so rather than failing silently every time you press it.

`ELEVENLABS_STT_MODEL_ID` overrides the transcription model, which defaults to
`scribe_v2`. It is separate from `ELEVENLABS_MODEL_ID`, which is the speaking
model — the two catalogues move independently.

## Searching the web

Helix answers from your notes. He reaches past them only when your words say
to, and the reply says which words did it:

- **You ask outright** — "search the web for…", "look it up", "google…",
  "check the internet".
- **The question cannot be about your vault** — "what's the latest…", "who
  won", "the current price of…", "what's the weather", "today".
- **`WEB <question>`** in the console does the same thing explicitly.

Turn it off in the same breath with "don't search", "without looking it up",
"no need to search" — so "what did I write today, don't search" stays in the
vault.

The search runs on Anthropic's side through your existing `ANTHROPIC_API_KEY`;
there is no second key and no search provider to sign up for. At most three
searches per question. Under the answer you get which phrase turned it on and
which sites he read, so a search you did not expect is visible rather than
silent.

## Asking him something in writing

Open the console with `Ctrl+K` and type a question. Anything ending in `?`
is treated as one, so you do not need a command word:

```
what is my storage ceiling?
```

The console gets out of the way and the answer appears under the wordmark,
with a dim line under it saying which notes he used and anything he kept. He
says it aloud too, if a voice is set up. `ASK <question>` does the same thing
explicitly.

Nothing is selected when the console opens, so `Enter` on an empty console
does nothing. Arrow to a command or type one.

He answers **only** from your notes and what he has been told to remember. If
nothing in the vault covers it, he says so rather than filling the gap — the
line under the answer reads *"Not from your notes"* when the reply was
conversation rather than fact.

## The Anthropic key

Get one at [console.anthropic.com](https://console.anthropic.com). Then:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

Or in `.env` beside `package.json`, with the others:

```
ANTHROPIC_API_KEY=sk-ant-...
```

The **Mind** light in the corner reads *on* once it is set;
`/ask/status` says which variable is missing if it is not.

---

# The ElevenLabs voice

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
