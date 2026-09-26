const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const docs = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean();
    res.json(docs.map(item => ({ ...item, id: item._id.toString(), read: Boolean(item.readAt) })));
  } catch (error) {
    res.status(500).json({ message: 'Notifications could not be loaded.' });
  }
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Notification not found.' });
  const item = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { $set: { readAt: new Date() } }, { returnDocument: 'after' });
  if (!item) return res.status(404).json({ message: 'Notification not found.' });
  res.json({ success: true, notification: { ...item.toObject(), id: item._id.toString(), read: true } });
});

module.exports = router;
