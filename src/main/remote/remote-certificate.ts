import { X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { generate } from "selfsigned";

import type { TlsIdentity } from "./remote-server";

/** iOS rejects server certificates valid for longer than 825 days, even ones a user accepts. */
const VALID_DAYS = 800;
/** Renew this close to expiry, so an open session never hits the date. */
const RENEW_BEFORE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RemoteCertificate extends TlsIdentity {
  /** SHA-256, colon-separated hex, as browsers show it. */
  fingerprint: string;
}

interface StoredCertificate {
  key: string;
  cert: string;
  /** Host names and IP addresses the certificate covers. */
  names: string[];
}

/**
 * The self-signed certificate this PC serves remote access with. It is reused while it covers
 * every current address, because each new certificate makes browsers warn again, and replaced
 * with one covering old and new addresses when the network changes.
 */
export async function loadCertificate(
  path: string,
  addresses: string[],
): Promise<RemoteCertificate> {
  const wanted = [...new Set(["localhost", "127.0.0.1", hostname(), ...addresses])];
  const stored = await readStored(path);
  if (stored && wanted.every((name) => stored.names.includes(name)) && !expiring(stored.cert))
    return withFingerprint(stored);

  const names = [...new Set([...wanted, ...(stored?.names ?? [])])];
  const notBeforeDate = new Date(Date.now() - DAY_MS);
  const generated = await generate([{ name: "commonName", value: `Nicegal on ${hostname()}` }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate: new Date(notBeforeDate.getTime() + VALID_DAYS * DAY_MS),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: names.map((name) =>
          /^[\d.]+$/.test(name) || name.includes(":")
            ? { type: 7 as const, ip: name }
            : { type: 2 as const, value: name },
        ),
      },
    ],
  });
  const created: StoredCertificate = { key: generated.private, cert: generated.cert, names };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return withFingerprint(created);
}

async function readStored(path: string): Promise<StoredCertificate | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<StoredCertificate>;
    if (
      typeof value.key === "string" &&
      typeof value.cert === "string" &&
      Array.isArray(value.names) &&
      value.names.every((name) => typeof name === "string")
    )
      return value as StoredCertificate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error("Could not read the remote access certificate; making a new one", error);
  }
  return null;
}

function expiring(cert: string): boolean {
  try {
    return (
      new Date(new X509Certificate(cert).validTo).getTime() - Date.now() <
      RENEW_BEFORE_DAYS * DAY_MS
    );
  } catch {
    return true;
  }
}

function withFingerprint(stored: StoredCertificate): RemoteCertificate {
  return {
    key: stored.key,
    cert: stored.cert,
    fingerprint: new X509Certificate(stored.cert).fingerprint256,
  };
}
