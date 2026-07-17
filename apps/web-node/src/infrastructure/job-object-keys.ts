type JobArtifactKind = "clip-outputs" | "tts";

function buildJobArtifactBasePath(
  userId: string,
  kind: JobArtifactKind,
  jobId: string,
  detailId: string
) {
  return `users/${userId}/jobs/${kind}/${jobId}/${detailId}`;
}

export function buildClipOutputArtifactBasePath(
  userId: string,
  jobId: string,
  clipOutputId: string
) {
  return buildJobArtifactBasePath(userId, "clip-outputs", jobId, clipOutputId);
}

export function buildTtsOutputArtifactBasePath(
  userId: string,
  jobId: string,
  ttsRequestId: string
) {
  return buildJobArtifactBasePath(userId, "tts", jobId, ttsRequestId);
}
