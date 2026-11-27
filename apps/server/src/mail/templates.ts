import type { Locale } from '@os-planner/shared';

export interface MailContent {
  subject: string;
  text: string;
  html: string;
  /** Extra mail headers (List-Unsubscribe). */
  headers?: Record<string, string>;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Copy {
  hello: (name: string | null) => string;
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
    hello: (n) => (n ? `Hi ${n},` : 'Hi,'),
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
    hello: (n) => (n ? `Olá ${n},` : 'Olá,'),
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
  p: { name: string | null; subject: string; body: string; button: string; ignore: string; url: string; validity: string },
): MailContent {
  const c = COPY[locale];
  const text = [c.hello(p.name), '', p.body, '', p.url, '', ...(p.validity ? [p.validity, ''] : []), p.ignore].join('\n');
  const html = `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2330">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px">
      <tr><td>
        <p style="margin:0 0 16px;font-size:16px">${escapeHtml(c.hello(p.name))}</p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.5">${escapeHtml(p.body)}</p>
        <p style="margin:0 0 24px"><a href="${escapeHtml(p.url)}" style="display:inline-block;background:#3b5bdb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">${escapeHtml(p.button)}</a></p>
        ${p.validity ? `<p style="margin:0 0 8px;font-size:13px;color:#5b6475">${escapeHtml(p.validity)}</p>` : ''}
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

// ---------------------------------------------------------------- joining teams (phase 5)

interface TeamCopy {
  inviteSubject: (team: string) => string;
  inviteBody: (inviter: string, team: string) => string;
  inviteButton: string;
  inviteIgnore: string;
  approvedSubject: (team: string) => string;
  approvedBody: (team: string) => string;
  deniedSubject: (team: string) => string;
  deniedBody: (team: string) => string;
  openApp: string;
  decisionIgnore: string;
  offeredSubject: (team: string) => string;
  offeredBody: (team: string) => string;
  offeredButton: string;
  assignedSubject: (team: string) => string;
  assignedBody: (team: string) => string;
  assignedButton: string;
  ownershipIgnore: string;
  days: (n: number) => string;
}

const TEAM_COPY: Record<Locale, TeamCopy> = {
  en: {
    inviteSubject: (t) => `You are invited to join ${t}`,
    inviteBody: (who, t) =>
      `${who} invited you to join the team "${t}" on OS_Planner. Use the address this message was sent to when you sign in or create your account.`,
    inviteButton: 'View the invitation',
    inviteIgnore: "If you don't know why you received this, you can ignore it. Nothing happens until you accept.",
    approvedSubject: (t) => `You are in: ${t}`,
    approvedBody: (t) => `Your request to join "${t}" was approved.`,
    deniedSubject: (t) => `Your request to join ${t}`,
    deniedBody: (t) => `Your request to join "${t}" was not approved this time.`,
    openApp: 'Open OS_Planner',
    decisionIgnore: 'You are receiving this because you asked to join this team.',
    offeredSubject: (t) => `You were named the owner of ${t}`,
    offeredBody: (t) =>
      `An administrator created the team "${t}" on OS_Planner and named you its owner. Create your account with this email address (or sign in and verify it) and the team is yours.`,
    offeredButton: 'Create your account',
    assignedSubject: (t) => `You are now the owner of ${t}`,
    assignedBody: (t) => `You are now the owner of the team "${t}" on OS_Planner.`,
    assignedButton: 'Open the team',
    ownershipIgnore: 'You are receiving this because ownership of a team was assigned to your address.',
    days: (n) => (n === 1 ? '1 day' : `${n} days`),
  },
  pt: {
    inviteSubject: (t) => `Foi convidado para a equipa ${t}`,
    inviteBody: (who, t) =>
      `${who} convidou-o para a equipa "${t}" no OS_Planner. Use o endereço para o qual esta mensagem foi enviada ao iniciar sessão ou criar a sua conta.`,
    inviteButton: 'Ver o convite',
    inviteIgnore: 'Se não sabe porque recebeu isto, pode ignorar. Nada acontece até aceitar.',
    approvedSubject: (t) => `Já faz parte de: ${t}`,
    approvedBody: (t) => `O seu pedido para entrar em "${t}" foi aprovado.`,
    deniedSubject: (t) => `O seu pedido para entrar em ${t}`,
    deniedBody: (t) => `O seu pedido para entrar em "${t}" não foi aprovado desta vez.`,
    openApp: 'Abrir o OS_Planner',
    decisionIgnore: 'Recebe esta mensagem porque pediu para entrar nesta equipa.',
    offeredSubject: (t) => `Foi indicado como dono de ${t}`,
    offeredBody: (t) =>
      `Um administrador criou a equipa "${t}" no OS_Planner e indicou-o como dono. Crie a sua conta com este endereço de email (ou inicie sessão e confirme-o) e a equipa passa a ser sua.`,
    offeredButton: 'Criar a conta',
    assignedSubject: (t) => `Agora é o dono de ${t}`,
    assignedBody: (t) => `Agora é o dono da equipa "${t}" no OS_Planner.`,
    assignedButton: 'Abrir a equipa',
    ownershipIgnore: 'Recebe esta mensagem porque a propriedade de uma equipa foi atribuída ao seu endereço.',
    days: (n) => (n === 1 ? '1 dia' : `${n} dias`),
  },
};

export function inviteMail(locale: Locale, inviter: string, team: string, url: string, expiresInDays: number): MailContent {
  const c = TEAM_COPY[locale];
  return render(locale, {
    name: null,
    subject: c.inviteSubject(team),
    body: c.inviteBody(inviter, team),
    button: c.inviteButton,
    ignore: c.inviteIgnore,
    url,
    validity: COPY[locale].validFor(c.days(expiresInDays)),
  });
}

export function requestDecisionMail(locale: Locale, name: string, team: string, approved: boolean, url: string): MailContent {
  const c = TEAM_COPY[locale];
  return render(locale, {
    name,
    subject: approved ? c.approvedSubject(team) : c.deniedSubject(team),
    body: approved ? c.approvedBody(team) : c.deniedBody(team),
    button: c.openApp,
    ignore: c.decisionIgnore,
    url,
    validity: '',
  });
}

export function ownershipMail(locale: Locale, name: string | null, team: string, kind: 'offered' | 'assigned', url: string): MailContent {
  const c = TEAM_COPY[locale];
  const offered = kind === 'offered';
  return render(locale, {
    name,
    subject: offered ? c.offeredSubject(team) : c.assignedSubject(team),
    body: offered ? c.offeredBody(team) : c.assignedBody(team),
    button: offered ? c.offeredButton : c.assignedButton,
    ignore: c.ownershipIgnore,
    url,
    validity: '',
  });
}

// ---------------------------------------------------------------- notification email (phase 9)

export interface DigestMail {
  /** "#general" or a person's name. */
  where: string;
  team: string | null;
  count: number;
  lines: { author: string; text: string }[];
  more: number;
  openUrl: string;
  unsubscribeUrl: string;
  muteUrl: string;
}

interface DigestCopy {
  subject: (n: number, where: string) => string;
  hello: (name: string) => string;
  intro: (n: number, where: string, team: string | null) => string;
  more: (n: number) => string;
  open: string;
  mute: string;
  unsubscribe: string;
  why: string;
}

const DIGEST_COPY: Record<Locale, DigestCopy> = {
  en: {
    subject: (n, where) => (n === 1 ? `New message in ${where}` : `${n} new messages in ${where}`),
    hello: (name) => `Hi ${name},`,
    intro: (n, where, team) => `${n === 1 ? 'There is a new message' : `There are ${n} new messages`} in ${where}${team ? ` (${team})` : ''}:`,
    more: (n) => `…and ${n} more`,
    open: 'Open the conversation',
    mute: 'Mute this chat',
    unsubscribe: 'Stop emails about this chat',
    why: 'You get this email because you asked for email about this chat in your notification settings.',
  },
  pt: {
    subject: (n, where) => (n === 1 ? `Nova mensagem em ${where}` : `${n} novas mensagens em ${where}`),
    hello: (name) => `Olá ${name},`,
    intro: (n, where, team) => `${n === 1 ? 'Há uma nova mensagem' : `Há ${n} novas mensagens`} em ${where}${team ? ` (${team})` : ''}:`,
    more: (n) => `…e mais ${n}`,
    open: 'Abrir a conversa',
    mute: 'Silenciar esta conversa',
    unsubscribe: 'Deixar de receber email desta conversa',
    why: 'Recebe este email porque pediu email sobre esta conversa nas definições de notificações.',
  },
};

/** The mail about one chat: how many messages, the last few, a button to open it, and links to mute or stop (no login needed). Never carries attachments. */
export function digestMail(locale: Locale, name: string, d: DigestMail): MailContent {
  const c = DIGEST_COPY[locale];
  const subject = c.subject(d.count, d.where);
  const text = [
    c.hello(name),
    '',
    c.intro(d.count, d.where, d.team),
    '',
    ...d.lines.map((l) => `${l.author}: ${l.text}`),
    ...(d.more ? [c.more(d.more)] : []),
    '',
    `${c.open}: ${d.openUrl}`,
    '',
    c.why,
    `${c.mute}: ${d.muteUrl}`,
    `${c.unsubscribe}: ${d.unsubscribeUrl}`,
  ].join('\n');
  const rows = d.lines
    .map((l) => `<tr><td style="padding:6px 0;font-size:15px;line-height:1.4"><strong>${escapeHtml(l.author)}</strong><br>${escapeHtml(l.text)}</td></tr>`)
    .join('');
  const html = `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2330">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px">
      <tr><td>
        <p style="margin:0 0 16px;font-size:16px">${escapeHtml(c.hello(name))}</p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.5">${escapeHtml(c.intro(d.count, d.where, d.team))}</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px">${rows}${d.more ? `<tr><td style="padding:6px 0;font-size:14px;color:#5b6475">${escapeHtml(c.more(d.more))}</td></tr>` : ''}</table>
        <p style="margin:0 0 24px"><a href="${escapeHtml(d.openUrl)}" style="display:inline-block;background:#3b5bdb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">${escapeHtml(c.open)}</a></p>
        <p style="margin:0 0 8px;font-size:13px;color:#5b6475">${escapeHtml(c.why)}</p>
        <p style="margin:0;font-size:13px"><a href="${escapeHtml(d.muteUrl)}" style="color:#3b5bdb">${escapeHtml(c.mute)}</a> · <a href="${escapeHtml(d.unsubscribeUrl)}" style="color:#3b5bdb">${escapeHtml(c.unsubscribe)}</a></p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, text, html, headers: { 'List-Unsubscribe': `<${d.unsubscribeUrl}>` } };
}

// ---------------------------------------------------------------- meeting reminder (phase 13)

const REMINDER_COPY: Record<Locale, { subject: (title: string) => string; body: (title: string, when: string) => string; button: string; ignore: string }> = {
  en: {
    subject: (t) => `Starting soon: ${t}`,
    body: (t, when) => `"${t}" starts ${when}.`,
    button: 'Open the calendar',
    ignore: 'You get this email because you turned on email reminders in your calendar settings.',
  },
  pt: {
    subject: (t) => `Começa em breve: ${t}`,
    body: (t, when) => `"${t}" começa ${when}.`,
    button: 'Abrir o calendário',
    ignore: 'Recebe este email porque ativou os lembretes por email nas definições do calendário.',
  },
};

/** The reminder of a meeting or event for somebody who asked for reminders by email. `when` is already written for them ("on 5 Jan, 09:00"). */
export function meetingReminderMail(locale: Locale, name: string, title: string, when: string, url: string): MailContent {
  const c = REMINDER_COPY[locale];
  return render(locale, { name, subject: c.subject(title), body: c.body(title, when), button: c.button, ignore: c.ignore, url, validity: '' });
}

// ---------------------------------------------------------------- notebook shared with you (phase 10)

const SHARE_COPY: Record<Locale, {
  subject: (nb: string) => string;
  body: (who: string, nb: string, access: 'read' | 'edit') => string;
  signIn: string;
  register: string;
  ignore: string;
}> = {
  en: {
    subject: (nb) => `A notebook was shared with you: ${nb}`,
    body: (who, nb, access) => `${who} shared the notebook "${nb}" with you (${access === 'edit' ? 'you can edit it' : 'read only'}).`,
    signIn: 'Open OS_Planner',
    register: 'Create an account to open it',
    ignore: 'You get this message because somebody typed your address. If you do not know them, ignore it.',
  },
  pt: {
    subject: (nb) => `Partilharam um caderno consigo: ${nb}`,
    body: (who, nb, access) => `${who} partilhou consigo o caderno "${nb}" (${access === 'edit' ? 'pode editá-lo' : 'só leitura'}).`,
    signIn: 'Abrir o OS_Planner',
    register: 'Crie uma conta para o abrir',
    ignore: 'Recebe esta mensagem porque alguém indicou o seu endereço. Se não conhece a pessoa, ignore-a.',
  },
};

/** "<person> shared a notebook with you". For an address without an account the button leads to registration. */
export function shareMail(locale: Locale, sharer: string, notebook: string, access: 'read' | 'edit', url: string, hasAccount: boolean): MailContent {
  const c = SHARE_COPY[locale];
  return render(locale, {
    name: null,
    subject: c.subject(notebook),
    body: c.body(sharer, notebook, access),
    button: hasAccount ? c.signIn : c.register,
    ignore: c.ignore,
    url,
    validity: '',
  });
}
