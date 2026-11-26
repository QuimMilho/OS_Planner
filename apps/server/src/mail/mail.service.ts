import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Locale } from '@os-planner/shared';
import { ENV, type Env } from '../config/env.js';
import { resetPasswordMail, verifyEmailMail, type MailContent } from './templates.js';

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
