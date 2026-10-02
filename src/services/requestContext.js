const { AsyncLocalStorage } = require('node:async_hooks');

// Carries who made the current request so an error reported deep in a service
// can name the member, without every function having to pass it down.
const storage = new AsyncLocalStorage();

function runWithContext(context, next) {
  storage.run(context, next);
}

function getContext() {
  return storage.getStore() ?? {};
}

// Express middleware. Must run after express.json(), otherwise req.body is
// still unparsed and the member id in the body is invisible.
function contextMiddleware(req, res, next) {
  runWithContext(
    {
      route: `${req.method} ${req.originalUrl}`,
      // The app sets these headers on every call; the body and query are
      // fallbacks for older builds that only send memberId on some endpoints.
      memberId:
        req.headers['x-member-id'] ||
        req.body?.memberId ||
        req.query?.memberId ||
        null,
      memberName: req.headers['x-member-name'] || null,
      appVersion: req.headers['x-app-version'] || null,
    },
    next
  );
}

module.exports = { runWithContext, getContext, contextMiddleware };
