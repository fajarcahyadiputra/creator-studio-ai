import { describe, expect, it } from "vitest";
import { isPublicIp } from "./ip.js";

describe("isPublicIp", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1"])(
    "rejects private or local address %s",
    (address) => expect(isPublicIp(address)).toBe(false)
  );

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts public address %s", (address) =>
    expect(isPublicIp(address)).toBe(true)
  );
});
