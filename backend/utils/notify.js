const Notification = require('../models/Notification');

async function notifyUser(userId, { type, title, message, data = {} }) {
  if (!userId) return null;
  try {
    return await Notification.create({ userId, type, title, message, data });
  } catch (error) {
    // Notifications must never make a successful booking/moderation operation fail.
    console.warn('Notification creation failed:', error.message);
    return null;
  }
}

module.exports = { notifyUser };
