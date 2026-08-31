require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Lazy clients — init only when first used (env vars guaranteed ready)
let _twilio, _openai;
const twilioClient = () => _twilio || (_twilio = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN));
const openai = () => {
  if (!_openai) {
    // Extract just the sk-... part from whatever is in the env var
    let rawKey = process.env.OPENAI_API_KEY || '';
    // If it contains "OPENAI_API_KEY=" prefix, extract after it
    if (rawKey.includes('=')) rawKey = rawKey.split('=').slice(1).join('=');
    // Take only first line, trim whitespace
    rawKey = rawKey.split('\n')[0].split('\r')[0].trim();
    console.log('[DEBUG] API key starts with:', rawKey.substring(0, 10));
    _openai = new OpenAI({ apiKey: rawKey });
  }
  return _openai;
};
const BASE = () => process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
// Clean env vars that might have extra content
const PHONE = () => {
  let p = process.env.TWILIO_PHONE_NUMBER || '';
  // Strip "KEY=VALUE" format if accidentally stored with key name
  if (p.includes('=')) p = p.split('=').pop();
  // Take first line only
  p = p.split('\n')[0].split('\r')[0].trim();
  // Fallback to known number if empty or suspicious
  if (!p.startsWith('+972')) p = '+97233768596';
  console.log('[PHONE]', p);
  return p;
};
const VOICE = { language: 'he-IL', voice: 'Google.he-IL-Wavenet-D' };

// ── User DB ───────────────────────────────────────────────────
function loadUser(userId) {
  const p = path.join(__dirname, 'users', `${userId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveUser(user) {
  fs.writeFileSync(path.join(__dirname, 'users', `${user.id}.json`), JSON.stringify(user, null, 2));
}
function getAllUsers() {
  const dir = path.join(__dirname, 'users');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(u => u.active);
}

// ── Memory & Prompt ───────────────────────────────────────────
function buildSystemPrompt(user) {
  const mem = (user.memory || []).slice(-5).map(m => `${m.date}: ${m.summary}`).join('\n');
  return `אתה צל — חבר קולי חם ואמיתי של ${user.name}. אתה מתקשר כל יום.

כללים:
• עברית פשוטה, משפטים קצרים — זו שיחת טלפון
• סבלני, חם, אף פעם לא ממהר
• אל תזכיר שאתה AI — אתה פשוט צל החבר
• שאל שאלה אחת בכל פעם, המתן לתשובה
• הגב לנושא ששוחח, אל תקפוץ לנושאים חדשים
• אם מדברים על בני משפחה — שאל עליהם בשם

${mem ? `זיכרון מהשיחות האחרונות:\n${mem}` : ''}
${(user.medications||[]).length ? `תרופות לזכור: ${user.medications.join(', ')}` : ''}`;
}

// ── Active calls ──────────────────────────────────────────────
const activeCalls = {};
const pendingOpenings = {};

async function prewarmOpening(user) {
  const r = await openai().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: buildSystemPrompt(user) },
      { role: 'user', content: '[פתח בברכה חמה, טבעית וקצרה — מקסימום 12 מילים]' }
    ],
    max_tokens: 50
  });
  pendingOpenings[user.id] = r.choices[0].message.content;
  console.log(`🔥 Opening for ${user.name}: ${pendingOpenings[user.id]}`);
}

// ── Transcribe via Whisper ────────────────────────────────────
async function transcribeRecording(recordingUrl) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const fetchAudio = (url, redirects = 3) => {
      https.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && redirects > 0) {
          return fetchAudio(res.headers.location, redirects - 1);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', async () => {
          try {
            const buf = Buffer.concat(chunks);
            const file = new File([buf], 'audio.mp3', { type: 'audio/mpeg' });
            const t = await openai().audio.transcriptions.create({ file, model: 'whisper-1', language: 'he' });
            resolve(t.text);
          } catch(e) { reject(e); }
        });
        res.on('error', reject);
      }).on('error', reject);
    };
    fetchAudio(recordingUrl + '.mp3');
  });
}

// ── AI reply ──────────────────────────────────────────────────
async function getReply(user, callSid, userSpeech) {
  const call = activeCalls[callSid] || { userId: user.id, messages: [] };
  call.messages.push({ role: 'user', content: userSpeech });
  const r = await openai().chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'system', content: buildSystemPrompt(user) }, ...call.messages],
    max_tokens: 80
  });
  const reply = r.choices[0].message.content;
  call.messages.push({ role: 'assistant', content: reply });
  activeCalls[callSid] = call;
  return reply;
}

// ── TwiML builder ─────────────────────────────────────────────
function twimlSayAndRecord(userId, callSid, text) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(VOICE, text);
  twiml.record({
    action: `${BASE()}/voice/recording?callSid=${callSid}&userId=${userId}`,
    maxLength: 40,
    timeout: 5,
    playBeep: false,
    trim: 'trim-silence'
  });
  return twiml.toString();
}

// ── Webhooks ──────────────────────────────────────────────────
app.post('/voice/outbound', (req, res) => {
  const { userId } = req.query;
  const callSid = req.body.CallSid;
  const user = loadUser(userId) || { id: userId, name: 'חבר', memory: [], medications: [] };
  activeCalls[callSid] = { userId: user.id, messages: [] };
  const opening = pendingOpenings[userId] || `שלום ${user.name}! צל מדבר. איך את/ה מרגיש/ה?`;
  delete pendingOpenings[userId];
  activeCalls[callSid].messages.push({ role: 'assistant', content: opening });
  console.log(`🎙️ Call connected for ${user.name}: ${opening}`);
  res.type('text/xml').send(twimlSayAndRecord(userId, callSid, opening));
});

app.post('/voice/recording', async (req, res) => {
  const { userId, callSid } = req.query;
  const recordingUrl = req.body.RecordingUrl;
  const user = loadUser(userId) || { id: userId, name: 'חבר', memory: [], medications: [] };

  if (!recordingUrl) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(VOICE, 'יום נעים! נדבר שוב.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    const speech = await transcribeRecording(recordingUrl);
    console.log(`💬 ${user.name}: ${speech}`);

    if (!speech || speech.trim().length < 2) {
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say(VOICE, 'לא הצלחתי לשמוע. תוכל לחזור?');
      twiml.record({
        action: `${BASE()}/voice/recording?callSid=${callSid}&userId=${userId}`,
        maxLength: 40, timeout: 5, playBeep: false, trim: 'trim-silence'
      });
      return res.type('text/xml').send(twiml.toString());
    }

    const reply = await getReply(user, callSid, speech);
    console.log(`🤖 צל: ${reply}`);
    res.type('text/xml').send(twimlSayAndRecord(userId, callSid, reply));
  } catch(e) {
    console.error('Recording error:', e.message);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(VOICE, 'סליחה, הייתה תקלה קטנה. נדבר שוב בקרוב.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

app.post('/voice/status', async (req, res) => {
  const { CallSid: callSid, CallStatus: status } = req.body;
  if (['completed','no-answer','busy','failed'].includes(status) && activeCalls[callSid]) {
    const { userId, messages } = activeCalls[callSid];
    const user = loadUser(userId);
    if (user && messages.length > 1) {
      try {
        const r = await openai().chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'סכם בעברית את השיחה הבאה במשפט-שניים. הדגש מצב רוח, נושאים חשובים ומה לזכור לשיחה הבאה.' },
            { role: 'user', content: messages.map(m => `${m.role==='assistant'?'צל':'משתמש'}: ${m.content}`).join('\n') }
          ],
          max_tokens: 100
        });
        const summary = r.choices[0].message.content;
        const today = new Date().toISOString().split('T')[0];
        user.memory = (user.memory||[]);
        user.memory.push({ date: today, summary });
        if (user.memory.length > 30) user.memory = user.memory.slice(-30);
        saveUser(user);
        console.log(`📝 Summary for ${user.name}: ${summary}`);
      } catch(e) { console.error('Summary error:', e.message); }
    }
    delete activeCalls[callSid];
  }
  res.sendStatus(200);
});

// ── Outbound caller ───────────────────────────────────────────
async function callUser(user) {
  const fromNum = PHONE();
  const toNum = user.phone;
  const webhookUrl = `${BASE()}/voice/outbound?userId=${user.id}`;
  console.log(`📞 Dialing ${user.name}: from=${fromNum} to=${toNum} url=${webhookUrl}`);
  try {
    const call = await twilioClient().calls.create({
      to: toNum,
      from: fromNum,
      url: webhookUrl,
      statusCallback: `${BASE()}/voice/status`,
      statusCallbackEvent: ['completed']
    });
    console.log(`✅ Call SID: ${call.sid}`);
    return call.sid;
  } catch(e) {
    console.error(`❌ Call failed: ${e.message}`);
    throw e;
  }
}

app.get('/call/:userId', async (req, res) => {
  const token = req.query.token || req.headers['x-call-token'];
  if (token !== (process.env.CALL_TOKEN || 'tzel2026')) return res.status(401).json({ error: 'Unauthorized' });
  const user = loadUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    await prewarmOpening(user);
    await callUser(user);
    res.json({ ok: true, message: `Calling ${user.name}...` });
  } catch(e) {
    console.error('Call error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: '🌿 צל running', users: getAllUsers().map(u=>u.name) }));

// ── Daily cron 10:00 Israel ───────────────────────────────────
cron.schedule('0 7 * * *', async () => {
  console.log('⏰ Daily calls...');
  for (const user of getAllUsers()) {
    await prewarmOpening(user);
    await callUser(user);
    await new Promise(r => setTimeout(r, 5000));
  }
}, { timezone: 'UTC' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌿 צל server on port ${PORT}`);
  console.log(`Users: ${getAllUsers().map(u=>u.name).join(', ')}`);
});
