import { addMinutes, addHours } from "./date-utils.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { emailQueue } from "../../infrastructure/queue/email-queue.js";
import { env } from "../../config/env.js";
import { ConflictError, UnauthorizedError } from "../../shared/errors/app-error.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createOneTimeToken, hashToken } from "./token.js";

export interface RegisterInput {
  email: string;
  display_name: string;
  password: string;
}

export class AuthService {
  public async register(input: RegisterInput) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ConflictError("EMAIL_ALREADY_REGISTERED", "An account already uses this email address.");
    }

    const passwordHash = await hashPassword(input.password);
    const { raw, hash } = createOneTimeToken();
    const expiresAt = addHours(new Date(), 24);

    const user = await prisma.$transaction(async (tx) => {
      const role = await tx.role.findUniqueOrThrow({ where: { code: "USER" } });
      const created = await tx.user.create({
        data: {
          email: input.email,
          displayName: input.display_name,
          passwordHash,
          roles: { create: { roleId: role.id } },
          setting: { create: {} }
        }
      });
      await tx.emailVerificationToken.create({
        data: { userId: created.id, tokenHash: hash, expiresAt }
      });
      return created;
    });

    const verifyUrl = `${env.APP_BASE_URL}/api/v1/auth/verify-email?token=${encodeURIComponent(raw)}`;
    await emailQueue.add("verify-email", {
      to: user.email,
      subject: "Verify your Creator Studio AI email",
      text: `Verify your account: ${verifyUrl}`,
      html: `<p>Verify your account:</p><p><a href="${verifyUrl}">Verify email</a></p>`
    });

    return { id: user.id, email: user.email, displayName: user.displayName, status: user.status };
  }

  public async login(email: string, password: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    const now = new Date();

    if (!user?.passwordHash || user.status === "DISABLED" || user.status === "SUSPENDED") {
      throw new UnauthorizedError("Invalid email or password.");
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new UnauthorizedError("Login is temporarily locked. Try again later.");
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      const failed = user.failedLoginCount + 1;
      const lockedUntil = failed >= 5 ? addMinutes(now, Math.min(30, 2 ** (failed - 5))) : null;
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: failed, lockedUntil }
      });
      throw new UnauthorizedError("Invalid email or password.");
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
      include: { roles: { include: { role: true } } }
    });
    return updated;
  }

  public async verifyEmail(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const token = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
    if (!token || token.usedAt || token.expiresAt <= new Date()) {
      throw new UnauthorizedError("The verification link is invalid or expired.");
    }
    await prisma.$transaction([
      prisma.emailVerificationToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }),
      prisma.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt: new Date(), status: "ACTIVE" }
      })
    ]);
  }

  public async requestPasswordReset(email: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.status === "DISABLED") return;

    const { raw, hash } = createOneTimeToken();
    const expiresAt = addMinutes(new Date(), 30);
    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() }
      }),
      prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hash, expiresAt }
      })
    ]);

    const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(raw)}`;
    await emailQueue.add("password-reset", {
      to: user.email,
      subject: "Reset your Creator Studio AI password",
      text: `Reset your password: ${resetUrl}`,
      html: `<p>This link expires in 30 minutes:</p><p><a href="${resetUrl}">Reset password</a></p>`
    });
  }

  public async resetPassword(rawToken: string, password: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const token = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!token || token.usedAt || token.expiresAt <= new Date()) {
      throw new UnauthorizedError("The password reset link is invalid or expired.");
    }
    const passwordHash = await hashPassword(password);
    await prisma.$transaction([
      prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }),
      prisma.passwordResetToken.updateMany({
        where: { userId: token.userId, usedAt: null },
        data: { usedAt: new Date() }
      }),
      prisma.user.update({
        where: { id: token.userId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null, version: { increment: 1 } }
      }),
      prisma.session.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      })
    ]);
  }

  public async findOrCreateGoogleUser(profile: {
    providerAccountId: string;
    email: string;
    displayName: string;
  }) {
    const account = await prisma.oAuthAccount.findUnique({
      where: { provider_providerAccountId: { provider: "google", providerAccountId: profile.providerAccountId } },
      include: { user: { include: { roles: { include: { role: true } } } } }
    });
    if (account) return account.user;

    const existing = await prisma.user.findUnique({ where: { email: profile.email } });
    return prisma.$transaction(async (tx) => {
      let user = existing;
      if (!user) {
        const role = await tx.role.findUniqueOrThrow({ where: { code: "USER" } });
        user = await tx.user.create({
          data: {
            email: profile.email,
            displayName: profile.displayName,
            status: "ACTIVE",
            emailVerifiedAt: new Date(),
            roles: { create: { roleId: role.id } },
            setting: { create: {} }
          }
        });
      }
      await tx.oAuthAccount.create({
        data: {
          userId: user.id,
          provider: "google",
          providerAccountId: profile.providerAccountId,
          email: profile.email
        }
      });
      return tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { roles: { include: { role: true } } }
      });
    });
  }
}
