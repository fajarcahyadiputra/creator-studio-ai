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

  await ensureDefaultClippingPreset(admin.id);
  await ensureDefaultBrandKit(admin.id);

  console.log(`Seed completed. Admin: ${adminEmail}`);
}

async function ensureDefaultClippingPreset(userId: string): Promise<void> {
  const name = "Short Edu Indonesia";
  const description = "Preset default untuk auto clipping edukasi Indonesia dengan hook cepat, subtitle siap publish, dan brief editor yang kuat.";
  const config = {
    target_platform: "YOUTUBE_SHORTS",
    objective: "EDUCATION",
    desired_clip_count: 5,
    minimum_viral_score: 7.5,
    hook_style: "QUESTION",
    cta_preference: "COMMENT",
    profanity_handling: "KEEP",
    aspect_ratio: "9:16",
    durations: {
      min_seconds: 30,
      max_seconds: 55
    },
    preferred_topics: [
      "hook 3 detik pertama",
      "audience retention",
      "storytelling",
      "CTA komentar"
    ],
    topics_to_avoid: [
      "politik partisan",
      "SARA",
      "klaim medis berisiko"
    ],
    sensitive_topics: [
      "klaim medis",
      "saran legal",
      "data pribadi"
    ],
    analysis_brief: [
      "Anda adalah editor short video Indonesia untuk TikTok, Reels, dan YouTube Shorts.",
      "Pilih potongan yang paling cepat menarik perhatian, paling mudah dipahami tanpa konteks panjang, dan punya alasan kuat untuk ditonton sampai akhir.",
      "Prioritaskan momen dengan hook kuat di 1-3 detik pertama, konflik atau rasa penasaran yang jelas, insight praktis, bahasa natural, dan payoff yang selesai dengan rapi.",
      "Jika ada beberapa kandidat, utamakan yang durasinya paling pendek tetapi tetap utuh secara makna.",
      "Hindari opening yang masih basa-basi, filler berulang, jeda kosong, transisi yang tidak penting, atau bagian yang baru menarik setelah terlalu lama setup.",
      "Jangan pernah memotong saat pembicara masih mulai menjelaskan, masih menjawab setengah, masih menggantung dengan kata sambung seperti karena, jadi, makanya, kalau, atau saat kalimat sesudahnya jelas masih menyelesaikan poin utama.",
      "Untuk konten edukatif, utamakan clip yang benar-benar menyelesaikan penjelasan inti, meski perlu tambahan 2-8 detik, selama hasilnya tetap tajam dan tidak melewati batas durasi.",
      "Cari ending yang bisa memicu komentar, share, save, atau diskusi, bukan ending yang menggantung tanpa payoff.",
      "Kalau sumber videonya edukatif, pilih bagian yang menyederhanakan ide rumit menjadi kalimat yang tajam dan mudah dipotong menjadi clip mandiri.",
      "Kalau ada istilah teknis, utamakan bagian yang paling jelas, paling quotable, dan paling relevan untuk audience Indonesia.",
      "Jika akhir clip masih terasa seperti setup untuk kalimat berikutnya, anggap kandidat itu gagal dan pilih atau perpanjang sampai jawabannya benar-benar landing."
    ].join(" "),
    subtitle: {
      language: "id",
      style: "Bold Clean",
      font_family: "Montserrat",
      position: "BOTTOM",
      text_case: "UPPERCASE",
      max_lines: 2,
      safe_margin_percent: 8,
      burn_in: true,
      export_formats: ["SRT", "ASS", "VTT", "JSON"]
    }
  };

  await prisma.preset.updateMany({
    where: { userId, type: "CLIPPING", deletedAt: null },
    data: { isDefault: false }
  });

  const existing = await prisma.preset.findFirst({
    where: { userId, type: "CLIPPING", name, deletedAt: null }
  });

  if (existing) {
    await prisma.preset.update({
      where: { id: existing.id },
      data: {
        description,
        config,
        isSystem: true,
        isDefault: true
      }
    });
    return;
  }

  await prisma.preset.create({
    data: {
      userId,
      type: "CLIPPING",
      name,
      description,
      config,
      isSystem: true,
      isDefault: true
    }
  });
}

async function ensureDefaultBrandKit(userId: string): Promise<void> {
  const name = "Creator Studio Default";

  await prisma.brandKit.updateMany({
    where: { userId, deletedAt: null },
    data: { isDefault: false }
  });

  const existing = await prisma.brandKit.findFirst({
    where: { userId, name, deletedAt: null }
  });

  const data = {
    isDefault: true,
    fontConfig: {
      primary: "Montserrat",
      secondary: "DM Sans",
      emphasis: "Montserrat SemiBold"
    },
    colorConfig: {
      primary: "#111827",
      secondary: "#f59e0b",
      accent: "#22c55e",
      subtitle_fill: "#ffffff",
      subtitle_stroke: "#111827"
    },
    safeMarginConfig: {
      top_percent: 8,
      bottom_percent: 8,
      left_percent: 6,
      right_percent: 6
    },
    subtitlePreset: {
      style: "Bold Clean",
      position: "BOTTOM",
      text_case: "UPPERCASE",
      max_lines: 2,
      safe_margin_percent: 8
    }
  };

  if (existing) {
    await prisma.brandKit.update({
      where: { id: existing.id },
      data
    });
    return;
  }

  await prisma.brandKit.create({
    data: {
      userId,
      name,
      ...data
    }
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
