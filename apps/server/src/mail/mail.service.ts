import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Locale } from '@os-planner/shared';
import { ENV, type Env } from '../config/env.js';
import {
  digestMail,
  inviteMail,
  meetingReminderMail,
  ownershipMail,
  requestDecisionMail,
  resetPasswordMail,
  shareMail,
  verifyEmailMail,
  type DigestMail,
  type MailContent,
} from './templates.js';

@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private readonly transport: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }

  /** Can the mail server be reached and does it take our login? (For /api/health; at most a few seconds.) */
  async verify(): Promise<boolean> {
    try {
      return await Promise.race([
        this.transport.verify().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 3000).unref()),
      ]);
    } catch {
      return false;
    }
  }

  private link(path: string, token: string): string {
    const base = this.env.APP_URL.replace(/\/+$/, '');
    return `${base}${path}?token=${encodeURIComponent(token)}`;
  }

  sendVerification(to: string, name: string, locale: Locale, token: string): Promise<boolean> {
    return this.send(to, verifyEmailMail(locale, name, this.link('/verify-email', token)));
  }

  sendPasswordReset(to: string, name: string, locale: Locale, token: string): Promise<boolean> {
    return this.send(to, resetPasswordMail(locale, name, this.link('/reset-password', token)));
  }

  /** An address inside the website, such as `/invite/<token>` or `/app`. */
  private appUrl(path: string): string {
    return `${this.env.APP_URL.replace(/\/+$/, '')}${path}`;
  }

  /** The invite mail. The language is the inviter's: nothing is known about the person, and none may be learned. */
  sendInvite(to: string, locale: Locale, inviter: string, team: string, token: string, expiresInDays: number): Promise<boolean> {
    return this.send(to, inviteMail(locale, inviter, team, this.appUrl(`/invite/${encodeURIComponent(token)}`), expiresInDays));
  }

  /** `hasAccount` false = an address nobody registered yet: the same text either way, only the button differs. */
  sendShare(to: string, locale: Locale, sharer: string, notebook: string, access: 'read' | 'edit', hasAccount: boolean): Promise<boolean> {
    return this.send(to, shareMail(locale, sharer, notebook, access, this.appUrl(hasAccount ? '/app' : '/register'), hasAccount));
  }

  sendRequestDecision(to: string, name: string, locale: Locale, team: string, approved: boolean): Promise<boolean> {
    return this.send(to, requestDecisionMail(locale, name, team, approved, this.appUrl('/app')));
  }

  /** `offered`: the team waits for an account with this address; `assigned`: ownership was just handed over. */
  sendOwnership(to: string, name: string | null, locale: Locale, team: string, kind: 'offered' | 'assigned'): Promise<boolean> {
    return this.send(to, ownershipMail(locale, name, team, kind, this.appUrl(kind === 'offered' ? '/register' : '/app')));
  }

  /** The mail about one chat (phase 9): a count, the latest messages, and links to open it, mute it or stop the mails. */
  sendNotificationDigest(to: string, name: string, locale: Locale, digest: DigestMail): Promise<boolean> {
    return this.send(to, digestMail(locale, name, digest));
  }

  /** A reminder of a meeting for somebody who turned on email reminders (phase 13). */
  sendMeetingReminder(to: string, name: string, locale: Locale, title: string, when: string): Promise<boolean> {
    return this.send(to, meetingReminderMail(locale, name, title, when, this.appUrl('/app/calendar')));
  }

  /** Never throws: a broken mail server must not break registration or leak account existence. */
  private async send(to: string, mail: MailContent): Promise<boolean> {
    try {
      await this.transport.sendMail({ from: this.env.MAIL_FROM, to, ...mail });
      return true;
    } catch (err) {
      this.log.error(`Could not send "${mail.subject}": ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}
