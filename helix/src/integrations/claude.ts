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

/**
 * Room for a turn that searches.
 *
 * Server tool calls and their results are output tokens too, so the ceiling
 * that fits a one-sentence reply does not fit one that had to look something
 * up first — it truncates mid-search and the answer never arrives.
 */
const MAX_TOKENS_SEARCHING = 2000;

/**
 * The web search tool, as the API names it today.
 *
 * Server-side: Anthropic runs the search and the results come back in the
 * same response. Nothing is executed here, and Helix never gets a browser.
 *
 * `max_uses` is the real safety rail. Without it a single question can turn
 * into an unbounded number of billed searches, and three is enough to answer
 * something and check it.
 */
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 } as const;

/**
 * How many times a paused turn may be resumed.
 *
 * The server runs its own sampling loop for a server tool and stops at ten
 * iterations with `pause_turn`, expecting to be handed the turn back. Left
 * unbounded that is a loop with someone else's stopping condition in it.
 */
const MAX_RESUMES = 3;

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
  /** How many web searches were actually run. Zero when none were. */
  readonly searches: number;
  /** The pages he looked at, in the order he found them. */
  readonly sources: readonly WebSource[];
}

/** One page a search turned up. Both fields come from the service. */
export interface WebSource {
  readonly title: string;
  readonly url: string;
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
    options: {
      readonly memory?: string;
      readonly history?: readonly Exchange[];
      /** Hand him the web for this turn. He still decides whether to use it. */
      readonly web?: boolean;
    } = {}
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

    const searching = options.web === true;

    let response: Anthropic.Message;
    try {
      response = await this.#client.messages.create({
        model: MODEL,
        max_tokens: searching ? MAX_TOKENS_SEARCHING : MAX_TOKENS,
        system: systemPrompt,
        // A one-line reply needs no deep reasoning, and paying for it would
        // add latency to something meant to feel like conversation.
        output_config: { effort: 'low' },
        ...(searching ? { tools: [WEB_SEARCH_TOOL] } : {}),
        messages,
      });

      /*
       * Resume a paused turn.
       *
       * The server stops its own tool loop after ten iterations and returns
       * `pause_turn`, expecting the turn back to carry on. The assistant
       * content is appended and the request repeated with nothing added — the
       * trailing tool-use block is what tells the server to resume, and a
       * "carry on" message of our own would only get in the way.
       */
      for (let resumed = 0; response.stop_reason === 'pause_turn'; resumed += 1) {
        if (resumed >= MAX_RESUMES) break;
        messages.push({ role: 'assistant', content: response.content });
        response = await this.#client.messages.create({
          model: MODEL,
          max_tokens: searching ? MAX_TOKENS_SEARCHING : MAX_TOKENS,
          system: systemPrompt,
          output_config: { effort: 'low' },
          ...(searching ? { tools: [WEB_SEARCH_TOOL] } : {}),
          messages,
        });
      }
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

    const found = HelixMind.#searchResults(response);

    return {
      text,
      // Grounded means "he had something to work from", and a page he read is
      // as much a source as a note. Saying otherwise would have the screen
      // print "not from your notes" under an answer that is from the web.
      grounded: notes !== '' || found.sources.length > 0,
      searches: found.searches,
      sources: found.sources,
    };
  }

  /**
   * What the search actually returned.
   *
   * A search that failed comes back as HTTP 200 with an error object where
   * the result list would be — not as a thrown error — so the shape has to be
   * checked rather than assumed. An error costs the sources and nothing else:
   * the model has already written its reply around whatever it did or did not
   * get, and failing the whole request here would throw that away.
   */
  static #searchResults(response: Anthropic.Message): {
    searches: number;
    sources: WebSource[];
  } {
    const sources: WebSource[] = [];
    const seen = new Set<string>();
    let searches = 0;

    for (const block of response.content) {
      if (block.type === 'server_tool_use' && block.name === 'web_search') searches += 1;
      if (block.type !== 'web_search_tool_result') continue;

      const content: unknown = (block as { content?: unknown }).content;
      if (!Array.isArray(content)) continue; // The error-object shape.

      for (const entry of content as readonly Record<string, unknown>[]) {
        const url = typeof entry.url === 'string' ? entry.url : '';
        if (url === '' || seen.has(url)) continue;
        seen.add(url);
        sources.push({
          title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : url,
          url,
        });
      }
    }

    return { searches, sources };
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
