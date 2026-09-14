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
  CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb6UR8S8fewn0otjcc0g',
  NEWSLETTER_JID: '120363409995383814@newsletter',

  OWNER_NUMBER: process.env.OWNER_NUMBER || '94770475809',
  OWNER_NAME: 'Thilina Anuhas',

  OWNER_CONTACTS: [
    { name: 'SASIND', number: '94767475809' },
    { name: 'SASIND', number: '94767475809' },
    { name: 'SASIND', number: '94767475809' },
  ],

  BOT_NAME: 'MIYORA MD',
  BOT_VERSION: 'V1',
  BOT_FOOTER: 'ᴘᴏᴡᴇʀᴅ ʙʏ ʙʟᴀᴄᴋ ᴄᴀᴛ ᴏꜰᴄ',

  RCD_IMAGE_PATH: 'https://raw.githubusercontent.com/NimeshMihiranga-Neno/sakura-help/main/IMG-20260707-WA0031.jpg',
  IMAGE_PATH: 'https://raw.githubusercontent.com/NimeshMihiranga-Neno/sakura-help/main/IMG-20260707-WA0031.jpg',

  BUTTON_IMAGES: {
    ALIVE: 'https://raw.githubusercontent.com/NimeshMihiranga-Neno/sakura-help/main/IMG-20260707-WA0031.jpg'
  },

  OTP_EXPIRY: 300000,

  MODE: process.env.BOT_MODE || 'public',

  SAKURA_DB_URI: process.env.SAKURA_DB_URI || 'mongodb+srv://mrshrii404:JLtbz0CEOC1u6CwS@shri.gkhohrr.mongodb.net/',
  SAKURA_DB_COUNT: process.env.SAKURA_DB_COUNT || 10
};

export const NEWSLETTER_CONTEXT = {
  forwardingScore: 1,
  isForwarded: true,

  forwardedNewsletterMessageInfo: {
    newsletterJid: '120363424190766692@newsletter',
    newsletterName: '♡⸝⸝> 𝐌𝐈𝐘𝐎𝐑𝐀 𝐌𝐃 🌸 <⸝⸝♡',
    serverMessageId: 999
  }
};

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
