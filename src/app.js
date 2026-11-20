require('dotenv').config();
require('express-async-errors');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const access = require('./utils/remote-access').remoteAccess();
const webSession = require('./utils/web-session');
webSession.requireHttps(access);
// Do not trust spoofable forwarded/identity headers for IPs or authorization.
app.set('trust proxy', false);
app.use(access.middleware);

app.use(helmet(access.helmet));
app.use(cors(access.cors));
app.use(express.json());
app.use('/api', webSession.writeProtection(access));
// Never include URLs/query strings, headers or credentials in access logs.
app.use(morgan(':method :status :response-time ms'));

// The tablet screens live in the "public" folder
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'habibi-pos', time: new Date().toISOString() });
});

// API routes
app.use('/api', require('./utils/business-day-context').middleware, require('./routes'));

// 404 handler
app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Broken JSON sent by a client
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON in request' });
  }

  // Something unique already exists (for example a duplicate code)
  if (err.code === 'P2002') {
    return res.status(409).json({ message: 'This record already exists' });
  }

  const status = err.status || 500;

  // Our own messages (404, 403, 409...) are safe to show. Unexpected errors are not.
  if (status >= 500) {
    // ORM messages/stacks may embed query arguments, PIN hashes or URLs.
    // Retain only fixed diagnostic labels; never log arbitrary error content.
    console.error('Unexpected API failure', require('./utils/safe-error')(err));
    return res.status(status).json({ message: 'Internal server error' });
  }
  res.status(status).json({ message: err.message || 'Request failed' });
});

module.exports = app;
