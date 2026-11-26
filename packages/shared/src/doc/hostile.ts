/**
 * Input that tries to get script or a foreign page into something a person reads. The notes' Markdown import and the chat
 * Markdown renderer are both tested against this one set, so a rule fixed in one cannot stay broken in the other.
 */

/** Link targets that must never become a link. */
export const UNSAFE_HREFS: readonly string[] = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html,<b>x</b>',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc3JpcHQ+',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  '//evil.example.com',
  '\\\\evil.example.com\\share',
];

/** Link targets that are fine. */
export const SAFE_HREFS: readonly string[] = [
  'https://a.example/x?y=1',
  'http://a.example',
  'mailto:a@b.co',
  'tel:+351123456',
  '#section',
  '/app/p/123',
];

/** Markdown that carries markup or links an attacker would like to see executed or followed. */
export const HOSTILE_MARKDOWN: readonly string[] = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[click](javascript:alert(1))',
  '[click](  javascript:alert(1)  )',
  '![pixel](javascript:alert(1))',
  '[x](data:text/html,<script>alert(1)</script>)',
  '<a href="javascript:alert(1)">x</a>',
  '<iframe src="https://evil.example"></iframe>',
  '**<b onmouseover=alert(1)>bold</b>**',
  '`<script>`',
  '```html\n<script>alert(1)</script>\n```',
  '> <svg onload=alert(1)>',
  '- <style>*{display:none}</style>',
  '[a](https://ok.example "title\" onmouseover=\"alert(1)")',
];
