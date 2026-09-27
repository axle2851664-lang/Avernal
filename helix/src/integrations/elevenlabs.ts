/**
 * Speech, through ElevenLabs.
 *
 * The API key comes from the environment and goes exactly one place: the
 * `xi-api-key` header on an outbound request. It is never returned to a
 * caller, never written into an error, never logged, and never stored — the
 * memory layer refuses key-shaped text for the same reason. If you find
 * yourself wanting to put it anywhere else, that is the bug.
 *
 * `fetch` is injected rather than reached for, so the whole of this file can
 * be tested — including how it behaves on a rejected key, a quota wall and a
 * network failure — without an account or a network.
 */

const API_ROOT = 'https://api.elevenlabs.io/v1';

/** ElevenLabs bills by character; this is a spoken reply, not an audiobook. */
export const MAX_SPEECH_LENGTH = 800;

/** Their default multilingual model. Overridable, since their catalogue moves. */
const DEFAULT_MODEL = 'eleven_multilingual_v2';

export interface VoiceConfig {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId?: string;
}

export interface VoiceSummary {
  readonly id: string;
  readonly name: string;
  readonly category: string;
}

export interface Speech {
  readonly audio: Buffer;
  readonly contentType: string;
  readonly characters: number;
}

export class VoiceError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'VoiceError';
    this.status = status;
  }
}

/** What the caller may know about the voice, which is never the key. */
export interface VoiceStatus {
  readonly configured: boolean;
  readonly voiceId: string | null;
  readonly modelId: string;
  /** Why it is not usable, when it is not. */
  readonly reason: string | null;
}

type Fetch = typeof globalThis.fetch;

export class ElevenLabsVoice {
  readonly #apiKey: string;
  readonly #voiceId: string;
  readonly #modelId: string;
  readonly #fetch: Fetch;

  public constructor(config: Partial<VoiceConfig> = {}, fetchImpl: Fetch = globalThis.fetch) {
    this.#apiKey = (config.apiKey ?? '').trim();
    this.#voiceId = (config.voiceId ?? '').trim();
    this.#modelId = (config.modelId ?? '').trim() === '' ? DEFAULT_MODEL : config.modelId!.trim();
    this.#fetch = fetchImpl;
  }

  /** Built from the environment. The only place the key is read. */
  public static fromEnvironment(env: NodeJS.ProcessEnv = process.env, fetchImpl?: Fetch): ElevenLabsVoice {
    return new ElevenLabsVoice(
      {
        apiKey: env.ELEVENLABS_API_KEY ?? '',
        voiceId: env.ELEVENLABS_VOICE_ID ?? '',
        modelId: env.ELEVENLABS_MODEL_ID ?? '',
      },
      fetchImpl
    );
  }

  public get configured(): boolean {
    return this.#apiKey !== '' && this.#voiceId !== '';
  }

  /**
   * What is wrong, in terms the user can act on.
   *
   * Names the environment variable to set rather than saying "not configured",
   * because the second tells you nothing you did not already know.
   */
  public status(): VoiceStatus {
    let reason: string | null = null;
    if (this.#apiKey === '' && this.#voiceId === '') {
      reason = 'Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to give Helix a voice.';
    } else if (this.#apiKey === '') {
      reason = 'Set ELEVENLABS_API_KEY.';
    } else if (this.#voiceId === '') {
      reason = 'Set ELEVENLABS_VOICE_ID. Ask Helix for the voice list to find one.';
    }

    return {
      configured: this.configured,
      // The id is not a credential — it names a voice, and the UI needs it.
      voiceId: this.#voiceId === '' ? null : this.#voiceId,
      modelId: this.#modelId,
      reason,
    };
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'xi-api-key': this.#apiKey, ...extra };
  }

  #requireConfigured(): void {
    if (this.configured) return;
    throw new VoiceError(this.status().reason ?? 'Voice is not configured.', 503);
  }

  /**
   * Turn a service response into a message worth reading.
   *
   * Their error bodies sometimes echo request details, so nothing from the
   * body is passed through verbatim — the status is mapped to a sentence
   * written here. That also guarantees the key cannot come back out in an
   * error, whatever they put in one.
   */
  static #explain(status: number): string {
    if (status === 401) return 'ElevenLabs rejected the API key.';
    if (status === 403) return 'That ElevenLabs key is not allowed to use this voice.';
    if (status === 404) return 'ElevenLabs has no voice with that id.';
    if (status === 422) return 'ElevenLabs would not accept that text.';
    if (status === 429) return 'ElevenLabs quota reached. Nothing more will be spoken this period.';
    if (status >= 500) return 'ElevenLabs is having trouble. Try again shortly.';
    return 'ElevenLabs refused the request (' + status + ').';
  }

  /** The voices this key can use. */
  public async voices(): Promise<readonly VoiceSummary[]> {
    this.#requireConfigured();

    let response: Response;
    try {
      response = await this.#fetch(API_ROOT + '/voices', { headers: this.#headers() });
    } catch (error) {
      throw new VoiceError('Could not reach ElevenLabs: ' + (error as Error).message, 502);
    }

    if (!response.ok) throw new VoiceError(ElevenLabsVoice.#explain(response.status), response.status);

    const body = (await response.json()) as { voices?: unknown };
    const list = Array.isArray(body.voices) ? body.voices : [];

    return list
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry.voice_id === 'string')
      .map((entry) => ({
        id: entry.voice_id as string,
        name: typeof entry.name === 'string' ? entry.name : 'unnamed',
        category: typeof entry.category === 'string' ? entry.category : 'unknown',
      }));
  }

  /** Speak. Returns the audio; playing it is the caller's problem. */
  public async speak(text: string): Promise<Speech> {
    this.#requireConfigured();

    const spoken = text.trim();
    if (spoken === '') throw new VoiceError('There is nothing to say.', 400);
    if (spoken.length > MAX_SPEECH_LENGTH) {
      throw new VoiceError(
        'That is ' +
          spoken.length +
          ' characters; the limit is ' +
          MAX_SPEECH_LENGTH +
          '. Say less, or say it in parts.',
        400
      );
    }

    let response: Response;
    try {
      response = await this.#fetch(API_ROOT + '/text-to-speech/' + encodeURIComponent(this.#voiceId), {
        method: 'POST',
        headers: this.#headers({ 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
        body: JSON.stringify({
          text: spoken,
          model_id: this.#modelId,
          // Leaning toward expressive: this voice has jokes to land, and a
          // perfectly even delivery kills every one of them.
          voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.35 },
        }),
      });
    } catch (error) {
      throw new VoiceError('Could not reach ElevenLabs: ' + (error as Error).message, 502);
    }

    if (!response.ok) throw new VoiceError(ElevenLabsVoice.#explain(response.status), response.status);

    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) throw new VoiceError('ElevenLabs returned no audio.', 502);

    return {
      audio,
      contentType: response.headers.get('content-type') ?? 'audio/mpeg',
      characters: spoken.length,
    };
  }
}
