const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? "";

function objectFromForm(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].filter(([key]) => key !== "_csrf"));
}

function showMessage(container, message, type = "danger") {
  if (!container) return;
  container.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
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
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
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
  autoClipForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(autoClipForm);
    const payload = {
      source: { type: "EXTERNAL_URL", url: String(data.get("source_url")) },
      content: {
        title: String(data.get("title") || ""),
        custom_vocabulary: [],
        rights_confirmed: data.get("rights_confirmed") === "on"
      },
      strategy: {
        target_platform: String(data.get("platform")),
        objective: String(data.get("objective")),
        tones: ["EDUCATIONAL", "SERIOUS"],
        desired_clip_count: Number(data.get("clip_count")),
        minimum_duration_seconds: Number(data.get("min_duration")),
        maximum_duration_seconds: Number(data.get("max_duration")),
        minimum_viral_score: 7,
        remove_long_silence: true,
        remove_filler_words: false
      },
      visual: {
        aspect_ratio: String(data.get("aspect_ratio")),
        crop_strategy: String(data.get("crop_strategy")),
        settings: {}
      },
      subtitle: {
        enabled: true,
        language: String(data.get("subtitle_language")),
        burn_in: true,
        export_formats: ["SRT", "VTT"],
        settings: {}
      },
      ai: { credential_mode: "PLATFORM" }
    };
    const button = autoClipForm.querySelector('button[type="submit"]');
    const messages = document.querySelector(".form-message");
    button.disabled = true;
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch("/api/v1/auto-clipping/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? "Could not create job.");
      showMessage(messages, `Job ${result.data.id.slice(0,8)} was queued.`, "success");
      setTimeout(() => window.location.assign("/app/jobs"), 800);
    } catch (error) {
      showMessage(messages, error instanceof Error ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  });
}
