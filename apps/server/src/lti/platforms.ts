import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/** One LMS registration, as configured in the LMS when the tool is added. */
export interface PlatformConfig {
  /** The platform's issuer, e.g. https://moodle.school.example */
  issuer: string;
  /** The client id the platform assigned to this tool. */
  clientId: string;
  deploymentIds: string[];
  /** OIDC authorization endpoint ("Authentication request URL" in Moodle). */
  authLoginUrl: string;
  /** OAuth2 token endpoint, used for AGS. */
  authTokenUrl: string;
  /** Some platforms expect a different `aud` in the client assertion than the token URL. */
  authTokenAudience?: string;
  jwksUrl: string;
}

export class PlatformRegistry {
  private readonly keySets = new Map<string, JWTVerifyGetKey>();

  constructor(
    private readonly platforms: PlatformConfig[],
    /** Injectable for tests; production fetches and caches the platform's JWKS. */
    private readonly keySetFor: (p: PlatformConfig) => JWTVerifyGetKey = (p) => createRemoteJWKSet(new URL(p.jwksUrl)),
  ) {}

  /** A platform may register the tool several times: issuer alone is not unique, issuer + client id is. */
  find(issuer: string, clientId?: string): PlatformConfig | undefined {
    const matches = this.platforms.filter((p) => p.issuer === issuer && (clientId === undefined || p.clientId === clientId));
    return matches.length === 1 ? matches[0] : undefined;
  }

  keys(p: PlatformConfig): JWTVerifyGetKey {
    const id = `${p.issuer}\u0000${p.clientId}`;
    let ks = this.keySets.get(id);
    if (!ks) this.keySets.set(id, (ks = this.keySetFor(p)));
    return ks;
  }
}
