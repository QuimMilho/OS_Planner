/**
 * Mentions in chat messages are tokens in the text: `<@user:UUID>`, `<@role:UUID>`, `<@everyone>` and `<@here>`. The text
 * stores ids, so a mention follows a rename; the view looks the name up when it draws the message.
 *
 * What a message really mentions is decided by the server (`Message.mentions`): which ids exist, who may see the channel and
 * whether the author may use `@everyone`. Clients never send that list, and a token the server did not accept is drawn as plain
 * text. The tokenizer here is only the syntax, shared so both sides read a message the same way.
 */
export const MENTION_KINDS = ['user', 'role', 'everyone', 'here'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

/** What the server found in a message and accepted. */
export interface MentionsDto {
  users: string[];
  roles: string[];
  everyone: boolean;
  here: boolean;
}

export const NO_MENTIONS: Readonly<MentionsDto> = Object.freeze({
  users: [],
  roles: [],
  everyone: false,
  here: false,
});

/** At most this many different people or roles in one message count; the rest is plain text. */
export const MENTION_LIMITS = { users: 50, roles: 10 } as const;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const STICKY = new RegExp(`<@(?:(user|role):(${UUID})|(everyone|here))>`, 'y');

export interface MentionMatch {
  kind: MentionKind;
  /** Lowercase uuid for users and roles, null for @everyone and @here. */
  id: string | null;
  /** Index just after the token. */
  end: number;
}

/** The token that starts exactly at `at`, if there is one. */
export function matchMentionAt(src: string, at: number): MentionMatch | null {
  if (src.charCodeAt(at) !== 60 /* < */) return null;
  STICKY.lastIndex = at;
  const m = STICKY.exec(src);
  if (!m) return null;
  return m[3]
    ? { kind: m[3] as MentionKind, id: null, end: STICKY.lastIndex }
    : { kind: m[1] as MentionKind, id: m[2]!.toLowerCase(), end: STICKY.lastIndex };
}

/** The token for a person, a role, `@everyone` or `@here`. */
export function mentionToken(kind: MentionKind, id?: string | null): string {
  return kind === 'user' || kind === 'role'
    ? `<@${kind}:${(id ?? '').toLowerCase()}>`
    : `<@${kind}>`;
}
