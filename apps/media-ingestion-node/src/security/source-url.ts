import { lookup } from "node:dns/promises";
import { config } from "../config.js";
import { isPublicIp } from "./ip.js";

export interface ValidatedSource {
  normalizedUrl: string;
  hostname: string;
  resolvedAddresses: string[];
}

export async function validateSourceUrl(raw: string): Promise<ValidatedSource> {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS sources are supported.");
  if (url.username || url.password) throw new Error("Source URLs containing credentials are not allowed.");
  url.hash = "";
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = [...config.allowedHosts].some((host) => hostname === host || hostname.endsWith(`.${host}`));
  if (!allowed) throw new Error("The source host is not enabled by platform policy.");

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error("The source host did not resolve.");
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.some((address) => !isPublicIp(address))) {
    throw new Error("The source resolves to a private, local, reserved, or multicast address.");
  }
  return { normalizedUrl: url.toString(), hostname, resolvedAddresses: addresses };
}
