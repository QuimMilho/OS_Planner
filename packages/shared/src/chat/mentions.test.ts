import { describe, expect, it } from 'vitest';
import { chatMarkdownToHtml, chatMarkdownToText, extractMentions, parseInline } from './markdown';
import { matchMentionAt, mentionToken } from './mentions';

const A = '0192f7a0-1b2c-7d3e-8f40-0123456789ab';
const B = '0192f7a0-1b2c-7d3e-8f40-0123456789ac';
const R = '0192f7a0-1b2c-7d3e-8f40-0123456789ad';

describe('mention tokens', () => {
  it('are made and read back', () => {
    expect(mentionToken('user', A)).toBe(`<@user:${A}>`);
    expect(mentionToken('role', A.toUpperCase())).toBe(`<@role:${A}>`);
    expect(mentionToken('everyone')).toBe('<@everyone>');
    expect(matchMentionAt(`hi <@user:${A}>!`, 3)).toEqual({
      kind: 'user',
      id: A,
      end: 3 + `<@user:${A}>`.length,
    });
    expect(matchMentionAt('<@here>', 0)).toEqual({ kind: 'here', id: null, end: 7 });
    expect(matchMentionAt(`x<@user:${A}>`, 0)).toBeNull();
  });

  it.each([
    '<@user:not-a-uuid>',
    '<@user:>',
    `<@user:${A}`,
    `<@users:${A}>`,
    `<@everyone:${A}>`,
    '<@everyone >',
    '<@ everyone>',
    '<@EVERYONE>',
    `<@user:${A}x>`,
    `< @user:${A}>`,
  ])('does not read %j as a mention', (text) => {
    expect(matchMentionAt(text, 0)).toBeNull();
    expect(extractMentions(text)).toEqual({ users: [], roles: [], everyone: false, here: false });
  });
});

describe('extracting mentions from a message', () => {
  it('finds every kind once', () => {
    const found = extractMentions(
      `Hi <@user:${A}> and <@user:${A.toUpperCase()}>, <@user:${B}>, <@role:${R}> <@everyone> <@here>`,
    );
    expect(found).toEqual({ users: [A, B], roles: [R], everyone: true, here: true });
  });

  it('ignores tokens in code, in code blocks and after a backslash', () => {
    expect(extractMentions(`\`<@everyone>\` and \`\`<@user:${A}>\`\``)).toMatchObject({
      everyone: false,
      users: [],
    });
    expect(extractMentions('```\n<@everyone>\n<@here>\n```')).toMatchObject({
      everyone: false,
      here: false,
    });
    expect(extractMentions('\\<@everyone>')).toMatchObject({ everyone: false });
    expect(
      extractMentions(`~~<@user:${A}>~~ **<@here>** [<@role:${R}>](https://example.com)`),
    ).toEqual({
      users: [A],
      roles: [R],
      everyone: false,
      here: true,
    });
    expect(extractMentions(`> quoted <@user:${B}>\n\n- item <@everyone>`)).toMatchObject({
      users: [B],
      everyone: true,
    });
  });

  it('counts at most a fixed number of different people', () => {
    const many = Array.from(
      { length: 80 },
      (_, i) => `<@user:0192f7a0-1b2c-7d3e-8f40-${String(i).padStart(12, '0')}>`,
    ).join(' ');
    expect(extractMentions(many).users).toHaveLength(50);
  });

  it('draws as a node, text and html without markup injection', () => {
    expect(parseInline(`a <@user:${A}> b`)).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'mention', kind: 'user', id: A },
      { t: 'text', v: ' b' },
    ]);
    expect(chatMarkdownToText('hello <@everyone>')).toBe('hello @everyone');
    expect(chatMarkdownToText(`hello <@user:${A}>`, () => 'Ana')).toBe('hello @Ana');
    expect(chatMarkdownToText(`hello <@user:${A}>`)).toBe('hello @user');
    expect(chatMarkdownToHtml(`<@user:${A}> <@here>`)).toBe(
      '<p><span class="mention">@user</span> <span class="mention">@here</span></p>',
    );
    // an escaped one is text
    expect(chatMarkdownToText('\\<@everyone>')).toBe('<@everyone>');
  });
});
