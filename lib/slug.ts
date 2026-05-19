/**
 * Topic slug validation and normalization.
 *
 * Slugs are user-supplied identifiers that map directly to filesystem
 * paths under the state dir. Strict rules are the single line of defense
 * against:
 *   - case-collision on macOS APFS (lowercase only)
 *   - filesystem-illegal chars on any platform (`[a-z0-9-]` only)
 *   - Windows reserved names (CON, PRN, AUX, NUL, COM[1-9], LPT[1-9])
 *   - unicode normalization divergence (ASCII only)
 *   - path-length blowup (capped well under FS filename limits)
 *   - silent re-typing (rejection blocklist for low-signal generic names)
 *
 * Anything that passes `validateTopic` is safe to write straight to disk.
 */

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/;
const CONSECUTIVE_DASHES = /--/;

const RESERVED = new Set([
  // Generic placeholders that pollute the registry
  'wip',
  'tmp',
  'test',
  'misc',
  'todo',
  'foo',
  'bar',
  'baz',
  // Windows reserved names (case-insensitive but slug is already lowercase)
  'con',
  'prn',
  'aux',
  'nul',
  'conin',
  'conout',
  'clock',
  // Internal directory names that would collide with our layout
  'archive',
  'history',
  'lock',
  'sessions',
  'state',
]);

const RESERVED_PATTERNS = [/^com[1-9]$/, /^lpt[1-9]$/];

export class TopicSlugError extends Error {
  constructor(
    readonly slug: string,
    readonly reason: string
  ) {
    super(`Invalid topic slug "${slug}": ${reason}`);
    this.name = 'TopicSlugError';
  }
}

/**
 * Validate a topic slug. Throws `TopicSlugError` with a human-readable
 * reason on failure. Accepts a slug verbatim — does NOT normalize. Slug
 * normalization (e.g. spaces → dashes) is a calling-agent concern; the
 * registry rejects ambiguous input rather than guessing intent.
 */
export function validateTopic(slug: string): void {
  if (typeof slug !== 'string') {
    throw new TopicSlugError(String(slug), 'must be a string');
  }
  if (slug.length < 8) {
    throw new TopicSlugError(slug, 'minimum 8 chars (avoids accidental short names)');
  }
  if (slug.length > 64) {
    throw new TopicSlugError(slug, 'maximum 64 chars (filesystem-friendly)');
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new TopicSlugError(
      slug,
      'must match /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/ (lowercase ASCII, dashes ok, no leading/trailing dash)'
    );
  }
  if (CONSECUTIVE_DASHES.test(slug)) {
    throw new TopicSlugError(slug, 'no consecutive dashes (reserved as collision-suffix delimiter)');
  }
  if (RESERVED.has(slug)) {
    throw new TopicSlugError(slug, 'reserved name (collides with filesystem or skill internals)');
  }
  for (const pattern of RESERVED_PATTERNS) {
    if (pattern.test(slug)) {
      throw new TopicSlugError(slug, `reserved pattern ${pattern} (Windows device name)`);
    }
  }
}

/** Returns true iff the slug is valid. Convenience wrapper for non-throwing checks. */
export function isValidTopic(slug: string): boolean {
  try {
    validateTopic(slug);
    return true;
  } catch {
    return false;
  }
}
