/** The roots HTTPS requests trust, and one TLS context built from them. */
import tls from "node:tls";

let trustedCas: string[] | null = null;
let trustedContext: tls.SecureContext | null = null;

/** System trust (as Python's default SSL context) plus Node's bundled roots. */
export function trustedCertificates(): string[] {
  trustedCas ??= [...new Set([...tls.getCACertificates("system"), ...tls.getCACertificates("default")])];
  return trustedCas;
}

/**
 * One context for every request: passing `ca` per request makes Node build
 * a context each time, parsing every root (about 25 ms, blocking the loop).
 */
export function trustedSecureContext(): tls.SecureContext {
  trustedContext ??= tls.createSecureContext({ ca: trustedCertificates() });
  return trustedContext;
}
