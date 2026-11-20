const express = require('express');
const router = express.Router();

const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireActiveUser } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const { login, logout, getMe, LOGIN_SCHEMA } = require('../controllers/auth.controller');

const loginLimiters = require('../utils/login-throttle').loginLimiters();

router.get('/csrf', require('../utils/web-session').csrf);
router.post('/login', ...loginLimiters, validate(LOGIN_SCHEMA), asyncHandler(login));
router.get('/me', authenticate, asyncHandler(requireActiveUser), asyncHandler(getMe));
router.post('/logout', authenticate, asyncHandler(requireActiveUser), asyncHandler(logout));

module.exports = router;
