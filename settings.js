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

import commentsRouter from './comments.js';

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
console.log(`📁 Static dir: ${dashboardStaticDir} (exists: ${fs.existsSync(dashboardStaticDir)})`);
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
// 🛡️ ADMIN HTML — MUST BE FIRST (before commentsRouter!)
// ============================================================
router.get('/admin', (req, res) => {
  const adminPath = path.join(dashboardStaticDir, 'admin.html');
  console.log(`📄 [/admin] Serving: ${adminPath} (exists: ${fs.existsSync(adminPath)})`);
  if (!fs.existsSync(adminPath)) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0b1020;color:#fff">
      <h1>❌ admin.html not found</h1>
      <p>Expected: <code>${adminPath}</code></p>
      <p>Available: <code>${fs.readdirSync(dashboardStaticDir).join(', ')}</code></p>
      </body></html>
    `);
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

// ============================================================
// 📦 MONGO INIT
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

  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await newsletterCol.createIndex({ jid: 1 }, { unique: true });
  console.log('✅ Mongo initialized (numbers/admins/newsletter) and collections ready');
}

// ============================================================
// 🌸 SAKURA SHARDS
// ============================================================
const SAKURA_CAPACITY = 30;
const SAKURA_SHARD_COUNT = Number(config.SAKURA_DB_COUNT || process.env.SAKURA_DB_COUNT || 10);
const SAKURA_BASE_URI = config.SAKURA_DB_URI || process.env.SAKURA_DB_URI || MONGO_URI;

let sakuraClient = null;
const sakuraShards = new Map();
let shardMapCol = null;

async function initShardMap() {
  if (shardMapCol) return;
  await initSettingsMongo();
  shardMapCol = settingsMongoDB.collection('sakura_shard_map');
  await shardMapCol.createIndex({ number: 1 }, { unique: true });
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

async function isSakuraFull(number) {
  const existing = await getShardIndexForNumber(number);
  if (existing !== null) return false;
  for (let i = 0; i < SAKURA_SHARD_COUNT; i++) {
    const shard = await getSakuraShard(i).catch(() => null);
    if (!shard) continue;
    const count = await shard.sessionsCol.countDocuments({});
    if (count < SAKURA_CAPACITY) return false;
  }
  return true;
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

async function initSettingsMongo() {
  try {
    if (settingsMongoClient && settingsMongoClient.topology && settingsMongoClient.topology.isConnected && settingsMongoClient.topology.isConnected()) return;
  } catch (e) {}
  settingsMongoClient = new MongoClient(SETTINGS_URI);
  await settingsMongoClient.connect();
  settingsMongoDB = settingsMongoClient.db(SETTINGS_DB);
  configsCol = settingsMongoDB.collection('configs');
  await configsCol.createIndex({ number: 1 }, { unique: true });
  console.log('✅ Settings Mongo initialized (configs collection ready)');
}

// ============================================================
// 💾 CREDS
// ============================================================
async function saveCredsToMongo(number, creds, keys = null) {
  const sanitized = number.replace(/[^0-9]/g, '');
  try {
    const index = await assignShardForNumber(sanitized);
    if (index === null) return { ok: false, full: true };
    const shard = await getSakuraShard(index);
    const now = new Date();
    const doc = { number: sanitized, creds, keys, updatedAt: now };
    await shard.sessionsCol.updateOne({ number: sanitized }, { $set: doc }, { upsert: true });
    await shardMapCol.updateOne({ number: sanitized }, { $set: { updatedAt: now } });
    return { ok: true, dbIndex: index };
  } catch (e) {
    console.error('saveCredsToMongo error:', e);
    return { ok: false, error: e.message || e };
  }
}

async function loadCredsFromMongo(number) {
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    const index = await getShardIndexForNumber(sanitized);
    if (index === null) return null;
    const shard = await getSakuraShard(index);
    if (!shard) return null;
    return await shard.sessionsCol.findOne({ number: sanitized }) || null;
  } catch (e) { console.error('loadCredsFromMongo error:', e); return null; }
}

async function removeSessionFromMongo(number) {
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    await initShardMap();
    const index = await getShardIndexForNumber(sanitized);
    if (index !== null) {
      const shard = await getSakuraShard(index);
      if (shard) await shard.sessionsCol.deleteOne({ number: sanitized });
    }
    await shardMapCol.deleteOne({ number: sanitized });
  } catch (e) { console.error('removeSessionFromMongo error:', e); }
}

async function addNumberToMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
  } catch (e) { console.error('addNumberToMongo', e); }
}

async function removeNumberFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.deleteOne({ number: sanitized });
  } catch (e) { console.error('removeNumberFromMongo', e); }
}

async function getAllNumbersFromMongo() {
  try {
    await initMongo();
    const docs = await numbersCol.find({}).toArray();
    return docs.map(d => d.number);
  } catch (e) { console.error('getAllNumbersFromMongo', e); return []; }
}

async function loadAdminsFromMongo() {
  try {
    await initMongo();
    const docs = await adminsCol.find({}).toArray();
    return docs.map(d => d.jid || d.number).filter(Boolean);
  } catch (e) { console.error('loadAdminsFromMongo', e); return []; }
}

async function addAdminToMongo(jidOrNumber) {
  try {
    await initMongo();
    await adminsCol.updateOne({ jid: jidOrNumber }, { $set: { jid: jidOrNumber } }, { upsert: true });
  } catch (e) { console.error('addAdminToMongo', e); }
}

async function removeAdminFromMongo(jidOrNumber) {
  try {
    await initMongo();
    await adminsCol.deleteOne({ jid: jidOrNumber });
  } catch (e) { console.error('removeAdminFromMongo', e); }
}

let _newslettersCache = null;
let _newslettersCacheAt = 0;
const NEWSLETTERS_CACHE_TTL_MS = 30 * 1000;

async function addNewsletterToMongo(jid, emojis = []) {
  try {
    await initMongo();
    const doc = { jid, emojis: Array.isArray(emojis) ? emojis : [], addedAt: new Date() };
    await newsletterCol.updateOne({ jid }, { $set: doc }, { upsert: true });
    _newslettersCache = null;
  } catch (e) { console.error('addNewsletterToMongo', e); throw e; }
}

async function removeNewsletterFromMongo(jid) {
  try {
    await initMongo();
    await newsletterCol.deleteOne({ jid });
    _newslettersCache = null;
  } catch (e) { console.error('removeNewsletterFromMongo', e); throw e; }
}

async function listNewslettersFromMongo() {
  if (_newslettersCache && (Date.now() - _newslettersCacheAt) < NEWSLETTERS_CACHE_TTL_MS) {
    return _newslettersCache;
  }
  try {
    await initMongo();
    const docs = await newsletterCol.find({}).toArray();
    _newslettersCache = docs.map(d => ({ jid: d.jid, emojis: Array.isArray(d.emojis) ? d.emojis : [] }));
    _newslettersCacheAt = Date.now();
    return _newslettersCache;
  } catch (e) { console.error('listNewslettersFromMongo', e); return _newslettersCache || []; }
}

// ============================================================
// 🔧 CUSTOM SETTINGS URI
// ============================================================
const customSettingsClients = new Map();

async function getCustomConfigsCollection(uri) {
  const cached = customSettingsClients.get(uri);
  if (cached) {
    try {
      if (cached.client.topology && cached.client.topology.isConnected && cached.client.topology.isConnected()) {
        return cached.col;
      }
    } catch (e) {}
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(SETTINGS_DB);
  const col = db.collection('configs');
  await col.createIndex({ number: 1 }, { unique: true }).catch(() => {});
  customSettingsClients.set(uri, { client, col });
  return col;
}

async function getSettingsUriForNumber(number) {
  try {
    await initSettingsMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await configsCol.findOne({ number: sanitized }, { projection: { settingsUri: 1 } });
    return (doc && doc.settingsUri) ? doc.settingsUri : null;
  } catch (e) { console.error('getSettingsUriForNumber', e); return null; }
}

async function setSettingsUriForNumber(number, uri) {
  try {
    await initSettingsMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    if (uri) {
      await configsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, settingsUri: uri } }, { upsert: true });
    } else {
      await configsCol.updateOne({ number: sanitized }, { $unset: { settingsUri: "" } }, { upsert: true });
    }
  } catch (e) { console.error('setSettingsUriForNumber', e); }
}

async function resolveConfigsCollectionForNumber(number) {
  const sanitized = number.replace(/[^0-9]/g, '');
  const uri = await getSettingsUriForNumber(sanitized);
  if (uri) {
    try { return await getCustomConfigsCollection(uri); }
    catch (e) { console.error('settings_uri connect failed:', e.message || e); }
  }
  await initSettingsMongo();
  return configsCol;
}

async function setUserConfigInMongo(number, conf) {
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    const col = await resolveConfigsCollectionForNumber(sanitized);
    await col.updateOne({ number: sanitized }, { $set: { number: sanitized, config: conf, updatedAt: new Date() } }, { upsert: true });
  } catch (e) { console.error('setUserConfigInMongo', e); }
}

async function loadUserConfigFromMongo(number) {
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    const col = await resolveConfigsCollectionForNumber(sanitized);
    const doc = await col.findOne({ number: sanitized });
    return doc ? doc.config : null;
  } catch (e) { console.error('loadUserConfigFromMongo', e); return null; }
}

function generateSettingsPassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const pool = letters + digits;
  let out = '';
  for (let i = 0; i < 6; i++) out += pool[crypto.randomInt(pool.length)];
  return out;
}

async function getOrCreateSettingsPassword(number) {
  try {
    await initSettingsMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const existing = await configsCol.findOne({ number: sanitized }, { projection: { settingsPassword: 1 } });
    if (existing && existing.settingsPassword) return existing.settingsPassword;
    const password = generateSettingsPassword();
    await configsCol.updateOne(
      { number: sanitized },
      { $set: { number: sanitized, settingsPassword: password }, $setOnInsert: { config: {}, updatedAt: new Date() } },
      { upsert: true }
    );
    return password;
  } catch (e) { console.error('getOrCreateSettingsPassword', e); return null; }
}

async function checkSettingsAuth(number, password) {
  try {
    await initSettingsMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    if (!sanitized || !password) return false;
    const doc = await configsCol.findOne({ number: sanitized }, { projection: { settingsPassword: 1 } });
    if (!doc || !doc.settingsPassword) return false;
    return doc.settingsPassword === String(password).trim().toUpperCase();
  } catch (e) { console.error('checkSettingsAuth', e); return false; }
}

// ============================================================
// 🪙 WALLET
// ============================================================
const COIN_COST_PER_DAY = 10;
const COIN_FIRST_LOGIN_BONUS = 10;
const COIN_DAILY_CLAIM = 5;
const COIN_DAILY_CLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  await channelReactCol.createIndex({ jid: 1 }, { unique: true });
  await walletsCol.createIndex({ number: 1 }, { unique: true });
  console.log(`✅ Channel-react Mongo initialized (${CHANNEL_REACT_DB})`);
}

async function getOrCreateWallet(number) {
  await initChannelReactMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  const existing = await walletsCol.findOne({ number: sanitized });
  if (existing) return { coins: existing.coins || 0, lastDailyClaimAt: existing.lastDailyClaimAt || null, isNewWallet: false };

  const doc = { number: sanitized, coins: COIN_FIRST_LOGIN_BONUS, lastDailyClaimAt: null, createdAt: new Date() };
  try {
    await walletsCol.insertOne(doc);
  } catch (e) {
    const raced = await walletsCol.findOne({ number: sanitized });
    if (raced) return { coins: raced.coins || 0, lastDailyClaimAt: raced.lastDailyClaimAt || null, isNewWallet: false };
    throw e;
  }
  return { coins: doc.coins, lastDailyClaimAt: null, isNewWallet: true };
}

async function getWallet(number) {
  await initChannelReactMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  const doc = await walletsCol.findOne({ number: sanitized });
  return doc ? { coins: doc.coins || 0, lastDailyClaimAt: doc.lastDailyClaimAt || null } : { coins: 0, lastDailyClaimAt: null };
}

async function claimDailyCoins(number) {
  await initChannelReactMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  await getOrCreateWallet(sanitized);
  const now = new Date();
  const wallet = await walletsCol.findOne({ number: sanitized });
  const last = wallet?.lastDailyClaimAt ? new Date(wallet.lastDailyClaimAt) : null;
  if (last && (now.getTime() - last.getTime()) < COIN_DAILY_CLAIM_INTERVAL_MS) {
    return { ok: false, nextClaimAt: new Date(last.getTime() + COIN_DAILY_CLAIM_INTERVAL_MS) };
  }
  const updated = await walletsCol.findOneAndUpdate(
    { number: sanitized },
    { $inc: { coins: COIN_DAILY_CLAIM }, $set: { lastDailyClaimAt: now } },
    { returnDocument: 'after' }
  );
  const doc = updated.value || updated;
  return { ok: true, coins: doc.coins, lastDailyClaimAt: doc.lastDailyClaimAt };
}

async function deductCoins(number, amount) {
  await initChannelReactMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  const updated = await walletsCol.findOneAndUpdate(
    { number: sanitized, coins: { $gte: amount } },
    { $inc: { coins: -amount } },
    { returnDocument: 'after' }
  );
  const doc = updated.value || updated;
  return doc ? doc.coins : null;
}

async function refundCoins(number, amount) {
  try {
    await initChannelReactMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await walletsCol.updateOne({ number: sanitized }, { $inc: { coins: amount } });
  } catch (e) { console.error('refundCoins', e); }
}

async function addChannelReactEntry({ number, jid, emojis, days }) {
  await initChannelReactMongo();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const doc = { jid, emojis: Array.isArray(emojis) ? emojis : [], number: number.replace(/[^0-9]/g, ''), days, addedAt: now, expiresAt };
  await channelReactCol.updateOne({ jid }, { $set: doc }, { upsert: true });
  return doc;
}

async function listChannelReactsForNumber(number) {
  await initChannelReactMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  const docs = await channelReactCol.find({ number: sanitized }).sort({ addedAt: -1 }).toArray();
  return docs.map(d => ({ jid: d.jid, emojis: d.emojis || [], days: d.days || 0, addedAt: d.addedAt, expiresAt: d.expiresAt }));
}

async function cleanupExpiredChannelReacts() {
  try {
    await initChannelReactMongo();
    const now = new Date();
    const expired = await channelReactCol.find({ expiresAt: { $lte: now } }).toArray();
    if (expired.length === 0) return;
    const jids = expired.map(d => d.jid);
    await channelReactCol.deleteMany({ jid: { $in: jids } });
  } catch (e) { console.error('cleanupExpiredChannelReacts', e); }
}

cleanupExpiredChannelReacts();
setInterval(cleanupExpiredChannelReacts, 10 * 60 * 1000);

// ============================================================
// 🛡️ ADMIN API
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

const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = (config.ADMIN_SESSION_HOURS || 12) * 60 * 60 * 1000;

function generateAdminToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAdminAuth(req, res, next) {
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

function requireConfirm(req, res, next) {
  if (req.headers['x-confirm'] !== 'yes') {
    return res.status(428).json({ ok: false, error: 'Confirmation required' });
  }
  next();
}

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

router.post('/api/admin/logout', requireAdminAuth, (req, res) => {
  adminSessions.delete(req.adminToken);
  logAdminAction('logout', { ip: req.ip });
  res.json({ ok: true });
});

router.get('/api/admin/me', requireAdminAuth, (req, res) => {
  res.json({ ok: true, session: { createdAt: req.adminSession.createdAt, ip: req.adminSession.ip } });
});

router.get('/api/admin/stats', requireAdminAuth, async (req, res) => {
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
      adminsList,
      newslettersList
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
        newslettersCount: newslettersList,
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

router.post('/api/admin/coins/give', requireAdminAuth, requireConfirm, async (req, res) => {
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

router.post('/api/admin/coins/set', requireAdminAuth, requireConfirm, async (req, res) => {
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

router.post('/api/admin/coins/deduct', requireAdminAuth, requireConfirm, async (req, res) => {
  try {
    const { number, amount, reason } = req.body || {};
    const amt = Number(amount);
    if (!number || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'Valid number and positive amount required' });
    await initChannelReactMongoExtended();
    const sanitized = number.replace(/[^0-9]/g, '');
    const result = await walletsCol.findOneAndUpdate({ number: sanitized, coins: { $gte: amt } }, { $inc: { coins: -amt } }, { returnDocument: 'after' });
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

router.post('/api/admin/coins/broadcast', requireAdminAuth, requireConfirm, async (req, res) => {
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

router.get('/api/admin/wallets', requireAdminAuth, async (req, res) => {
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

router.get('/api/admin/channels', requireAdminAuth, async (req, res) => {
  try {
    await initChannelReactMongoExtended();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const search = (req.query.search || '').replace(/[^0-9]/g, '');
    const filter = search ? { number: { $regex: search } } : {};
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      channelReactCol.find(filter).sort({ addedAt: -1 }).skip(skip).limit(limit).toArray(),
      channelReactCol.countDocuments(filter)
    ]);
    res.json({ ok: true, page, limit, total, pages: Math.ceil(total / limit), channels: items });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/admin/channels/add', requireAdminAuth, requireConfirm, async (req, res) => {
  try {
    const { number, jid, emojis, days } = req.body || {};
    if (!number || !jid || !jid.endsWith('@newsletter')) return res.status(400).json({ ok: false, error: 'number and valid @newsletter jid required' });
    if (!Array.isArray(emojis) || emojis.length === 0) return res.status(400).json({ ok: false, error: 'emojis required' });
    const numDays = Number(days) || 30;
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await addChannelReactEntry({ number: sanitized, jid, emojis, days: numDays });
    await logAdminAction('channels.add', { number: sanitized, jid, days: numDays });
    res.json({ ok: true, channel: doc });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/admin/channels/delete', requireAdminAuth, requireConfirm, async (req, res) => {
  try {
    const { jid } = req.body || {};
    if (!jid) return res.status(400).json({ ok: false, error: 'jid required' });
    await initChannelReactMongoExtended();
    const r = await channelReactCol.deleteOne({ jid });
    await logAdminAction('channels.delete', { jid, deleted: r.deletedCount });
    res.json({ ok: true, jid, deleted: r.deletedCount });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/admin/channels/extend', requireAdminAuth, async (req, res) => {
  try {
    const { jid, days } = req.body || {};
    const numDays = Number(days);
    if (!jid || !Number.isInteger(numDays) || numDays < 1) return res.status(400).json({ ok: false, error: 'jid and days required' });
    await initChannelReactMongoExtended();
    const doc = await channelReactCol.findOne({ jid });
    if (!doc) return res.status(404).json({ ok: false, error: 'Channel not found' });
    const base = doc.expiresAt && new Date(doc.expiresAt) > new Date() ? new Date(doc.expiresAt) : new Date();
    const newExpiry = new Date(base.getTime() + numDays * 24 * 60 * 60 * 1000);
    await channelReactCol.updateOne({ jid }, { $set: { expiresAt: newExpiry } });
    await logAdminAction('channels.extend', { jid, days: numDays, newExpiry });
    res.json({ ok: true, jid, expiresAt: newExpiry });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.get('/api/admin/sessions', requireAdminAuth, async (req, res) => {
  try {
    await initShardMap();
    const docs = await shardMapCol.find({}, { projection: { number: 1, updatedAt: 1, dbIndex: 1 } })
      .sort({ updatedAt: -1 }).toArray();
    const active = Array.from(activeSockets.keys());
    const merged = docs.map(d => ({ ...d, active: active.includes(d.number) }));
    res.json({ ok: true, sessions: merged, activeCount: active.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/admin/sessions/delete', requireAdminAuth, requireConfirm, async (req, res) => {
  try {
    const { number } = req.body || {};
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    const sanitized = ('' + number).replace(/[^0-9]/g, '');
    const running = activeSockets.get(sanitized);
    if (running) {
      try { if (typeof running.logout === 'function') await running.logout().catch(() => {}); } catch (e) {}
      try { running.ws?.close(); } catch (e) {}
      activeSockets.delete(sanitized);
      socketCreationTime.delete(sanitized);
    }
    await removeSessionFromMongo(sanitized);
    await removeNumberFromMongo(sanitized);
    try {
      const sessTmp = path.join(os.tmpdir(), `session_${sanitized}`);
      if (fs.existsSync(sessTmp)) fs.removeSync(sessTmp);
    } catch (e) {}
    await logAdminAction('sessions.delete', { number: sanitized });
    res.json({ ok: true, message: `Session ${sanitized} removed` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

// ============================================================
// 🔧 HELPERS
// ============================================================
function resolveReplyJid(m) {
  const raw = m?.key?.remoteJid;
  return (raw && raw.endsWith('@lid') && m.key.remoteJidAlt) ? m.key.remoteJidAlt : raw;
}

function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }
function getSriLankaTimestamp(){ return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss'); }

const activeSockets = new Map();
const intentionalDisconnects = new Set();
const socketCreationTime = new Map();
const pendingModApk = new Map();
const otpStore = new Map();

// ============================================================
// 👥 GROUP JOIN
// ============================================================
async function joinGroup(socket) {
  let retries = config.MAX_RETRIES;
  const inviteCodeMatch = (config.GROUP_INVITE_LINK || '').match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
  if (!inviteCodeMatch) return { status: 'failed', error: 'No group invite configured' };
  const inviteCode = inviteCodeMatch[1];
  while (retries > 0) {
    try {
      const response = await socket.groupAcceptInvite(inviteCode);
      if (response?.gid) return { status: 'success', gid: response.gid };
      throw new Error('No group ID in response');
    } catch (error) {
      retries--;
      let errorMessage = error.message || 'Unknown error';
      if (error.message && error.message.includes('not-authorized')) errorMessage = 'Bot not authorized';
      else if (error.message && error.message.includes('conflict')) errorMessage = 'Already a member';
      else if (error.message && error.message.includes('gone')) errorMessage = 'Invite invalid/expired';
      if (retries === 0) return { status: 'failed', error: errorMessage };
      await delay(2000 * (config.MAX_RETRIES - retries));
    }
  }
  return { status: 'failed', error: 'Max retries reached' };
}

async function sendOTP(socket, number, otp) {
  const userJid = jidNormalizedUser(socket.user.id);
  const message = formatMessage(`🔐 OTP — ${BOT_NAME_FANCY}`, `Your OTP: *${otp}*\nExpires in 5 min.`, BOT_NAME_FANCY);
  try { await socket.sendMessage(userJid, { text: message }); }
  catch (error) { console.error(`Failed to send OTP:`, error); throw error; }
}

// ============================================================
// 📱 PAIRING
// ============================================================
async function EmpirePair(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');

  try {
    const full = await isSakuraFull(sanitizedNumber);
    if (full) {
      if (!res.headersSent) {
        res.status(507).send({ ok: false, error: 'full', message: `System full.` });
      }
      return;
    }
  } catch (e) { console.error('Sakura capacity check failed:', e); }

  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
  await initMongo().catch(()=>{});
  try {
    const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
    if (mongoDoc && mongoDoc.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
      if (mongoDoc.keys) fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
    }
  } catch (e) { console.warn('Prefill from Mongo failed', e); }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

  try {
    const socket = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Safari'),
      markOnlineOnConnect: false
    });

    socketCreationTime.set(sanitizedNumber, Date.now());

    const _origSend = socket.sendMessage.bind(socket);
    socket.sendMessage = async (jid, content, opts) => {
      if (content && typeof content === 'object' && !content.react && !content.delete) {
        content = { ...content, contextInfo: NEWSLETTER_CONTEXT };
      }
      return _origSend(jid, content, opts);
    };

    if (!socket.authState.creds.registered) {
      let retries = config.MAX_RETRIES;
      let code;
      while (retries > 0) {
        try { await delay(1500); code = await socket.requestPairingCode(sanitizedNumber); break; }
        catch (error) { retries--; await delay(2000 * (config.MAX_RETRIES - retries)); }
      }
      if (!res.headersSent) res.send({ code });
    }

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
        const credsObj = JSON.parse(fileContent);
        const keysObj = state.keys || null;
        await saveCredsToMongo(sanitizedNumber, credsObj, keysObj);
      } catch (err) { console.error('Failed saving creds:', err); }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        try {
          try { await socket.sendPresenceUpdate('unavailable'); } catch (e) {}
          await delay(3000);
          const userJid = jidNormalizedUser(socket.user.id);
          await joinGroup(socket).catch(()=>({ status: 'failed', error: 'joinGroup failed' }));

          try {
            const newsletterListDocs = await listNewslettersFromMongo();
            for (const doc of newsletterListDocs) {
              try { if (typeof socket.newsletterFollow === 'function') await socket.newsletterFollow(doc.jid); } catch(e){}
            }
          } catch(e){}

          activeSockets.set(sanitizedNumber, socket);

          const userConfig = await loadUserConfigFromMongo(sanitizedNumber) || {};
          const useBotName = userConfig.botName || BOT_NAME_FANCY;
          const useLogo = userConfig.logo || config.RCD_IMAGE_PATH;
          const settingsPassword = await getOrCreateSettingsPassword(sanitizedNumber);

          const caption = formatMessage(useBotName,
            `✅ Connected!\n\n🔢 Number: ${sanitizedNumber}\n🕒 ${getSriLankaTimestamp()}\n\n🔐 Password: ${settingsPassword || 'N/A'}\n🌐 Panel: /settings.html`,
            useBotName
          );

          try {
            if (String(useLogo).startsWith('http')) {
              await socket.sendMessage(userJid, { image: { url: useLogo }, caption });
            } else {
              const buf = fs.readFileSync(useLogo);
              await socket.sendMessage(userJid, { image: buf, caption });
            }
          } catch (e) { await socket.sendMessage(userJid, { text: caption }); }

          await addNumberToMongo(sanitizedNumber);

          try {
            await delay(1000);
            intentionalDisconnects.add(sanitizedNumber);
            activeSockets.delete(sanitizedNumber);
            await socket.end(new Error('Intentional disconnect after pairing'));
          } catch (e) { console.error('Error releasing socket:', e); }

        } catch (e) { console.error('Connection open error:', e); }
      }
      if (connection === 'close') {
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (intentionalDisconnects.has(sanitizedNumber)) {
          intentionalDisconnects.delete(sanitizedNumber);
          activeSockets.delete(sanitizedNumber);
          return;
        }

        if (shouldReconnect) {
          activeSockets.delete(sanitizedNumber);
          setTimeout(() => {
            const mockRes = { headersSent: true, send: () => {}, status: () => mockRes };
            EmpirePair(sanitizedNumber, mockRes).catch(e => console.error('Reconnect failed:', e));
          }, 2000);
        } else {
          try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
          await removeSessionFromMongo(sanitizedNumber).catch(()=>{});
          activeSockets.delete(sanitizedNumber);
        }
      }
    });

    activeSockets.set(sanitizedNumber, socket);

  } catch (error) {
    console.error('Pairing error:', error);
    socketCreationTime.delete(sanitizedNumber);
    if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
  }
}

// ============================================================
// 🧭 PUBLIC API ROUTES
// ============================================================
router.get('/code', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'Number required' });
  if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
    return res.status(200).send({ status: 'already_connected', message: 'Already connected' });
  }
  await EmpirePair(number, res);
});

router.get('/pair', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'Number required' });
  if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
    return res.status(200).send({ status: 'already_connected', message: 'Already connected' });
  }
  await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
  res.status(200).send({ botName: BOT_NAME_FANCY, count: activeSockets.size, numbers: Array.from(activeSockets.keys()), timestamp: getSriLankaTimestamp() });
});

router.get('/ping', (req, res) => {
  res.status(200).send({ status: 'active', botName: BOT_NAME_FANCY, message: `🇱🇰${config.BOT_NAME} FREE BOT`, activesession: activeSockets.size });
});

router.get('/connect-all', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No numbers found' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(number, mockRes);
      results.push({ number, status: 'connection_initiated' });
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Connect all error:', error); res.status(500).send({ error: 'Failed' }); }
});

router.get('/reconnect', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No numbers' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      try { await EmpirePair(number, mockRes); results.push({ number, status: 'connection_initiated' }); } catch (err) { results.push({ number, status: 'failed', error: err.message }); }
      await delay(1000);
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Reconnect error:', error); res.status(500).send({ error: 'Failed' }); }
});

// ============================================================
// 📨 NEWSLETTER
// ============================================================
router.post('/newsletter/add', async (req, res) => {
  const { jid, emojis } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  if (!jid.endsWith('@newsletter')) return res.status(400).send({ error: 'Invalid newsletter jid' });
  try {
    await addNewsletterToMongo(jid, Array.isArray(emojis) ? emojis : []);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

router.post('/newsletter/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await removeNewsletterFromMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

router.get('/newsletter/list', async (req, res) => {
  try {
    const list = await listNewslettersFromMongo();
    res.status(200).send({ status: 'ok', channels: list });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

// ============================================================
// 👑 OLD ADMIN
// ============================================================
router.post('/admin/add', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await addAdminToMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

router.post('/admin/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await removeAdminFromMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

router.get('/admin/list', async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.status(200).send({ status: 'ok', admins: list });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

// ============================================================
// ⚙️ SETTINGS API
// ============================================================
router.post('/api/settings/login', async (req, res) => {
  try {
    const { number, password } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });
    const cfg = await loadUserConfigFromMongo(sanitizedNumber) || {};
    const settingsUri = await getSettingsUriForNumber(sanitizedNumber);
    res.json({ ok: true, number: sanitizedNumber, config: cfg, settingsUri: settingsUri || null });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/settings/get', async (req, res) => {
  try {
    const { number, password } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });
    const cfg = await loadUserConfigFromMongo(sanitizedNumber) || {};
    const settingsUri = await getSettingsUriForNumber(sanitizedNumber);
    res.json({ ok: true, number: sanitizedNumber, config: cfg, settingsUri: settingsUri || null });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/settings/update', async (req, res) => {
  try {
    const { number, password, config: newConfig, settingsUri } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password required' });
    if (!newConfig || typeof newConfig !== 'object') return res.status(400).json({ ok: false, error: 'Config object required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });

    if (typeof settingsUri === 'string') {
      const trimmed = settingsUri.trim();
      if (trimmed) {
        try { await getCustomConfigsCollection(trimmed); }
        catch (e) { return res.status(400).json({ ok: false, error: 'Could not connect' }); }
        await setSettingsUriForNumber(sanitizedNumber, trimmed);
      } else {
        await setSettingsUriForNumber(sanitizedNumber, null);
      }
    }

    const existing = await loadUserConfigFromMongo(sanitizedNumber) || {};
    if (typeof newConfig.ownerNumber === 'string') {
      newConfig.ownerNumber = newConfig.ownerNumber.replace(/[^0-9]/g, '');
    }
    const merged = { ...existing, ...newConfig };
    await setUserConfigInMongo(sanitizedNumber, merged);
    const currentSettingsUri = await getSettingsUriForNumber(sanitizedNumber);
    res.json({ ok: true, message: 'Settings updated', config: merged, settingsUri: currentSettingsUri || null });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

// ============================================================
// 🎨 REACT API
// ============================================================
router.post('/api/react/login', async (req, res) => {
  try {
    const { number, password } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });
    const wallet = await getOrCreateWallet(sanitizedNumber);
    res.json({ ok: true, number: sanitizedNumber, coins: wallet.coins, lastDailyClaimAt: wallet.lastDailyClaimAt, isNewWallet: wallet.isNewWallet });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/react/wallet', async (req, res) => {
  try {
    const { number, password } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });
    const wallet = await getWallet(sanitizedNumber);
    res.json({ ok: true, coins: wallet.coins, lastDailyClaimAt: wallet.lastDailyClaimAt });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/react/claim-daily', async (req, res) => {
  try {
    const { number, password } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });
    const result = await claimDailyCoins(sanitizedNumber);
    if (!result.ok) return res.status(400).json({ ok: false, error: 'already_claimed', nextClaimAt: result.nextClaimAt });
    res.json({ ok: true, coins: result.coins, lastDailyClaimAt: result.lastDailyClaimAt, claimed: COIN_DAILY_CLAIM });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/react/add-channel', async (req, res) => {
  try {
    const { number, password, jid, emojis, days } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });

    if (!jid || typeof jid !== 'string' || !jid.endsWith('@newsletter')) {
      return res.status(400).json({ ok: false, error: 'A valid @newsletter jid required' });
    }
    if (!Array.isArray(emojis) || emojis.length === 0) {
      return res.status(400).json({ ok: false, error: 'Pick at least one emoji' });
    }
    const numDays = Number(days);
    if (!Number.isInteger(numDays) || numDays < 1 || numDays > 365) {
      return res.status(400).json({ ok: false, error: 'Days must be 1-365' });
    }

    const cost = numDays * COIN_COST_PER_DAY;
    const remaining = await deductCoins(sanitizedNumber, cost);
    if (remaining === null) {
      const wallet = await getWallet(sanitizedNumber);
      return res.status(402).json({ ok: false, error: 'insufficient_coins', needed: cost, have: wallet.coins });
    }

    try {
      const doc = await addChannelReactEntry({ number: sanitizedNumber, jid, emojis, days: numDays });
      await logCoinTransaction({ number: sanitizedNumber, amount: -cost, type: 'channel_purchase', reason: `Channel ${jid} for ${numDays}d` });
      res.json({ ok: true, coins: remaining, jid: doc.jid, emojis: doc.emojis, days: doc.days, expiresAt: doc.expiresAt });
    } catch (e) {
      await refundCoins(sanitizedNumber, cost);
      throw e;
    }
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.post('/api/react/channels', async (req, res) => {
  try {
    const { number, password } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });
    const channels = await listChannelReactsForNumber(sanitizedNumber);
    res.json({ ok: true, channels });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

// ============================================================
// 📊 PUBLIC API
// ============================================================
router.get('/code/api/sessions', async (req, res) => {
  try {
    await initShardMap();
    const docs = await shardMapCol.find({}, { projection: { number: 1, updatedAt: 1, dbIndex: 1 } }).sort({ updatedAt: -1 }).toArray();
    res.json({ ok: true, sessions: docs });
  } catch (err) {
    console.error('API /code/api/sessions error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

router.get('/code/api/sakura-status', async (req, res) => {
  try {
    const status = await getSakuraStatus();
    res.json({ ok: true, ...status });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.get('/code/api/active', async (req, res) => {
  try {
    const keys = Array.from(activeSockets.keys());
    res.json({ ok: true, active: keys, count: keys.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.get('/code/api/newsletters', async (req, res) => {
  try {
    const list = await listNewslettersFromMongo();
    res.json({ ok: true, list });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.get('/code/api/admins', async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.json({ ok: true, list });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

// ============================================================
// 🚨 PROCESS HANDLERS
// ============================================================
process.on('exit', () => {
  activeSockets.forEach((socket, number) => {
    try { socket.ws.close(); } catch (e) {}
    activeSockets.delete(number);
    socketCreationTime.delete(number);
    try { fs.removeSync(path.join(os.tmpdir(), `session_${number}`)); } catch(e){}
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// ============================================================
// ⚠️ COMMENTS ROUTER — MUST BE LAST!
// ============================================================
router.use(commentsRouter);

// ============================================================
// 🚀 INIT
// ============================================================
initMongo().catch(err => console.warn('Mongo init failed at startup', err));
initSettingsMongo().catch(err => console.warn('Settings Mongo init failed at startup', err));
initChannelReactMongo().catch(err => console.warn('Channel-react Mongo init failed at startup', err));

export default router;
