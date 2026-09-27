/**
 * Refuses to let credentials into memory.
 *
 * This runs before anything is stored, and it is the only thing standing
 * between a careless "remember this" and a password sitting in a JSON file on
 * disk. It is deliberately a blunt instrument: a false positive costs the user
 * one rephrase, a false negative writes their token down forever.
 *
 * It is not a secret scanner for source code and does not pretend to be. It
 * catches the shapes a person actually types at an assistant — "my password
 * is…", a pasted key, a bearer token — and says no.
 */

/** Why a piece of text was refused. Shown to the user, so it names the kind. */
export interface SecretFinding {
  readonly kind: string;
  readonly hint: string;
}

/** Words that mean "what follows is a credential". */
const CREDENTIAL_WORDS =
  '(?:password|passwd|passphrase|secret|api[ _-]?key|apikey|access[ _-]?token|auth[ _-]?token|bearer[ _-]?token|client[ _-]?secret|private[ _-]?key|credentials?|pin[ _-]?code)';

/**
 * A credential word followed by an assignment and something that looks like a
 * value. The value has to be at least four characters and free of spaces,
 * which is what separates "my password is hunter2" from "I changed my password
 * this morning".
 */
const LABELLED_VALUE = new RegExp(
  CREDENTIAL_WORDS + "\\s*(?:is|was|=|:|->)\\s*['\"`]?([^\\s'\"`,;]{4,})",
  'i'
);

interface Pattern {
  readonly kind: string;
  readonly hint: string;
  readonly test: RegExp;
}

/**
 * Shapes that are a credential whatever the surrounding sentence says. These
 * are prefixes the issuing services chose precisely so their keys are
 * recognisable, which makes them reliable to match on.
 */
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'private key',
    hint: 'a PEM private key block',
    test: /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
  },
  {
    kind: 'JSON web token',
    hint: 'a three-part JWT',
    test: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    kind: 'OpenAI-style key',
    hint: 'a key beginning sk-',
    test: /\bsk-[A-Za-z0-9_-]{16,}\b/,
  },
  {
    kind: 'GitHub token',
    hint: 'a token beginning ghp_, gho_, ghu_, ghs_ or github_pat_',
    test: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    kind: 'Google API key',
    hint: 'a key beginning AIza',
    test: /\bAIza[A-Za-z0-9_-]{20,}\b/,
  },
  {
    kind: 'Google OAuth client secret',
    hint: 'a secret beginning GOCSPX-',
    test: /\bGOCSPX-[A-Za-z0-9_-]{10,}\b/,
  },
  {
    kind: 'AWS access key id',
    hint: 'an identifier beginning AKIA or ASIA',
    test: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    kind: 'Slack token',
    hint: 'a token beginning xox',
    test: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    kind: 'Stripe key',
    hint: 'a key beginning sk_live, rk_live or pk_live',
    test: /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{10,}\b/,
  },
  {
    kind: 'bearer token',
    hint: 'an Authorization header value',
    test: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  },
  {
    kind: 'ElevenLabs key',
    hint: 'a key beginning sk_ or xi-api-key',
    test: /\b(?:xi-api-key\s*[:=]\s*\S+|sk_[a-f0-9]{32,})\b/i,
  },
];

/**
 * What, if anything, in this text must not be written down.
 *
 * Returns every distinct kind found rather than the first, so the message back
 * to the user can name all of it and they do not discover the second problem
 * only after fixing the first.
 */
export function findSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const pattern of PATTERNS) {
    if (!pattern.test.test(text)) continue;
    if (seen.has(pattern.kind)) continue;
    seen.add(pattern.kind);
    found.push({ kind: pattern.kind, hint: pattern.hint });
  }

  const labelled = LABELLED_VALUE.exec(text);
  if (labelled !== null && !seen.has('labelled credential')) {
    found.push({
      kind: 'labelled credential',
      hint: 'a value written out next to a word like password, secret or API key',
    });
  }

  return found;
}

export function containsSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}

/**
 * The refusal, phrased for the user.
 *
 * It names what was spotted but never repeats the value back: quoting a
 * password into an error message only moves it somewhere else.
 */
export function refusalFor(findings: readonly SecretFinding[]): string {
  const kinds = findings.map((f) => f.hint).join(', and ');
  return (
    'Refusing to remember this: it looks like it contains ' +
    kinds +
    '. Helix has no secure place to keep credentials, so it does not keep them at all.'
  );
}
