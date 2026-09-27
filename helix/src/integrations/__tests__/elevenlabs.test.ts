import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsVoice, MAX_SPEECH_LENGTH, VoiceError } from '../elevenlabs.js';

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
