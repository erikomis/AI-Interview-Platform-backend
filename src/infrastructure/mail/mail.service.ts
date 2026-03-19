import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    const host = config.get<string>('MAIL_HOST');
    if (!host) {
      this.logger.warn('MAIL_HOST not set — emails will be logged to console only');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port: config.get<number>('MAIL_PORT', 587),
      secure: config.get<number>('MAIL_PORT', 587) === 465,
      auth: {
        user: config.get<string>('MAIL_USER'),
        pass: config.get<string>('MAIL_PASS'),
      },
    });
  }

  async sendVerificationEmail(to: string, name: string, token: string) {
    const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3001');
    const link = `${appUrl}/verify-email?token=${token}`;

    await this.send({
      to,
      subject: 'Confirm your AI Interview account',
      html: this.verificationTemplate(name, link),
    });
  }

  async sendInterviewFeedback(
    to: string,
    name: string,
    role: string,
    experienceLevel: string,
    language: string,
    fb: { overall: number; technical: number; communication: number; confidence: number; clarity: number; summary: string; strengths: string[]; improvements: string[] },
  ) {
    const isEn = language === 'en';
    await this.send({
      to,
      subject: isEn
        ? `Your AI Interview results — ${role}`
        : `Seu resultado de entrevista — ${role}`,
      html: this.feedbackTemplate(name, role, experienceLevel, language, fb),
    });
  }

  async sendPasswordResetEmail(to: string, name: string, token: string) {
    const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3001');
    const link = `${appUrl}/reset-password?token=${token}`;

    await this.send({
      to,
      subject: 'Reset your AI Interview password',
      html: this.passwordResetTemplate(name, link),
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async send(options: { to: string; subject: string; html: string }) {
    const from = this.config.get<string>('MAIL_FROM', 'noreply@aiinterview.app');

    if (!this.transporter) {
      // Dev fallback: print to console
      this.logger.log(`[MAIL] To: ${options.to} | Subject: ${options.subject}`);
      this.logger.log(`[MAIL] ${options.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
      return;
    }

    try {
      await this.transporter.sendMail({ from, ...options });
      this.logger.log(`Email sent to ${options.to}: ${options.subject}`);
    } catch (err) {
      this.logger.error(`Failed to send email to ${options.to}: ${(err as Error).message}`);
      throw err;
    }
  }

  private verificationTemplate(name: string, link: string): string {
    return `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0f172a;color:#e2e8f0;border-radius:12px">
        <h2 style="color:#6366f1;margin-bottom:8px">AI Interview</h2>
        <h3 style="margin-bottom:16px">Verify your email, ${name}</h3>
        <p style="color:#94a3b8;line-height:1.6">Click the button below to activate your account. This link expires in <strong>24 hours</strong>.</p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:12px 28px;background:#6366f1;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Verify email
        </a>
        <p style="color:#64748b;font-size:13px">Or copy this link:<br/><span style="color:#818cf8">${link}</span></p>
        <p style="color:#475569;font-size:12px;margin-top:24px">If you didn't create an account, you can ignore this email.</p>
      </div>
    `;
  }

  private passwordResetTemplate(name: string, link: string): string {
    return `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0f172a;color:#e2e8f0;border-radius:12px">
        <h2 style="color:#6366f1;margin-bottom:8px">AI Interview</h2>
        <h3 style="margin-bottom:16px">Reset your password, ${name}</h3>
        <p style="color:#94a3b8;line-height:1.6">Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:12px 28px;background:#6366f1;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Reset password
        </a>
        <p style="color:#64748b;font-size:13px">Or copy this link:<br/><span style="color:#818cf8">${link}</span></p>
        <p style="color:#475569;font-size:12px;margin-top:24px">If you didn't request a password reset, you can ignore this email safely.</p>
      </div>
    `;
  }

  private feedbackTemplate(
    name: string,
    role: string,
    level: string,
    language: string,
    fb: { overall: number; technical: number; communication: number; confidence: number; clarity: number; summary: string; strengths: string[]; improvements: string[] },
  ): string {
    const isEn = language === 'en';
    const bar = (v: number) => `<div style="background:#1e293b;border-radius:4px;height:8px;width:100%;margin-top:4px"><div style="background:#6366f1;border-radius:4px;height:8px;width:${v * 10}%"></div></div>`;
    const scoreColor = (v: number) => v >= 7 ? '#34d399' : v >= 5 ? '#fbbf24' : '#f87171';
    const metrics = [
      { label: isEn ? 'Technical'     : 'Técnico',       value: fb.technical },
      { label: isEn ? 'Communication' : 'Comunicação',   value: fb.communication },
      { label: isEn ? 'Confidence'    : 'Confiança',     value: fb.confidence },
      { label: isEn ? 'Clarity'       : 'Clareza',       value: fb.clarity },
    ];
    const levelLabel: Record<string, string> = {
      junior: isEn ? 'Junior' : 'Júnior',
      mid:    isEn ? 'Mid'    : 'Pleno',
      senior: isEn ? 'Senior' : 'Sênior',
    };
    return `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#0f172a;color:#e2e8f0;border-radius:12px">
      <h2 style="color:#6366f1;margin-bottom:4px">AI Interview</h2>
      <h3 style="margin-bottom:4px">${isEn ? `Results for ${name}` : `Resultado de ${name}`}</h3>
      <p style="color:#94a3b8;margin-bottom:24px">${role} · ${levelLabel[level] ?? level}</p>

      <div style="text-align:center;background:#1e293b;border-radius:10px;padding:20px;margin-bottom:20px">
        <div style="font-size:48px;font-weight:700;color:${scoreColor(fb.overall)}">${fb.overall.toFixed(1)}</div>
        <div style="color:#94a3b8;font-size:13px">${isEn ? 'Overall score / 10' : 'Nota geral / 10'}</div>
        ${bar(fb.overall)}
      </div>

      <div style="margin-bottom:20px">
        ${metrics.map(m => `
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;font-size:13px">
              <span>${m.label}</span>
              <span style="color:${scoreColor(m.value)};font-weight:600">${m.value.toFixed(1)}</span>
            </div>
            ${bar(m.value)}
          </div>
        `).join('')}
      </div>

      <p style="color:#94a3b8;font-size:13px;line-height:1.7;margin-bottom:20px">${fb.summary}</p>

      ${fb.strengths.length > 0 ? `
        <div style="background:#052e16;border-left:3px solid #34d399;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:12px">
          <p style="color:#34d399;font-size:12px;font-weight:600;margin-bottom:8px">${isEn ? 'STRENGTHS' : 'PONTOS FORTES'}</p>
          ${fb.strengths.map(s => `<p style="color:#bbf7d0;font-size:13px;margin:4px 0">· ${s}</p>`).join('')}
        </div>
      ` : ''}

      ${fb.improvements.length > 0 ? `
        <div style="background:#1c1400;border-left:3px solid #fbbf24;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px">
          <p style="color:#fbbf24;font-size:12px;font-weight:600;margin-bottom:8px">${isEn ? 'AREAS TO IMPROVE' : 'ÁREAS DE MELHORIA'}</p>
          ${fb.improvements.map(s => `<p style="color:#fef3c7;font-size:13px;margin:4px 0">· ${s}</p>`).join('')}
        </div>
      ` : ''}

      <p style="color:#475569;font-size:12px;margin-top:24px">${isEn ? 'Keep practicing to improve your scores.' : 'Continue praticando para melhorar seus resultados.'}</p>
    </div>
  `;
  }
}
