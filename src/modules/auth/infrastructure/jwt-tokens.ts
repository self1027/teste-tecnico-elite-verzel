import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { AccessTokens } from '../contracts/auth.js';
import type { AuthConfig } from '../../../shared/config.js';
import { unauthenticated } from '../../../shared/http/app-error.js';

const issuer = 'verzel-auction-house';
const audience = 'verzel-api';

export class JwtTokens implements AccessTokens {
  private readonly key: Uint8Array;

  constructor(private readonly config: AuthConfig) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  issue(subject: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(subject).setIssuer(issuer).setAudience(audience)
      .setIssuedAt(now).setExpirationTime(now + this.config.jwtExpiresInSeconds)
      .sign(this.key);
  }

  async verify(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], issuer, audience, typ: 'JWT',
        requiredClaims: ['sub', 'iat', 'exp'],
      });
      const subject = z.uuid().safeParse(payload.sub);
      if (!subject.success) throw unauthenticated();
      return subject.data;
    } catch (error) {
      if (error instanceof errors.JOSEError) throw unauthenticated();
      throw error;
    }
  }
}
