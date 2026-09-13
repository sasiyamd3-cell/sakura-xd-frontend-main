import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import pino from 'pino';
import moment from 'moment-timezone';
import Jimp from 'jimp';
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

let mongoClient, mongoDB;
let numbersCol, adminsCol, newsletterCol;

async function initMongo() {
  try {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected && mongoClient.topology.isConnected()) return;
  } catch(e){}
  mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await mongoClient.connect();
  mongoDB = mongoClient.db(MONGO_DB);

  numbersCol = mongoDB.collection('numbers');
  adminsCol = mongoDB.collection('admins');
  newsletterCol = mongoDB.collection('newsletter_list');

  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await newsletterCol.createIndex({ jid: 1 }, { unique: true });
  console.log('✅ Mongo initialized (numbers/admins/newsletter) and collections ready');
}







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
  sakuraClient = new MongoClient(SAKURA_BASE_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await sakuraClient.connect();
  console.log(`✅ Connected to sakura cluster (${SAKURA_SHARD_COUNT} db shards: sakuradb-1..${SAKURA_SHARD_COUNT})`);
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


let settingsMongoClient, settingsMongoDB;
let configsCol;

async function initSettingsMongo() {
  try {
    if (settingsMongoClient && settingsMongoClient.topology && settingsMongoClient.topology.isConnected && settingsMongoClient.topology.isConnected()) return;
  } catch (e) {}
  settingsMongoClient = new MongoClient(SETTINGS_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await settingsMongoClient.connect();
  settingsMongoDB = settingsMongoClient.db(SETTINGS_DB);
  configsCol = settingsMongoDB.collection('configs');
  await configsCol.createIndex({ number: 1 }, { unique: true });
  console.log('✅ Settings Mongo initialized (configs collection ready)');
}



async function saveCredsToMongo(number, creds, keys = null) {
  const sanitized = number.replace(/[^0-9]/g, '');
  try {
    const index = await assignShardForNumber(sanitized);
    if (index === null) {
      console.error(`🛑 All sakura DBs are full (${SAKURA_SHARD_COUNT} x ${SAKURA_CAPACITY}). Cannot save session for ${sanitized}.`);
      return { ok: false, full: true };
    }
    const shard = await getSakuraShard(index);
    const now = new Date();
    const doc = { number: sanitized, creds, keys, updatedAt: now };
    await shard.sessionsCol.updateOne({ number: sanitized }, { $set: doc }, { upsert: true });
    await shardMapCol.updateOne({ number: sanitized }, { $set: { updatedAt: now } });
    console.log(`Saved creds to sakuradb-${index + 1} for ${sanitized}`);
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
    const doc = await shard.sessionsCol.findOne({ number: sanitized });
    return doc || null;
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
    console.log(`Removed session from sakura shard for ${sanitized}`);
  } catch (e) { console.error('removeSessionFromMongo error:', e); }
}

async function addNumberToMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
    console.log(`Added number ${sanitized} to Mongo numbers`);
  } catch (e) { console.error('addNumberToMongo', e); }
}

async function removeNumberFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.deleteOne({ number: sanitized });
    console.log(`Removed number ${sanitized} from Mongo numbers`);
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
    const doc = { jid: jidOrNumber };
    await adminsCol.updateOne({ jid: jidOrNumber }, { $set: doc }, { upsert: true });
    console.log(`Added admin ${jidOrNumber}`);
  } catch (e) { console.error('addAdminToMongo', e); }
}

async function removeAdminFromMongo(jidOrNumber) {
  try {
    await initMongo();
    await adminsCol.deleteOne({ jid: jidOrNumber });
    console.log(`Removed admin ${jidOrNumber}`);
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
    console.log(`Added newsletter ${jid} -> emojis: ${doc.emojis.join(',')}`);
  } catch (e) { console.error('addNewsletterToMongo', e); throw e; }
}

async function removeNewsletterFromMongo(jid) {
  try {
    await initMongo();
    await newsletterCol.deleteOne({ jid });
    _newslettersCache = null;
    console.log(`Removed newsletter ${jid}`);
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
  const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
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
      await configsCol.updateOne(
        { number: sanitized },
        { $set: { number: sanitized, settingsUri: uri } },
        { upsert: true }
      );
    } else {
      await configsCol.updateOne(
        { number: sanitized },
        { $unset: { settingsUri: "" } },
        { upsert: true }
      );
    }
  } catch (e) { console.error('setSettingsUriForNumber', e); }
}


async function resolveConfigsCollectionForNumber(number) {
  const sanitized = number.replace(/[^0-9]/g, '');
  const uri = await getSettingsUriForNumber(sanitized);
  if (uri) {
    try {
      return await getCustomConfigsCollection(uri);
    } catch (e) {
      console.error('settings_uri connect failed, falling back to main DB:', e.message || e);
    }
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


const COIN_COST_PER_DAY = 10;
const COIN_FIRST_LOGIN_BONUS = 10;
const COIN_DAILY_CLAIM = 5;
const COIN_DAILY_CLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000;

let channelReactMongoClient, channelReactMongoDB, channelReactCol, walletsCol;

async function initChannelReactMongo() {
  try {
    if (channelReactMongoClient && channelReactMongoClient.topology && channelReactMongoClient.topology.isConnected && channelReactMongoClient.topology.isConnected()) return;
  } catch (e) {}
  channelReactMongoClient = new MongoClient(SETTINGS_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await channelReactMongoClient.connect();
  channelReactMongoDB = channelReactMongoClient.db(CHANNEL_REACT_DB);
  channelReactCol = channelReactMongoDB.collection('channels');
  walletsCol = channelReactMongoDB.collection('wallets');
  await channelReactCol.createIndex({ jid: 1 }, { unique: true });
  await walletsCol.createIndex({ number: 1 }, { unique: true });
  console.log(`✅ Channel-react Mongo initialized (${CHANNEL_REACT_DB}.channels + .wallets ready)`);
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
  console.log(`🪙 New react.html wallet for ${sanitized} — granted ${COIN_FIRST_LOGIN_BONUS} coin first-login bonus`);
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
  await getOrCreateWallet(sanitized); // ensure wallet exists
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
  const doc = {
    jid,
    emojis: Array.isArray(emojis) ? emojis : [],
    number: number.replace(/[^0-9]/g, ''),
    days,
    addedAt: now,
    expiresAt
  };
  await channelReactCol.updateOne({ jid }, { $set: doc }, { upsert: true });
  console.log(`Added channel-react ${jid} for ${doc.number} -> ${doc.emojis.join(',')} | ${days}d | expires ${expiresAt.toISOString()}`);
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
    console.log(`🗑️ [ChannelReact] Auto-deleted ${jids.length} expired channel(s): ${jids.join(', ')}`);
  } catch (e) { console.error('cleanupExpiredChannelReacts', e); }
}

cleanupExpiredChannelReacts();
setInterval(cleanupExpiredChannelReacts, 10 * 60 * 1000);
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

async function sendAdminConnectMessage(socket, number, groupResult, sessionConfig = {}) {
  const admins = await loadAdminsFromMongo();
  const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`;
  const botName = sessionConfig.botName || BOT_NAME_FANCY;
  const image = sessionConfig.logo || config.RCD_IMAGE_PATH;
  const caption = formatMessage(botName, `📞 Number: ${number}`, botName);
  for (const admin of admins) {
    try {
      const to = admin.includes('@') ? admin : `${admin}@s.whatsapp.net`;
      if (String(image).startsWith('http')) {
        await socket.sendMessage(to, { image: { url: image }, caption });
      } else {
        try {
          const buf = fs.readFileSync(image);
          await socket.sendMessage(to, { image: buf, caption });
        } catch (e) {
          await socket.sendMessage(to, { image: { url: config.RCD_IMAGE_PATH }, caption });
        }
      }
    } catch (err) {
      console.error('Failed to send connect message to admin', admin, err?.message || err);
    }
  }
}

async function sendOwnerConnectMessage(socket, number, groupResult, sessionConfig = {}) {
  try {
    const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
    const activeCount = activeSockets.size;
    const botName = sessionConfig.botName || BOT_NAME_FANCY;
    const image = sessionConfig.logo || config.RCD_IMAGE_PATH;
    const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(`👑 OWNER CONNECT`, `📞 Number: ${number}\n\n🔢 Active sessions: ${activeCount}`, botName);
    if (String(image).startsWith('http')) {
      await socket.sendMessage(ownerJid, { image: { url: image }, caption });
    } else {
      try {
        const buf = fs.readFileSync(image);
        await socket.sendMessage(ownerJid, { image: buf, caption });
      } catch (e) {
        await socket.sendMessage(ownerJid, { image: { url: config.RCD_IMAGE_PATH }, caption });
      }
    }
  } catch (err) { console.error('Failed to send owner connect message:', err); }
}

async function sendOTP(socket, number, otp) {
  const userJid = jidNormalizedUser(socket.user.id);
  const message = formatMessage(`🔐 OTP VERIFICATION — ${BOT_NAME_FANCY}`, `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.\n\nNumber: ${number}`, BOT_NAME_FANCY);
  try { await socket.sendMessage(userJid, { text: message }); console.log(`OTP ${otp} sent to ${number}`); }
  catch (error) { console.error(`Failed to send OTP to ${number}:`, error); throw error; }
}


async function resize(image, width, height) {
  let oyy = await Jimp.read(image);
  return await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
}



async function EmpirePair(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');

  // Stop early if this is a brand-new number and every sakura DB is full.
  // Existing/registered numbers (already in the shard map) are never blocked.
  try {
    const full = await isSakuraFull(sanitizedNumber);
    if (full) {
      console.error(`🛑 Rejected pairing for ${sanitizedNumber}: all sakuradb-1..${SAKURA_SHARD_COUNT} shards are full (${SAKURA_CAPACITY} sessions each).`);
      if (!res.headersSent) {
        res.status(507).send({
          ok: false,
          error: 'full',
          message: `System full. All ${SAKURA_SHARD_COUNT} sakura databases (${SAKURA_CAPACITY} sessions each) are at capacity — new sessions cannot be created right now.`
        });
      }
      return;
    }
  } catch (e) {
    console.error('Sakura capacity check failed, continuing:', e);
  }

  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
  await initMongo().catch(()=>{});
  try {
    const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
    if (mongoDoc && mongoDoc.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
      if (mongoDoc.keys) fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
      console.log('Prefilled creds from Mongo');
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
      } catch (err) { console.error('Failed saving creds on creds.update:', err); }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        try {
          try { await socket.sendPresenceUpdate('unavailable'); } catch (e) {}

          await delay(3000);
          const userJid = jidNormalizedUser(socket.user.id);
          const groupResult = await joinGroup(socket).catch(()=>({ status: 'failed', error: 'joinGroup not configured' }));

          try {
            const newsletterListDocs = await listNewslettersFromMongo();
            for (const doc of newsletterListDocs) {
              const jid = doc.jid;
              try { if (typeof socket.newsletterFollow === 'function') await socket.newsletterFollow(jid); } catch(e){}
            }
          } catch(e){}

          activeSockets.set(sanitizedNumber, socket);
          const groupStatus = groupResult.status === 'success' ? 'Joined successfully' : `Failed to join group: ${groupResult.error}`;

          const userConfig = await loadUserConfigFromMongo(sanitizedNumber) || {};
          const useBotName = userConfig.botName || BOT_NAME_FANCY;
          const useLogo = userConfig.logo || config.RCD_IMAGE_PATH;

          const initialCaption = formatMessage(useBotName,
            `✅\n\n✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n🕒 Connecting: Bot will become active in a few seconds`,
            useBotName
          );

          let sentMsg = null;
          try {
            if (String(useLogo).startsWith('http')) {
              sentMsg = await socket.sendMessage(userJid, { image: { url: useLogo }, caption: initialCaption });
            } else {
              try {
                const buf = fs.readFileSync(useLogo);
                sentMsg = await socket.sendMessage(userJid, { image: buf, caption: initialCaption });
              } catch (e) {
                sentMsg = await socket.sendMessage(userJid, { image: { url: config.RCD_IMAGE_PATH }, caption: initialCaption });
              }
            }
          } catch (e) {
            console.warn('Failed to send initial connect message (image). Falling back to text.', e?.message || e);
            try { sentMsg = await socket.sendMessage(userJid, { text: initialCaption }); } catch(e){}
          }

          await delay(4000);

          const settingsPassword = await getOrCreateSettingsPassword(sanitizedNumber);

          const updatedCaption = formatMessage(useBotName,
            `✅\n\n✅ Successfully connected and ACTIVE!\n\n🔢 Number: ${sanitizedNumber}\n🩵 🕒 Connected at: ${getSriLankaTimestamp()}\n\n⏳ Bot will be connected within the next 6 minutes...\n\n🔐 Settings Password: ${settingsPassword || 'unavailable'}\n🌐 Settings Panel: open settings.html, enter this number and password to edit your bot's settings.`,
            useBotName
          );

          try {
            if (sentMsg && sentMsg.key) {
              try {
                await socket.sendMessage(userJid, { delete: sentMsg.key });
              } catch (delErr) {
                console.warn('Could not delete original connect message (not fatal):', delErr?.message || delErr);
              }
            }

            try {
              if (String(useLogo).startsWith('http')) {
                await socket.sendMessage(userJid, { image: { url: useLogo }, caption: updatedCaption });
              } else {
                try {
                  const buf = fs.readFileSync(useLogo);
                  await socket.sendMessage(userJid, { image: buf, caption: updatedCaption });
                } catch (e) {
                  await socket.sendMessage(userJid, { text: updatedCaption });
                }
              }
            } catch (imgErr) {
              await socket.sendMessage(userJid, { text: updatedCaption });
            }
          } catch (e) {
            console.error('Failed during connect-message edit sequence:', e);
          }

          await addNumberToMongo(sanitizedNumber);




          try {
            await delay(1000);
            console.log(`Releasing connection for ${sanitizedNumber} after sending connect message (session kept in Mongo).`);
            intentionalDisconnects.add(sanitizedNumber);
            activeSockets.delete(sanitizedNumber);
            await socket.end(new Error('Intentional disconnect after pairing - session handed off'));
          } catch (e) { console.error('Error releasing socket after connect:', e); }

        } catch (e) {
          console.error('Connection open error:', e);
          try { exec(`pm2.restart ${process.env.PM2_NAME || 'CHAMA-MINI-main'}`); } catch(e) { console.error('pm2 restart failed', e); }
        }
      }
      if (connection === 'close') {
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (intentionalDisconnects.has(sanitizedNumber)) {

          console.log(`Socket for ${sanitizedNumber} closed intentionally, not reconnecting on this server.`);
          intentionalDisconnects.delete(sanitizedNumber);
          activeSockets.delete(sanitizedNumber);
          return;
        }

        if (shouldReconnect) {

          console.log(`Connection closed (code ${statusCode}) for ${sanitizedNumber}, reconnecting...`);
          activeSockets.delete(sanitizedNumber);
          setTimeout(() => {
            const mockRes = { headersSent: true, send: () => {}, status: () => mockRes };
            EmpirePair(sanitizedNumber, mockRes).catch(e => console.error('Reconnect failed:', e));
          }, 2000);
        } else {

          console.log(`Session logged out for ${sanitizedNumber}, clearing session.`);
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

router.get('/', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'Number parameter is required' });
  if (activeSockets.has(number.replace(/[^0-9]/g, ''))) return res.status(200).send({ status: 'already_connected', message: 'This number is already connected' });
  await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
  res.status(200).send({ botName: BOT_NAME_FANCY, count: activeSockets.size, numbers: Array.from(activeSockets.keys()), timestamp: getSriLankaTimestamp() });
});

router.get('/ping', (req, res) => {
  res.status(200).send({ status: 'active', botName: BOT_NAME_FANCY, message: `🇱🇰${config.BOT_NAME}  FREE BOT`, activesession: activeSockets.size });
});

router.get('/connect-all', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No numbers found to connect' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(number, mockRes);
      results.push({ number, status: 'connection_initiated' });
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Connect all error:', error); res.status(500).send({ error: 'Failed to connect all bots' }); }
});

router.get('/reconnect', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No session numbers found in MongoDB' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      try { await EmpirePair(number, mockRes); results.push({ number, status: 'connection_initiated' }); } catch (err) { results.push({ number, status: 'failed', error: err.message }); }
      await delay(1000);
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Reconnect error:', error); res.status(500).send({ error: 'Failed to reconnect bots' }); }
});

router.get('/update-config', async (req, res) => {
  const { number, config: configString } = req.query;
  if (!number || !configString) return res.status(400).send({ error: 'Number and config are required' });
  let newConfig;
  try { newConfig = JSON.parse(configString); } catch (error) { return res.status(400).send({ error: 'Invalid config format' }); }
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
  const otp = generateOTP();
  otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });
  try { await sendOTP(socket, sanitizedNumber, otp); res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' }); }
  catch (error) { otpStore.delete(sanitizedNumber); res.status(500).send({ error: 'Failed to send OTP' }); }
});

router.get('/verify-otp', async (req, res) => {
  const { number, otp } = req.query;
  if (!number || !otp) return res.status(400).send({ error: 'Number and OTP are required' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const storedData = otpStore.get(sanitizedNumber);
  if (!storedData) return res.status(400).send({ error: 'No OTP request found for this number' });
  if (Date.now() >= storedData.expiry) { otpStore.delete(sanitizedNumber); return res.status(400).send({ error: 'OTP has expired' }); }
  if (storedData.otp !== otp) return res.status(400).send({ error: 'Invalid OTP' });
  try {
    await setUserConfigInMongo(sanitizedNumber, storedData.newConfig);
    otpStore.delete(sanitizedNumber);
    const sock = activeSockets.get(sanitizedNumber);
    if (sock) await sock.sendMessage(jidNormalizedUser(sock.user.id), { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('📌 CONFIG UPDATED', 'Your configuration has been successfully updated!', BOT_NAME_FANCY) });
    res.status(200).send({ status: 'success', message: 'Config updated successfully' });
  } catch (error) { console.error('Failed to update config:', error); res.status(500).send({ error: 'Failed to update config' }); }
});

router.post('/api/settings/login', async (req, res) => {
  try {
    const { number, password } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password are required' });
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
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password are required' });
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
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password are required' });
    if (!newConfig || typeof newConfig !== 'object') return res.status(400).json({ ok: false, error: 'Config object is required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });


    if (typeof settingsUri === 'string') {
      const trimmed = settingsUri.trim();
      if (trimmed) {
        try {
          await getCustomConfigsCollection(trimmed);
        } catch (e) {
          return res.status(400).json({ ok: false, error: 'Could not connect to the provided settings_uri: ' + (e.message || e) });
        }
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

    const sock = activeSockets.get(sanitizedNumber);
    if (sock) {
      try {
        await sock.sendMessage(jidNormalizedUser(sock.user.id), {
          image: { url: config.RCD_IMAGE_PATH },
          caption: formatMessage('📌 SETTINGS UPDATED', 'Your bot settings were just updated from the settings panel.', BOT_NAME_FANCY)
        });
      } catch (e) {}
    }

    const currentSettingsUri = await getSettingsUriForNumber(sanitizedNumber);
    res.json({ ok: true, message: 'Settings updated successfully', config: merged, settingsUri: currentSettingsUri || null });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});


router.post('/api/react/login', async (req, res) => {
  try {
    const { number, password } = req.body || {};
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password are required' });
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
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password are required' });
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
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password are required' });
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
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password are required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });

    if (!jid || typeof jid !== 'string' || !jid.endsWith('@newsletter')) {
      return res.status(400).json({ ok: false, error: 'A valid channel jid ending in @newsletter is required' });
    }
    if (!Array.isArray(emojis) || emojis.length === 0) {
      return res.status(400).json({ ok: false, error: 'Pick at least one emoji' });
    }
    const numDays = Number(days);
    if (!Number.isInteger(numDays) || numDays < 1 || numDays > 365) {
      return res.status(400).json({ ok: false, error: 'Days must be a whole number between 1 and 365' });
    }

    const cost = numDays * COIN_COST_PER_DAY;
    const remaining = await deductCoins(sanitizedNumber, cost);
    if (remaining === null) {
      const wallet = await getWallet(sanitizedNumber);
      return res.status(402).json({ ok: false, error: 'insufficient_coins', needed: cost, have: wallet.coins });
    }

    try {
      const doc = await addChannelReactEntry({ number: sanitizedNumber, jid, emojis, days: numDays });
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
    if (!number || !password) return res.status(400).json({ ok: false, error: 'Number and password are required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const valid = await checkSettingsAuth(sanitizedNumber, password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect number or password' });
    const channels = await listChannelReactsForNumber(sanitizedNumber);
    res.json({ ok: true, channels });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

router.get('/getabout', async (req, res) => {
  const { number, target } = req.query;
  if (!number || !target) return res.status(400).send({ error: 'Number and target number are required' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
  const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  try {
    const statusData = await socket.fetchStatus(targetJid);
    const aboutStatus = statusData.status || 'No status available';
    const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
    res.status(200).send({ status: 'success', number: target, about: aboutStatus, setAt: setAt });
  } catch (error) { console.error(`Failed to fetch status for ${target}:`, error); res.status(500).send({ status: 'error', message: `Failed to fetch About status for ${target}.` }); }
});

const dashboardStaticDir = path.join(__dirname, 'dashboard_static');
if (!fs.existsSync(dashboardStaticDir)) fs.ensureDirSync(dashboardStaticDir);
router.use('/dashboard/static', express.static(dashboardStaticDir));
router.get('/dashboard', async (req, res) => {
  res.sendFile(path.join(dashboardStaticDir, 'index.html'));
});

router.get('/api/sessions', async (req, res) => {
  try {
    await initShardMap();
    const docs = await shardMapCol.find({}, { projection: { number: 1, updatedAt: 1, dbIndex: 1 } }).sort({ updatedAt: -1 }).toArray();
    res.json({ ok: true, sessions: docs });
  } catch (err) {
    console.error('API /api/sessions error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

router.get('/api/sakura-status', async (req, res) => {
  try {
    const status = await getSakuraStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error('API /api/sakura-status error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

router.get('/api/active', async (req, res) => {
  try {
    const keys = Array.from(activeSockets.keys());
    res.json({ ok: true, active: keys, count: keys.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

router.post('/api/session/delete', async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    const sanitized = ('' + number).replace(/[^0-9]/g, '');
    const running = activeSockets.get(sanitized);
    if (running) {
      try { if (typeof running.logout === 'function') await running.logout().catch(()=>{}); } catch(e){}
      try { running.ws?.close(); } catch(e){}
      activeSockets.delete(sanitized);
      socketCreationTime.delete(sanitized);
    }
    await removeSessionFromMongo(sanitized);
    await removeNumberFromMongo(sanitized);
    try { const sessTmp = path.join(os.tmpdir(), `session_${sanitized}`); if (fs.existsSync(sessTmp)) fs.removeSync(sessTmp); } catch(e){}
    res.json({ ok: true, message: `Session ${sanitized} removed` });
  } catch (err) {
    console.error('API /api/session/delete error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

router.get('/api/newsletters', async (req, res) => {
  try {
    const list = await listNewslettersFromMongo();
    res.json({ ok: true, list });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});
router.get('/api/admins', async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.json({ ok: true, list });
  } catch (err) { res.status(500).json({ ok: false, error: err.message || err }); }
});

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
  try { exec(`pm2.restart ${process.env.PM2_NAME || 'CHAMA-MINI-main'}`); } catch(e) { console.error('Failed to restart pm2:', e); }
});


router.use(commentsRouter);

initMongo().catch(err => console.warn('Mongo init failed at startup', err));
initSettingsMongo().catch(err => console.warn('Settings Mongo init failed at startup', err));
initChannelReactMongo().catch(err => console.warn('Channel-react Mongo init failed at startup', err));

export default router;

