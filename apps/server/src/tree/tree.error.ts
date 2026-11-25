import {
  type ArgumentsHost,
  Catch,
  ConflictException,
  type ExceptionFilter,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { SyncErrorCode } from '@notes/shared';

/**
 * A rule of the notebook/category/page tree was violated. Thrown by the services so the same
 * logic serves both REST (mapped to an HTTP status) and sync batches (mapped to a result code).
 */
export class TreeError extends Error {
  constructor(
    readonly code: Exclude<SyncErrorCode, 'internal'>,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = 'not_found') => new TreeError('not_found', what);
export const parentDeleted = () => new TreeError('parent_deleted');
export const invalid = (message: string) => new TreeError('invalid', message);
export const idTaken = () => new TreeError('id_taken');

function toHttp(err: TreeError): HttpException {
  switch (err.code) {
    case 'not_found':
      return new NotFoundException(err.message);
    case 'parent_deleted':
    case 'id_taken':
      return new ConflictException(err.code);
    case 'invalid':
      return new UnprocessableEntityException(err.message);
  }
}

@Catch(TreeError)
export class TreeErrorFilter implements ExceptionFilter {
  catch(err: TreeError, host: ArgumentsHost): void {
    const http = toHttp(err);
    host.switchToHttp().getResponse().status(http.getStatus()).json(http.getResponse());
  }
}
