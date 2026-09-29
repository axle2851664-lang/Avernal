import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsVoice, MAX_AUDIO_BYTES, MAX_SPEECH_LENGTH, VoiceError } from '../elevenlabs.js';

const KEY = 'test-key-value-not-real';
const CONFIG = { apiKey: KEY, voiceId: 'voice-123' };

function respond(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

describe('configuration', () => {
  it('is not configured without both a key and a voice, and says which is missing', () => {
    expect(new ElevenLabsVoice({}).status().reason).toContain('ELEVENLABS_API_KEY');
    expect(new ElevenLabsVoice({ apiKey: KEY }).status().reason).toContain('ELEVENLABS_VOICE_ID');
    expect(new ElevenLabsVoice({ voiceId: 'v' }).status().reason).toContain('ELEVENLABS_API_KEY');
    expect(new ElevenLabsVoice(CONFIG).configured).toBe(true);
  });

  it('reports the hearing gap separately from the speaking gap', () => {
    // A missing voice id stops him speaking, not hearing. Telling someone to
    // set one to fix the microphone sends them the wrong way.
    const halfway = new ElevenLabsVoice({ apiKey: KEY }).status();
    expect(halfway.configured).toBe(false);
    expect(halfway.reason).toContain('ELEVENLABS_VOICE_ID');
    expect(halfway.canHear).toBe(true);
    expect(halfway.hearingReason).toBeNull();

    const nothing = new ElevenLabsVoice({}).status();
    expect(nothing.canHear).toBe(false);
    expect(nothing.hearingReason).toContain('ELEVENLABS_API_KEY');
  });

  it('never puts the key in its own status', () => {
    const status = new ElevenLabsVoice(CONFIG).status();
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it('reads the environment without reaching anywhere else for the key', () => {
    const voice = ElevenLabsVoice.fromEnvironment({
      ELEVENLABS_API_KEY: KEY,
      ELEVENLABS_VOICE_ID: 'voice-123',
    } as NodeJS.ProcessEnv);
    expect(voice.configured).toBe(true);
    expect(voice.status().voiceId).toBe('voice-123');
  });

  it('refuses to call out at all when it is not configured', async () => {
    const fetchImpl = vi.fn();
    const voice = new ElevenLabsVoice({}, fetchImpl as unknown as typeof fetch);

    await expect(voice.speak('hello')).rejects.toBeInstanceOf(VoiceError);
    // The point: no request is attempted, so nothing leaks and nothing 401s.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('speak', () => {
  it('sends the key as a header and the text as the body', async () => {
    const fetchImpl = vi.fn(async () =>
      respond(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })
    );
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    const speech = await voice.speak('Good evening.');

    expect(speech.audio).toHaveLength(3);
    expect(speech.contentType).toBe('audio/mpeg');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/text-to-speech/voice-123');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
    expect(String(init.body)).toContain('Good evening.');
    // The key belongs in the header and nowhere else.
    expect(String(init.body)).not.toContain(KEY);
  });

  it('will not speak nothing, or an essay', async () => {
    const fetchImpl = vi.fn();
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    await expect(voice.speak('   ')).rejects.toThrow('nothing to say');
    await expect(voice.speak('x'.repeat(MAX_SPEECH_LENGTH + 1))).rejects.toThrow('the limit is');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('translates a rejected key, a quota wall and an outage into plain sentences', async () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [401, 'rejected the API key'],
      [403, 'not allowed to use this voice'],
      [404, 'no voice with that id'],
      [429, 'quota reached'],
      [503, 'having trouble'],
    ];

    for (const [status, fragment] of cases) {
      const voice = new ElevenLabsVoice(CONFIG, (async () =>
        respond('{"detail":"whatever they said"}', { status })) as unknown as typeof fetch);
      await expect(voice.speak('hello'), String(status)).rejects.toThrow(fragment);
    }
  });

  it('does not pass their error body through, so nothing of ours can come back in it', async () => {
    // Their bodies sometimes echo the request. Mapping status to our own
    // sentence is what guarantees the key cannot return in an error.
    const voice = new ElevenLabsVoice(CONFIG, (async () =>
      respond(JSON.stringify({ detail: 'bad key ' + KEY }), { status: 401 })) as unknown as typeof fetch);

    await expect(voice.speak('hello')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(KEY) }) as Error
    );
  });

  it('reports a network failure as one, rather than as a refusal', async () => {
    const voice = new ElevenLabsVoice(CONFIG, (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch);

    await expect(voice.speak('hello')).rejects.toThrow('Could not reach ElevenLabs');
  });

  it('treats an empty body as a failure rather than as silence', async () => {
    const voice = new ElevenLabsVoice(CONFIG, (async () =>
      respond(new Uint8Array([]))) as unknown as typeof fetch);
    await expect(voice.speak('hello')).rejects.toThrow('no audio');
  });
});

describe('voices', () => {
  it('lists what the key can use', async () => {
    const voice = new ElevenLabsVoice(CONFIG, (async () =>
      respond(
        JSON.stringify({
          voices: [
            { voice_id: 'a', name: 'Alice', category: 'premade' },
            { voice_id: 'b', name: 'Bob', category: 'cloned' },
            { name: 'no id, skipped' },
          ],
        })
      )) as unknown as typeof fetch);

    const list = await voice.voices();
    expect(list.map((v) => v.id)).toEqual(['a', 'b']);
  });

  it('survives a response that is not the shape they document', async () => {
    const voice = new ElevenLabsVoice(CONFIG, (async () =>
      respond(JSON.stringify({}))) as unknown as typeof fetch);
    await expect(voice.voices()).resolves.toEqual([]);
  });
});

describe('transcribe', () => {
  const CLIP = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

  /*
   * The shape these assert is not remembered: it is the one in ElevenLabs'
   * own generated client, @elevenlabs/elevenlabs-js 2.69.0 — POST
   * v1/speech-to-text, multipart with model_id and file, answering
   * { language_code, language_probability, text, words }. If they move it,
   * these fail here rather than in someone's microphone.
   */
  function heard(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('posts the clip as multipart with the model and the file', async () => {
    const fetchImpl = vi.fn(async () => heard({ text: 'what is in the vault', language_code: 'eng' }));
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    const transcript = await voice.transcribe(CLIP, 'speech.webm', 'audio/webm');

    expect(transcript.text).toBe('what is in the vault');
    expect(transcript.language).toBe('eng');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model_id')).toBe('scribe_v2');
    const file = form.get('file') as File;
    expect(file.name).toBe('speech.webm');
    expect(file.type).toBe('audio/webm');
    expect(file.size).toBe(CLIP.length);
  });

  it('sets no Content-Type of its own, so the boundary is not lost', async () => {
    // A hand-written multipart header has no boundary in it, and the service
    // reads an empty body. This is the classic way to break this call.
    const fetchImpl = vi.fn(async () => heard({ text: 'hello' }));
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    await voice.transcribe(CLIP, 'speech.webm', 'audio/webm');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('carries the browser\'s own container through rather than assuming one', async () => {
    // Safari records mp4, Chrome webm. Insisting on either makes Helix deaf
    // on the other.
    const fetchImpl = vi.fn(async () => heard({ text: 'hello' }));
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    await voice.transcribe(CLIP, 'speech.mp4', 'audio/mp4');

    const form = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect((form.get('file') as File).type).toBe('audio/mp4');
  });

  it('listens on the key alone, without a voice chosen', async () => {
    // Speaking needs a voice; hearing does not. Someone part-way through
    // setup should still be able to talk to Helix.
    const fetchImpl = vi.fn(async () => heard({ text: 'hello' }));
    const voice = new ElevenLabsVoice({ apiKey: KEY }, fetchImpl as unknown as typeof fetch);

    expect(voice.configured).toBe(false);
    expect(voice.canHear).toBe(true);
    await expect(voice.transcribe(CLIP, 'speech.webm', 'audio/webm')).resolves.toBeTruthy();
  });

  it('refuses to call out at all without a key', async () => {
    const fetchImpl = vi.fn();
    const voice = new ElevenLabsVoice({ voiceId: 'v' }, fetchImpl as unknown as typeof fetch);

    await expect(voice.transcribe(CLIP, 'speech.webm', 'audio/webm')).rejects.toThrow(
      /ELEVENLABS_API_KEY/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('will not post an empty clip or an oversized one', async () => {
    const fetchImpl = vi.fn();
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    await expect(voice.transcribe(Buffer.alloc(0), 'a.webm', 'audio/webm')).rejects.toThrow(
      /no audio/i
    );
    await expect(
      voice.transcribe(Buffer.alloc(MAX_AUDIO_BYTES + 1), 'a.webm', 'audio/webm')
    ).rejects.toThrow(/limit/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a transcript of nothing as nothing said, not as a question', async () => {
    // Silence comes back as an empty string with a 200. Putting that to the
    // model would have Helix answering a question nobody asked.
    const fetchImpl = vi.fn(async () => heard({ text: '   ', language_code: 'eng' }));
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    await expect(voice.transcribe(CLIP, 'a.webm', 'audio/webm')).rejects.toThrow(/nothing was said/i);
  });

  it('maps a refusal to a sentence of its own, never the service body', async () => {
    const fetchImpl = vi.fn(async () =>
      heard({ detail: 'your key sk-live-should-never-be-echoed failed' }, 401)
    );
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    await expect(voice.transcribe(CLIP, 'a.webm', 'audio/webm')).rejects.toThrow(
      'ElevenLabs rejected the API key.'
    );
  });

  it('reports an unreachable service as unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const voice = new ElevenLabsVoice(CONFIG, fetchImpl as unknown as typeof fetch);

    await expect(voice.transcribe(CLIP, 'a.webm', 'audio/webm')).rejects.toThrow(/Could not reach/);
  });

  it('takes the transcription model from the environment', async () => {
    const fetchImpl = vi.fn(async () => heard({ text: 'hello' }));
    const voice = ElevenLabsVoice.fromEnvironment(
      { ELEVENLABS_API_KEY: KEY, ELEVENLABS_STT_MODEL_ID: 'scribe_v1' } as NodeJS.ProcessEnv,
      fetchImpl as unknown as typeof fetch
    );

    await voice.transcribe(CLIP, 'a.webm', 'audio/webm');

    const form = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get('model_id')).toBe('scribe_v1');
  });
});
