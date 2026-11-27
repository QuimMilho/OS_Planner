import { type ArgumentsHost, Catch, type ExceptionFilter, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

/** The one answer for "there is nothing here you may see" (the same as a TreeError `not_found`). */
export const NOT_FOUND_BODY = {
  message: 'not_found',
  error: 'Not Found',
  statusCode: 404,
} as const;

/**
 * Something that exists but is hidden must answer exactly like something that does not exist (phase 17). Services say
 * "not found" in two ways (`new NotFoundException()` and the tree's `not_found`), often both within one route, which told
 * the two cases apart. A bare 404 becomes the canonical body here; a 404 that carries a code of its own (`invalid_invite`,
 * `invalid_link`, an unknown route) is left as it is: those are already the same for every reason.
 */
@Catch(NotFoundException)
export class NotFoundFilter implements ExceptionFilter {
  catch(e: NotFoundException, host: ArgumentsHost): void {
    const body = e.getResponse();
    const message = typeof body === 'string' ? body : (body as { message?: unknown }).message;
    const res = host.switchToHttp().getResponse<Response>();
    res
      .status(404)
      .json(message === 'Not Found' || message === 'not_found' ? NOT_FOUND_BODY : body);
  }
}
