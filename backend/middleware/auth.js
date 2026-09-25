const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const User = require('../models/User');

function tokenFromRequest(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

async function resolveUser(req) {
    const token = tokenFromRequest(req);
    if (!token || !process.env.JWT_SECRET) return null;
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        return await User.findById(payload.userId).select('-passwordHash').then(user => (user && user.isActive === false ? null : user));
    } catch (error) {
        return null;
    }
}

async function requireAuth(req, res, next) {
    const user = await resolveUser(req);
    if (!user) {
        return res.status(401).json({ message: 'Login required or your session has expired.' });
    }
    req.user = user;
    next();
}

// Used for public detail endpoints where an owner/admin may be viewing a
// pending or rejected listing. Invalid tokens remain anonymous; protected
// endpoints should always use requireAuth.
async function optionalAuth(req, res, next) {
    req.user = await resolveUser(req);
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'You do not have permission for this action.' });
        }
        next();
    };
}

async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}

async function comparePassword(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
}

module.exports = {
    requireAuth,
    optionalAuth,
    requireRole,
    hashPassword,
    comparePassword
};
