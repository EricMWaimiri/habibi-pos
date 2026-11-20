const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const { ensureDefaults } = require('./utils/permissions');
const { secureSockets } = require('./sockets/security');
const prisma = require('./config/prisma');

// Refuse to start if required secrets are missing. No default secrets.
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is missing from .env. Set it before starting the server.');
  process.exit(1);
}
if (!process.env.PIN_PEPPER) {
  console.error('FATAL: PIN_PEPPER is missing from .env. Set it before starting the server.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const access = require('./utils/remote-access').remoteAccess();
const io = new Server(server, { cors: access.cors, allowRequest: access.allowRequest });
io.engine.use(access.engineMiddleware);

secureSockets(io, prisma);

app.set('io', io);

// Seed defaults exactly once, THEN start listening
require('./utils/runtime-database').verifyRuntimeDatabase(prisma)
  .then(() => ensureDefaults())
  .then(() => server.listen(PORT, '127.0.0.1', () => console.log(`Habibi POS listening on :${PORT}`)))
  .catch((err) => { console.error('Failed to initialize POS', require('./utils/safe-error')(err)); process.exit(1); });
