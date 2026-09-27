/**
 * The part of Helix that thinks of something to say.
 *
 * Everything that gives him a character already existed and was going unused:
 * SYSTEM_PROMPT holds the persona, groundedNotes picks which notes bear on a
 * question, and renderNotesContext lays them out. This file is the wire
 * between those and the model — it adds no judgement of its own.
 *
 * The API key comes from the environment. It goes to the SDK and nowhere
 * else: never into a response, never into an error, never into memory.
 */

import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';

/**
 * Opus 5. A reply is one or two sentences, so the ceiling is low and the
 * effort is low with it — this is a remark, not a research task, and paying
 * for deep reasoning to produce one flat sentence is money on fire.
 */
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 400;

/** Long enough for a real question, short enough that nobody pastes a book in. */
export const MAX_QUESTION_LENGTH = 1000;

export class MindError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'MindError';
    this.status = status;
  }
}

export interface MindStatus {
  readonly configured: boolean;
  readonly model: string;
  readonly reason: string | null;
}

export interface Answer {
  readonly text: string;
  /** Whether the reply was grounded in notes or was conversation. */
  readonly grounded: boolean;
}

/** One prior exchange, oldest first. Kept by the caller, not by this class. */
export interface Exchange {
  readonly question: string;
  readonly answer: string;
}

export class HelixMind {
  readonly #client: Anthropic | null;

  public constructor(apiKey: string) {
    const key = apiKey.trim();
    // Constructing without a key would throw later, at the worst moment. A
    // null client is the honest representation of "not set up".
    this.#client = key === '' ? null : new Anthropic({ apiKey: key });
  }

  public static fromEnvironment(env: NodeJS.ProcessEnv = process.env): HelixMind {
    return new HelixMind(env.ANTHROPIC_API_KEY ?? '');
  }

  public get configured(): boolean {
    return this.#client !== null;
  }

  public status(): MindStatus {
    return {
      configured: this.configured,
      model: MODEL,
      reason: this.configured ? null : 'Set ANTHROPIC_API_KEY to let Helix answer.',
    };
  }

  /**
   * Answer a question.
   *
   * `notes` is the rendered notes block, empty when nothing in the vault
   * qualified — its absence is what tells the persona it is making
   * conversation rather than answering from the vault, so it is passed
   * through untouched rather than padded with an apology.
   *
   * `memory` is what the brain considered relevant. It goes in as a separate,
   * clearly labelled block so the model can tell a remembered preference from
   * a note in the vault, and so neither can be mistaken for the other.
   */
  public async answer(
    question: string,
    notes: string,
    systemPrompt: string,
    options: { readonly memory?: string; readonly history?: readonly Exchange[] } = {}
  ): Promise<Answer> {
    if (this.#client === null) {
      throw new MindError('Set ANTHROPIC_API_KEY to let Helix answer.', 503);
    }

    const asked = question.trim();
    if (asked === '') throw new MindError('There is no question.', 400);
    if (asked.length > MAX_QUESTION_LENGTH) {
      throw new MindError(
        'That is ' + asked.length + ' characters; the limit is ' + MAX_QUESTION_LENGTH + '.',
        400
      );
    }

    const preamble: string[] = [];
    if ((options.memory ?? '') !== '') {
      preamble.push('WHAT YOU REMEMBER ABOUT THEM\n' + options.memory);
    }
    if (notes !== '') {
      preamble.push('NOTES FROM THEIR VAULT\n' + notes);
    }

    const messages: Anthropic.MessageParam[] = [];
    // Prior turns first, so a follow-up like "and the other one?" has
    // something to refer to.
    for (const turn of options.history ?? []) {
      messages.push({ role: 'user', content: turn.question });
      messages.push({ role: 'assistant', content: turn.answer });
    }
    messages.push({
      role: 'user',
      content: preamble.length === 0 ? asked : preamble.join('\n\n') + '\n\n' + asked,
    });

    let response: Anthropic.Message;
    try {
      response = await this.#client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        // A one-line reply needs no deep reasoning, and paying for it would
        // add latency to something meant to feel like conversation.
        output_config: { effort: 'low' },
        messages,
      });
    } catch (error) {
      throw HelixMind.#translate(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new MindError('Helix declined to answer that one.', 422);
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (text === '') throw new MindError('Helix had nothing to say.', 502);

    return { text, grounded: notes !== '' };
  }

  /**
   * Turn an SDK error into something worth reading.
   *
   * Mapped by type rather than passed through, for the same reason the voice
   * client maps its statuses: an error body is not a place to trust with
   * whatever it happens to contain.
   */
  static #translate(error: unknown): MindError {
    // Most specific first: AuthenticationError and the rest all extend
    // APIError, so a broad check placed early would swallow every one of them.
    if (error instanceof AuthenticationError) {
      return new MindError('Anthropic rejected the API key.', 401);
    }
    if (error instanceof PermissionDeniedError) {
      return new MindError('That API key is not allowed to use this model.', 403);
    }
    if (error instanceof RateLimitError) {
      return new MindError('Rate limited by Anthropic. Try again shortly.', 429);
    }
    if (error instanceof APIConnectionError) {
      return new MindError('Could not reach Anthropic.', 502);
    }
    if (error instanceof APIError) {
      const status = error.status ?? 500;
      return new MindError(
        status >= 500 ? 'Anthropic is having trouble.' : 'Anthropic refused the request.',
        status
      );
    }
    return new MindError('Helix could not think of anything.', 500);
  }
}
