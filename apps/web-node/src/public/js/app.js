const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? "";

function objectFromForm(form) {
  const data = new FormData(form);
  return Object.fromEntries(
    [...data.entries()]
      .filter(([key]) => key !== "_csrf")
      .map(([key, value]) => {
        if (value === "true") return [key, true];
        if (value === "false") return [key, false];
        return [key, value];
      })
  );
}

function showMessage(container, message, type = "danger") {
  if (!container) return;
  container.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

for (const form of document.querySelectorAll("[data-api-form]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"],button:not([type])');
    const messages = form.closest("main,section")?.querySelector(".form-message") ?? document.querySelector(".form-message");
    if (button) button.disabled = true;
    try {
      const response = await fetch(form.action, {
        method: form.method || "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
          ...(form.dataset.idempotencyKey === "true" ? { "idempotency-key": crypto.randomUUID() } : {})
        },
        body: JSON.stringify(objectFromForm(form))
      });
      const payload = response.status === 204 ? {} : await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "The request failed.");
      const redirect = payload?.data?.redirect;
      if (redirect) window.location.assign(redirect);
      else showMessage(messages, payload?.data?.message ?? "Saved successfully.", "success");
    } catch (error) {
      showMessage(messages, error instanceof Error ? error.message : String(error));
    } finally {
      if (button) button.disabled = false;
    }
  });
}

for (const button of document.querySelectorAll("[data-api-action]")) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await fetch(button.dataset.apiAction, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: "{}"
      });
      const payload = response.status === 204 ? {} : await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "The request failed.");
      window.location.assign(payload?.data?.redirect ?? "/");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      button.disabled = false;
    }
  });
}

const autoClipForm = document.querySelector("#auto-clip-form");
if (autoClipForm) {
  const advancedModeField = autoClipForm.querySelector('[name="advanced_mode"]');
  const sourceModeField = autoClipForm.querySelector('[name="source_mode"]');
  const sourceUrlField = autoClipForm.querySelector('[name="source_url"]');
  const mediaAssetField = autoClipForm.querySelector('[name="media_asset_id"]');
  const presetSelector = autoClipForm.querySelector("[data-auto-clip-preset-selector]");
  const brandKitSelector = autoClipForm.querySelector("[data-auto-clip-brand-kit-selector]");
  const presetNameNode = autoClipForm.querySelector("[data-auto-clip-preset-name]");
  const presetDescriptionNode = autoClipForm.querySelector("[data-auto-clip-preset-description]");
  const presetTagsNode = autoClipForm.querySelector("[data-auto-clip-preset-tags]");
  const brandNameNode = autoClipForm.querySelector("[data-auto-clip-brand-name]");
  const brandDescriptionNode = autoClipForm.querySelector("[data-auto-clip-brand-description]");
  const brandTagsNode = autoClipForm.querySelector("[data-auto-clip-brand-tags]");
  const sourcePanels = autoClipForm.querySelectorAll("[data-source-panel]");
  const advancedFields = autoClipForm.querySelectorAll("[data-advanced-field]");
  const presets = parseAutoClipConfig("auto-clip-presets-json");
  const brandKits = parseAutoClipConfig("auto-clip-brand-kits-json");

  const syncAdvancedMode = () => {
    const enabled = advancedModeField?.checked === true;
    for (const field of advancedFields) {
      field.hidden = !enabled;
    }
  };

  const syncSourceMode = () => {
    const mode = sourceModeField?.value === "MEDIA_ASSET" ? "MEDIA_ASSET" : "EXTERNAL_URL";
    for (const panel of sourcePanels) {
      panel.hidden = panel.getAttribute("data-source-panel") !== mode;
    }
    if (sourceUrlField) sourceUrlField.required = mode === "EXTERNAL_URL";
    if (mediaAssetField) mediaAssetField.required = mode === "MEDIA_ASSET";
  };

  const setFieldValue = (name, value) => {
    if (value === undefined || value === null || value === "") return;
    const field = autoClipForm.querySelector(`[name="${name}"]`);
    if (!field) return;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
      field.value = String(value);
    }
  };

  const renderTagList = (container, tags) => {
    if (!container) return;
    const items = tags.filter(Boolean);
    container.innerHTML = items.length
      ? items.map((item) => `<span>${escapeHtml(String(item))}</span>`).join("")
      : "<span>Default</span>";
  };

  const updatePresetPreview = (preset) => {
    if (presetNameNode) {
      presetNameNode.textContent = preset?.name || "Manual defaults";
    }
    if (presetDescriptionNode) {
      presetDescriptionNode.textContent =
        preset?.description?.trim() ||
        "Gunakan default bawaan untuk mulai cepat, atau pilih preset agar strategi clipping langsung terisi.";
    }
    const config = toObject(preset?.config);
    const durations = toObject(config.durations);
    renderTagList(presetTagsNode, [
      config.target_platform ? `Platform ${config.target_platform}` : "Platform flexible",
      durations.min_seconds && durations.max_seconds
        ? `${durations.min_seconds}-${durations.max_seconds} detik`
        : "Durasi manual",
      config.hook_style ? `Hook ${config.hook_style}` : "Hook auto",
      config.cta_preference ? `CTA ${config.cta_preference}` : ""
    ]);
  };

  const updateBrandKitPreview = (brandKit) => {
    if (brandNameNode) {
      brandNameNode.textContent = brandKit?.name || "No brand kit";
    }
    if (brandDescriptionNode) {
      brandDescriptionNode.textContent = brandKit
        ? "Brand kit ini akan membantu subtitle dan framing tetap konsisten saat clip masuk ke final render pipeline."
        : "Pilih brand kit untuk subtitle style yang konsisten saat render pipeline final sudah aktif.";
    }
    const fontConfig = toObject(brandKit?.fontConfig);
    const safeMarginConfig = toObject(brandKit?.safeMarginConfig);
    const subtitlePreset = toObject(brandKit?.subtitlePreset);
    renderTagList(brandTagsNode, [
      fontConfig.primary ? `Font ${fontConfig.primary}` : "Font default",
      subtitlePreset.position ? `Posisi ${subtitlePreset.position}` : "Position manual",
      subtitlePreset.max_lines ? `${subtitlePreset.max_lines} lines` : "",
      subtitlePreset.safe_margin_percent ?? safeMarginConfig.bottom_percent
        ? `Safe margin ${subtitlePreset.safe_margin_percent ?? safeMarginConfig.bottom_percent}%`
        : "Safe margin default"
    ]);
  };

  const applyPreset = (presetId) => {
    const preset = presets.find((item) => item.id === presetId);
    updatePresetPreview(preset);
    if (!preset || !preset.config || typeof preset.config !== "object") return;
    const config = preset.config;
    const durations = toObject(config.durations);
    const subtitle = toObject(config.subtitle);

    setFieldValue("platform", config.target_platform);
    setFieldValue("objective", config.objective);
    setFieldValue("clip_count", config.desired_clip_count);
    setFieldValue("min_duration", durations.min_seconds);
    setFieldValue("max_duration", durations.max_seconds);
    setFieldValue("minimum_viral_score", config.minimum_viral_score);
    setFieldValue("hook_style", config.hook_style);
    setFieldValue("cta_preference", config.cta_preference);
    setFieldValue("aspect_ratio", config.aspect_ratio);
    setFieldValue("preferred_topics", joinTextList(config.preferred_topics));
    setFieldValue("topics_to_avoid", joinTextList(config.topics_to_avoid));
    setFieldValue("sensitive_topics", joinTextList(config.sensitive_topics));
    setFieldValue("subtitle_language", subtitle.language);
    setFieldValue("subtitle_style", subtitle.style);
    setFieldValue("subtitle_font_family", subtitle.font_family);
  };

  const applyBrandKit = (brandKitId) => {
    const brandKit = brandKits.find((item) => item.id === brandKitId);
    updateBrandKitPreview(brandKit);
    if (!brandKit) return;
    const fontConfig = toObject(brandKit.fontConfig);
    const safeMarginConfig = toObject(brandKit.safeMarginConfig);
    const subtitlePreset = toObject(brandKit.subtitlePreset);

    setFieldValue("subtitle_font_family", fontConfig.primary);
    setFieldValue("subtitle_position", subtitlePreset.position);
    setFieldValue("subtitle_max_lines", subtitlePreset.max_lines);
    setFieldValue("subtitle_safe_margin_percent", subtitlePreset.safe_margin_percent ?? safeMarginConfig.bottom_percent);
  };

  syncAdvancedMode();
  syncSourceMode();
  updatePresetPreview(null);
  updateBrandKitPreview(null);
  if (presetSelector?.value) applyPreset(presetSelector.value);
  if (brandKitSelector?.value) applyBrandKit(brandKitSelector.value);
  advancedModeField?.addEventListener("change", syncAdvancedMode);
  sourceModeField?.addEventListener("change", syncSourceMode);
  presetSelector?.addEventListener("change", () => {
    applyPreset(presetSelector.value);
  });
  brandKitSelector?.addEventListener("change", () => {
    applyBrandKit(brandKitSelector.value);
  });

  autoClipForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(autoClipForm);
    const sourceMode = String(data.get("source_mode") || "EXTERNAL_URL");
    const source =
      sourceMode === "MEDIA_ASSET"
        ? compactObject({
            type: "MEDIA_ASSET",
            media_asset_id: String(data.get("media_asset_id") || "").trim() || undefined
          })
        : compactObject({
            type: "EXTERNAL_URL",
            url: String(data.get("source_url") || "").trim() || undefined
          });
    const tones = [String(data.get("primary_tone") || "EDUCATIONAL"), String(data.get("secondary_tone") || "")]
      .map((value) => value.trim())
      .filter(Boolean);
    const advancedModeEnabled = data.get("advanced_mode") === "on";
    const subtitlePosition = String(data.get("subtitle_position") || "").trim();
    const subtitleStyle = String(data.get("subtitle_style") || "").trim();
    const subtitleFontFamily = String(data.get("subtitle_font_family") || "").trim();
    const payload = {
      source,
      content: compactObject({
        title: String(data.get("title") || "").trim() || undefined,
        context: String(data.get("content_context") || "").trim() || undefined,
        topic: String(data.get("topic") || "").trim() || undefined,
        niche: String(data.get("niche") || "").trim() || undefined,
        target_audience: String(data.get("target_audience") || "").trim() || undefined,
        source_language: String(data.get("source_language") || "").trim() || undefined,
        speaker_count: data.get("speaker_count") ? Number(data.get("speaker_count")) : undefined,
        custom_vocabulary: splitCsv(data.get("custom_vocabulary")),
        rights_confirmed: data.get("rights_confirmed") === "on"
      }),
      strategy: compactObject({
        target_platform: String(data.get("platform")),
        objective: String(data.get("objective")),
        tones,
        desired_clip_count: Number(data.get("clip_count")),
        minimum_duration_seconds: Number(data.get("min_duration")),
        maximum_duration_seconds: Number(data.get("max_duration")),
        minimum_viral_score: Number(data.get("minimum_viral_score") || 7),
        preferred_topics: splitCsv(data.get("preferred_topics")),
        topics_to_avoid: splitCsv(data.get("topics_to_avoid")),
        sensitive_topics: splitCsv(data.get("sensitive_topics")),
        hook_style: String(data.get("hook_style") || "").trim() || undefined,
        cta_preference: String(data.get("cta_preference") || "").trim() || undefined,
        profanity_handling: String(data.get("profanity_handling") || "KEEP"),
        remove_long_silence: data.get("remove_long_silence") === "on",
        remove_filler_words: data.get("remove_filler_words") === "on"
      }),
      visual: {
        aspect_ratio: String(data.get("aspect_ratio")),
        crop_strategy: String(data.get("crop_strategy")),
        settings: {
          mode: data.get("advanced_mode") === "on" ? "ADVANCED" : "QUICK"
        }
      },
        subtitle: {
          enabled: true,
          language: String(data.get("subtitle_language")),
          burn_in: true,
          export_formats: ["SRT", "ASS", "VTT", "JSON"],
          settings: compactObject({
            style: subtitleStyle || undefined,
            font_family: subtitleFontFamily || undefined,
            position: subtitlePosition || undefined,
            max_lines: data.get("subtitle_max_lines") ? Number(data.get("subtitle_max_lines")) : undefined,
            safe_margin_percent: data.get("subtitle_safe_margin_percent")
              ? Number(data.get("subtitle_safe_margin_percent"))
              : undefined,
            word_highlight: advancedModeEnabled ? data.get("subtitle_word_highlight") === "on" : undefined,
            profanity_censor: advancedModeEnabled ? data.get("subtitle_profanity_censor") === "on" : undefined
          })
        },
        ai: { credential_mode: "PLATFORM" }
      };
    const button = autoClipForm.querySelector('button[type="submit"]');
    const messages = document.querySelector(".form-message");
    button.disabled = true;
    try {
      if (payload.content.rights_confirmed !== true) {
        throw new Error("Please confirm you have the rights to process this content.");
      }
      if (sourceMode === "MEDIA_ASSET" && !payload.source.media_asset_id) {
        throw new Error("Choose a ready media asset before creating the job.");
      }
      if (sourceMode === "EXTERNAL_URL" && !payload.source.url) {
        throw new Error("Enter an external source URL before creating the job.");
      }
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch("/api/v1/auto-clipping/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) {
        const fieldDetails = formatValidationDetails(result?.error?.details?.fields);
        throw new Error(fieldDetails ? `${result?.error?.message ?? "Could not create job."}\n${fieldDetails}` : (result?.error?.message ?? "Could not create job."));
      }
      showMessage(messages, `Job ${result.data.id.slice(0,8)} was queued.`, "success");
      setTimeout(() => window.location.assign("/app/jobs"), 800);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showMessage(messages, message.replaceAll("\n", "<br>"));
    } finally {
      button.disabled = false;
    }
  });
}

const jobStreamRoot = document.querySelector("[data-job-stream]");
if (jobStreamRoot) {
  initJobStream(jobStreamRoot);
}

for (const row of document.querySelectorAll("[data-job-stream-row]")) {
  initJobRowStream(row);
}

function initJobStream(root) {
  const jobId = root.getAttribute("data-job-stream");
  if (!jobId || typeof EventSource === "undefined") return;

  const progressBar = root.querySelector("[data-job-progress-bar]");
  const progressValues = root.querySelectorAll("[data-job-progress-value], [data-job-progress-value-inline]");
  const statusNode = root.querySelector("[data-job-status]");
  const stageNode = root.querySelector("[data-job-stage]");
  const eventsContainer = root.querySelector("[data-job-events]");
  const eventsEmpty = root.querySelector("[data-job-events-empty]");
  const stageRows = new Map(
    [...root.querySelectorAll("[data-stage-row]")].map((row) => [row.getAttribute("data-stage-row"), row])
  );

  const stream = new EventSource(`/api/v1/jobs/${jobId}/events/stream`);

  stream.addEventListener("error", () => {
    // Let the browser retry automatically for transient disconnects.
  });

  const updateFromEvent = (eventPayload) => {
    const overallProgress = clampPercentage(eventPayload.overall_progress);
    const stageProgress = clampPercentage(eventPayload.stage_progress);
    const stageName = String(eventPayload.stage || eventPayload.event_type || "Unknown");
    const nextStatus = eventPayload.status ? String(eventPayload.status) : null;

    if (progressBar) progressBar.style.width = `${overallProgress}%`;
    for (const node of progressValues) node.textContent = `${overallProgress}%`;
    if (stageNode) stageNode.textContent = stageName;
    if (statusNode && nextStatus) statusNode.textContent = nextStatus;

    if (stageName) {
      const row = stageRows.get(stageName);
      if (row) {
        const progressNode = row.querySelector("[data-stage-progress]");
        const statusBadge = row.querySelector("[data-stage-status]");
        if (progressNode) progressNode.textContent = `${stageProgress}%`;
        if (statusBadge) {
          const resolvedStageStatus = stageProgress >= 100 ? "COMPLETED" : "RUNNING";
          statusBadge.textContent = resolvedStageStatus;
          statusBadge.className = `status status-${resolvedStageStatus.toLowerCase()}`;
        }
      }
    }

    if (eventsContainer) {
      if (eventsEmpty) eventsEmpty.remove();
      const item = document.createElement("article");
      item.className = "event-item";
      item.innerHTML = `
        <div class="event-line">
          <strong>${escapeHtml(stageName)}</strong>
          <span>${escapeHtml(formatEventTime(eventPayload.occurred_at))}</span>
        </div>
        <p>${escapeHtml(String(eventPayload.user_message || eventPayload.message || ""))}</p>
      `;
      eventsContainer.prepend(item);
      while (eventsContainer.children.length > 25) {
        eventsContainer.removeChild(eventsContainer.lastElementChild);
      }
    }
  };

  const handleStreamMessage = (message) => {
    try {
      updateFromEvent(JSON.parse(message.data));
    } catch (_error) {
      // Ignore malformed event payloads.
    }
  };

  stream.onmessage = handleStreamMessage;
  for (const eventName of ["job.progress", "job.stage", "job.completed", "job.failed", "job.canceled"]) {
    stream.addEventListener(eventName, handleStreamMessage);
  }

  window.addEventListener(
    "beforeunload",
    () => {
      stream.close();
    },
    { once: true }
  );
}

function initJobRowStream(row) {
  const jobId = row.getAttribute("data-job-stream-row");
  if (!jobId || typeof EventSource === "undefined") return;

  const progressBar = row.querySelector("[data-job-row-progress-bar]");
  const progressValue = row.querySelector("[data-job-row-progress-value]");
  const stageNode = row.querySelector("[data-job-row-stage]");
  const statusNode = row.querySelector("[data-job-row-status]");
  const stream = new EventSource(`/api/v1/jobs/${jobId}/events/stream`);

  const handleStreamMessage = (message) => {
    try {
      const payload = JSON.parse(message.data);
      const overallProgress = clampPercentage(payload.overall_progress);
      const stageName = String(payload.stage || payload.event_type || "-");
      const nextStatus = payload.status ? String(payload.status) : null;

      if (progressBar) progressBar.style.width = `${overallProgress}%`;
      if (progressValue) progressValue.textContent = `${overallProgress}%`;
      if (stageNode) stageNode.textContent = stageName;
      if (statusNode && nextStatus) {
        statusNode.textContent = nextStatus;
        statusNode.className = `status status-${nextStatus.toLowerCase()}`;
      }
    } catch (_error) {
      // Ignore malformed payloads.
    }
  };

  stream.onmessage = handleStreamMessage;
  for (const eventName of ["job.progress", "job.stage", "job.completed", "job.failed", "job.canceled"]) {
    stream.addEventListener(eventName, handleStreamMessage);
  }

  stream.addEventListener("error", () => {
    // Browser retry is sufficient here.
  });

  window.addEventListener(
    "beforeunload",
    () => {
      stream.close();
    },
    { once: true }
  );
}

function clampPercentage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function formatEventTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "Now";
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseAutoClipConfig(id) {
  const node = document.getElementById(id);
  if (!node?.textContent) return [];
  try {
    const parsed = JSON.parse(node.textContent);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function toObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "")
  );
}

function formatValidationDetails(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return "";
  return fields
    .map((field) => {
      if (!field || typeof field !== "object") return null;
      const path = typeof field.path === "string" && field.path.trim() ? field.path.trim() : "field";
      const message = typeof field.message === "string" && field.message.trim() ? field.message.trim() : "Invalid value";
      return `- ${path}: ${message}`;
    })
    .filter(Boolean)
    .join("\n");
}

function joinTextList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => typeof item === "string" && item.trim().length > 0).join(", ");
}
