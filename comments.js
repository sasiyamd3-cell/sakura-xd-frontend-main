// comments.js
// Standalone comment-system router for the Sakura XD website (main.html).
// Visitors can post a comment and react with an emoji. Only the admin
// (verified with COMMENT_ADMIN_PASSWORD from config.js) can post an official
// reply — when they do, the comment is auto-"hearted" the way a YouTube
// creator heart works, which is tracked separately from normal reactions so
// it never looks like just another visitor reacting.
//
// Mount this in your main server file next to settings.js, e.g.:
//   const commentsRouter = require('./comments');
//   app.use(commentsRouter);

const express = require('express');
const router = express.Router();
router.use(express.json());

const { MongoClient, ObjectId } = require('mongodb');
const { BOT_NAME_FANCY, COMMENT_URL, COMMENT_DB, COMMENT_ADMIN_PASSWORD } = require('./config');

const ALLOWED_EMOJIS = ['😂', '❤️', '👍', '✊', '👎'];
const MAX_NAME_LEN = 40;
const MAX_TEXT_LEN = 800;

let commentMongoClient, commentMongoDB, commentsCol;

async function initCommentMongo() {
  try {
    if (commentMongoClient && commentMongoClient.topology && commentMongoClient.topology.isConnected && commentMongoClient.topology.isConnected()) return;
  } catch (e) {}
  commentMongoClient = new MongoClient(COMMENT_URL, { useNewUrlParser: true, useUnifiedTopology: true });
  await commentMongoClient.connect();
  commentMongoDB = commentMongoClient.db(COMMENT_DB);
  commentsCol = commentMongoDB.collection('comments');
  await commentsCol.createIndex({ createdAt: -1 });
  console.log('✅ Comment Mongo initialized (comments collection ready)');
}

function emptyReactions() {
  const r = {};
  for (const e of ALLOWED_EMOJIS) r[e] = 0;
  return r;
}

function serializeComment(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    text: doc.text,
    createdAt: doc.createdAt,
    reactions: { ...emptyReactions(), ...(doc.reactions || {}) },
    heartedByAdmin: !!doc.heartedByAdmin,
    adminReply: doc.adminReply
      ? { text: doc.adminReply.text, createdAt: doc.adminReply.createdAt }
      : null
  };
}

function sanitizeText(str, maxLen) {
  return String(str || '').trim().slice(0, maxLen);
}

// ---------- List all comments, newest first ----------
router.get('/api/comments', async (req, res) => {
  try {
    await initCommentMongo();
    const docs = await commentsCol.find({}).sort({ createdAt: -1 }).limit(500).toArray();
    res.json({ ok: true, comments: docs.map(serializeComment), botName: BOT_NAME_FANCY });
  } catch (err) {
    console.error('API /api/comments GET error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

// ---------- Post a new comment ----------
router.post('/api/comments', async (req, res) => {
  try {
    await initCommentMongo();
    const name = sanitizeText(req.body && req.body.name, MAX_NAME_LEN);
    const text = sanitizeText(req.body && req.body.text, MAX_TEXT_LEN);
    if (!name) return res.status(400).json({ ok: false, error: 'Name is required' });
    if (!text) return res.status(400).json({ ok: false, error: 'Comment text is required' });

    const doc = {
      name,
      text,
      createdAt: new Date(),
      reactions: emptyReactions(),
      heartedByAdmin: false,
      adminReply: null
    };
    const result = await commentsCol.insertOne(doc);
    doc._id = result.insertedId;
    res.json({ ok: true, comment: serializeComment(doc) });
  } catch (err) {
    console.error('API /api/comments POST error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

// ---------- React to a comment with an emoji ----------
router.post('/api/comments/:id/react', async (req, res) => {
  try {
    await initCommentMongo();
    const { id } = req.params;
    const { emoji } = req.body || {};
    if (!ALLOWED_EMOJIS.includes(emoji)) {
      return res.status(400).json({ ok: false, error: 'Unsupported emoji' });
    }
    let objectId;
    try { objectId = new ObjectId(id); } catch (e) {
      return res.status(400).json({ ok: false, error: 'Invalid comment id' });
    }
    const result = await commentsCol.findOneAndUpdate(
      { _id: objectId },
      { $inc: { [`reactions.${emoji}`]: 1 } },
      { returnDocument: 'after' }
    );
    const updated = result && result.value ? result.value : await commentsCol.findOne({ _id: objectId });
    if (!updated) return res.status(404).json({ ok: false, error: 'Comment not found' });
    res.json({ ok: true, comment: serializeComment(updated) });
  } catch (err) {
    console.error('API /api/comments/:id/react error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

// ---------- Admin reply (password protected) ----------
// Posting a reply here also marks the comment as "heartedByAdmin" — this is
// tracked completely separately from the normal reaction counts, so on the
// front end it renders as a small creator heart next to the reply instead of
// bumping the ❤️ button like a regular visitor reaction would.
router.post('/api/comments/:id/reply', async (req, res) => {
  try {
    await initCommentMongo();
    const { id } = req.params;
    const { password, text } = req.body || {};
    if (!password || password !== COMMENT_ADMIN_PASSWORD) {
      return res.status(401).json({ ok: false, error: 'Incorrect admin password' });
    }
    const replyText = sanitizeText(text, MAX_TEXT_LEN);
    if (!replyText) return res.status(400).json({ ok: false, error: 'Reply text is required' });

    let objectId;
    try { objectId = new ObjectId(id); } catch (e) {
      return res.status(400).json({ ok: false, error: 'Invalid comment id' });
    }

    const adminReply = { text: replyText, createdAt: new Date() };
    const result = await commentsCol.findOneAndUpdate(
      { _id: objectId },
      { $set: { adminReply, heartedByAdmin: true } },
      { returnDocument: 'after' }
    );
    const updated = result && result.value ? result.value : await commentsCol.findOne({ _id: objectId });
    if (!updated) return res.status(404).json({ ok: false, error: 'Comment not found' });
    res.json({ ok: true, comment: serializeComment(updated) });
  } catch (err) {
    console.error('API /api/comments/:id/reply error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

module.exports = router;
