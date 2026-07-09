import { randomUUID } from "node:crypto";
import { prisma } from "../infrastructure/database/prisma.js";
import { JobService } from "../modules/jobs/job-service.js";

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: "admin@example.local" }
  });

  if (!user) {
    throw new Error("admin@example.local user was not found");
  }

  const jobService = new JobService();
  const job = await jobService.createAutoClippingJob({
    userId: user.id,
    idempotencyKey: randomUUID(),
    input: {
      source: {
        type: "EXTERNAL_URL",
        url: "https://www.youtube.com/watch?v=L6_iFG2SS0I"
      },
      content: {
        title: "APBN dan ekonomi Indonesia",
        context: "Uji pipeline auto clipping end to end untuk konten edukasi ekonomi Indonesia.",
        topic: "Ekonomi Indonesia",
        source_language: "id",
        custom_vocabulary: ["APBN", "ekonomi Indonesia", "anggaran negara"],
        rights_confirmed: true
      },
      strategy: {
        target_platform: "YOUTUBE_SHORTS",
        objective: "ENGAGEMENT",
        tones: ["EDUCATIONAL", "AUTHORITATIVE"],
        desired_clip_count: 3,
        minimum_duration_seconds: 20,
        maximum_duration_seconds: 45,
        minimum_viral_score: 7,
        preferred_topics: ["APBN", "ekonomi Indonesia", "analisis kebijakan"],
        topics_to_avoid: ["konten dewasa"],
        sensitive_topics: ["politik"],
        hook_style: "BOLD_STATEMENT",
        cta_preference: "COMMENT",
        profanity_handling: "KEEP",
        remove_long_silence: true,
        remove_filler_words: false
      },
      visual: {
        aspect_ratio: "9:16",
        crop_strategy: "ACTIVE_SPEAKER",
        settings: { mode: "ADVANCED" }
      },
      subtitle: {
        enabled: true,
        language: "id",
        burn_in: true,
        format: "ASS",
        export_formats: ["ASS", "SRT", "VTT", "JSON"],
        settings: {
          style: "creator-bold",
          font_family: "Poppins",
          position: "BOTTOM",
          max_lines: 2,
          safe_margin_percent: 12,
          word_highlight: true,
          profanity_censor: false
        }
      },
      ai: {
        credential_mode: "PLATFORM"
      }
    }
  });

  console.log(
    JSON.stringify({
      id: job.id,
      status: job.status,
      stage: job.currentStage,
      workflowId: job.workflowId
    })
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
