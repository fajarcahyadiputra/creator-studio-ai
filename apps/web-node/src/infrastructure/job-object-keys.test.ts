import { describe, expect, it } from "vitest";
import {
  buildClipOutputArtifactBasePath,
  buildTtsOutputArtifactBasePath
} from "./job-object-keys.js";

describe("job artifact object keys", () => {
  it("groups clip output artifacts by type before job and output ids", () => {
    expect(buildClipOutputArtifactBasePath("user-1", "job-1", "output-1"))
      .toBe("users/user-1/jobs/clip-outputs/job-1/output-1");
  });

  it("groups TTS artifacts by type before job and request ids", () => {
    expect(buildTtsOutputArtifactBasePath("user-1", "job-1", "tts-request-1"))
      .toBe("users/user-1/jobs/tts/job-1/tts-request-1");
  });
});
