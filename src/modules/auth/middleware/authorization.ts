import type { RequestHandler } from 'express';
import type { UserRole } from '../../users/contracts/user-reader.js';
import type { AuthLocals } from './authentication.js';
import { AppError, unauthenticated } from '../../../shared/http/app-error.js';

export function authorize(...roles: UserRole[]): RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, AuthLocals> {
  return (_request, response, next) => {
    const user = response.locals.user;
    if (!user) throw unauthenticated();
    if (!roles.includes(user.role)) throw new AppError(403, 'FORBIDDEN', 'Access denied');
    next();
  };
}
