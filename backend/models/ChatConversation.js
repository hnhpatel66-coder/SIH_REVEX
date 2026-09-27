const mongoose = require('mongoose');

/**
 * A REVEX Assistant conversation.
 *
 * The reference implementation kept history in the browser, which meant nothing
 * loaded on a new device and any hand-edited localStorage key could read another
 * account's messages. Conversations and messages are therefore stored per
 * authenticated user, and every read is scoped to `userId`.
 */
const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  text: { type: String, required: true, trim: true, maxlength: 4000 },
  at: { type: Date, default: Date.now }
}, { _id: true, timestamps: false });

const conversationSchema = new mongoose.Schema({
  // The owner of the conversation. A conversation is NEVER shared implicitly.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, trim: true, maxlength: 120, default: 'REVEX Assistant' },
  role: { type: String, enum: ['user', 'owner', 'admin', ''], default: 'user' },
  messages: { type: [messageSchema], default: [] },
  lastMessageAt: { type: Date, default: Date.now }
}, { timestamps: true });

conversationSchema.index({ userId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('ChatConversation', conversationSchema);
