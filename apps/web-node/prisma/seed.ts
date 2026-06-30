import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/modules/auth/password";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });

const permissions = [
  ["admin.dashboard.view", "View the administration dashboard"],
  ["admin.users.read", "View users"],
  ["admin.users.write", "Create and update users"],
  ["admin.users.impersonate", "Open an audited user workspace"],
  ["admin.jobs.manage", "Manage all jobs and workflows"],
  ["admin.providers.manage", "Manage providers, models, and credentials"],
  ["admin.audit.read", "View audit logs"],
  ["admin.system.manage", "Manage feature flags and system settings"]
] as const;

async function main(): Promise<void> {
  const userRole = await prisma.role.upsert({
    where: { code: "USER" },
    update: {},
    create: { code: "USER", name: "User", description: "Standard creator workspace", isSystem: true }
  });
  const adminRole = await prisma.role.upsert({
    where: { code: "SUPERADMIN" },
    update: {},
    create: { code: "SUPERADMIN", name: "Superadmin", description: "Platform administrator", isSystem: true }
  });

  for (const [code, description] of permissions) {
    const permission = await prisma.permission.upsert({
      where: { code },
      update: { description },
      create: { code, description }
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } },
      update: {},
      create: { roleId: adminRole.id, permissionId: permission.id }
    });
  }

  const plan = await prisma.plan.upsert({
    where: { code: "FREE" },
    update: {},
    create: {
      code: "FREE",
      name: "Free",
      description: "Development starter plan",
      limits: {
        max_upload_size_bytes: 2147483648,
        max_source_duration_seconds: 3600,
        monthly_transcription_seconds: 3600,
        monthly_render_seconds: 1800,
        storage_bytes: 5368709120,
        concurrent_jobs: 1
      },
      features: { platform_credentials: true }
    }
  });

  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required for seeding.");
  }
  const passwordHash = await hashPassword(adminPassword);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { planId: plan.id },
    create: {
      email: adminEmail,
      displayName: "Platform Administrator",
      passwordHash,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      planId: plan.id,
      setting: { create: {} }
    }
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } },
    update: {},
    create: { userId: admin.id, roleId: adminRole.id }
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: userRole.id } },
    update: {},
    create: { userId: admin.id, roleId: userRole.id }
  });

  await prisma.featureFlag.upsert({
    where: { key: "auto_clipping_foundation" },
    update: { enabled: true },
    create: {
      key: "auto_clipping_foundation",
      description: "Allows the Phase 1 durable workflow foundation",
      enabled: true
    }
  });

  console.log(`Seed completed. Admin: ${adminEmail}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
