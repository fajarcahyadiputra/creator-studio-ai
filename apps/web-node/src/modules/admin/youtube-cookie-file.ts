import { ValidationError } from "../../shared/errors/app-error.js";

export function validateYoutubeCookieContent(value: string): string {
  const normalized = value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd() + "\n";
  const lines = normalized.split("\n");
  const cookieLines = lines.filter((line) => line && !line.startsWith("#"));
  const validRows = cookieLines.filter((line) => line.split("\t").length >= 7);
  const hasYoutubeCookie = validRows.some((line) => {
    const domain = line.split("\t", 1)[0]?.toLowerCase() ?? "";
    return domain === "youtube.com" || domain.endsWith(".youtube.com");
  });

  if (!lines[0]?.includes("Netscape HTTP Cookie File") || validRows.length === 0 || !hasYoutubeCookie) {
    throw new ValidationError(
      "File cookie harus memakai format Netscape cookies.txt dan berisi cookie youtube.com."
    );
  }
  return normalized;
}
