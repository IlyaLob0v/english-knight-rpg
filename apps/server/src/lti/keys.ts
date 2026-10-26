import { exportJWK, generateKeyPair, importPKCS8, type JWK, type CryptoKey } from "jose";

export interface ToolKeys {
  kid: string;
  alg: "RS256";
  privateKey: CryptoKey;
  publicJwk: JWK;
}

/**
 * The tool's signing key: signs AGS client assertions; the public half is served
 * at /.well-known/jwks.json for the LMS. Without a configured key an ephemeral one
 * is generated, which is fine for tests and local Moodle, not for production
 * (the LMS caches the public key).
 */
export async function loadToolKeys(kid: string, privateKeyPem?: string): Promise<ToolKeys> {
  let privateKey: CryptoKey;
  let publicJwk: JWK;
  if (privateKeyPem) {
    privateKey = await importPKCS8(privateKeyPem, "RS256", { extractable: true });
    const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = await exportJWK(privateKey);
    publicJwk = pub;
  } else {
    const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
  }
  return { kid, alg: "RS256", privateKey, publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } };
}
