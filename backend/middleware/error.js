/**
 * Centralized production error handling.
 * Never leaks stack traces, connection strings, or any secrets.
 */

export class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    if (details) this.details = details;
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // Mongoose schema validation errors → 400 with field details
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: err.message,
      errors: Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    });
  }

  // Duplicate key violations → 409
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0];
    return res.status(409).json({
      success: false,
      message: `Duplicate value for ${field || 'unique field'}`,
    });
  }

  // Malformed ObjectIds → 400
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid identifier' });
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Invalid or expired session' });
  }

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // Unexpected errors — log server-side, return a generic message
  console.error('[unhandled]', err);
  return res.status(500).json({ success: false, message: 'Internal server error' });
}
