export const BOT_NAME_FANCY = '♡⸝⸝> ̫ <⸝⸝♡ 𝐌𝐈𝐘𝐎𝐑𝐀 𝐌𝐃 🌸';

export const config = {
  AUTO_VIEW_STATUS: 'false',
  AUTO_LIKE_STATUS: 'true',
  AUTO_RECORDING: 'false',
  AUTO_VV_UNLOCK: 'false',
  AUTO_VV_UNLOCK_MODE: 'inbox',
  AUTO_ANTIDELETE: 'false',
  AUTO_ANTIDELETE_MODE: 'inbox',

  AUTO_LIKE_EMOJI: [
    '🔥','👍','❤️','💜','💙','💚','🧡','🤍','🖤',
    '💖','💗','💓','💞','💕','💝','💘','💟',
    '✨','🌟','💫','⚡','☀️','🌈','🌙','🌸','🌷','🌼','🌺','🌻',
    '🍓','🍒','🍎','🍉','🍇','🍰','🧁','🍭','🍬','🍫','🍩','🍪',
    '🐣','🐥','🐤','🐰','🐼','🐨','🦊','🧸','🐶','🐱','🐭',
    '🎀','🎁','🎈','🎉','🎊','💎','👑','🏆','🎶','🎵'
  ],

  PREFIX: '.',
  MAX_RETRIES: 3,

  GROUP_INVITE_LINK: 'https://chat.whatsapp.com/KBy93MkplPmGLwbPU3GSnd',
  CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbAJE36E50UhXhxcPh2M',
  NEWSLETTER_JID: '120363411194438648@newsletter',

  OWNER_NUMBER: process.env.OWNER_NUMBER || '94770475809',
  OWNER_NAME: 'saainda denuwan ',

  OWNER_CONTACTS: [
    { name: 'SASIND', number: '94770475809' },
    { name: 'SASIND', number: '94770475809' },
    { name: 'SASIND', number: '94770475809' },
  ],

  BOT_NAME: 'MIYORA MD',
  BOT_VERSION: 'V1',
  BOT_FOOTER: 'ᴘᴏᴡᴇʀᴅ ʙʏ sasiya ᴏꜰᴄ | https://whatsapp.com/channel/0029VbAJE36E50UhXhxcPh2M',

  RCD_IMAGE_PATH: 'https://files.catbox.moe/u6ek3x.png',
  IMAGE_PATH: 'https://files.catbox.moe/u6ek3x.png',

  BUTTON_IMAGES: {
    ALIVE: 'https://files.catbox.moe/u6ek3x.png'
  },

  OTP_EXPIRY: 300000,

  MODE: process.env.BOT_MODE || 'public',

  SAKURA_DB_URI: process.env.SAKURA_DB_URI || 'mongodb+srv://mrshrii404:JLtbz0CEOC1u6CwS@shri.gkhohrr.mongodb.net/',
  SAKURA_DB_COUNT: process.env.SAKURA_DB_COUNT || 10,

  // 🔐 ADMIN PANEL
  ADMIN_PANEL_KEY: process.env.ADMIN_PANEL_KEY || 'SASINDA123',
  ADMIN_SESSION_HOURS: Number(process.env.ADMIN_SESSION_HOURS || 12),
  ADMIN_MAX_AMOUNT: Number(process.env.ADMIN_MAX_AMOUNT || 1000000),

  // 📢 CHANNEL / NEWSLETTER INFO
  CHANNEL_URL: 'https://whatsapp.com/channel/0029VbAJE36E50UhXhxcPh2M',
  CHANNEL_NAME: '♡⸝⸝> 𝐌𝐈𝐘𝐎𝐑𝐀 𝐌𝐃 🌸 <⸝⸝♡'
};

export const NEWSLETTER_CONTEXT = {
  forwardingScore: 1,
  isForwarded: true,

  forwardedNewsletterMessageInfo: {
    newsletterJid: '120363412616808702@newsletter',
    newsletterName: '♡⸝⸝> 𝐌𝐈𝐘𝐎𝐑𝐀 𝐌𝐃 🌸 <⸝⸝♡',
    serverMessageId: 999
  }
};

// 📢 CHANNEL URL (global export)
export const CHANNEL_URL = 'https://whatsapp.com/channel/0029VbAJE36E50UhXhxcPh2M';

export const MONGO_URI =
  process.env.MONGO_URI ||
  'mongodb+srv://mrshrii404:JLtbz0CEOC1u6CwS@shri.gkhohrr.mongodb.net/';

export const MONGO_DB =
  process.env.MONGO_DB || 'SAKURADB';

export const SETTINGS_URI =
  process.env.SETTINGS_URI ||
  'mongodb+srv://mrshrii404:JLtbz0CEOC1u6CwS@shri.gkhohrr.mongodb.net/';

export const SETTINGS_DB =
  process.env.SETTINGS_DB || 'SETTINGSDB';

export const COMMENT_URL =
  process.env.COMMENT_URL ||
  'mongodb+srv://mrshrii404:JLtbz0CEOC1u6CwS@shri.gkhohrr.mongodb.net/';

export const COMMENT_DB =
  process.env.COMMENT_DB || 'COMMENTSDB';

export const CHANNEL_REACT_DB =
  process.env.CHANNEL_REACT_DB || 'CHANNELREACTDB';

export const COMMENT_ADMIN_PASSWORD =
  process.env.COMMENT_ADMIN_PASSWORD || 'Nimesh@123';
