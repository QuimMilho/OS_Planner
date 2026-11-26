import type { Locale } from '@os-planner/shared';

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Copy {
  hello: (name: string) => string;
  verifySubject: string;
  verifyBody: string;
  verifyButton: string;
  resetSubject: string;
  resetBody: string;
  resetButton: string;
  resetIgnore: string;
  verifyIgnore: string;
  linkFallback: string;
  validFor: (what: string) => string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    hello: (n) => `Hi ${n},`,
    verifySubject: 'Confirm your email address',
    verifyBody: 'Welcome to OS_Planner! Please confirm your email address to unlock uploads and PDF export.',
    verifyButton: 'Confirm email',
    verifyIgnore: "If you didn't create an account, you can ignore this message.",
    resetSubject: 'Reset your password',
    resetBody: 'We received a request to reset your password. Choose a new one with the button below.',
    resetButton: 'Reset password',
    resetIgnore: "If you didn't ask for this, you can ignore this message. Your password will not change.",
    linkFallback: 'If the button does not work, copy this link into your browser:',
    validFor: (w) => `This link is valid for ${w}.`,
  },
  pt: {
    hello: (n) => `Olá ${n},`,
    verifySubject: 'Confirme o seu endereço de email',
    verifyBody:
      'Bem-vindo ao OS_Planner! Confirme o seu endereço de email para ativar os carregamentos e a exportação para PDF.',
    verifyButton: 'Confirmar email',
    verifyIgnore: 'Se não criou uma conta, pode ignorar esta mensagem.',
    resetSubject: 'Redefinir a sua palavra-passe',
    resetBody: 'Recebemos um pedido para redefinir a sua palavra-passe. Escolha uma nova com o botão abaixo.',
    resetButton: 'Redefinir palavra-passe',
    resetIgnore: 'Se não fez este pedido, pode ignorar esta mensagem. A sua palavra-passe não será alterada.',
    linkFallback: 'Se o botão não funcionar, copie esta ligação para o navegador:',
    validFor: (w) => `Esta ligação é válida durante ${w}.`,
  },
};

function render(
  locale: Locale,
  p: { name: string; subject: string; body: string; button: string; ignore: string; url: string; validity: string },
): MailContent {
  const c = COPY[locale];
  const text = [c.hello(p.name), '', p.body, '', p.url, '', p.validity, '', p.ignore].join('\n');
  const html = `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2330">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px">
      <tr><td>
        <p style="margin:0 0 16px;font-size:16px">${escapeHtml(c.hello(p.name))}</p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.5">${escapeHtml(p.body)}</p>
        <p style="margin:0 0 24px"><a href="${escapeHtml(p.url)}" style="display:inline-block;background:#3b5bdb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">${escapeHtml(p.button)}</a></p>
        <p style="margin:0 0 8px;font-size:13px;color:#5b6475">${escapeHtml(p.validity)}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#5b6475">${escapeHtml(c.linkFallback)}</p>
        <p style="margin:0 0 24px;font-size:13px;word-break:break-all"><a href="${escapeHtml(p.url)}" style="color:#3b5bdb">${escapeHtml(p.url)}</a></p>
        <p style="margin:0;font-size:13px;color:#5b6475">${escapeHtml(p.ignore)}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject: p.subject, text, html };
}

export function verifyEmailMail(locale: Locale, name: string, url: string): MailContent {
  const c = COPY[locale];
  return render(locale, {
    name,
    subject: c.verifySubject,
    body: c.verifyBody,
    button: c.verifyButton,
    ignore: c.verifyIgnore,
    url,
    validity: c.validFor(locale === 'pt' ? '24 horas' : '24 hours'),
  });
}

export function resetPasswordMail(locale: Locale, name: string, url: string): MailContent {
  const c = COPY[locale];
  return render(locale, {
    name,
    subject: c.resetSubject,
    body: c.resetBody,
    button: c.resetButton,
    ignore: c.resetIgnore,
    url,
    validity: c.validFor(locale === 'pt' ? '1 hora' : '1 hour'),
  });
}
