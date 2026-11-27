// Server-side validation with Zod (NFR3). On success the parsed (and type-coerced)
// values replace req.body / req.params; parsed query values go to req.q because
// Express 5 makes req.query read-only.

export function validate({ body, params, query } = {}) {
  return (req, _res, next) => {
    if (params) req.params = params.parse(req.params);
    if (query) req.q = query.parse(req.query);
    if (body) req.body = body.parse(req.body ?? {});
    next();
  };
}
