import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("uses a salted Argon2 hash and verifies the correct password", async () => {
    const first = await hashPassword("StrongPassword123!");
    const second = await hashPassword("StrongPassword123!");
    expect(first).not.toEqual(second);
    expect(await verifyPassword(first, "StrongPassword123!")).toBe(true);
    expect(await verifyPassword(first, "incorrect")).toBe(false);
  });
});
