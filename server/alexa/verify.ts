/**
 * Alexa request verification (required for any skill endpoint not hosted on Lambda):
 * https://developer.amazon.com/docs/custom-skills/host-a-custom-skill-as-a-web-service.html
 */
import crypto, { X509Certificate } from 'node:crypto';
import path from 'node:path';
import tls from 'node:tls';

const TOLERANCE_MS = 150_000;
const certCache = new Map<string, { leaf: X509Certificate; until: number }>();
let roots: X509Certificate[] | undefined;

function trustedRoots() {
  roots ??= tls.rootCertificates.map((pem) => new X509Certificate(pem));
  return roots;
}

function validCertUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:'
    && u.hostname.toLowerCase() === 's3.amazonaws.com'
    && (u.port === '' || u.port === '443')
    && path.posix.normalize(u.pathname).startsWith('/echo.api/');
}

async function leafCert(url: string): Promise<X509Certificate> {
  const cached = certCache.get(url);
  if (cached && cached.until > Date.now()) return cached.leaf;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cert download failed: ${res.status}`);
  const pem = await res.text();
  const certs = (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((p) => new X509Certificate(p));
  if (!certs.length) throw new Error('empty certificate chain');
  const leaf = certs[0];
  const now = Date.now();
  if (now < Date.parse(leaf.validFrom) || now > Date.parse(leaf.validTo)) throw new Error('certificate expired or not yet valid');
  if (!(leaf.subjectAltName ?? '').split(/,\s*/).includes('DNS:echo-api.amazon.com')) throw new Error('certificate SAN mismatch');
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].checkIssued(certs[i + 1]) || !certs[i].verify(certs[i + 1].publicKey)) throw new Error('broken certificate chain');
  }
  const top = certs[certs.length - 1];
  const anchored = trustedRoots().some((r) => r.fingerprint256 === top.fingerprint256 || (top.checkIssued(r) && top.verify(r.publicKey)));
  if (!anchored) throw new Error('certificate chain not anchored in a trusted root');
  certCache.set(url, { leaf, until: Math.min(Date.parse(leaf.validTo), now + 3600_000) });
  return leaf;
}

/** Throws with a reason when the request must be rejected. */
export async function verifyAlexaRequest(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, expectedSkillId: string) {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const certUrl = h('signaturecertchainurl');
  const signature = h('signature-256');
  if (!certUrl || !signature) throw new Error('missing signature headers');
  if (!validCertUrl(certUrl)) throw new Error('invalid certificate URL');

  const body = JSON.parse(rawBody.toString('utf8'));
  const ts = Date.parse(body?.request?.timestamp ?? '');
  if (!ts || Math.abs(Date.now() - ts) > TOLERANCE_MS) throw new Error('stale request timestamp');

  const leaf = await leafCert(certUrl);
  const ok = crypto.verify('sha256', rawBody, leaf.publicKey, Buffer.from(signature, 'base64'));
  if (!ok) throw new Error('invalid signature');

  const appId = body?.context?.System?.application?.applicationId ?? body?.session?.application?.applicationId;
  if (expectedSkillId && appId !== expectedSkillId) throw new Error(`unexpected skill id ${appId}`);
  return body;
}
