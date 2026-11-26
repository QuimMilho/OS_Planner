import type { Locale, NotificationKind } from '@os-planner/shared';

/** The few sentences the server writes itself (push and email), in the recipient's language. */
interface Copy {
  /** Push and inbox text when the channel hides previews: says what happened, not what was said. */
  redacted: (actor: string, kind: NotificationKind | 'message') => string;
  deletedUser: string;
  pushTitleChannel: (channel: string, team: string) => string;
  mailSubject: (count: number, where: string) => string;
  mailHello: (name: string) => string;
  mailIntro: (count: number, where: string, team: string | null) => string;
  mailMore: (n: number) => string;
  mailOpen: string;
  mailMute: string;
  mailUnsubscribe: string;
  mailWhy: string;
  mailRedacted: string;
  mailOk: (what: 'unsubscribe' | 'mute') => string;
}

export const COPY: Record<Locale, Copy> = {
  en: {
    redacted: (actor, kind) =>
      kind === 'mention_everyone' || kind === 'mention_here'
        ? `${actor} notified everyone`
        : kind === 'reply'
          ? `${actor} replied to you`
          : kind === 'dm' || kind === 'message'
            ? `${actor} sent a message`
            : `${actor} mentioned you`,
    deletedUser: 'Deleted user',
    pushTitleChannel: (channel, team) => `#${channel} · ${team}`,
    mailSubject: (n, where) =>
      n === 1 ? `New message in ${where}` : `${n} new messages in ${where}`,
    mailHello: (name) => `Hi ${name},`,
    mailIntro: (n, where, team) =>
      `${n === 1 ? 'There is a new message' : `There are ${n} new messages`} in ${where}${team ? ` (${team})` : ''}:`,
    mailMore: (n) => `…and ${n} more`,
    mailOpen: 'Open the conversation',
    mailMute: 'Mute this chat',
    mailUnsubscribe: 'Stop emails about this chat',
    mailWhy:
      'You get this email because you asked for email about this chat in your notification settings.',
    mailRedacted: 'New message (this channel hides previews)',
    mailOk: (what) =>
      what === 'mute' ? 'This chat is muted.' : 'You will not get email about this chat any more.',
  },
  pt: {
    redacted: (actor, kind) =>
      kind === 'mention_everyone' || kind === 'mention_here'
        ? `${actor} notificou todos`
        : kind === 'reply'
          ? `${actor} respondeu-lhe`
          : kind === 'dm' || kind === 'message'
            ? `${actor} enviou uma mensagem`
            : `${actor} mencionou-o`,
    deletedUser: 'Utilizador eliminado',
    pushTitleChannel: (channel, team) => `#${channel} · ${team}`,
    mailSubject: (n, where) =>
      n === 1 ? `Nova mensagem em ${where}` : `${n} novas mensagens em ${where}`,
    mailHello: (name) => `Olá ${name},`,
    mailIntro: (n, where, team) =>
      `${n === 1 ? 'Há uma nova mensagem' : `Há ${n} novas mensagens`} em ${where}${team ? ` (${team})` : ''}:`,
    mailMore: (n) => `…e mais ${n}`,
    mailOpen: 'Abrir a conversa',
    mailMute: 'Silenciar esta conversa',
    mailUnsubscribe: 'Deixar de receber email desta conversa',
    mailWhy:
      'Recebe este email porque pediu email sobre esta conversa nas definições de notificações.',
    mailRedacted: 'Nova mensagem (este canal esconde as pré-visualizações)',
    mailOk: (what) =>
      what === 'mute' ? 'Esta conversa está silenciada.' : 'Já não receberá email desta conversa.',
  },
};

export const copyFor = (locale: string): Copy => COPY[locale === 'pt' ? 'pt' : 'en'];
