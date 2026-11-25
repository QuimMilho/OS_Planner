/**
 * Passwords that satisfy a length rule yet are among the first a credential-stuffing run tries.
 * Compared case-insensitively. Not exhaustive: the point is to catch the obvious ones.
 */
const COMMON = new Set(
  [
    'password12',
    'password123',
    'password1234',
    'passw0rd123',
    '1234567890',
    '12345678910',
    '123456789012',
    '0123456789',
    'qwertyuiop',
    'qwerty12345',
    'qwerty123456',
    'abcdefghij',
    'abcd123456',
    'iloveyou12',
    'iloveyou123',
    'letmein123',
    'welcome123',
    'welcome1234',
    'administrator',
    'changeme123',
    'trustno1234',
    'superman123',
    'football123',
    'baseball123',
    'monkey12345',
    'dragon12345',
    'sunshine123',
    'princess123',
    'passwordpassword',
    '1q2w3e4r5t',
    '1qaz2wsx3edc',
    'zaq12wsxcde3',
    'senha12345',
    'senha123456',
    'palavrapasse',
  ].map((p) => p.toLowerCase()),
);

export function isCommonPassword(password: string): boolean {
  const p = password.toLowerCase();
  return COMMON.has(p) || /^(.)\1+$/.test(p) /* "aaaaaaaaaa" */;
}
