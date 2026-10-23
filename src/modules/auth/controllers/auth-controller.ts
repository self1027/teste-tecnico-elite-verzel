import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthUseCases } from '../contracts/auth.js';
import type { AuthLocals } from '../middleware/authentication.js';
import { unauthenticated } from '../../../shared/http/app-error.js';

const loginInput = z.strictObject({
  email: z.string().trim().toLowerCase().max(255).pipe(z.email()),
  password: z.string().min(1).max(1024),
});

export class AuthController {
  constructor(private readonly auth: AuthUseCases) {}

  login = async (request: Request, response: Response): Promise<void> => {
    const input = loginInput.parse(request.body);
    response.json(await this.auth.login(input));
  };

  me = (_request: Request, response: Response<unknown, AuthLocals>): void => {
    const user = response.locals.user;
    if (!user) throw unauthenticated();
    response.json({ user });
  };
}
