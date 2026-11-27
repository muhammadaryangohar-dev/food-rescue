// Turns every error into one consistent JSON shape (NFR3):
//   { "error": { "code": "...", "message": "...", "details": ... } }
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: details[0]?.message || 'Invalid input', details } });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const fields = [].concat(err.meta?.target || []).join(', ');
      return res.status(409).json({ error: { code: 'DUPLICATE', message: `Already exists (${fields})` } });
    }
    if (err.code === 'P2025') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
    if (err.code === 'P2003') return res.status(400).json({ error: { code: 'BAD_REFERENCE', message: 'A referenced record does not exist' } });
    // P2024 = connection pool timeout, P2028 = transaction timed out. Nothing was
    // written (the transaction rolled back), so the client can simply retry.
    if (err.code === 'P2024' || err.code === 'P2028') {
      return res.status(503).json({ error: { code: 'BUSY', message: 'The server is busy right now. Please try again in a moment.' } });
    }
  }

  // A CHECK constraint in the database rejected the write (last line of defence)
  const raw = `${err.message || ''}`;
  if (raw.includes('violates check constraint') || raw.includes('23514')) {
    const name = raw.match(/constraint "([^"]+)"/)?.[1];
    return res.status(400).json({ error: { code: 'CONSTRAINT_VIOLATION', message: `Data rule violated${name ? ` (${name})` : ''}` } });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
  }

  console.error(err);
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong on the server' } });
}
