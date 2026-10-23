import type { RequestHandler } from 'express';
import type { PublicUser } from '../../users/contracts/user-reader.js';
import type { AuthUseCases } from '../contracts/auth.js';
import { unauthenticated } from '../../../shared/http/app-error.js';

export interface AuthLocals extends Record<string, unknown> {
  user?: PublicUser;
}

export function authentication(auth: AuthUseCases): RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, AuthLocals> {
  return async (request, response, next) => {
    const header = request.headers.authorization;
    const match = header ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    const token = match?.[1];
    if (!token) throw unauthenticated();
    response.locals.user = await auth.authenticate(token);
    next();
  };
}
