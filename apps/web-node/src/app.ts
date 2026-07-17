import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import passport from "passport";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database/prisma.js";
import { createRedisClient, type RedisClient } from "./infrastructure/redis/client.js";
import { createSessionMiddleware } from "./infrastructure/session/session.js";
import { closeTemporalClient } from "./infrastructure/temporal/client.js";
import { impersonationRouter } from "./modules/admin/impersonation-routes.js";
import { AdminProviderService } from "./modules/admin/admin-provider-service.js";
import { AdminSystemService } from "./modules/admin/admin-system-service.js";
import { AdminUserService } from "./modules/admin/admin-user-service.js";
import { AdminObservabilityService } from "./modules/admin/admin-observability-service.js";
import { AdminJobService } from "./modules/admin/admin-job-service.js";
import { AdminMediaService } from "./modules/admin/admin-media-service.js";
import { adminJobRouter } from "./modules/admin/job-management-routes.js";
import { adminMediaRouter } from "./modules/admin/media-management-routes.js";
import { adminObservabilityRouter } from "./modules/admin/observability-routes.js";
import { adminProviderRouter } from "./modules/admin/provider-management-routes.js";
import { adminSystemRouter } from "./modules/admin/system-management-routes.js";
import { adminUserRouter } from "./modules/admin/user-management-routes.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { attachCsrfToken, verifyCsrf } from "./modules/auth/csrf.js";
import { loadIdentity } from "./modules/auth/identity-middleware.js";
import { configurePassport } from "./modules/auth/passport.js";
import { authRouter } from "./modules/auth/routes.js";
import { dashboardRouter } from "./modules/dashboard/routes.js";
import {
  healthRouter,
  httpRequestCounter,
  httpRequestDuration
} from "./modules/health/routes.js";
import { internalRouter } from "./modules/internal/routes.js";
import { JobEventBus } from "./modules/jobs/job-event-bus.js";
import { JobProjectionService } from "./modules/jobs/job-projection-service.js";
import { JobService } from "./modules/jobs/job-service.js";
import { jobsRouter } from "./modules/jobs/routes.js";
import { mediaRouter } from "./modules/media/routes.js";
import { PresetService } from "./modules/presets/preset-service.js";
import { presetsRouter } from "./modules/presets/routes.js";
import { settingsRouter } from "./modules/settings/routes.js";
import { SettingsService } from "./modules/settings/settings-service.js";
import { uploadsRouter } from "./modules/uploads/routes.js";
import { UploadService } from "./modules/uploads/upload-service.js";
import { errorHandler } from "./shared/http/error-handler.js";
import { notFoundHandler } from "./shared/http/not-found.js";
import { requestContext } from "./shared/http/request-context.js";
import { logger } from "./shared/logging/logger.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

type PublicHomeLanguage = "id" | "en";

function resolvePublicHomeLanguage(value: unknown): PublicHomeLanguage {
  return value === "en" ? "en" : "id";
}

function buildPublicHomeContent(language: PublicHomeLanguage) {
  if (language === "en") {
    return {
      pageLang: "en",
      navLogin: "Login",
      navRegister: "Get Started",
      languageLabel: "Language",
      heroEyebrow: "AI clipping workflow for creator teams",
      heroTitle: "Turn long videos into short clips your team can publish faster.",
      heroDescription:
        "Creator Studio AI helps creators, podcast teams, agencies, and brands transform long videos into vertical clips with transcript-aware analysis, subtitle styling, render automation, and cleaner review loops.",
      heroPrimaryCta: "Start Free",
      heroSecondaryCta: "See Workspace",
      heroProof: "Used for clipping, subtitles, voice, review, and export in one workspace.",
      heroPoints: [
        "Find hook-heavy moments with clearer editorial reasoning.",
        "Review progress, retries, regenerate flows, and output artifacts from one job detail page.",
        "Ship 9:16 short clips faster for TikTok, Reels, and YouTube Shorts."
      ],
      previewLabel: "Product Preview",
      previewTitle: "One workflow for ingest, analysis, subtitles, render, and final export.",
      previewSteps: ["Upload", "Analyze", "Subtitle", "Render", "Export"],
      previewMetrics: [
        { value: "9:16", label: "Vertical-ready outputs" },
        { value: "SRT / ASS / VTT", label: "Sidecar subtitle artifacts" },
        { value: "Retry / Regenerate", label: "Cleaner iteration flow" }
      ],
      trustTitle: "Built for modern short-content operations",
      trustItems: ["Podcast clips", "Education content", "Agency workflows", "Brand social teams"],
      whyEyebrow: "Why it works",
      whyTitle: "More than a clipper. It is a structured content production system.",
      whyCards: [
        {
          title: "Editorial clip analysis",
          description: "Prioritize hooks, conflict, insight, payoff, and retention cues instead of rough timestamp cutting."
        },
        {
          title: "Traceable runtime flow",
          description: "See stage-by-stage progress, logs, failures, retries, and regenerate actions with less chaos."
        },
        {
          title: "Fewer tool handoffs",
          description: "Keep clipping, subtitles, review, TTS, and exports inside one operational workspace."
        }
      ],
      workflowEyebrow: "How the flow looks",
      workflowTitle: "Designed to feel closer to a production console than a generic upload form.",
      workflowSteps: [
        {
          index: "01",
          title: "Bring in source media",
          description: "Start from supported uploads or source links, then keep the job pipeline traceable from first import to final output."
        },
        {
          index: "02",
          title: "Review candidate intelligence",
          description: "Score clips with hook, payoff, subtitle, and retention context so editors can move faster with better confidence."
        },
        {
          index: "03",
          title: "Render and export",
          description: "Generate vertical outputs, subtitle artifacts, and downloadable assets without juggling multiple disconnected tools."
        }
      ],
      useCasesEyebrow: "Use Cases",
      useCasesTitle: "Works well for podcasts, education, experts, founders, and social content teams.",
      useCases: [
        {
          title: "Podcast & interview clips",
          description: "Extract sharp answers, strong debates, and scroll-stopping moments from longer conversations."
        },
        {
          title: "Education & explainer content",
          description: "Turn dense ideas into short clips that still make sense without a long setup."
        },
        {
          title: "Agencies & internal teams",
          description: "Standardize review, retries, presets, and output delivery across recurring content operations."
        },
        {
          title: "Daily creator workflow",
          description: "Keep your clipping pipeline fast enough for frequent posting without losing control over output quality."
        }
      ],
      toolsEyebrow: "AI Tools",
      toolsTitle: "Two production tools that work together inside the same workspace.",
      toolsDescription:
        "Start from auto clipping when you need short-form outputs, then switch to TTS when you need fast narration, local model previews, and script-to-audio workflows.",
      tools: [
        {
          eyebrow: "Auto Clipping",
          title: "Find stronger moments and render vertical clips faster.",
          description:
            "Analyze long videos, score candidate moments, generate subtitles, and export ready-to-review 9:16 outputs from one pipeline.",
          bullets: [
            "Hook-first candidate analysis with regenerate flow",
            "Vertical render, subtitle artifacts, and output validation",
            "Designed for podcasts, education, interviews, and expert content"
          ],
          cta: "Explore Auto Clipping"
        },
        {
          eyebrow: "Narration TTS",
          title: "Generate narration with reusable voices and faster iteration.",
          description:
            "Create speech segments, preview local TTS models, and render narration output for explainers, faceless content, and scripted videos.",
          bullets: [
            "Local model preview before generating the full output",
            "Segment-aware narration flow with speech pacing controls",
            "Fits explainer videos, documentary style, and social voiceover"
          ],
          cta: "Explore TTS"
        }
      ],
      showcaseEyebrow: "Auto-clip Preview",
      showcaseTitle: "See how finished short clips can look inside your workflow.",
      showcaseDescription:
        "These preview cards show the style of output Creator Studio AI is built to help you review: vertical framing, on-video subtitle treatment, and clear packaging for short-form publishing.",
      showcaseSlides: [
        {
          badge: "Podcast clip",
          title: "Kritik tajam media sosial",
          subtitle: "Hook tajam, subtitle terbaca, dan framing vertikal siap review."
        },
        {
          badge: "Story clip",
          title: "Pengalaman seram di konser TDS",
          subtitle: "Momen emosional yang cepat masuk ke konflik dan tetap utuh di ending."
        },
        {
          badge: "Insight clip",
          title: "Kebocoran nikel 200 triliun",
          subtitle: "Topik berat dibungkus jadi clip pendek yang tetap jelas dan memancing diskusi."
        }
      ],
      faqEyebrow: "FAQs",
      faqTitle: "Questions teams usually ask before they move their clipping workflow here.",
      faqDescription: "Still unsure? Reach us at hello@creatorstudio.ai for product, workflow, or partnership questions.",
      faqs: [
        {
          question: "How does auto clipping work in practice?",
          answer:
            "You submit a source video, then the system analyzes spoken moments, ranks clip candidates, prepares subtitles, and renders final short-form outputs that your team can review from one job detail page."
        },
        {
          question: "What kinds of videos usually perform best?",
          answer:
            "Podcast conversations, education explainers, expert commentary, interviews, product insights, and strong opinion clips usually work best because they contain clear hooks, quotable lines, and stronger payoff moments."
        },
        {
          question: "Can I use text-to-speech without using auto clipping first?",
          answer:
            "Yes. TTS is available as its own tool, so you can generate narration, preview local voices, and create audio outputs even when you are not clipping a long-form source video."
        },
        {
          question: "How much manual review is still needed?",
          answer:
            "The goal is to reduce review time, not hide it. Your team still checks the final outputs, but the workflow already brings together scoring, subtitles, render artifacts, retries, and regenerate actions in one place."
        },
        {
          question: "Is this better for solo creators or teams?",
          answer:
            "Both. Solo creators use it to post faster, while teams benefit more from the job history, presets, rerender flows, and clearer operational visibility across recurring content production."
        }
      ],
      ctaEyebrow: "Ready to try",
      ctaTitle: "Build a faster clipping workflow before your team gets buried in manual review.",
      ctaDescription:
        "Use Creator Studio AI to submit jobs, inspect outputs, regenerate styles, and move from long-form source to short-form publishing with less friction.",
      ctaPrimary: "Create Account",
      ctaSecondary: "Login to Workspace"
    };
  }

  return {
    pageLang: "id",
    navLogin: "Login",
    navRegister: "Coba Gratis",
    languageLabel: "Bahasa",
    heroEyebrow: "Workflow AI clipping untuk creator dan tim konten",
    heroTitle: "Ubah video panjang jadi short clip yang lebih cepat tayang.",
    heroDescription:
      "Creator Studio AI membantu creator, podcaster, agency, media team, dan brand Indonesia mengubah video panjang menjadi clip vertikal dengan analisis momen, subtitle, render otomatis, dan workflow review yang lebih rapi.",
    heroPrimaryCta: "Mulai Gratis",
    heroSecondaryCta: "Lihat Workspace",
    heroProof: "Satu workspace untuk clipping, subtitle, voice, review, dan export.",
    heroPoints: [
      "Cari momen dengan hook kuat dan payoff yang lebih jelas.",
      "Lihat progress, retry, regenerate, dan hasil output dari satu halaman job detail.",
      "Percepat produksi 9:16 untuk TikTok, Reels, dan YouTube Shorts."
    ],
    previewLabel: "Preview Produk",
    previewTitle: "Satu alur kerja untuk ingest, analisis, subtitle, render, sampai export final.",
    previewSteps: ["Upload", "Analyze", "Subtitle", "Render", "Export"],
    previewMetrics: [
      { value: "9:16", label: "Output siap vertikal" },
      { value: "SRT / ASS / VTT", label: "Artifact subtitle sidecar" },
      { value: "Retry / Regenerate", label: "Iterasi lebih rapi" }
    ],
    trustTitle: "Dibuat untuk workflow short-content modern",
    trustItems: ["Clip podcast", "Konten edukasi", "Workflow agency", "Tim social brand"],
    whyEyebrow: "Kenapa lebih enak dipakai",
    whyTitle: "Bukan cuma alat potong video, tapi sistem produksi konten yang lebih terstruktur.",
    whyCards: [
      {
        title: "Analisis clip lebih editorial",
        description: "Prioritaskan hook, konflik, insight, payoff, dan sinyal retention, bukan sekadar potong timestamp kasar."
      },
      {
        title: "Alur runtime yang bisa dilacak",
        description: "Lihat progress per tahap, log, error, retry, dan regenerate tanpa bikin workflow makin berantakan."
      },
      {
        title: "Lebih sedikit pindah tool",
        description: "Clipping, subtitle, review, TTS, dan export tetap di satu workspace operasional."
      }
    ],
    workflowEyebrow: "Cara kerjanya",
    workflowTitle: "Dirancang lebih terasa seperti production console daripada form upload biasa.",
    workflowSteps: [
      {
        index: "01",
        title: "Masukkan source media",
        description: "Mulai dari upload atau source link yang didukung, lalu simpan alur job tetap terlacak dari import pertama sampai output final."
      },
      {
        index: "02",
        title: "Review kandidat dengan konteks",
        description: "Nilai clip lewat hook, payoff, subtitle, dan retention cue supaya editor bisa ambil keputusan lebih cepat."
      },
      {
        index: "03",
        title: "Render lalu export",
        description: "Bentuk output vertikal, artifact subtitle, dan file siap unduh tanpa harus pindah-pindah tool."
      }
    ],
    useCasesEyebrow: "Use Cases",
    useCasesTitle: "Cocok untuk podcast, edukasi, expert content, personal brand, dan tim social media.",
    useCases: [
      {
        title: "Clip podcast & wawancara",
        description: "Ambil jawaban paling tajam, debat paling menarik, dan momen yang bikin orang berhenti scroll."
      },
      {
        title: "Konten edukasi & explainer",
        description: "Ubah ide padat jadi clip pendek yang tetap masuk akal tanpa setup terlalu panjang."
      },
      {
        title: "Agency & tim internal",
        description: "Standarkan review, retry, preset, dan pengiriman output untuk produksi konten yang berulang."
      },
      {
        title: "Workflow creator harian",
        description: "Bikin pipeline clipping cukup cepat untuk posting rutin tanpa kehilangan kontrol kualitas hasil."
      }
    ],
    toolsEyebrow: "AI Tools",
    toolsTitle: "Dua tools utama untuk produksi short-content dan voice workflow.",
    toolsDescription:
      "Mulai dari auto clipping saat butuh hasil short clip, lalu lanjut ke TTS saat perlu voiceover, preview model lokal, dan alur script-to-audio yang lebih cepat.",
    tools: [
      {
        eyebrow: "Auto Clipping",
        title: "Cari momen terbaik lalu render clip vertikal lebih cepat.",
        description:
          "Analisis video panjang, ranking kandidat clip, buat subtitle, lalu export output 9:16 yang siap direview dan diunduh.",
        bullets: [
          "Analisis kandidat dengan fokus hook, payoff, dan retention",
          "Render vertikal, artifact subtitle, dan validasi output",
          "Cocok untuk podcast, edukasi, wawancara, dan expert content"
        ],
        cta: "Lihat Auto Clipping"
      },
      {
        eyebrow: "Narration TTS",
        title: "Buat voiceover lebih cepat dengan preview model dan workflow yang rapi.",
        description:
          "Generate segment narasi, preview model TTS lokal, lalu bentuk output audio untuk explainer, faceless content, dan video scripted.",
        bullets: [
          "Preview suara lokal sebelum generate full output",
          "Segment-aware narration dengan kontrol pacing",
          "Cocok untuk explainer, dokumenter, dan voiceover social video"
        ],
        cta: "Lihat TTS"
      }
    ],
    showcaseEyebrow: "Preview Hasil",
    showcaseTitle: "Lihat gaya hasil auto clip yang lebih dekat ke output final.",
    showcaseDescription:
      "Section ini menampilkan contoh style hasil yang ingin dibantu Creator Studio AI: framing vertikal, subtitle yang kebaca, dan packaging yang lebih siap publish.",
    showcaseSlides: [
      {
        badge: "Clip podcast",
        title: "Kritik tajam media sosial",
        subtitle: "Hook kuat, subtitle jelas, dan framing 9:16 yang enak direview."
      },
      {
        badge: "Clip cerita",
        title: "Pengalaman seram di konser TDS",
        subtitle: "Momen emosional yang langsung masuk konflik dan tetap punya payoff."
      },
      {
        badge: "Clip insight",
        title: "Kebocoran nikel 200 triliun",
        subtitle: "Topik berat dibungkus jadi clip pendek yang memancing diskusi."
      }
    ],
    faqEyebrow: "FAQ",
    faqTitle: "Pertanyaan yang sering muncul sebelum tim mulai pakai workflow ini.",
    faqDescription: "Masih ada pertanyaan lain? Hubungi kami di hello@creatorstudio.ai untuk diskusi product, workflow, atau partnership.",
    faqs: [
      {
        question: "Bagaimana cara kerja auto clipping di Creator Studio AI?",
        answer:
          "Kamu upload video atau submit source yang didukung, lalu sistem menganalisis momen bicara, memilih kandidat clip yang paling potensial, menyiapkan subtitle, dan merender output final yang bisa direview dari satu halaman job detail."
      },
      {
        question: "Video seperti apa yang paling cocok diproses di sini?",
        answer:
          "Podcast, wawancara, konten edukasi, opini expert, diskusi tim, dan video dengan value verbal yang kuat biasanya paling cocok karena punya hook, quote, insight, atau konflik yang lebih gampang dipotong jadi clip mandiri."
      },
      {
        question: "Apakah TTS bisa dipakai tanpa auto clipping?",
        answer:
          "Bisa. Tool TTS berdiri sendiri, jadi kamu bisa generate narasi, preview suara lokal, dan membuat output audio tanpa harus submit job clipping dulu."
      },
      {
        question: "Apakah hasilnya masih perlu direview manual?",
        answer:
          "Iya, tapi jauh lebih ringan. Tujuannya bukan menghilangkan review, melainkan memusatkan scoring, subtitle, render artifact, retry, dan regenerate supaya tim tidak buang waktu pindah tool."
      },
      {
        question: "Lebih cocok untuk creator solo atau tim?",
        answer:
          "Dua-duanya. Creator solo bisa posting lebih cepat, sementara tim akan lebih terbantu oleh history job, preset, rerender flow, dan visibilitas operasional yang lebih jelas untuk produksi berulang."
      }
    ],
    ctaEyebrow: "Siap mulai",
    ctaTitle: "Bangun workflow clipping yang lebih cepat sebelum timmu tenggelam di review manual.",
    ctaDescription:
      "Pakai Creator Studio AI untuk submit job, cek hasil, regenerate style, dan bergerak dari video panjang ke short-form publishing dengan friksi yang lebih kecil.",
    ctaPrimary: "Buat Akun",
    ctaSecondary: "Masuk ke Workspace"
  };
}

function resolveCspOrigins() {
  const origins = new Set<string>();
  const candidates = [env.APP_BASE_URL, env.WEB_INTERNAL_BASE_URL, env.S3_PUBLIC_ENDPOINT, env.S3_ENDPOINT];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      origins.add(new URL(String(candidate)).origin);
    } catch {
      // Ignore malformed runtime URLs here because env validation owns correctness.
    }
  }

  return [...origins];
}

export interface ApplicationRuntime {
  app: Express;
  close: () => Promise<void>;
}

export async function createApplication(): Promise<ApplicationRuntime> {
  const redis = createRedisClient();
  await redis.connect();
  const eventBus = new JobEventBus(redis);
  await eventBus.start();

  const authService = new AuthService();
  const jobService = new JobService();
  const presetService = new PresetService({ prisma });
  const settingsService = new SettingsService({ prisma });
  const adminJobService = new AdminJobService({ prisma, jobService });
  const adminMediaService = new AdminMediaService({ prisma });
  const adminObservabilityService = new AdminObservabilityService({ prisma });
  const adminProviderService = new AdminProviderService({ prisma });
  const adminSystemService = new AdminSystemService({ prisma });
  const adminUserService = new AdminUserService({ prisma, authService });
  const projectionService = new JobProjectionService(eventBus);
  const uploadService = new UploadService();
  configurePassport(authService);

  const app = express();
  const cspOrigins = resolveCspOrigins();
  const jsonBodyLimit = `${env.HTTP_JSON_BODY_LIMIT_MB}mb`;
  if (env.TRUST_PROXY) app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.join(dirname, "views"));

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      customProps: (request) => ({ requestId: request.requestId }),
      serializers: {
        req: (request) => ({ method: request.method, url: request.url, remoteAddress: request.remoteAddress }),
        res: (response) => ({ statusCode: response.statusCode })
      }
    })
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          imgSrc: ["'self'", "data:", "blob:", ...cspOrigins],
          mediaSrc: ["'self'", "blob:", ...cspOrigins],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "https://cdn.jsdelivr.net"]
        }
      },
      crossOriginResourcePolicy: { policy: "cross-origin" }
    })
  );
  app.use(express.json({ limit: jsonBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: jsonBodyLimit }));
  app.use(createSessionMiddleware(redis));
  app.use(attachCsrfToken);
  app.use(passport.initialize());
  app.use(loadIdentity);

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (request) => request.identity?.actorUserId ?? ipKeyGenerator(request.ip ?? "unknown")
    })
  );
  app.use(
    ["/api/v1/auth/login", "/api/v1/auth/forgot-password", "/api/v1/auth/reset-password"],
    rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false })
  );

  app.use((request, response, next) => {
    const end = httpRequestDuration.startTimer({ method: request.method });
    response.on("finish", () => {
      const route = request.route?.path ? String(request.route.path) : request.path;
      const status = String(response.statusCode);
      httpRequestCounter.inc({ method: request.method, route, status });
      end({ route, status });
    });
    next();
  });

  app.use(express.static(path.join(dirname, "public"), { maxAge: env.NODE_ENV === "production" ? "1d" : 0 }));
  app.use(verifyCsrf);
  app.use((request, response, next) => {
    response.locals.appName = env.APP_NAME;
    response.locals.path = request.path;
    response.locals.impersonation = request.session.impersonation;
    response.locals.csrfToken = request.session.csrfToken;
    next();
  });

  app.get("/", (request, response) => {
    if (!request.identity) {
      const language = resolvePublicHomeLanguage(request.query.lang);
      const home = buildPublicHomeContent(language);
      const host = request.get("host");
      const origin = host ? `${request.protocol}://${host}` : "";
      const canonicalUrl = origin ? `${origin}/?lang=${language}` : `/?lang=${language}`;
      response.render("public/home", {
        title:
          language === "en"
            ? "AI Video Clipping Workspace for Creator Teams"
            : "AI Auto Clipping untuk Creator Indonesia",
        pageLang: home.pageLang,
        metaDescription:
          language === "en"
            ? "Creator Studio AI helps creator teams turn long videos into short-form clips with analysis, subtitles, rendering, review flow, and cleaner export operations."
            : "Creator Studio AI membantu creator, podcaster, agency, dan brand mengubah video panjang menjadi short clip vertikal lengkap dengan analisis momen, subtitle, render, dan workflow review yang rapi.",
        metaKeywords:
          language === "en"
            ? "AI video clipping, creator workflow, short-form video editor, subtitle workflow, podcast clipping AI, reels shorts tiktok AI"
            : "AI auto clipping Indonesia, AI shorts creator, subtitle video Indonesia, clipping podcast AI, TikTok Reels YouTube Shorts AI, creator workflow Indonesia",
        canonicalUrl,
        ogTitle:
          language === "en"
            ? "Creator Studio AI - Turn Long Videos Into Publish-Ready Short Clips"
            : "Creator Studio AI - Ubah Video Panjang Jadi Short Clip Siap Upload",
        ogDescription:
          language === "en"
            ? "Move faster from source video to vertical outputs with analysis, subtitle artifacts, regenerate flows, and a cleaner creator workspace."
            : "Masuk lebih cepat ke proses clipping, subtitle, render 9:16, regenerate, dan review output dalam satu workspace creator yang rapi.",
        twitterTitle:
          language === "en" ? "Creator Studio AI for Creator Teams" : "Creator Studio AI untuk Creator Indonesia",
        twitterDescription:
          language === "en"
            ? "AI workflow for turning long videos into short clips ready for TikTok, Reels, and YouTube Shorts."
            : "Workflow AI untuk mengubah video panjang menjadi short clip siap TikTok, Reels, dan YouTube Shorts.",
        home,
        selectedLanguage: language
      });
      return;
    }
    if (request.identity.permissions.has("admin.dashboard.view")) return response.redirect("/admin/dashboard");
    return response.redirect("/app/dashboard");
  });

  app.use(healthRouter);
  app.use(authRouter(authService));
  app.use(impersonationRouter);
  app.use(adminJobRouter(adminJobService));
  app.use(adminMediaRouter(adminMediaService));
  app.use(adminObservabilityRouter(adminObservabilityService));
  app.use(adminProviderRouter(adminProviderService));
  app.use(adminSystemRouter(adminSystemService));
  app.use(adminUserRouter(adminUserService));
  app.use(uploadsRouter(uploadService));
  app.use(jobsRouter(jobService, eventBus));
  app.use(mediaRouter());
  app.use(presetsRouter(presetService));
  app.use(settingsRouter(settingsService));
  app.use(internalRouter(projectionService));
  app.use(dashboardRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    close: async () => {
      await eventBus.close();
      await closeRedis(redis);
      await closeTemporalClient();
      await prisma.$disconnect();
    }
  };
}

async function closeRedis(redis: RedisClient): Promise<void> {
  if (redis.isOpen) await redis.quit();
}
