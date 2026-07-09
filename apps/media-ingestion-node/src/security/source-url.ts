import { lookup, resolve4, resolve6 } from "node:dns/promises";
import { config } from "../config.js";
import { isPublicIp } from "./ip.js";

export interface ValidatedSource {
  normalizedUrl: string;
  hostname: string;
  resolvedAddresses: string[];
  validationMode: "resolved_dns" | "trusted_host_dns_bypass";
}

export async function validateSourceUrl(raw: string): Promise<ValidatedSource> {
  const url = normalizeKnownVideoUrl(new URL(raw));
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS sources are supported.");
  if (url.username || url.password) throw new Error("Source URLs containing credentials are not allowed.");
  url.hash = "";
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = [...config.allowedHosts].some((host) => hostname === host || hostname.endsWith(`.${host}`));
  if (!allowed) throw new Error("The source host is not enabled by platform policy.");

  try {
    const records = await resolveHostname(hostname);
    if (records.length === 0) throw new Error("The source host did not resolve.");
    const addresses = [...new Set(records.map((record) => record.address))];
    if (addresses.some((address) => !isPublicIp(address))) {
      throw new Error("The source resolves to a private, local, reserved, or multicast address.");
    }
    return {
      normalizedUrl: url.toString(),
      hostname,
      resolvedAddresses: addresses,
      validationMode: "resolved_dns"
    };
  } catch (error) {
    if (isRetryableYoutubeResolutionFailure(hostname, error)) {
      return {
        normalizedUrl: url.toString(),
        hostname,
        resolvedAddresses: [],
        validationMode: "trusted_host_dns_bypass"
      };
    }

    throw error;
  }
}

function normalizeKnownVideoUrl(url: URL): URL {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname !== "youtu.be" && hostname !== "www.youtu.be") return url;

  const videoId = url.pathname.split("/").filter(Boolean)[0];
  if (!videoId) return url;

  const normalized = new URL("https://www.youtube.com/watch");
  normalized.searchParams.set("v", videoId);

  for (const [key, value] of url.searchParams.entries()) {
    if (key === "v") continue;
    normalized.searchParams.append(key, value);
  }
  return normalized;
}

async function resolveHostname(hostname: string) {
  const candidates = getResolutionHostnames(hostname);
  let sawRetryableDnsError = false;

  for (const candidate of candidates) {
    try {
      const records = await lookupWithFallback(candidate);
      if (records.length > 0) return records;
    } catch (error) {
      if (isDnsRetryableError(error)) {
        sawRetryableDnsError = true;
        continue;
      }

      if (isDnsNotFoundError(error)) {
        continue;
      }

      throw error;
    }
  }

  if (sawRetryableDnsError) {
    throw new Error(buildRetryableDnsMessage(hostname));
  }

  throw new Error("The source host did not resolve.");
}

function getResolutionHostnames(hostname: string): string[] {
  const candidates = [hostname];

  if (hostname === "youtube.com") candidates.push("www.youtube.com");
  if (hostname === "www.youtube.com") candidates.push("youtube.com");
  if (hostname === "youtu.be") candidates.push("www.youtube.com", "youtube.com");

  return [...new Set(candidates)];
}

async function lookupWithFallback(hostname: string) {
  const records = await tryLookup(hostname);
  if (records.length > 0) return records;

  const resolvedAddresses = new Set<string>();
  const [ipv4, ipv6] = await Promise.all([
    tryResolve4(hostname),
    tryResolve6(hostname)
  ]);

  ipv4.forEach((address) => resolvedAddresses.add(address));
  ipv6.forEach((address) => resolvedAddresses.add(address));

  return [...resolvedAddresses].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

async function tryLookup(hostname: string) {
  try {
    return await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    if (isDnsRetryableError(error) || isDnsNotFoundError(error)) throw error;
    return [];
  }
}

async function tryResolve4(hostname: string): Promise<string[]> {
  try {
    return await resolve4(hostname);
  } catch (error) {
    if (isDnsRetryableError(error)) throw error;
    return [];
  }
}

async function tryResolve6(hostname: string): Promise<string[]> {
  try {
    return await resolve6(hostname);
  } catch (error) {
    if (isDnsRetryableError(error)) throw error;
    return [];
  }
}

function buildRetryableDnsMessage(hostname: string): string {
  if (hostname === "youtu.be" || hostname === "youtube.com" || hostname === "www.youtube.com") {
    return "Temporary DNS lookup failure while resolving YouTube. Retry in a moment. If it still fails, keep using the canonical https://www.youtube.com/watch?v=... URL and ensure the ingestion container can resolve public DNS.";
  }

  return "Temporary DNS lookup failure while resolving the source host. Retry in a moment and verify the ingestion container can resolve public DNS.";
}

function isDnsRetryableError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EAI_AGAIN"
  );
}

function isDnsNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOTFOUND" || (error as NodeJS.ErrnoException).code === "ENODATA")
  );
}

function isRetryableYoutubeResolutionFailure(hostname: string, error: unknown): boolean {
  return isTrustedYoutubeHostname(hostname) && error instanceof Error && error.message.includes("Temporary DNS lookup failure while resolving YouTube");
}

function isTrustedYoutubeHostname(hostname: string): boolean {
  return hostname === "youtube.com" || hostname === "www.youtube.com" || hostname === "youtu.be";
}
