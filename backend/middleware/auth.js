const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const User = require('../models/User');

async function requireAuth(req, res, next) {
    try {
        const header = req.headers.authorization || '';

        const token = header.startsWith('Bearer ')
            ? header.slice(7)
            : null;

        if (!token) {
            return res.status(401).json({
                message: 'Login required.'
            });
        }

        const payload = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        const user = await User.findById(payload.userId)
            .select('-passwordHash');

        if (!user) {
            return res.status(401).json({
                message: 'User account not found.'
            });
        }

        req.user = user;

        next();

    } catch (error) {
        return res.status(401).json({
            message: 'Invalid or expired login session.'
        });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {

        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                message: 'You do not have permission for this action.'
            });
        }

        next();
    };
}

// Bcrypt: password hash
async function hashPassword(password) {
    return await bcrypt.hash(password, 10);
}

// Bcrypt: password compare
async function comparePassword(password, passwordHash) {
    return await bcrypt.compare(password, passwordHash);
}

module.exports = {
    requireAuth,
    requireRole,
    hashPassword,
    comparePassword
};