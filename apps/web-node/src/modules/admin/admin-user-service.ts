import type { Prisma } from "../../generated/prisma/client.js";
import { UserStatus } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { AuthService } from "../auth/auth-service.js";
import { hashPassword } from "../auth/password.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError
} from "../../shared/errors/app-error.js";

const USER_STATUS_OPTIONS = ["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED", "DISABLED"] as const;

interface AdminUserFilters {
  q?: string;
  status?: string;
}

interface CreateAdminUserInput {
  email: string;
  display_name: string;
  password: string;
  status: (typeof USER_STATUS_OPTIONS)[number];
  plan_code?: string;
  role_codes_csv?: string;
}

interface UpdateAdminUserInput {
  email: string;
  display_name: string;
  status: (typeof USER_STATUS_OPTIONS)[number];
  plan_code?: string;
  role_codes_csv?: string;
}

interface AdminUserServiceDeps {
  authService: Pick<AuthService, "requestPasswordReset">;
  prisma: typeof prisma;
}

export class AdminUserService {
  public constructor(
    private readonly deps: AdminUserServiceDeps = {
      prisma,
      authService: new AuthService()
    }
  ) {}

  public async getUserManagementPageData(filters: AdminUserFilters) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(isUserStatus(filters.status) ? { status: filters.status } : {}),
      ...(filters.q
        ? {
            OR: [
              { email: { contains: filters.q, mode: "insensitive" as const } },
              { displayName: { contains: filters.q, mode: "insensitive" as const } }
            ]
          }
        : {})
    };

    const [users, roles, plans] = await Promise.all([
      this.deps.prisma.user.findMany({
        where,
        include: {
          plan: true,
          roles: { include: { role: true } },
          sessions: { where: { revokedAt: null }, select: { id: true } },
          _count: { select: { jobs: true, auditLogsAsTarget: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 50
      }),
      this.deps.prisma.role.findMany({ orderBy: { code: "asc" } }),
      this.deps.prisma.plan.findMany({ where: { enabled: true }, orderBy: { name: "asc" } })
    ]);

    return {
      filters: {
        q: filters.q?.trim() ?? "",
        status: isUserStatus(filters.status) ? filters.status : "ALL"
      },
      plans,
      roles,
      statusOptions: USER_STATUS_OPTIONS,
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        emailVerifiedAt: user.emailVerifiedAt,
        planCode: user.plan?.code ?? null,
        planName: user.plan?.name ?? null,
        roleCodes: user.roles.map((assignment) => assignment.role.code),
        activeSessionCount: user.sessions.length,
        jobCount: user._count.jobs,
        auditCount: user._count.auditLogsAsTarget
      }))
    };
  }

  public async createUser(input: CreateAdminUserInput) {
    const existing = await this.deps.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ConflictError("EMAIL_ALREADY_REGISTERED", "An account already uses this email address.");
    }

    const passwordHash = await hashPassword(input.password);
    const roles = await this.resolveRoles(input.role_codes_csv);
    const plan = await this.resolvePlan(input.plan_code);

    return this.deps.prisma.user.create({
      data: {
        email: input.email,
        displayName: input.display_name,
        passwordHash,
        status: input.status,
        emailVerifiedAt: input.status === "ACTIVE" ? new Date() : null,
        planId: plan?.id,
        roles: { create: roles.map((role) => ({ roleId: role.id })) },
        setting: { create: {} }
      },
      include: { plan: true, roles: { include: { role: true } } }
    });
  }

  public async updateUser(userId: string, actorUserId: string, input: UpdateAdminUserInput) {
    await this.requireUser(userId);
    const existing = await this.deps.prisma.user.findUnique({ where: { email: input.email } });
    if (existing && existing.id !== userId) {
      throw new ConflictError("EMAIL_ALREADY_REGISTERED", "An account already uses this email address.");
    }
    if (actorUserId === userId && input.status !== "ACTIVE") {
      throw new ForbiddenError("You cannot change your own account to a non-active state.");
    }

    const roles = await this.resolveRoles(input.role_codes_csv);
    if (actorUserId === userId && !roles.some((role) => role.code === "SUPERADMIN")) {
      throw new ForbiddenError("You cannot remove your own SUPERADMIN role.");
    }

    const plan = await this.resolvePlan(input.plan_code);

    return this.deps.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      return tx.user.update({
        where: { id: userId },
        data: {
          email: input.email,
          displayName: input.display_name,
          status: input.status,
          planId: plan?.id ?? null,
          roles: { create: roles.map((role) => ({ roleId: role.id })) }
        },
        include: { plan: true, roles: { include: { role: true } } }
      });
    });
  }

  public async verifyEmail(userId: string) {
    await this.requireUser(userId);
    return this.deps.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date(), status: "ACTIVE" }
    });
  }

  public async sendPasswordReset(userId: string) {
    const user = await this.requireUser(userId);
    await this.deps.authService.requestPasswordReset(user.email);
    return user;
  }

  public async revokeSessions(userId: string, actorUserId: string) {
    await this.requireUser(userId);
    if (actorUserId === userId) {
      throw new ForbiddenError("Use the logout flow instead of revoking your current admin session.");
    }

    return this.deps.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }

  public async softDeleteUser(userId: string, actorUserId: string) {
    await this.requireUser(userId);
    if (actorUserId === userId) {
      throw new ForbiddenError("You cannot delete your own admin account.");
    }

    return this.deps.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });

      return tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: new Date(),
          status: "DISABLED",
          emailVerifiedAt: null
        }
      });
    });
  }

  private async requireUser(userId: string) {
    const user = await this.deps.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { roles: { include: { role: true } }, plan: true }
    });
    if (!user) throw new NotFoundError("User");
    return user;
  }

  private async resolvePlan(planCode?: string) {
    if (!planCode) return null;
    const plan = await this.deps.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan) {
      throw new ValidationError("Selected plan is invalid.", { fields: [{ path: "plan_code", message: "Unknown plan code." }] });
    }
    return plan;
  }

  private async resolveRoles(roleCodesCsv?: string) {
    const roleCodes = normalizeRoleCodes(roleCodesCsv);
    const codes = roleCodes.length ? roleCodes : ["USER"];
    const roles = await this.deps.prisma.role.findMany({ where: { code: { in: codes } }, orderBy: { code: "asc" } });
    if (roles.length !== codes.length) {
      const found = new Set(roles.map((role) => role.code));
      const missing = codes.filter((code) => !found.has(code));
      throw new ValidationError("Selected roles are invalid.", {
        fields: missing.map((code) => ({ path: "role_codes_csv", message: `Unknown role code: ${code}` }))
      });
    }
    return roles;
  }
}

function normalizeRoleCodes(roleCodesCsv?: string): string[] {
  if (!roleCodesCsv) return [];
  return [...new Set(roleCodesCsv.split(",").map((value) => value.trim()).filter(Boolean))];
}

function isUserStatus(value: string | undefined): value is UserStatus {
  return typeof value === "string" && value in UserStatus;
}
