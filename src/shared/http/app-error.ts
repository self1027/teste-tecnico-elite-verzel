export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function unauthenticated(): AppError {
  return new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
}
