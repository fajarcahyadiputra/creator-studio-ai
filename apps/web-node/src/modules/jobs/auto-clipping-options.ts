export type AutoClipSelectOption = Readonly<{
  value: string;
  label: string;
}>;

function humanizeOptionValue(value: string) {
  return value
    .split("_")
    .map((part) => part === "FOMO" ? part : `${part.charAt(0)}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function buildOptions<const TValues extends readonly string[]>(
  values: TValues,
  labels: Readonly<Record<string, string>> = {}
) {
  return values.map((value) => ({
    value,
    label: labels[value] ?? humanizeOptionValue(value)
  })) satisfies AutoClipSelectOption[];
}

export const AUTO_CLIP_OBJECTIVES = [
  "ENGAGEMENT",
  "EDUCATION",
  "CONTROVERSY",
  "STORYTELLING",
  "PRODUCT_AWARENESS",
  "LEAD_GENERATION",
  "RETENTION",
  "VIRALITY",
  "BRAND_AWARENESS",
  "COMMUNITY_DISCUSSION",
  "THOUGHT_LEADERSHIP",
  "SALES_CONVERSION",
  "NEWS_COMMENTARY",
  "AUTHORITY_BUILDING",
  "VIRAL_POTENTIAL",
  "HIGH_ENGAGEMENT",
  "SPARK_DISCUSSION",
  "TRIGGER_DEBATE",
  "GENERATE_COMMENTS",
  "ENCOURAGE_SHARING",
  "INCREASE_WATCH_TIME",
  "MAXIMIZE_RETENTION",
  "CREATE_CURIOSITY",
  "DELIVER_STRONG_INSIGHT",
  "HIGHLIGHT_CONTROVERSY",
  "HIGHLIGHT_SHOCKING_MOMENT",
  "HIGHLIGHT_EMOTIONAL_MOMENT",
  "HIGHLIGHT_FUNNY_MOMENT",
  "HIGHLIGHT_SURPRISING_FACT",
  "HIGHLIGHT_STRONG_OPINION",
  "HIGHLIGHT_RELATABLE_MOMENT",
  "HIGHLIGHT_VALUABLE_INFORMATION",
  "HIGHLIGHT_CONFLICT",
  "HIGHLIGHT_STORYTELLING_MOMENT",
  "CREATE_AWARENESS",
  "EDUCATE_AUDIENCE",
  "ENTERTAIN_AUDIENCE",
  "INSPIRE_AUDIENCE",
  "MOTIVATE_AUDIENCE",
  "BUILD_TRUST",
  "BUILD_PERSONAL_BRANDING",
  "PROMOTE_PRODUCT",
  "GENERATE_LEADS",
  "DRIVE_CONVERSION",
  "ENCOURAGE_CALL_TO_ACTION",
  "INCREASE_BRAND_AWARENESS",
  "CREATE_FOMO",
  "CHALLENGE_AUDIENCE_OPINION"
] as const;

export const AUTO_CLIP_OBJECTIVE_OPTIONS = buildOptions(AUTO_CLIP_OBJECTIVES, {
  ENGAGEMENT: "Engagement",
  EDUCATION: "Edukasi / insight jelas",
  CONTROVERSY: "Kontroversi",
  STORYTELLING: "Storytelling",
  PRODUCT_AWARENESS: "Awareness produk",
  LEAD_GENERATION: "Lead / prospek",
  RETENTION: "Tahan penonton sampai akhir",
  VIRALITY: "Potensi viral tertinggi",
  BRAND_AWARENESS: "Bangun brand",
  COMMUNITY_DISCUSSION: "Pancing komunitas diskusi",
  THOUGHT_LEADERSHIP: "Bangun otoritas",
  SALES_CONVERSION: "Dorong konversi",
  NEWS_COMMENTARY: "Komentar isu/news",
  AUTHORITY_BUILDING: "Bangun kredibilitas"
});

export const AUTO_CLIP_OBJECTIVE_LABELS: Record<string, string> = Object.fromEntries(
  AUTO_CLIP_OBJECTIVE_OPTIONS.map(({ value, label }) => [value, label])
);

export const AUTO_CLIP_PRIMARY_TONES = [
  "EDUCATIONAL",
  "SERIOUS",
  "DIRECT",
  "CASUAL",
  "CONTROVERSIAL",
  "EMOTIONAL",
  "CONFIDENT",
  "HUMOROUS",
  "CURIOUS",
  "DRAMATIC",
  "CRITICAL",
  "INSPIRATIONAL",
  "EMPATHETIC",
  "URGENT",
  "ANALYTICAL",
  "AUTHORITATIVE",
  "FRIENDLY",
  "CHALLENGING",
  "REFLECTIVE",
  "PRACTICAL",
  "SHARP",
  "WARM",
  "SUSPENSEFUL",
  "PROVOCATIVE",
  "SHOCKING",
  "INFORMATIVE",
  "INSIGHTFUL",
  "MOTIVATIONAL",
  "ENTERTAINING",
  "SARCASTIC",
  "RELATABLE",
  "CONVERSATIONAL",
  "INVESTIGATIVE",
  "STORYTELLING",
  "MYSTERIOUS",
  "SURPRISING",
  "EXCITING",
  "BOLD",
  "THOUGHT_PROVOKING",
  "HEARTWARMING",
  "AUTHENTIC"
] as const;

export const AUTO_CLIP_PRIMARY_TONE_OPTIONS = buildOptions(AUTO_CLIP_PRIMARY_TONES);

export const AUTO_CLIP_SECONDARY_TONES = [
  "SERIOUS",
  "DIRECT",
  "CASUAL",
  "CONTROVERSIAL",
  "EMOTIONAL",
  "CONFIDENT",
  "HUMOROUS",
  "CURIOUS",
  "DRAMATIC",
  "CRITICAL",
  "INSPIRATIONAL",
  "EMPATHETIC",
  "URGENT",
  "ANALYTICAL",
  "AUTHORITATIVE",
  "FRIENDLY",
  "CHALLENGING",
  "REFLECTIVE",
  "PRACTICAL",
  "SHARP",
  "WARM",
  "SUSPENSEFUL",
  "RELATABLE",
  "INFORMATIVE",
  "EDUCATIONAL",
  "MOTIVATIONAL",
  "SKEPTICAL",
  "PROVOCATIVE",
  "SURPRISING",
  "CONVERSATIONAL",
  "PERSONAL",
  "AUTHENTIC",
  "ENERGETIC",
  "THOUGHT_PROVOKING",
  "MYSTERIOUS",
  "EXCITING"
] as const;

export const AUTO_CLIP_SECONDARY_TONE_OPTIONS = buildOptions(AUTO_CLIP_SECONDARY_TONES);
