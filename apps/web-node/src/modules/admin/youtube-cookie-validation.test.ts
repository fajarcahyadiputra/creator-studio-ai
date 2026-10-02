import { describe, expect, it } from "vitest";
import { ValidationError } from "../../shared/errors/app-error.js";
import { validateYoutubeCookieContent } from "./youtube-cookie-file.js";

describe("validateYoutubeCookieContent", () => {
  it("accepts Netscape YouTube cookie exports", () => {
    const content = "# Netscape HTTP Cookie File\r\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret";
    expect(validateYoutubeCookieContent(content)).toBe(
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret\n"
    );
  });

  it("rejects arbitrary text and non-YouTube cookie files", () => {
    expect(() => validateYoutubeCookieContent("SID=secret")).toThrow(ValidationError);
    expect(() => validateYoutubeCookieContent(
      "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tSID\tsecret"
    )).toThrow(ValidationError);
  });
});
