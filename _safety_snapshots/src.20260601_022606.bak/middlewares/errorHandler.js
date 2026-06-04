module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'Internal server error';

  if (res.headersSent) {
    return next(err);
  }

  res.status(status).json({
    success: false,
    error: {
      code,
      message,
    },
  });
};
