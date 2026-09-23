import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import pino from 'pino';
import moment from 'moment-timezone';
import { Jimp, JimpMime } from 'jimp';
import crypto from 'crypto';
import axios from 'axios';
import * as FileType from 'file-type';
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';
import { sms, downloadMediaMessage } from './msg.js';
import { fileURLToPath } from 'url';

import {
  default as makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  downloadContentFromMessage,
  DisconnectReason
} from 'baileys';

import {
  BOT_NAME_FANCY,
  config,
  NEWSLETTER_CONTEXT,
  MONGO_URI,
  MONGO_DB,
  SETTINGS_URI,
  SETTINGS_DB,
  CHANNEL_REACT_DB
} from './config.js';

// COMMENT OUT THIS LINE IF comments.js DOES NOT EXIST YET TO PREVENT ERRORS
// import commentsRouter from './comments.js'; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
router.use(express.json());

// ============================================================
// 📁 STATIC DIR — Auto-detect 'sakura' or 'dashboard_static'
// ============================================================
let dashboardStaticDir = path.join(__dirname, 'dashboard_static');
if (!fs.existsSync(dashboardStaticDir)) {
  const sakuraDir = path.join(__dirname, 'sakura');
  if (fs.existsSync(sakuraDir)) {
    dashboardStaticDir = sakuraDir;
  } else {
    fs.ensureDirSync(dashboardStaticDir);
  }
}
console.log(`📁 Static dir: ${dashboardStaticDir} (exists:${fs.existsSync(dashboardStaticDir)})`);
try {
  const files = fs.readdirSync(dashboardStaticDir);
  console.log(`📂 Files in static dir: ${files.join(', ')}`);
} catch (e) {
  console.warn('Could not read static dir:', e.message);
}

// Serve static assets
router.use('/dashboard/static', express.static(dashboardStaticDir));
router.use('/static', express.static(dashboardStaticDir));

// ============================================================
// 🛡️ ADMIN HTML — CRITICAL FIXES
// ============================================================
// Admin auth functions must be defined BEFORE being used in routes.
let adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = (config.ADMIN_SESSION_HOURS || 12) * 60 * 60 * 1000;

function generateAdminToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware to check if admin is logged in for API
function requireAdminAuthAPI(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken || (req.body && req.body.adminToken);
  const session = adminSessions.get(token);
  if (!session || (Date.now() - session.createdAt) > ADMIN_SESSION_TTL_MS) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  req.adminSession = session;
  req.adminToken = token;
  next();
}

// Middleware to enforce confirmation header for sensitive actions
function requireConfirm(req, res, next) {
  if (req.headers['x-confirm'] !== 'yes') {
    return res.status(428).json({ ok: false, error: 'Confirmation required' });
  }
  next();
}

// --- [ADMIN UI ROUTE] ---
// This route serves the admin.html file. 
// It DOES NOT require login itself, otherwise you could never load the login page.
// The login logic inside admin.html will handle authentication via API.
router.get('/admin', (req, res) => {
  const adminPath = path.join(dashboardStaticDir, 'admin.html');
  console.log(`📄 [/admin] Serving: ${adminPath} (exists:${fs.existsSync(adminPath)})`);
  
  if (!fs.existsSync(adminPath)) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0b1020;color:#fff">
      <h1>❌ admin.html not found</h1>
      <p>Expected: <code>${adminPath}</code></p>
      </body></html>
    ');
  }
  res.sendFile(adminPath);
});

// ============================================================
// 📄 HTML ROUTES — Serve from static dir
// ============================================================
const htmlPages = ['pair.html', 'settings.html', 'react.html', 'main.html', 'index.html'];
htmlPages.forEach(page => {
  router.get('/' + page, (req, res) => {
    const p = path.join(dashboardStaticDir, page);
    if (fs.existsSync(p)) return res.sendFile(p);
    res.status(404).send(`${page} not found`);
  });
});

// ============================================================
// 🏠 ROOT ROUTE — index.html (or main.html if no index)
// ============================================================
router.get('/', (req, res, next) => {
  const indexPath = path.join(dashboardStaticDir, 'index.html');
  const mainPath = path.join(dashboardStaticDir, 'main.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  if (fs.existsSync(mainPath)) return res.sendFile(mainPath);
  next();
});

router.get('/dashboard', (req, res) => {
  const indexPath = path.join(dashboardStaticDir, 'index.html');
  const mainPath = path.join(dashboardStaticDir, 'main.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  if (fs.existsSync(mainPath)) return res.sendFile(mainPath);
  res.status(404).send('Dashboard not found');
});

// --- [COMMENTS ROUTER] ---
// Moved this BELOW the HTML routes to ensure it doesn't interfere.
// UNCOMMENT IF YOU HAVE comments.js setup.
// if (typeof commentsRouter !== 'undefined') {
//     router.use('/code/api/comments', commentsRouter);
// }


// ============================================================
// 📦 MONGO INIT & UTILS
// ============================================================
let mongoClient, mongoDB;
let numbersCol, adminsCol, newsletterCol;

async function initMongo() {
  try {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected && mongoClient.topology.isConnected()) return;
  } catch (e) {}
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  mongoDB = mongoClient.db(MONGO_DB);

  numbersCol = mongoDB.collection('numbers');
  adminsCol = mongoDB.collection('admins');
  newsletterCol = mongoDB.collection('newsletter_list');

  await numbersCol.createIndex({ number: 1 }, { unique: true }).catch(() => {});
  await newsletterCol.createIndex({ jid: 1 }, { unique: true }).catch(() => {});
  console.log('✅ Mongo initialized (numbers/admins/newsletter) and collections ready');
}

// Placeholder for uptime/timestamp function used in admin stats
function getSriLankaTimestamp() {
  return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss Z');
}

// Need activeSockets defined for stats
const activeSockets = new Map();


// ============================================================
// 🌸 SAKURA SHARDS
// ============================================================
const SAKURA_CAPACITY = 30;
const SAKURA_SHARD_COUNT = Number(config.SAKURA_DB_COUNT || process.env.SAKURA_DB_COUNT || 10);
const SAKURA_BASE_URI = config.SAKURA_DB_URI || process.env.SAKURA_DB_URI || MONGO_URI;

let sakuraClient = null;
const sakuraShards = new Map();
let shardMapCol = null;

async function initSettingsMongo() {
    try {
        if (settingsMongoClient && settingsMongoClient.topology && settingsMongoClient.topology.isConnected && settingsMongoClient.topology.isConnected()) return;
    } catch (e) {}
    settingsMongoClient = new MongoClient(SETTINGS_URI);
    await settingsMongoClient.connect();
    settingsMongoDB = settingsMongoClient.db(SETTINGS_DB);
    configsCol = settingsMongoDB.collection('configs');
    await configsCol.createIndex({ number: 1 }, { unique: true }).catch(() => {});
    console.log('✅ Settings Mongo initialized (configs collection ready)');
}

async function initShardMap() {
  if (shardMapCol) return;
  await initSettingsMongo();
  shardMapCol = settingsMongoDB.collection('sakura_shard_map');
  await shardMapCol.createIndex({ number: 1 }, { unique: true }).catch(() => {});
}

async function getSakuraClient() {
  try {
    if (sakuraClient && sakuraClient.topology && sakuraClient.topology.isConnected && sakuraClient.topology.isConnected()) {
      return sakuraClient;
    }
  } catch (e) {}
  sakuraClient = new MongoClient(SAKURA_BASE_URI);
  await sakuraClient.connect();
  console.log(`✅ Connected to sakura cluster (${SAKURA_SHARD_COUNT} db shards)`);
  return sakuraClient;
}

async function getSakuraShard(index) {
  if (index < 0 || index >= SAKURA_SHARD_COUNT) return null;
  const cached = sakuraShards.get(index);
  if (cached) return cached;
  const client = await getSakuraClient();
  const dbName = `sakuradb-${index + 1}`;
  const db = client.db(dbName);
  const sessionsCol = db.collection('sessions');
  await sessionsCol.createIndex({ number: 1 }, { unique: true }).catch(() => {});
  const shard = { db, sessionsCol };
  sakuraShards.set(index, shard);
  return shard;
}

async function getShardIndexForNumber(number) {
  await initShardMap();
  const doc = await shardMapCol.findOne({ number });
  return doc ? doc.dbIndex : null;
}

async function assignShardForNumber(number) {
  await initShardMap();
  const existing = await shardMapCol.findOne({ number });
  if (existing) return existing.dbIndex;

  for (let i = 0; i < SAKURA_SHARD_COUNT; i++) {
    const shard = await getSakuraShard(i).catch(() => null);
    if (!shard) continue;
    const count = await shard.sessionsCol.countDocuments({});
    if (count < SAKURA_CAPACITY) {
      await shardMapCol.updateOne(
        { number },
        { $set: { number, dbIndex: i, assignedAt: new Date() } },
        { upsert: true }
      );
      return i;
    }
  }
  return null;
}

async function getSakuraStatus() {
  const shards = [];
  for (let i = 0; i < SAKURA_SHARD_COUNT; i++) {
    const shard = await getSakuraShard(i).catch(() => null);
    const count = shard ? await shard.sessionsCol.countDocuments({}).catch(() => null) : null;
    shards.push({ name: `sakuradb-${i + 1}`, count, capacity: SAKURA_CAPACITY, full: count !== null ? count >= SAKURA_CAPACITY : null });
  }
  const totalUsed = shards.reduce((sum, s) => sum + (s.count || 0), 0);
  const totalCapacity = SAKURA_CAPACITY * SAKURA_SHARD_COUNT;
  return { shards, totalUsed, totalCapacity, allFull: shards.every(s => s.full) };
}

// ============================================================
// ⚙️ SETTINGS MONGO
// ============================================================
let settingsMongoClient, settingsMongoDB;
let configsCol;

// Moved settings mongo init up where it was first used.

// ============================================================
// 💾 CREDS / WALLET / CHANNELREACT
// ============================================================
// Omitted for brevity, assuming they remain as in your original snippet.

// Need wallet/channel init functions defined for admin stats
let channelReactMongoClient, channelReactMongoDB, channelReactCol, walletsCol;

async function initChannelReactMongo() {
    try {
        if (channelReactMongoClient && channelReactMongoClient.topology && channelReactMongoClient.topology.isConnected && channelReactMongoClient.topology.isConnected()) return;
    } catch (e) {}
    channelReactMongoClient = new MongoClient(SETTINGS_URI);
    await channelReactMongoClient.connect();
    channelReactMongoDB = channelReactMongoClient.db(CHANNEL_REACT_DB);
    channelReactCol = channelReactMongoDB.collection('channels');
    walletsCol = channelReactMongoDB.collection('wallets');
    await channelReactCol.createIndex({ jid: 1 }, { unique: true }).catch(() => {});
    await walletsCol.createIndex({ number: 1 }, { unique: true }).catch(() => {});
    console.log(`✅ Channel-react Mongo initialized (${CHANNEL_REACT_DB})`);
}

// ============================================================
// 🛡️ ADMIN API ROUTES
// ============================================================
let coinTxCol;
let adminAuditCol;

async function initChannelReactMongoExtended() {
  await initChannelReactMongo();
  if (!coinTxCol) {
    coinTxCol = channelReactMongoDB.collection('coin_transactions');
    await coinTxCol.createIndex({ number: 1, at: -1 }).catch(() => {});
  }
  if (!adminAuditCol) {
    adminAuditCol = channelReactMongoDB.collection('admin_audit');
    await adminAuditCol.createIndex({ at: -1 }).catch(() => {});
  }
}

async function logCoinTransaction(tx) {
  try {
    await initChannelReactMongoExtended();
    await coinTxCol.insertOne({ ...tx, at: tx.at || new Date() });
  } catch (e) { console.error('logCoinTransaction', e); }
}

async function logAdminAction(action, meta = {}) {
  try {
    await initChannelReactMongoExtended();
    await adminAuditCol.insertOne({ action, meta, at: new Date() });
  } catch (e) { console.error('logAdminAction', e); }
}

// --- [LOGIN API] ---
router.post('/api/admin/login', (req, res) => {
  const { key } = req.body || {};
  const ADMIN_KEY = config.ADMIN_PANEL_KEY || 'SASINDA123';
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid admin key' });
  }
  const token = generateAdminToken();
  adminSessions.set(token, { createdAt: Date.now(), ip: req.ip });
  logAdminAction('login', { ip: req.ip });
  res.json({ ok: true, token, expiresIn: ADMIN_SESSION_TTL_MS });
});

// --- [LOGOUT API] ---
router.post('/api/admin/logout', requireAdminAuthAPI, (req, res) => {
  adminSessions.delete(req.adminToken);
  logAdminAction('logout', { ip: req.ip });
  res.json({ ok: true });
});

// --- [ME API - Verify Session] ---
router.get('/api/admin/me', requireAdminAuthAPI, (req, res) => {
  res.json({ ok: true, session: { createdAt: req.adminSession.createdAt, ip: req.adminSession.ip } });
});

// --- [STATS API] ---
router.get('/api/admin/stats', requireAdminAuthAPI, async (req, res) => {
  try {
    await initChannelReactMongoExtended();
    await initMongo();
    await initShardMap();

    const [
      totalWallets,
      totalCoinsAgg,
      totalChannels,
      activeChannels,
      expiredChannels,
      totalSessions,
      numbersCount,
      adminsList, // This is just a count, rename for clarity
      newslettersCount // Renamed for clarity
    ] = await Promise.all([
      walletsCol.countDocuments({}),
      walletsCol.aggregate([{ $group: { _id: null, sum: { $sum: '$coins' } } }]).toArray(),
      channelReactCol.countDocuments({}),
      channelReactCol.countDocuments({ expiresAt: { $gt: new Date() } }),
      channelReactCol.countDocuments({ expiresAt: { $lte: new Date() } }),
      shardMapCol.countDocuments({}).catch(() => 0),
      numbersCol.countDocuments({}).catch(() => 0),
      adminsCol.countDocuments({}).catch(() => 0),
      newsletterCol.countDocuments({}).catch(() => 0)
    ]);

    const sakura = await getSakuraStatus();

    res.json({
      ok: true,
      stats: {
        totalWallets,
        totalCoinsInCirculation: totalCoinsAgg[0]?.sum || 0,
        totalChannels,
        activeChannels,
        expiredChannels,
        totalSessions,
        numbersCount,
        adminsCount: adminsList,
        newslettersCount: newslettersCount,
        activeSockets: activeSockets.size,
        sakura,
        uptimeSec: Math.floor(process.uptime()),
        timestamp: getSriLankaTimestamp()
      }
    });
  } catch (err) {
    console.error('admin stats', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

// --- [COIN APIs] ---
// Give Coins
async function getOrCreateWallet(number) {
    await initChannelReactMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const existing = await walletsCol.findOne({ number: sanitized });
    if (existing) return { coins: existing.coins || 0, lastDailyClaimAt: existing.lastDailyClaimAt || null, isNewWallet: false };

    const doc = { number: sanitized, coins: 10, lastDailyClaimAt: null, createdAt: new Date() };
    try {
        await walletsCol.insertOne(doc);
    } catch (e) {
        const raced = await walletsCol.findOne({ number: sanitized });
        if (raced) return { coins: raced.coins || 0, lastDailyClaimAt: raced.lastDailyClaimAt || null, isNewWallet: false };
        throw e;
    }
    return { coins: doc.coins, lastDailyClaimAt: null, isNewWallet: true };
}

router.post('/api/admin/coins/give', requireAdminAuthAPI, requireConfirm, async (req, res) => {
  try {
    const { number, amount, reason } = req.body || {};
    const amt = Number(amount);
    if (!number || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'Valid number and positive amount required' });
    await initChannelReactMongoExtended();
    const sanitized = number.replace(/[^0-9]/g, '');
    await getOrCreateWallet(sanitized);
    const result = await walletsCol.findOneAndUpdate({ number: sanitized }, { $inc: { coins: amt } }, { returnDocument: 'after' });
    const doc = result?.value || result;
    await logCoinTransaction({ number: sanitized, amount: amt, type: 'admin_give', reason: reason || 'Admin grant' });
    await logAdminAction('coins.give', { number: sanitized, amount: amt, reason });
    res.json({ ok: true, number: sanitized, coins: doc.coins, added: amt });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

// Set Coins
router.post('/api/admin/coins/set', requireAdminAuthAPI, requireConfirm, async (req, res) => {
  try {
    const { number, amount, reason } = req.body || {};
    const amt = Number(amount);
    if (!number || !Number.isFinite(amt) || amt < 0) return res.status(400).json({ ok: false, error: 'Valid number and non-negative amount required' });
    await initChannelReactMongoExtended();
    const sanitized = number.replace(/[^0-9]/g, '');
    await getOrCreateWallet(sanitized);
    const result = await walletsCol.findOneAndUpdate({ number: sanitized }, { $set: { coins: amt } }, { returnDocument: 'after' });
    const doc = result?.value || result;
    await logCoinTransaction({ number: sanitized, amount: amt, type: 'admin_set', reason: reason || 'Admin set' });
    await logAdminAction('coins.set', { number: sanitized, after: amt, reason });
    res.json({ ok: true, number: sanitized, coins: doc.coins });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

// Deduct Coins
async function getWallet(number) {
    await initChannelReactMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await walletsCol.findOne({ number: sanitized });
    return doc ? { coins: doc.coins || 0, lastDailyClaimAt: doc.lastDailyClaimAt || null } : { coins: 0, lastDailyClaimAt: null };
}

router.post('/api/admin/coins/deduct', requireAdminAuthAPI, requireConfirm, async (req, res) => {
  try {
    const { number, amount, reason } = req.body || {};
    const amt = Number(amount);
    if (!number || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'Valid number and positive amount required' });
    await initChannelReactMongoExtended();
    const sanitized = number.replace(/[^0-9]/g, '');
    const result = await walletsCol.findOneAndUpdate({ number: sanitized, coins: { $gte: amt } }, {$inc: { coins: -amt } }, { returnDocument: 'after' });
    const doc = result?.value || result;
    if (!doc) {
      const w = await getWallet(sanitized);
      return res.status(400).json({ ok: false, error: 'insufficient_coins', have: w.coins });
    }
    await logCoinTransaction({ number: sanitized, amount: -amt, type: 'admin_deduct', reason: reason || 'Admin deduction' });
    await logAdminAction('coins.deduct', { number: sanitized, amount: amt, reason });
    res.json({ ok: true, number: sanitized, coins: doc.coins, deducted: amt });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

// Broadcast Coins
router.post('/api/admin/coins/broadcast', requireAdminAuthAPI, requireConfirm, async (req, res) => {
  try {
    const { amount, reason } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'Positive amount required' });
    await initChannelReactMongoExtended();
    const result = await walletsCol.updateMany({}, { $inc: { coins: amt } });
    await logAdminAction('coins.broadcast', { amount: amt, count: result.modifiedCount, reason });
    res.json({ ok: true, modified: result.modifiedCount, amountPerUser: amt });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

// --- [WALLETS LIST API] ---
router.get('/api/admin/wallets', requireAdminAuthAPI, async (req, res) => {
    try {
        await initChannelReactMongoExtended();
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const search = (req.query.search || '').replace(/[^0-9]/g, '');
        const filter = search ? { number: { $regex: search } } : {};
        const skip = (page - 1) * limit;

        const [items, total, totalCoinsAgg] = await Promise.all([
            walletsCol.find(filter).sort({ coins: -1 }).skip(skip).limit(limit).toArray(),
            walletsCol.countDocuments(filter),
            walletsCol.aggregate([{ $group: { _id: null, sum: { $sum: '$coins' } } }]).toArray()
        ]);

        res.json({
            ok: true, page, limit, total,
            pages: Math.ceil(total / limit),
            totalCoinsInCirculation: totalCoinsAgg[0]?.sum || 0,
            wallets: items
        });
    } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});


export default router;

// --- END OF FIXED ADMIN CODE ---
