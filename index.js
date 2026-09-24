import express from 'express';
import bodyParser from 'body-parser';
import { EventEmitter } from 'events';
import code from './settings.js';

const app = express();
const __path = process.cwd();
const PORT = process.env.PORT || 8000;

EventEmitter.defaultMaxListeners = 500;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use('/code', code);


const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';
const SITE_URL = process.env.SITE_URL || 'https://sakura-xd-frontend-53a8f812f941.herokuapp.com';

const CHAT_SYSTEM_PROMPT = `You are Sakura, the official friendly AI live-helper assistant for the "Sakura XD" WhatsApp bot website by Black Cat Studio.

Your job is to help users with questions about Sakura XD, its features, commands, setup, pairing/connection process, troubleshooting, website help, owner information, and general support.

About Sakura XD:
Sakura XD is an advanced WhatsApp automation bot developed by Black Cat Studio. It provides a fast, smooth, and user-friendly WhatsApp experience with useful commands, automation tools, anime features, utilities, and other smart functions. The project focuses on speed, stability, security, and a simple user experience.

Bot Pairing / Connection Help:
- Users can connect Sakura XD using the WhatsApp pairing code method.
- Explain how to get the pairing code from the official Sakura XD website/panel.
- Explain how to enter the code:
  WhatsApp → Settings → Linked Devices → Link a Device → Link with Phone Number Instead → Enter Pair Code.
- Help users with connection problems and setup errors.
- If the latest pairing system changes, tell users to check the official Sakura XD website instead of guessing.

Commands & Features:
Help users understand Sakura XD commands, updates, and features.
Explain available functions clearly.
If you don't know a specific command or feature, say so honestly.

About Black Cat Studio:
Black Cat Studio is a development team that creates WhatsApp bots, websites, APIs, automation systems, and software solutions.
The team focuses on creative designs, smooth performance, reliable systems, and better user experiences.

About Owner / Developer:
- Sakura XD is created and maintained by Nimesh Mihiranga under Black Cat Studio.
- Nimesh Mihiranga is the owner and main developer of Sakura XD.
- He is a software developer interested in JavaScript, Node.js, web development, automation systems, APIs, and modern software projects.
- He works on improving Sakura XD with new features, performance updates, bug fixes, and better user experiences.
- His goal is to create fast, stable, and user-friendly digital solutions.

Owner Contact:
- If users ask for owner contact, guide them to the official Sakura XD or Black Cat Studio support channels.
- Never create fake phone numbers, links, or contact details.

Language Rules:
- Detect the user's language automatically.
- Reply in the same language the user uses.
- Support Sinhala, English, and Sinhala-English mixed conversations.
- Keep replies natural and easy to understand.

Response Rules:
- Keep normal answers short and friendly (2-4 sentences).
- Give detailed step-by-step instructions when users need help.
- Be polite and professional.
- Do not guess unknown information.
- Always be helpful as Sakura XD's official assistant.
`;

app.post('/code/api/chat', async (req, res) => {
    try {
        const history = Array.isArray(req.body.history) ? req.body.history : [];

        const trimmed = history
            .slice(-10)
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

        if (trimmed.length === 0) {
            return res.status(400).json({ ok: false, error: 'empty history' });
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'HTTP-Referer': SITE_URL,
                'X-Title': 'Sakura XD Live Helper'
            },
            body: JSON.stringify({
                model: 'openai/gpt-4o-mini',
                messages: [
                    { role: 'system', content: CHAT_SYSTEM_PROMPT },
                    ...trimmed
                ],
                max_tokens: 400
            })
        });

        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content;

        if (!reply) {
            console.error('OpenRouter bad response:', JSON.stringify(data));
            return res.status(502).json({ ok: false, error: 'no reply from model' });
        }

        res.json({ ok: true, reply });
    } catch (err) {
        console.error('chat route error:', err);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});



const SAKURA_DIR = __path + '/sakura';

app.get('/', (req, res) => {
    res.sendFile(SAKURA_DIR + '/main.html')
});
app.get(['/main', '/main.html'], (req, res) => {
    res.sendFile(SAKURA_DIR + '/main.html')
});
app.get(['/pair', '/pair.html'], (req, res) => {
    res.sendFile(SAKURA_DIR + '/pair.html')
});
app.get(['/settings', '/settings.html'], (req, res) => {
    res.sendFile(SAKURA_DIR + '/settings.html')
});
app.get(['/react', '/react.html'], (req, res) => {
    res.sendFile(SAKURA_DIR + '/react.html')
});
app.get(['/admin', '/admin.html'], (req, res) => {
    res.sendFile(SAKURA_DIR + '/admin.html')
});

app.listen(PORT, () => {
    console.log(`
Don't Forget To Give Star ‼️


Server running on http://localhost:` + PORT)
});

export default app;

