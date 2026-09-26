const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const ChatConversation = require('../models/ChatConversation');
const { providerConfig, callProvider, describeStatus, userMessage, cleanText } = require('../utils/chatProvider');

const router = express.Router();

/**
 * REVEX ASSISTANT
 *
 * The reference implementation kept the conversation in the browser's
 * localStorage and accepted anonymous requests. That meant nothing loaded on a
 * new device, and any hand-edited storage key could read another account's
 * messages. Here:
 *
 *   - every endpoint requires a signed-in account,
 *   - conversations are stored in MongoDB and always scoped to `userId`,
 *   - the provider is chosen by the environment, so Gemini and any
 *     OpenAI-compatible endpoint both work with no code change,
 *   - a Google AI Studio key is enough on its own; the endpoint is derived,
 *   - the API key only ever exists in the environment.
 *
 * All provider knowledge — prompt, URL derivation, request shape, error
 * mapping — lives in utils/chatProvider.js. This file is only the HTTP surface.
 */

const HISTORY_TURNS = 8;

/* ------------------------------------------------------------ conversations */

async function latestConversation(userId) {
  return ChatConversation.findOne({ userId }).sort({ lastMessageAt: -1 }).lean();
}

function shapeConversation(conversation) {
  return {
    id: String(conversation._id),
    title: conversation.title || 'REVEX Assistant',
    role: conversation.role || 'user',
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
    messages: (conversation.messages || []).map(message => ({ id: String(message._id), role: message.role, text: message.text, at: message.at }))
  };
}

/** Is the assistant usable right now? Drives the UI's "not configured" state. */
router.get('/status', requireAuth, (req, res) => {
  res.json(describeStatus());
});

/** Recent conversations for the signed-in account. */
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const rows = await ChatConversation.find({ userId: req.user._id })
      .sort({ lastMessageAt: -1 }).limit(20).lean();
    res.json(rows.map(shapeConversation));
  } catch (error) {
    console.error('[chat] conversations failed:', error.message);
    res.status(500).json({ message: 'Your conversations could not be loaded.' });
  }
});

/** One conversation, always scoped to the signed-in account. */
router.get('/conversations/:id', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Conversation not found.' });
  try {
    const conversation = await ChatConversation.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });
    res.json(shapeConversation(conversation));
  } catch (error) {
    console.error('[chat] conversation failed:', error.message);
    res.status(500).json({ message: 'This conversation could not be loaded.' });
  }
});

router.post('/conversations', requireAuth, async (req, res) => {
  try {
    const conversation = await ChatConversation.create({
      userId: req.user._id,
      role: req.user.role || 'user',
      title: cleanText(req.body?.title, 120) || 'REVEX Assistant',
      messages: [],
      lastMessageAt: new Date()
    });
    res.status(201).json(shapeConversation(conversation.toObject()));
  } catch (error) {
    console.error('[chat] create conversation failed:', error.message);
    res.status(500).json({ message: 'A new conversation could not be started.' });
  }
});

router.delete('/conversations/:id', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Conversation not found.' });
  try {
    const result = await ChatConversation.deleteOne({ _id: req.params.id, userId: req.user._id });
    if (!result.deletedCount) return res.status(404).json({ message: 'Conversation not found.' });
    res.json({ success: true, message: 'Conversation deleted.' });
  } catch (error) {
    console.error('[chat] delete conversation failed:', error.message);
    res.status(500).json({ message: 'The conversation could not be deleted.' });
  }
});

/**
 * Send a message.
 *
 * The message is persisted BEFORE the provider is called, so a provider outage
 * never loses what the user typed, and the answer is appended afterwards.
 */
router.post('/', requireAuth, async (req, res) => {
  const text = cleanText(req.body?.message);
  if (!text) return res.status(400).json({ message: 'Type a message before sending.' });

  const config = providerConfig();
  if (!config.configured) {
    return res.status(503).json({
      message: `${config.problem} Set the assistant key in the backend .env file, then restart the server.`,
      code: 'CHAT_NOT_CONFIGURED'
    });
  }

  try {
    let conversation = null;
    if (req.body?.conversationId && mongoose.isValidObjectId(req.body.conversationId)) {
      conversation = await ChatConversation.findOne({ _id: req.body.conversationId, userId: req.user._id });
    }
    if (!conversation) {
      conversation = await ChatConversation.create({
        userId: req.user._id,
        role: req.user.role || 'user',
        title: cleanText(text, 60) || 'REVEX Assistant',
        messages: [],
        lastMessageAt: new Date()
      });
    }

    conversation.messages.push({ role: 'user', text, at: new Date() });
    conversation.lastMessageAt = new Date();
    await conversation.save();

    const history = conversation.messages
      .slice(-(HISTORY_TURNS * 2 + 1))
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => ({ role: message.role, text: message.text }));

    const result = await callProvider(config, history);
    if (!result.ok) {
      // `status` is already an HTTP status for THIS api (502/504), never the
      // provider's raw code, so a bad assistant key can never be mistaken for an
      // expired user session by the frontend. `kind` picks an accurate message:
      // an exhausted quota, a short rate limit, a bad key and an outage each need
      // a different thing from the reader, and calling them all "unavailable"
      // is what made this impossible to diagnose.
      console.error(`[chat] provider ${result.kind}:`, result.providerStatus || '-', result.detail);
      if (result.retryAfter) console.error(`[chat] retry in ${result.retryAfter}s`);
      if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
      return res.status(result.status).json({
        message: userMessage(result.kind, result.retryAfter),
        kind: result.kind,
        retryAfter: result.retryAfter || undefined,
        conversation: shapeConversation(conversation.toObject())
      });
    }

    conversation.messages.push({ role: 'assistant', text: result.reply, at: new Date() });
    conversation.lastMessageAt = new Date();
    // Bound the stored history so one long session cannot grow without limit.
    if (conversation.messages.length > 100) conversation.messages = conversation.messages.slice(-100);
    await conversation.save();

    res.json({ reply: result.reply, conversation: shapeConversation(conversation.toObject()) });
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ message: 'The REVEX Assistant took too long to respond. Please try again.' });
    }
    console.error('[chat] send failed:', error.message);
    res.status(500).json({ message: 'The REVEX Assistant could not respond right now.' });
  }
});

module.exports = router;
