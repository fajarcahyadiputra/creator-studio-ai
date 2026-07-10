const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? "";
const stageDisplayMap = {
  VALIDATING_SCRIPT: { key: "TTS_VALIDATION", label: "Script validation" },
  GENERATING_SEGMENTS: { key: "TTS_SEGMENTATION", label: "Speech segmentation" },
  SAVING_OUTPUTS: { key: "DELIVERY", label: "Saving outputs" },
  VALIDATING_SOURCE: { key: "SOURCE_PREP", label: "Source preparation" },
  PROBING_MEDIA: { key: "SOURCE_PREP", label: "Source preparation" },
  EXTRACTING_AUDIO: { key: "AUDIO_TRANSCRIPT", label: "Audio and transcript" },
  TRANSCRIBING: { key: "AUDIO_TRANSCRIPT", label: "Audio and transcript" },
  DETECTING_SCENES: { key: "CANDIDATE_ANALYSIS", label: "Candidate analysis" },
  DETECTING_SILENCE: { key: "CANDIDATE_ANALYSIS", label: "Candidate analysis" },
  ANALYZING_CLIP_CANDIDATES: { key: "CANDIDATE_ANALYSIS", label: "Candidate analysis" },
  NORMALIZING_BOUNDARIES: { key: "CANDIDATE_ANALYSIS", label: "Candidate analysis" },
  RANKING_AND_DEDUPLICATING: { key: "CANDIDATE_ANALYSIS", label: "Candidate analysis" },
  GENERATING_PREVIEWS: { key: "RESULT_PREP", label: "Result packaging" },
  GENERATING_METADATA: { key: "RESULT_PREP", label: "Result packaging" },
  REFRAMING: { key: "FINAL_RENDER", label: "Final render" },
  GENERATING_SUBTITLES: { key: "FINAL_RENDER", label: "Final render" },
  RENDERING_FINAL_CLIPS: { key: "FINAL_RENDER", label: "Final render" },
  QUALITY_CHECK: { key: "FINAL_REVIEW", label: "Output validation" },
  UPLOADING_OUTPUTS: { key: "DELIVERY", label: "Saving outputs" }
};

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
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateShortTextList(list, options) {
  const values = Array.isArray(list) ? list : [];
  const {
    fieldPath,
    fieldLabel,
    maxItems,
    maxChars
  } = options;

  const errors = [];
  if (typeof maxItems === "number" && values.length > maxItems) {
    errors.push(`${fieldPath} maksimal ${maxItems} item. Ringkas atau hapus beberapa item di ${fieldLabel}.`);
  }

  values.forEach((value, index) => {
    if (typeof value !== "string") return;
    if (typeof maxChars === "number" && value.length > maxChars) {
      errors.push(`${fieldPath}.${index + 1} terlalu panjang (${value.length}/${maxChars} karakter). Pisahkan menjadi topik pendek di ${fieldLabel}.`);
    }
  });

  return errors;
}

for (const picker of document.querySelectorAll("[data-append-to-field]")) {
  picker.addEventListener("change", () => {
    if (!(picker instanceof HTMLSelectElement)) return;

    const targetName = picker.getAttribute("data-append-to-field");
    const selectedValue = String(picker.value || "").trim();
    if (!targetName || !selectedValue) return;

    const target = document.querySelector(`[name="${targetName}"]`);
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      picker.value = "";
      return;
    }

    const currentItems = String(target.value || "")
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (!currentItems.includes(selectedValue)) {
      currentItems.push(selectedValue);
      target.value = currentItems.join(", ");
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }

    picker.value = "";
  });
}

for (const picker of document.querySelectorAll("[data-json-template-picker]")) {
  picker.addEventListener("change", () => {
    if (!(picker instanceof HTMLSelectElement)) return;

    const sourceId = picker.getAttribute("data-json-template-picker");
    if (!sourceId) return;

    const sourceNode = document.getElementById(sourceId);
    if (!sourceNode?.textContent) return;

    let templates = [];
    try {
      const parsed = JSON.parse(sourceNode.textContent);
      templates = Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return;
    }

    const selectedIndex = Number.parseInt(String(picker.value || ""), 10);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= templates.length) {
      return;
    }

    const template = templates[selectedIndex];
    if (!template || typeof template !== "object") return;

    const applyValue = (attributeName, templateKey, transform) => {
      const fieldName = picker.getAttribute(attributeName);
      if (!fieldName) return;
      const field = document.querySelector(`[name="${fieldName}"]`);
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) {
        return;
      }
      const rawValue = template[templateKey];
      if (rawValue === undefined) return;
      field.value = typeof transform === "function" ? transform(rawValue) : String(rawValue);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };

    applyValue("data-template-key-field", "key");
    applyValue("data-template-description-field", "description");
    applyValue("data-template-json-field", "json", (value) => JSON.stringify(value ?? {}, null, 2));
    applyValue("data-template-enabled-field", "enabled", (value) => String(Boolean(value)));
    applyValue("data-template-secret-field", "isSecret", (value) => String(Boolean(value)));
  });
}

for (const form of document.querySelectorAll("[data-api-form]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
      return;
    }
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

const settingsProfileForm = document.querySelector('form[data-api-form][action="/api/v1/settings/profile"]');
if (settingsProfileForm) {
  const logoInput = settingsProfileForm.querySelector("[data-settings-logo-input]");
  const logoObjectKeyField = settingsProfileForm.querySelector("[data-settings-logo-object-key]");
  const logoPreviewWrap = settingsProfileForm.querySelector("[data-settings-logo-preview-wrap]");
  const logoPreview = settingsProfileForm.querySelector("[data-settings-logo-preview]");
  const logoEmpty = settingsProfileForm.querySelector("[data-settings-logo-empty]");
  const logoStatus = settingsProfileForm.querySelector("[data-settings-logo-status]");
  const messages = settingsProfileForm.closest("main,section")?.querySelector(".form-message") ?? document.querySelector(".form-message");

  const setLogoStatus = (message, type = "muted") => {
    if (!logoStatus) return;
    logoStatus.className = `small text-${type} mt-2`;
    logoStatus.textContent = message;
  };

  const ensureLogoPreview = (src) => {
    if (!(logoPreviewWrap instanceof HTMLElement) || !src) return;

    if (logoEmpty instanceof HTMLElement) {
      logoEmpty.remove();
    }

    let imageNode = logoPreview;
    if (!(imageNode instanceof HTMLImageElement)) {
      imageNode = document.createElement("img");
      imageNode.setAttribute("data-settings-logo-preview", "");
      imageNode.alt = "Channel logo preview";
      imageNode.style.maxWidth = "100%";
      imageNode.style.maxHeight = "120px";
      imageNode.style.objectFit = "contain";
      logoPreviewWrap.innerHTML = "";
      logoPreviewWrap.appendChild(imageNode);
    }

    imageNode.src = src;
  };

  if (logoInput instanceof HTMLInputElement) {
    logoInput.addEventListener("change", async () => {
      const file = logoInput.files?.[0];
      if (!file) return;

      const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
      if (!allowedTypes.includes(file.type)) {
        showMessage(messages, "Gunakan file logo PNG, JPG, WEBP, atau SVG.");
        logoInput.value = "";
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        showMessage(messages, "Ukuran logo maksimal 5 MB.");
        logoInput.value = "";
        return;
      }

      logoInput.disabled = true;
      setLogoStatus("Mengupload logo ke storage...", "warning");

      try {
        const createUploadResponse = await fetch("/api/v1/settings/profile/logo-upload", {
          method: "POST",
          headers: {
            "content-type": file.type,
            "x-csrf-token": csrf,
            "x-file-name": encodeURIComponent(file.name)
          },
          body: file
        });
        const createUploadPayload = await createUploadResponse.json();
        if (!createUploadResponse.ok) {
          throw new Error(createUploadPayload?.error?.message ?? "Gagal menyiapkan upload logo.");
        }

        const upload = createUploadPayload?.data ?? {};
        if (logoObjectKeyField instanceof HTMLInputElement) {
          logoObjectKeyField.value = String(upload.object_key || "");
        }
        ensureLogoPreview(URL.createObjectURL(file));
        setLogoStatus("Logo baru sudah terupload. Klik Save profile untuk menyimpan ke akun.", "success");
        showMessage(messages, "Logo berhasil diupload. Simpan profile untuk memakai logo ini.", "success");
      } catch (error) {
        setLogoStatus("Upload logo gagal. Coba lagi.", "danger");
        showMessage(messages, error instanceof Error ? error.message : String(error));
      } finally {
        logoInput.disabled = false;
      }
    });
  }
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
  const submitSummarySource = autoClipForm.querySelector("[data-submit-summary-source]");
  const submitSummarySourceDetail = autoClipForm.querySelector("[data-submit-summary-source-detail]");
  const submitSummaryStrategy = autoClipForm.querySelector("[data-submit-summary-strategy]");
  const submitSummaryDuration = autoClipForm.querySelector("[data-submit-summary-duration]");
  const submitSummarySubtitle = autoClipForm.querySelector("[data-submit-summary-subtitle]");
  const submitSummaryVisual = autoClipForm.querySelector("[data-submit-summary-visual]");
  const submitSummaryMode = autoClipForm.querySelector("[data-submit-summary-mode]");
  const submitSummaryRights = autoClipForm.querySelector("[data-submit-summary-rights]");
  const sourceUrlHelper = autoClipForm.querySelector("[data-source-url-helper]");
  const precheckList = autoClipForm.querySelector("[data-auto-clip-precheck-list]");
  const layoutPanels = autoClipForm.querySelectorAll("[data-layout-panel]");
  const listHelpers = new Map(
    [...autoClipForm.querySelectorAll("[data-list-helper]")].map((node) => [node.getAttribute("data-list-helper"), node])
  );
  const sourcePanels = autoClipForm.querySelectorAll("[data-source-panel]");
  const advancedFields = autoClipForm.querySelectorAll("[data-advanced-field]");
  const presets = parseAutoClipConfig("auto-clip-presets-json");
  const brandKits = parseAutoClipConfig("auto-clip-brand-kits-json");
  const fieldErrorNodes = new Map();

  const fieldElements = {
    source_url: sourceUrlField,
    media_asset_id: mediaAssetField,
    rights_confirmed: autoClipForm.querySelector('[name="rights_confirmed"]'),
    candidate_pool_count: autoClipForm.querySelector('[name="candidate_pool_count"]'),
    clip_count: autoClipForm.querySelector('[name="clip_count"]'),
    min_duration: autoClipForm.querySelector('[name="min_duration"]'),
    max_duration: autoClipForm.querySelector('[name="max_duration"]'),
    preferred_topics: autoClipForm.querySelector('[name="preferred_topics"]'),
    topics_to_avoid: autoClipForm.querySelector('[name="topics_to_avoid"]')
  };

  const ensureFieldErrorNode = (fieldName) => {
    const existing = fieldErrorNodes.get(fieldName);
    if (existing) return existing;

    const field = fieldElements[fieldName];
    if (!field?.parentElement) return null;

    const node = document.createElement("div");
    node.className = "invalid-feedback d-block";
    node.hidden = true;
    field.parentElement.appendChild(node);
    fieldErrorNodes.set(fieldName, node);
    return node;
  };

  const clearFieldErrors = () => {
    Object.values(fieldElements).forEach((field) => {
      if (!field) return;
      field.classList.remove("is-invalid");
    });
    for (const node of fieldErrorNodes.values()) {
      node.hidden = true;
      node.textContent = "";
    }
  };

  const setFieldError = (fieldName, message) => {
    const field = fieldElements[fieldName];
    if (!field) return;
    field.classList.add("is-invalid");
    const node = ensureFieldErrorNode(fieldName);
    if (!node) return;
    node.hidden = false;
    node.textContent = message;
  };

  const applyAutoClipFieldErrors = (issues) => {
    clearFieldErrors();
    if (!Array.isArray(issues)) return;

    issues.forEach((issue) => {
      const text = String(issue || "");
      if (!text) return;

      if (text.includes("media asset")) {
        setFieldError("media_asset_id", text);
      } else if (text.includes("external source URL") || text.includes("source.url")) {
        setFieldError("source_url", text);
      } else if (text.includes("rights confirmation") || text.includes("rights")) {
        setFieldError("rights_confirmed", text);
      } else if (text.includes("candidate_pool_count") || text.includes("Candidate pool count")) {
        setFieldError("candidate_pool_count", text);
        setFieldError("clip_count", text);
      } else if (text.includes("minimum duration") || text.includes("minimum_duration_seconds") || text.includes("min_duration")) {
        setFieldError("min_duration", text);
      } else if (text.includes("maximum duration") || text.includes("maximum_duration_seconds") || text.includes("max_duration")) {
        setFieldError("max_duration", text);
      } else if (text.includes("preferred_topics") || text.includes("preferred topic")) {
        setFieldError("preferred_topics", text);
      } else if (text.includes("topics_to_avoid") || text.includes("topics to avoid")) {
        setFieldError("topics_to_avoid", text);
      }
    });
  };

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
    syncSubmitSummary();
  };

  const syncLayoutMode = () => {
    const aspectRatio = String(autoClipForm.querySelector('[name="aspect_ratio"]')?.value || "9:16").trim();
    for (const panel of layoutPanels) {
      panel.hidden = panel.getAttribute("data-layout-panel") !== aspectRatio;
    }
    const layoutField = autoClipForm.querySelector('[name="layout_template"]');
    if (layoutField instanceof HTMLSelectElement && aspectRatio !== "9:16") {
      layoutField.value = "STANDARD";
    }
    syncSubmitSummary();
  };

  const setFieldValue = (name, value) => {
    if (value === undefined || value === null || value === "") return;
    const field = autoClipForm.querySelector(`[name="${name}"]`);
    if (!field) return;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
      field.value = String(value);
    }
  };

  const setCheckboxValue = (name, checked) => {
    if (typeof checked !== "boolean") return;
    const field = autoClipForm.querySelector(`[name="${name}"]`);
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      field.checked = checked;
    }
  };

  const renderTagList = (container, tags) => {
    if (!container) return;
    const items = tags.filter(Boolean);
    container.innerHTML = items.length
      ? items.map((item) => `<span>${escapeHtml(String(item))}</span>`).join("")
      : "<span>Default</span>";
  };

  const renderListHelper = (fieldName, items, maxItems, maxChars) => {
    const helper = listHelpers.get(fieldName);
    if (!helper) return;
    const values = Array.isArray(items) ? items : [];
    const tooLongCount = values.filter((value) => typeof value === "string" && value.length > maxChars).length;
    helper.textContent = `${values.length}/${maxItems} item` + (tooLongCount ? ` | ${tooLongCount} item terlalu panjang` : "");
  };

  const syncSubmitSummary = () => {
    const sourceMode = sourceModeField?.value === "MEDIA_ASSET" ? "MEDIA_ASSET" : "EXTERNAL_URL";
    const selectedAssetLabel = mediaAssetField?.selectedOptions?.[0]?.textContent?.trim() || "Belum ada media asset dipilih.";
    const sourceUrlValue = String(sourceUrlField?.value || "").trim();
    const platform = String(autoClipForm.querySelector('[name="platform"]')?.value || "YOUTUBE_SHORTS").trim();
    const objective = String(autoClipForm.querySelector('[name="objective"]')?.value || "EDUCATION").trim();
    const minDuration = String(autoClipForm.querySelector('[name="min_duration"]')?.value || "").trim();
    const maxDuration = String(autoClipForm.querySelector('[name="max_duration"]')?.value || "").trim();
    const clipCount = String(autoClipForm.querySelector('[name="clip_count"]')?.value || "").trim();
    const candidatePoolCount = String(autoClipForm.querySelector('[name="candidate_pool_count"]')?.value || "").trim();
    const subtitleLanguage = String(autoClipForm.querySelector('[name="subtitle_language"]')?.value || "id").trim();
    const subtitleFormat = String(autoClipForm.querySelector('[name="subtitle_primary_format"]')?.value || "ASS").trim();
    const aspectRatio = String(autoClipForm.querySelector('[name="aspect_ratio"]')?.value || "9:16").trim();
    const cropStrategy = String(autoClipForm.querySelector('[name="crop_strategy"]')?.value || "AUTO_REFRAME").trim();
    const layoutTemplate = String(autoClipForm.querySelector('[name="layout_template"]')?.value || "STANDARD").trim();
    const rightsConfirmed = autoClipForm.querySelector('[name="rights_confirmed"]')?.checked === true;
    const advancedMode = advancedModeField?.checked === true;
    const preferredTopics = splitCsv(autoClipForm.querySelector('[name="preferred_topics"]')?.value || "");
    const topicsToAvoid = splitCsv(autoClipForm.querySelector('[name="topics_to_avoid"]')?.value || "");
    const issues = [];

    if (submitSummarySource) {
      submitSummarySource.textContent = sourceMode === "MEDIA_ASSET" ? "Uploaded media asset" : "External URL";
    }
    if (submitSummarySourceDetail) {
      submitSummarySourceDetail.textContent = sourceMode === "MEDIA_ASSET"
        ? selectedAssetLabel
        : (sourceUrlValue || "Belum ada external URL diisi.");
    }
    if (submitSummaryStrategy) {
      submitSummaryStrategy.textContent = `${platform} | ${objective}`;
    }
    if (submitSummaryDuration) {
      submitSummaryDuration.textContent = `${minDuration || "-"}-${maxDuration || "-"} detik | ${clipCount || "-"} clip | pool ${candidatePoolCount || "-"}`;
    }
    if (submitSummarySubtitle) {
      submitSummarySubtitle.textContent = `${subtitleLanguage || "-"} | ${subtitleFormat || "-"}`;
    }
    if (submitSummaryVisual) {
      submitSummaryVisual.textContent = `${aspectRatio || "-"} | ${cropStrategy || "-"} | ${layoutTemplate || "STANDARD"}`;
    }
    if (submitSummaryMode) {
      submitSummaryMode.textContent = advancedMode ? "Advanced Mode" : "Quick Mode";
    }
    if (submitSummaryRights) {
      submitSummaryRights.textContent = rightsConfirmed
        ? "Rights confirmation sudah aman."
        : "Rights confirmation belum dicentang.";
    }

    if (sourceUrlHelper) {
      if (sourceMode === "EXTERNAL_URL" && sourceUrlValue.includes("youtu.be/")) {
        sourceUrlHelper.innerHTML = 'Short URL terdeteksi. Jika ingestion gagal, ganti ke format penuh <code>youtube.com/watch?v=...</code>.';
      } else if (sourceMode === "EXTERNAL_URL" && !sourceUrlValue) {
        sourceUrlHelper.textContent = "Gunakan URL publik yang benar-benar bisa diakses worker ingestion.";
      } else if (sourceMode === "EXTERNAL_URL") {
        sourceUrlHelper.textContent = "URL siap divalidasi oleh ingestion service.";
      } else {
        sourceUrlHelper.textContent = "Mode media asset aktif, URL eksternal tidak dipakai.";
      }
    }

    renderListHelper("preferred_topics", preferredTopics, 20, 120);
    renderListHelper("topics_to_avoid", topicsToAvoid, 20, 120);

    if (sourceMode === "MEDIA_ASSET" && !String(mediaAssetField?.value || "").trim()) {
      issues.push("Pilih media asset sebelum submit.");
    }
    if (sourceMode === "EXTERNAL_URL" && !sourceUrlValue) {
      issues.push("Isi external source URL sebelum submit.");
    }
    if (sourceMode === "EXTERNAL_URL" && sourceUrlValue.includes("youtu.be/")) {
      issues.push("Pertimbangkan pakai URL penuh youtube.com/watch agar ingestion lebih stabil.");
    }
    if (!rightsConfirmed) {
      issues.push("Centang rights confirmation.");
    }
    if (Number(candidatePoolCount || 0) < Number(clipCount || 0)) {
      issues.push("Candidate pool count harus >= number of clips.");
    }
    if (Number(maxDuration || 0) < Number(minDuration || 0)) {
      issues.push("Maximum duration harus >= minimum duration.");
    }
    if (preferredTopics.some((item) => item.length > 120)) {
      issues.push("Ada preferred topic yang terlalu panjang. Pecah jadi topik singkat.");
    }
    if (topicsToAvoid.some((item) => item.length > 120)) {
      issues.push("Ada topics to avoid yang terlalu panjang. Pecah jadi topik singkat.");
    }

    if (precheckList) {
      precheckList.innerHTML = (issues.length ? issues : ["Semua guardrail utama terlihat aman untuk disubmit."])
        .map((item) => `<li>${escapeHtml(String(item))}</li>`)
        .join("");
    }

    applyAutoClipFieldErrors(issues);
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
    setFieldValue("candidate_pool_count", config.candidate_pool_count);
    setFieldValue("min_duration", durations.min_seconds);
    setFieldValue("max_duration", durations.max_seconds);
    setFieldValue("minimum_viral_score", config.minimum_viral_score);
    setFieldValue("hook_style", config.hook_style);
    setFieldValue("cta_preference", config.cta_preference);
    setFieldValue("standalone_priority", config.standalone_priority);
    setFieldValue("aspect_ratio", config.aspect_ratio);
    setFieldValue("layout_template", config.layout_template || config.layoutTemplate);
    setFieldValue("preferred_topics", joinTextList(config.preferred_topics));
    setFieldValue("topics_to_avoid", joinTextList(config.topics_to_avoid));
    setFieldValue("clip_style_tags", joinTextList(config.clip_style_tags));
    setFieldValue("virality_priorities", joinTextList(config.virality_priorities));
    setFieldValue("selection_brief", config.selection_brief || config.clip_selection_brief);
    setFieldValue("avoidance_brief", config.avoidance_brief || config.clip_avoidance_brief);
    setFieldValue("packaging_brief", config.packaging_brief || config.packaging_brief_long);
    setFieldValue("content_context", config.content_context || config.analysis_brief || config.editor_brief);
    setFieldValue("sensitive_topics", joinTextList(config.sensitive_topics));
    setCheckboxValue("require_spoken_audio", config.require_spoken_audio);
    setFieldValue("subtitle_language", subtitle.language);
    setFieldValue("subtitle_primary_format", subtitle.format);
    setCheckboxValue("subtitle_burn_in", subtitle.burn_in);
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
  syncLayoutMode();
  syncSubmitSummary();
  updatePresetPreview(null);
  updateBrandKitPreview(null);
  if (presetSelector?.value) applyPreset(presetSelector.value);
  if (brandKitSelector?.value) applyBrandKit(brandKitSelector.value);
  advancedModeField?.addEventListener("change", syncAdvancedMode);
  advancedModeField?.addEventListener("change", syncSubmitSummary);
  sourceModeField?.addEventListener("change", syncSourceMode);
  autoClipForm.querySelector('[name="aspect_ratio"]')?.addEventListener("change", syncLayoutMode);
  presetSelector?.addEventListener("change", () => {
    applyPreset(presetSelector.value);
    syncLayoutMode();
    syncSubmitSummary();
  });
  brandKitSelector?.addEventListener("change", () => {
    applyBrandKit(brandKitSelector.value);
    syncSubmitSummary();
  });
  for (const field of autoClipForm.querySelectorAll("input, select, textarea")) {
    field.addEventListener("input", syncSubmitSummary);
    field.addEventListener("change", syncSubmitSummary);
  }

  autoClipForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFieldErrors();
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
    const subtitlePrimaryFormat = String(data.get("subtitle_primary_format") || "ASS").trim().toUpperCase();
    const subtitleBurnIn = data.get("subtitle_burn_in") === "on";
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
        candidate_pool_count: Number(data.get("candidate_pool_count")),
        minimum_duration_seconds: Number(data.get("min_duration")),
        maximum_duration_seconds: Number(data.get("max_duration")),
        minimum_viral_score: Number(data.get("minimum_viral_score") || 7),
        preferred_topics: splitCsv(data.get("preferred_topics")),
        topics_to_avoid: splitCsv(data.get("topics_to_avoid")),
        sensitive_topics: splitCsv(data.get("sensitive_topics")),
        clip_style_tags: splitCsv(data.get("clip_style_tags")),
        virality_priorities: splitCsv(data.get("virality_priorities")),
        selection_brief: String(data.get("selection_brief") || "").trim() || undefined,
        avoidance_brief: String(data.get("avoidance_brief") || "").trim() || undefined,
        packaging_brief: String(data.get("packaging_brief") || "").trim() || undefined,
        hook_style: String(data.get("hook_style") || "").trim() || undefined,
        cta_preference: String(data.get("cta_preference") || "").trim() || undefined,
        standalone_priority: String(data.get("standalone_priority") || "PREFERRED").trim(),
        require_spoken_audio: data.get("require_spoken_audio") === "on",
        profanity_handling: String(data.get("profanity_handling") || "KEEP"),
        remove_long_silence: data.get("remove_long_silence") === "on",
        remove_filler_words: data.get("remove_filler_words") === "on"
      }),
      visual: {
        aspect_ratio: String(data.get("aspect_ratio")),
        crop_strategy: String(data.get("crop_strategy")),
        settings: {
          mode: data.get("advanced_mode") === "on" ? "ADVANCED" : "QUICK",
          layout_template: String(data.get("layout_template") || "STANDARD").trim() || "STANDARD",
          brand_kit_id: String(data.get("brand_kit_id") || "").trim() || undefined
        }
      },
        subtitle: {
          enabled: true,
          language: String(data.get("subtitle_language")),
          burn_in: subtitleBurnIn,
          format: subtitlePrimaryFormat,
          export_formats: [subtitlePrimaryFormat, "SRT", "ASS", "VTT", "JSON"].filter(
            (value, index, items) => items.indexOf(value) === index
          ),
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
      const clientValidationErrors = validateAutoClipPayload(payload);
      if (clientValidationErrors.length > 0) {
        applyAutoClipFieldErrors(clientValidationErrors);
        throw new Error(clientValidationErrors.map((message) => `- ${message}`).join("\n"));
      }
      if (payload.content.rights_confirmed !== true) {
        applyAutoClipFieldErrors(["Centang rights confirmation."]);
        throw new Error("Please confirm you have the rights to process this content.");
      }
      if (sourceMode === "MEDIA_ASSET" && !payload.source.media_asset_id) {
        applyAutoClipFieldErrors(["Pilih media asset sebelum submit."]);
        throw new Error("Choose a ready media asset before creating the job.");
      }
      if (sourceMode === "EXTERNAL_URL" && !payload.source.url) {
        applyAutoClipFieldErrors(["Isi external source URL sebelum submit."]);
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
        applyAutoClipFieldErrors(
          Array.isArray(result?.error?.details?.fields)
            ? result.error.details.fields.map((field) => `${field?.path ?? "field"}: ${field?.message ?? "Invalid value"}`)
            : []
        );
        console.error("auto-clipping validation failed", {
          payload,
          error: result?.error,
          fieldDetails: result?.error?.details?.fields ?? []
        });
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

const ttsForm = document.querySelector("#tts-form");
if (ttsForm) {
  const presetSelector = ttsForm.querySelector("[data-tts-preset-selector]");
  const presets = parseAutoClipConfig("tts-presets-json");
  const localModels = parseAutoClipConfig("tts-local-models-json");
  const localModelSelector = ttsForm.querySelector("[data-tts-local-model-selector]");
  const previewTextField = ttsForm.querySelector("[data-tts-preview-text]");
  const previewButton = ttsForm.querySelector("[data-tts-preview-button]");
  const previewAudio = ttsForm.querySelector("[data-tts-preview-audio]");
  const previewStatus = ttsForm.querySelector("[data-tts-preview-status]");
  const modelBadges = ttsForm.querySelector("[data-tts-model-badges]");
  var previewObjectUrl = null;

  const renderLocalModelPreview = () => {
    const selectedModel = localModels.find((model) => model?.key === localModelSelector?.value);
    if (modelBadges) {
      const badges = selectedModel
        ? [
            selectedModel.languageCode,
            selectedModel.voiceName,
            selectedModel.quality ? `${selectedModel.quality} quality` : null,
            selectedModel.sampleRate ? `${selectedModel.sampleRate} Hz` : null
          ].filter(Boolean)
        : ["Belum ada model dipilih"];
      modelBadges.innerHTML = badges.map((badge) => `<span>${escapeHtml(String(badge))}</span>`).join("");
    }

    if (selectedModel && previewTextField && !String(previewTextField.value || "").trim()) {
      previewTextField.value = selectedModel.defaultSampleText || "";
    }
  };

  const applyPreset = () => {
    const selectedPreset = presets.find((preset) => preset?.id === presetSelector?.value);
    const config = toObject(selectedPreset?.config);
    setIfPresent(ttsForm, "language", config.language);
    setIfPresent(ttsForm, "local_model_key", config.local_model_key || config.voice_identifier);
    setIfPresent(ttsForm, "voice_identifier", config.voice_identifier);
    setIfPresent(ttsForm, "speaking_style", config.speaking_style);
    setIfPresent(ttsForm, "emotion", config.emotion);
    setIfPresent(ttsForm, "speaking_speed", config.speaking_speed);
    setIfPresent(ttsForm, "pitch", config.pitch);
    setIfPresent(ttsForm, "pause_intensity", config.pause_intensity);
    setIfPresent(ttsForm, "target_duration_ms", config.target_duration_ms);
    setIfPresent(ttsForm, "preferred_format", config.preferred_format);
    setIfPresent(ttsForm, "segmentation_mode", config.segmentation_mode);
    setIfPresent(ttsForm, "sample_rate", config.sample_rate);
    setIfPresent(ttsForm, "channels", config.channels);
    setIfPresent(ttsForm, "tone_notes", config.tone_notes);
    setIfPresent(ttsForm, "delivery_goal", config.delivery_goal);
    setIfPresent(ttsForm, "segment_length_preference", config.segment_length_preference);
    setIfPresent(ttsForm, "breathing_style", config.breathing_style);
    setIfPresent(ttsForm, "sample_preview_text", config.sample_preview_text);
    renderLocalModelPreview();
  };

  presetSelector?.addEventListener("change", applyPreset);
  localModelSelector?.addEventListener("change", () => {
    const selectedModel = localModels.find((model) => model?.key === localModelSelector?.value);
    if (selectedModel) {
      const languageField = ttsForm.querySelector('[name="language"]');
      if (languageField && !String(languageField.value || "").trim()) {
        languageField.value = String(selectedModel.languageCode || "");
      }
      if (previewTextField && selectedModel.defaultSampleText) {
        previewTextField.value = selectedModel.defaultSampleText;
      }
    }
    renderLocalModelPreview();
  });

  previewButton?.addEventListener("click", async () => {
    const modelKey = String(localModelSelector?.value || "").trim();
    const sampleText = String(previewTextField?.value || "").trim();
    if (!modelKey) {
      showMessage(document.querySelector(".form-message"), "Pilih local Piper model dulu.");
      return;
    }
    if (!sampleText) {
      showMessage(document.querySelector(".form-message"), "Isi sample preview text dulu.");
      return;
    }

    previewButton.disabled = true;
    if (previewStatus) previewStatus.textContent = "Generating preview voice...";

    try {
      const response = await fetch("/api/v1/tts/local-model-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf
        },
        body: JSON.stringify({
          model_key: modelKey,
          text: sampleText
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? "Preview suara model lokal gagal dibuat.");
      }

      const blob = await response.blob();
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
      }
      previewObjectUrl = URL.createObjectURL(blob);
      if (previewAudio) {
        previewAudio.src = previewObjectUrl;
        previewAudio.load();
        await previewAudio.play().catch(() => undefined);
      }
      if (previewStatus) previewStatus.textContent = "Preview siap diputar.";
    } catch (error) {
      if (previewStatus) previewStatus.textContent = "Preview gagal dibuat.";
      showMessage(
        document.querySelector(".form-message"),
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      previewButton.disabled = false;
    }
  });

  renderLocalModelPreview();

  ttsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = ttsForm.querySelector('button[type="submit"]');
    const messages = ttsForm.closest("main,section")?.querySelector(".form-message") ?? document.querySelector(".form-message");
    if (button) button.disabled = true;

    try {
      const payload = buildTtsPayload(ttsForm);
      const validationErrors = validateTtsPayload(payload);
      if (validationErrors.length) {
        throw new Error(validationErrors.join("\n"));
      }

      const response = await fetch("/api/v1/tts/jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "idempotency-key": crypto.randomUUID()
        },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(formatValidationDetails(result?.error?.details?.fields) || (result?.error?.message ?? "Could not create TTS job."));
      }

      showMessage(messages, `TTS job ${result.data.id.slice(0, 8)} was queued.`, "success");
      setTimeout(() => window.location.assign(`/app/jobs/${result.data.id}`), 800);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showMessage(messages, message.replaceAll("\n", "<br>"));
    } finally {
      if (button) button.disabled = false;
    }
  });
}

const jobStreamRoot = document.querySelector("[data-job-stream]");
if (jobStreamRoot) {
  initJobStream(jobStreamRoot);
}

initClipPreviewPlayers();

for (const row of document.querySelectorAll("[data-job-stream-row]")) {
  initJobRowStream(row);
}

function initJobStream(root) {
  const jobId = root.getAttribute("data-job-stream");
  if (!jobId || typeof EventSource === "undefined") return;
  const jobType = String(root.getAttribute("data-job-type") || "").trim();

  const progressBar = root.querySelector("[data-job-progress-bar]");
  const progressValues = root.querySelectorAll("[data-job-progress-value], [data-job-progress-value-inline]");
  const statusNode = root.querySelector("[data-job-status]");
  const stageNode = root.querySelector("[data-job-stage]");
  const eventsContainer = root.querySelector("[data-job-events]");
  const eventsEmpty = root.querySelector("[data-job-events-empty]");
  const issuePanel = root.querySelector("[data-job-issue-panel]");
  const stageRows = new Map(
    [...root.querySelectorAll("[data-stage-row]")].map((row) => [row.getAttribute("data-stage-row"), row])
  );
  const clipOutputsSection = [...root.querySelectorAll(".empty-cell")].find((node) =>
    String(node.textContent || "").includes("No rendered clip outputs have been stored yet.")
  );
  const featuredOutputCard = root.querySelector("[data-featured-clip-output]");
  const featuredOutputSummary = root.querySelector("[data-featured-output-summary]");
  let completionRefreshTriggered = false;

  normalizeJobProgressView({ progressBar, progressValues, statusNode, stageNode });
  focusFeaturedOutputIfReady(statusNode?.textContent, featuredOutputCard, featuredOutputSummary);

  const stream = new EventSource(`/api/v1/jobs/${jobId}/events/stream`);

  stream.addEventListener("error", () => {
    // Let the browser retry automatically for transient disconnects.
  });

  const updateFromEvent = (eventPayload) => {
    const nextStatus = resolveEventStatus(eventPayload.status, eventPayload.event_type, statusNode?.textContent);
    const overallProgress = resolveDisplayProgress(eventPayload.overall_progress, nextStatus);
    const stageProgress = clampPercentage(eventPayload.stage_progress);
    const rawStageName = resolveDisplayStage(eventPayload.stage, eventPayload.event_type, nextStatus);
    const stageName = resolveDisplayStageLabel(rawStageName, nextStatus);
    const stageGroupKey = resolveDisplayStageGroup(rawStageName, nextStatus);

    if (progressBar) progressBar.style.width = `${overallProgress}%`;
    for (const node of progressValues) node.textContent = `${overallProgress}%`;
    if (stageNode) stageNode.textContent = stageName;
    if (statusNode && nextStatus) statusNode.textContent = nextStatus;
    if (statusNode && nextStatus) {
      statusNode.className = `status status-${nextStatus.toLowerCase()}`;
    }
    focusFeaturedOutputIfReady(nextStatus, featuredOutputCard, featuredOutputSummary);

    if (stageGroupKey) {
      const row = stageRows.get(stageGroupKey);
      if (row) {
        const progressNode = row.querySelector("[data-stage-progress]");
        const statusBadge = row.querySelector("[data-stage-status]");
        if (progressNode) progressNode.textContent = `${stageProgress}%`;
        if (statusBadge) {
          const resolvedStageStatus =
            nextStatus && ["FAILED", "NEEDS_REVIEW", "CANCELED"].includes(nextStatus)
              ? nextStatus
              : stageProgress >= 100
                ? "COMPLETED"
                : "RUNNING";
          statusBadge.textContent = resolvedStageStatus;
          statusBadge.className = `status status-${resolvedStageStatus.toLowerCase()}`;
        }
      }
    }

    if (issuePanel) {
      const eventType = String(eventPayload.event_type || "");
      if (eventType === "job.warning" || eventType === "job.failed" || eventType === "job.needs_review") {
        const title =
          eventType === "job.warning"
            ? "Latest pipeline warning"
            : eventType === "job.needs_review"
              ? "Latest workflow issue"
              : "Latest workflow failure";
        issuePanel.innerHTML = `
          <div class="clip-output-warning-box mt-3" data-job-issue-box data-issue-kind="${escapeHtml(eventType)}">
            <strong>${escapeHtml(title)}</strong>
            <ul>
              <li><strong>Type:</strong> ${escapeHtml(eventType)}</li>
              <li><strong>Message:</strong> ${escapeHtml(String(eventPayload.user_message || eventPayload.message || "-"))}</li>
              <li><strong>Technical detail:</strong> ${escapeHtml(String(eventPayload.message || "-"))}</li>
              <li><strong>Occurred at:</strong> ${escapeHtml(formatEventTime(eventPayload.occurred_at))}</li>
            </ul>
          </div>
        `;
      }
    }

    if (eventsContainer) {
      if (eventsEmpty) eventsEmpty.remove();
      const item = document.createElement("article");
      item.className = "job-log-item";
      item.innerHTML = `
        <strong>[${escapeHtml(String(eventPayload.event_type || "job.progress"))}]</strong>
        <span>${escapeHtml(formatEventTime(eventPayload.occurred_at))}</span>
        <p>${escapeHtml(String(eventPayload.user_message || eventPayload.message || ""))}</p>
      `;
      if (stageName) {
        item.insertAdjacentHTML("beforeend", `
          <div class="text-muted small">${escapeHtml(stageName)} • ${escapeHtml(String(stageProgress))}%</div>
        `);
      }
      eventsContainer.prepend(item);
      while (eventsContainer.children.length > 25) {
        eventsContainer.removeChild(eventsContainer.lastElementChild);
      }
    }

    if (
      !completionRefreshTriggered
      && jobType === "AUTO_CLIPPING"
      && clipOutputsSection
      && nextStatus === "COMPLETED"
      && ["job.completed", "job.warning"].includes(String(eventPayload.event_type || ""))
    ) {
      completionRefreshTriggered = true;
      stream.close();
      window.setTimeout(() => {
        window.location.reload();
      }, 1200);
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
  for (const eventName of ["job.progress", "job.stage", "job.completed", "job.failed", "job.canceled", "job.needs_review", "job.warning"]) {
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

function focusFeaturedOutputIfReady(status, featuredOutputCard, featuredOutputSummary) {
  const normalizedStatus = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (!["COMPLETED", "PARTIALLY_COMPLETED"].includes(normalizedStatus)) return;
  if (!(featuredOutputCard instanceof HTMLElement)) return;
  if (featuredOutputCard.dataset.autofocused === "true") return;

  const target = featuredOutputSummary instanceof HTMLElement ? featuredOutputSummary : featuredOutputCard;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => {
    featuredOutputCard.focus({ preventScroll: true });
    featuredOutputCard.dataset.autofocused = "true";
  }, 120);
}

function initJobRowStream(row) {
  const jobId = row.getAttribute("data-job-stream-row");
  if (!jobId || typeof EventSource === "undefined") return;

  const progressBar = row.querySelector("[data-job-row-progress-bar]");
  const progressValue = row.querySelector("[data-job-row-progress-value]");
  const stageNode = row.querySelector("[data-job-row-stage]");
  const statusNode = row.querySelector("[data-job-row-status]");
  normalizeJobProgressView({
    progressBar,
    progressValues: progressValue ? [progressValue] : [],
    statusNode,
    stageNode
  });
  const stream = new EventSource(`/api/v1/jobs/${jobId}/events/stream`);

  const handleStreamMessage = (message) => {
    try {
      const payload = JSON.parse(message.data);
      const nextStatus = resolveEventStatus(payload.status, payload.event_type, statusNode?.textContent);
      const overallProgress = resolveDisplayProgress(payload.overall_progress, nextStatus);
      const rawStageName = resolveDisplayStage(payload.stage, payload.event_type, nextStatus);
      const stageName = resolveDisplayStageLabel(rawStageName, nextStatus);

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
  for (const eventName of ["job.progress", "job.stage", "job.completed", "job.failed", "job.canceled", "job.needs_review", "job.warning"]) {
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

function normalizeJobProgressView({ progressBar, progressValues, statusNode, stageNode }) {
  const status = statusNode?.textContent ? String(statusNode.textContent).trim().toUpperCase() : null;
  if (!status) return;

  const normalizedProgress = resolveDisplayProgress(
    progressBar?.style?.width ? Number.parseFloat(progressBar.style.width) : 0,
    status
  );

  if (progressBar) progressBar.style.width = `${normalizedProgress}%`;
  for (const node of progressValues || []) {
    if (node) node.textContent = `${normalizedProgress}%`;
  }
  if (stageNode) {
    stageNode.textContent = resolveDisplayStageLabel(stageNode.textContent, status);
  }
}

function resolveEventStatus(status, eventType, currentStatus) {
  if (typeof status === "string" && status.trim()) {
    return status.trim().toUpperCase();
  }

  const normalizedEventType = typeof eventType === "string" ? eventType.trim().toLowerCase() : "";
  if (normalizedEventType === "job.completed") return "COMPLETED";
  if (normalizedEventType === "job.failed") return "FAILED";
  if (normalizedEventType === "job.canceled") return "CANCELED";
  if (normalizedEventType === "job.needs_review") return "NEEDS_REVIEW";

  if (typeof currentStatus === "string" && currentStatus.trim()) {
    return currentStatus.trim().toUpperCase();
  }

  return null;
}

function resolveDisplayProgress(value, status) {
  const progress = clampPercentage(value);
  if (status === "COMPLETED" || status === "PARTIALLY_COMPLETED") return 100;
  if (status === "FAILED" || status === "CANCELED" || status === "NEEDS_REVIEW") {
    return Math.min(progress, 99);
  }
  return progress;
}

function resolveDisplayStage(stage, eventType, status) {
  if (typeof status === "string" && ["COMPLETED", "FAILED", "CANCELED", "PARTIALLY_COMPLETED", "NEEDS_REVIEW"].includes(status)) {
    return status;
  }
  return String(stage || eventType || "Unknown");
}

function resolveDisplayStageGroup(stage, status) {
  if (typeof status === "string" && ["COMPLETED", "FAILED", "CANCELED", "PARTIALLY_COMPLETED", "NEEDS_REVIEW"].includes(status)) {
    return status;
  }
  return stageDisplayMap[String(stage)]?.key ?? String(stage || "Unknown");
}

function resolveDisplayStageLabel(stage, status) {
  if (typeof status === "string" && ["COMPLETED", "FAILED", "CANCELED", "PARTIALLY_COMPLETED", "NEEDS_REVIEW"].includes(status)) {
    return status;
  }
  return stageDisplayMap[String(stage)]?.label ?? String(stage || "Unknown");
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

function setIfPresent(form, fieldName, value) {
  if (value === undefined || value === null || value === "") return;
  const field = form.querySelector(`[name="${fieldName}"]`);
  if (!field) return;
  field.value = String(value);
}

function parseKeyValueLines(value) {
  return Object.fromEntries(
    String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) return [null, null];
        const key = line.slice(0, separatorIndex).trim();
        const mappedValue = line.slice(separatorIndex + 1).trim();
        return [key, mappedValue];
      })
      .filter(([key, mappedValue]) => key && mappedValue)
  );
}

function buildTtsPayload(form) {
  const script = String(form.querySelector('[name="script"]')?.value || "").trim();
  const targetDurationValue = String(form.querySelector('[name="target_duration_ms"]')?.value || "").trim();
  const speakingSpeedValue = String(form.querySelector('[name="speaking_speed"]')?.value || "").trim();
  const pitchValue = String(form.querySelector('[name="pitch"]')?.value || "").trim();
  const pauseIntensityValue = String(form.querySelector('[name="pause_intensity"]')?.value || "").trim();
  const sampleRateValue = String(form.querySelector('[name="sample_rate"]')?.value || "").trim();
  const channelsValue = String(form.querySelector('[name="channels"]')?.value || "").trim();

  return {
    script,
    language: String(form.querySelector('[name="language"]')?.value || "id").trim() || "id",
    local_model_key: String(form.querySelector('[name="local_model_key"]')?.value || "").trim() || undefined,
    voice_identifier: String(form.querySelector('[name="voice_identifier"]')?.value || "").trim() || undefined,
    speaking_style: String(form.querySelector('[name="speaking_style"]')?.value || "").trim() || undefined,
    emotion: String(form.querySelector('[name="emotion"]')?.value || "").trim() || undefined,
    speaking_speed: speakingSpeedValue ? Number(speakingSpeedValue) : undefined,
    pitch: pitchValue ? Number(pitchValue) : undefined,
    pause_intensity: pauseIntensityValue ? Number(pauseIntensityValue) : undefined,
    target_duration_ms: targetDurationValue ? Number(targetDurationValue) : undefined,
    pronunciation_dictionary: parseKeyValueLines(form.querySelector('[name="pronunciation_dictionary"]')?.value),
    output_config: compactObject({
      preferred_format: String(form.querySelector('[name="preferred_format"]')?.value || "WAV").trim() || "WAV",
      segmentation_mode:
        String(form.querySelector('[name="segmentation_mode"]')?.value || "LOCAL_HEURISTIC").trim() || "LOCAL_HEURISTIC",
      sample_rate: sampleRateValue ? Number(sampleRateValue) : undefined,
      channels: channelsValue ? Number(channelsValue) : undefined
    }),
    user_preferences: compactObject({
      tone_notes: String(form.querySelector('[name="tone_notes"]')?.value || "").trim() || undefined,
      delivery_goal: String(form.querySelector('[name="delivery_goal"]')?.value || "").trim() || undefined,
      segment_length_preference: String(form.querySelector('[name="segment_length_preference"]')?.value || "").trim() || undefined,
      breathing_style: String(form.querySelector('[name="breathing_style"]')?.value || "").trim() || undefined
    }),
    ai: {
      credential_mode: "PLATFORM"
    }
  };
}

function validateAutoClipPayload(payload) {
  const errors = [];
  const sourceType = payload?.source?.type;
  const source = payload?.source ?? {};
  const content = payload?.content ?? {};
  const strategy = payload?.strategy ?? {};
  const visual = payload?.visual ?? {};
  const visualSettings = visual.settings ?? {};
  const subtitle = payload?.subtitle ?? {};
  const subtitleSettings = subtitle.settings ?? {};
  const ai = payload?.ai ?? {};

  if (sourceType !== "MEDIA_ASSET" && sourceType !== "EXTERNAL_URL") {
    errors.push("source.type must be MEDIA_ASSET or EXTERNAL_URL");
  }
  if (sourceType === "MEDIA_ASSET" && !source.media_asset_id) {
    errors.push("source.media_asset_id is required for MEDIA_ASSET mode");
  }
  if (sourceType === "EXTERNAL_URL" && !source.url) {
    errors.push("source.url is required for EXTERNAL_URL mode");
  }

  if (!Array.isArray(strategy.tones) || strategy.tones.length < 1 || strategy.tones.length > 5) {
    errors.push("strategy.tones must contain 1 to 5 values");
  }
  if (!Number.isInteger(strategy.desired_clip_count) || strategy.desired_clip_count < 1 || strategy.desired_clip_count > 30) {
    errors.push("strategy.desired_clip_count must be an integer between 1 and 30");
  }
  if (!Number.isInteger(strategy.candidate_pool_count) || strategy.candidate_pool_count < 1 || strategy.candidate_pool_count > 30) {
    errors.push("strategy.candidate_pool_count must be an integer between 1 and 30");
  }
  if (
    Number.isInteger(strategy.desired_clip_count)
    && Number.isInteger(strategy.candidate_pool_count)
    && strategy.candidate_pool_count < strategy.desired_clip_count
  ) {
    errors.push("strategy.candidate_pool_count must be greater than or equal to strategy.desired_clip_count");
  }
  if (!Number.isInteger(strategy.minimum_duration_seconds) || strategy.minimum_duration_seconds < 10 || strategy.minimum_duration_seconds > 180) {
    errors.push("strategy.minimum_duration_seconds must be an integer between 10 and 180");
  }
  if (!Number.isInteger(strategy.maximum_duration_seconds) || strategy.maximum_duration_seconds < 15 || strategy.maximum_duration_seconds > 180) {
    errors.push("strategy.maximum_duration_seconds must be an integer between 15 and 180");
  }
  if (
    Number.isInteger(strategy.minimum_duration_seconds)
    && Number.isInteger(strategy.maximum_duration_seconds)
    && strategy.maximum_duration_seconds < strategy.minimum_duration_seconds
  ) {
    errors.push("strategy.maximum_duration_seconds must be greater than or equal to strategy.minimum_duration_seconds");
  }
  if (typeof strategy.minimum_viral_score !== "number" || strategy.minimum_viral_score < 0 || strategy.minimum_viral_score > 10) {
    errors.push("strategy.minimum_viral_score must be between 0 and 10");
  }
  errors.push(
    ...validateShortTextList(content.custom_vocabulary, {
      fieldPath: "content.custom_vocabulary",
      fieldLabel: "Custom vocabulary",
      maxItems: 200,
      maxChars: 100
    }),
    ...validateShortTextList(strategy.preferred_topics, {
      fieldPath: "strategy.preferred_topics",
      fieldLabel: "Preferred topics",
      maxItems: 20,
      maxChars: 120
    }),
    ...validateShortTextList(strategy.topics_to_avoid, {
      fieldPath: "strategy.topics_to_avoid",
      fieldLabel: "Topics to avoid",
      maxItems: 20,
      maxChars: 120
    }),
    ...validateShortTextList(strategy.sensitive_topics, {
      fieldPath: "strategy.sensitive_topics",
      fieldLabel: "Sensitive topics",
      maxItems: 20,
      maxChars: 120
    }),
    ...validateShortTextList(strategy.clip_style_tags, {
      fieldPath: "strategy.clip_style_tags",
      fieldLabel: "Clip style tags",
      maxItems: 20,
      maxChars: 80
    }),
    ...validateShortTextList(strategy.virality_priorities, {
      fieldPath: "strategy.virality_priorities",
      fieldLabel: "Virality priorities",
      maxItems: 20,
      maxChars: 80
    })
  );

  [
    ["strategy.selection_brief", strategy.selection_brief],
    ["strategy.avoidance_brief", strategy.avoidance_brief],
    ["strategy.packaging_brief", strategy.packaging_brief],
    ["content.context", content.context]
  ].forEach(([fieldPath, value]) => {
    if (value !== undefined && value !== null && typeof value !== "string") {
      errors.push(`${fieldPath} must be a string when provided`);
    }
  });

  if (!["9:16", "1:1", "4:5", "16:9", "CUSTOM"].includes(String(visual.aspect_ratio || ""))) {
    errors.push("visual.aspect_ratio is invalid");
  }
  if (!["CENTER", "ACTIVE_SPEAKER", "FACE_TRACKING", "AUTO_REFRAME", "SPLIT_SCREEN", "SPEAKER_AND_SCREEN", "BLURRED_BACKGROUND", "MANUAL"].includes(String(visual.crop_strategy || ""))) {
    errors.push("visual.crop_strategy is invalid");
  }
  if (
    String(visual.aspect_ratio || "") !== "9:16"
    && String(visualSettings.layout_template || "STANDARD") !== "STANDARD"
  ) {
    errors.push("visual.settings.layout_template hanya tersedia untuk aspect ratio 9:16");
  }

  if (typeof subtitle.language !== "string" || subtitle.language.trim().length === 0) {
    errors.push("subtitle.language is required");
  }
  if (!Array.isArray(subtitle.export_formats) || subtitle.export_formats.length === 0) {
    errors.push("subtitle.export_formats must contain at least one format");
  }
  if (
    subtitleSettings.position !== undefined
    && !["TOP", "CENTER", "BOTTOM"].includes(String(subtitleSettings.position))
  ) {
    errors.push("subtitle.settings.position is invalid");
  }

  if (!["PLATFORM", "USER_OWNED"].includes(String(ai.credential_mode || ""))) {
    errors.push("ai.credential_mode is invalid");
  }

  if (!["REQUIRED", "PREFERRED", "FLEXIBLE"].includes(String(strategy.standalone_priority || ""))) {
    errors.push("strategy.standalone_priority is invalid");
  }

  return errors;
}

function validateTtsPayload(payload) {
  const errors = [];
  if (!payload?.script || payload.script.length < 1) {
    errors.push("script is required");
  }
  if (payload?.script && payload.script.length > 100000) {
    errors.push("script must be 100000 characters or less");
  }
  if (!payload?.language || String(payload.language).length < 2) {
    errors.push("language must be at least 2 characters");
  }
  if (payload?.target_duration_ms !== undefined && (!Number.isInteger(payload.target_duration_ms) || payload.target_duration_ms <= 0)) {
    errors.push("target_duration_ms must be a positive integer");
  }
  if (payload?.speaking_speed !== undefined && (Number.isNaN(payload.speaking_speed) || payload.speaking_speed < 0.5 || payload.speaking_speed > 3)) {
    errors.push("speaking_speed must be between 0.5 and 3");
  }
  if (payload?.pitch !== undefined && (Number.isNaN(payload.pitch) || payload.pitch < -20 || payload.pitch > 20)) {
    errors.push("pitch must be between -20 and 20");
  }
  if (payload?.pause_intensity !== undefined && (Number.isNaN(payload.pause_intensity) || payload.pause_intensity < 0 || payload.pause_intensity > 3)) {
    errors.push("pause_intensity must be between 0 and 3");
  }
  if (
    payload?.output_config?.segmentation_mode !== undefined
    && !["OPENAI", "LOCAL_HEURISTIC"].includes(String(payload.output_config.segmentation_mode))
  ) {
    errors.push("output_config.segmentation_mode must be OPENAI or LOCAL_HEURISTIC");
  }
  return errors;
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

function initClipPreviewPlayers() {
  for (const video of document.querySelectorAll("[data-clip-preview]")) {
    if (!(video instanceof HTMLVideoElement)) continue;

    const start = Number(video.dataset.previewStart || "0");
    const end = Number(video.dataset.previewEnd || "0");
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
    const safeEnd = Number.isFinite(end) && end > safeStart ? end : null;

    var hasSeekedToStart = false;

    const seekToStart = () => {
      if (!Number.isFinite(video.duration) || safeStart <= 0) return;
      try {
        video.currentTime = Math.min(safeStart, Math.max(0, video.duration - 0.1));
        hasSeekedToStart = true;
      } catch (_error) {
        // Ignore browsers that reject seek before enough metadata is available.
      }
    };

    video.addEventListener("loadedmetadata", seekToStart, { once: true });
    video.addEventListener("play", () => {
      if (!hasSeekedToStart && safeStart > 0) {
        seekToStart();
      }
    });
    video.addEventListener("timeupdate", () => {
      if (safeEnd === null) return;
      if (video.currentTime >= safeEnd) {
        video.pause();
        if (safeStart < safeEnd) {
          video.currentTime = safeStart;
        }
      }
    });
  }
}
