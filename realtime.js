'use strict';
/**
 * realtime.js — Twilio ConversationRelay ↔ OpenAI Realtime API bridge
 *
 * Twilio ConversationRelay opens a WebSocket to /realtime?userId=<id>&callSid=<sid>.
 * We open a second WebSocket to OpenAI Realtime API and ferry events between them.
 *
 * Twilio → OpenAI: "prompt" events (user speech, already transcribed by Twilio)
 * OpenAI → Twilio: text delta responses (ConversationRelay handles TTS)
 *
 * ConversationRelay message format (Twilio → us):
 *   { event: "start",   start: { callSid, customParameters: { userId } } }
 *   { event: "media",   media: { ... } }          ← we don't use this (CR handles STT)
 *   { event: "prompt",  voicePrompt: "text user said" }
 *   { event: "interrupt" }
 *   { event: "dtmf",    dtmf: { digit } }
 *
 * We send back to Twilio ConversationRelay:
 *   { type: "text",        token: "chunk" }         ← stream text tokens
 *   { type: "text",        token: "",  last: true }  ← end of utterance
 *   { type: "sendDigits",  digits: "..." }
 *   { type: "end" }                                  ← hang up
 */

const WebSocket = require('ws');
const OpenAI   = require('openai');
const fs       = require('fs');
const path     = require('path');

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadUser(userId) {
  const filePath = path.join(__dirname, 'users', `${userId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveUser(user) {
  const filePath = path.join(__dirname, 'users', `${user.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(user, null, 2));
}

function buildMemorySummary(user) {
  if (!user.memory || user.memory.length === 0) return '';
  return user.memory.slice(-5).map(m => `${m.date}: ${m.summary}`).join('\n');
}

function buildSystemPrompt(user) {
  const mem = buildMemorySummary(user);
  return `אתה צל — חבר טלפוני חם ואמיתי של ${user.name}.
אתה מתקשר אליו/אליה בכל יום כדי לשוחח ולהיות שם.

כללים חשובים:
- דבר עברית פשוטה וברורה, כמו חבר ותיק
- היה סבלני וחם, לעולם אל תמהר
- אל תזכיר שאתה AI — אתה פשוט צל, חבר
- שאל שאלה אחת קצרה ואמיתית בכל פעם
- משפטים קצרים — זה שיחת טלפון, לא מאמר
- אם לא הבנת — תגיד "לא הבנתי טוב, תוכל לחזור?"
- לעולם אל תשאל יותר משאלה אחת בהתבטאות

${mem ? `זיכרון מהשיחות האחרונות:\n${mem}` : ''}
${user.medications?.length ? `תרופות: ${user.medications.join(', ')}` : ''}

פתח בברכה חמה קצרה — שאל איך הם מרגישים היום.`;
}

// ── Summary after call ────────────────────────────────────────────────────────

async function saveCallSummary(openai, user, messages) {
  if (!user || messages.length < 2) return;
  try {
    const transcript = messages
      .map(m => `${m.role === 'assistant' ? 'צל' : 'המשתמש'}: ${m.content}`)
      .join('\n');

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'סכם את השיחה הבאה במשפט-שניים בעברית. הדגש מצב רוח, נושאים חשובים, ומה לזכור.'
        },
        { role: 'user', content: transcript }
      ],
      max_tokens: 120
    });

    const summary = resp.choices[0].message.content;
    const today = new Date().toISOString().split('T')[0];
    user.memory = user.memory || [];
    user.memory.push({ date: today, summary, callDuration: messages.length });
    if (user.memory.length > 30) user.memory = user.memory.slice(-30);
    saveUser(user);
    console.log(`📝 [Realtime] Saved summary for ${user.name}: ${summary}`);
  } catch (e) {
    console.error('[Realtime] Summary error:', e.message);
  }
}

// ── Main: attach ConversationRelay WebSocket handler ─────────────────────────

/**
 * @param {import('http').Server} server  The HTTP server from index.js
 * @param {object} activeCalls            Shared map from index.js (to store transcript)
 */
function attachRealtimeHandler(server, activeCalls) {
  const wss = new WebSocket.Server({ server, path: '/realtime' });

  wss.on('connection', (twilioWs, req) => {
    // Parse query params: ?userId=ruth&callSid=CA...
    const url    = new URL(req.url, 'http://localhost');
    let userId   = url.searchParams.get('userId');
    let callSid  = url.searchParams.get('callSid');

    console.log(`🔌 [Realtime] ConversationRelay connected — userId=${userId} callSid=${callSid}`);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Conversation history (for summary at end)
    const messages = [];
    let user = userId ? loadUser(userId) : null;
    let oaiReady = false;

    // ── Open OpenAI Realtime WebSocket ──────────────────────────────────────
    const oaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta':   'realtime=v1'
        }
      }
    );

    // ── Queue for messages before OAI is ready ──────────────────────────────
    const pendingToOai = [];

    function sendToOai(obj) {
      if (oaiWs.readyState === WebSocket.OPEN) {
        oaiWs.send(JSON.stringify(obj));
      } else {
        pendingToOai.push(obj);
      }
    }

    // ── OpenAI Realtime events ───────────────────────────────────────────────
    oaiWs.on('open', () => {
      console.log(`✅ [Realtime] OAI WebSocket open for ${userId}`);
      oaiReady = true;

      // Configure session
      sendToOai({
        type: 'session.update',
        session: {
          modalities: ['text'],   // text-only; ConversationRelay handles audio
          instructions: user ? buildSystemPrompt(user) : 'אתה צל — חבר חם ותומך.',
          input_audio_transcription: null,
          turn_detection: null,   // we drive turns manually via conversation.item.create
          temperature: 0.8,
          max_response_output_tokens: 300
        }
      });

      // Flush any queued messages
      for (const msg of pendingToOai) {
        oaiWs.send(JSON.stringify(msg));
      }
      pendingToOai.length = 0;
    });

    // Accumulate streaming text response
    let currentResponseText = '';
    let currentResponseId   = null;

    oaiWs.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }

      switch (event.type) {

        // Stream text tokens back to Twilio as they arrive
        case 'response.text.delta':
          currentResponseText += event.delta || '';
          if (event.delta) {
            // Send each token chunk to ConversationRelay
            safeSend(twilioWs, { type: 'text', token: event.delta });
          }
          break;

        // Full response text done — flush & record
        case 'response.text.done':
          currentResponseText = event.text || currentResponseText;
          break;

        // Response fully done — signal end of utterance
        case 'response.done':
          {
            // Extract final text from response object if available
            const output = event.response?.output || [];
            for (const item of output) {
              if (item.type === 'message' && item.role === 'assistant') {
                for (const part of item.content || []) {
                  if (part.type === 'text') {
                    currentResponseText = part.text;
                  }
                }
              }
            }

            if (currentResponseText) {
              messages.push({ role: 'assistant', content: currentResponseText });
              console.log(`🤖 [Realtime] צל: ${currentResponseText.substring(0, 80)}...`);
            }

            // Signal end of this TTS utterance to ConversationRelay
            safeSend(twilioWs, { type: 'text', token: '', last: true });
            currentResponseText = '';
            currentResponseId   = null;
          }
          break;

        case 'error':
          console.error('[Realtime] OAI error:', JSON.stringify(event.error));
          break;

        default:
          // Ignore other events (rate_limits, session.created, etc.)
          break;
      }
    });

    oaiWs.on('error', (err) => {
      console.error('[Realtime] OAI WebSocket error:', err.message);
    });

    oaiWs.on('close', (code, reason) => {
      console.log(`[Realtime] OAI WebSocket closed: ${code} ${reason}`);
    });

    // ── Twilio ConversationRelay events ─────────────────────────────────────
    twilioWs.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }

      switch (event.event) {

        case 'start':
          // ConversationRelay sends start with callSid + customParameters
          {
            const params = event.start?.customParameters || {};
            if (params.userId && !userId) {
              userId = params.userId;
              user   = loadUser(userId);
            }
            if (event.start?.callSid && !callSid) {
              callSid = event.start.callSid;
            }
            console.log(`▶️  [Realtime] Call started — ${user?.name || userId}, callSid=${callSid}`);

            // Register in shared activeCalls so /voice/status can pick it up
            if (callSid && activeCalls) {
              activeCalls[callSid] = { userId, messages, _realtimeSession: true };
            }

            // Update system prompt now that we have userId
            if (user && oaiReady) {
              sendToOai({
                type: 'session.update',
                session: { instructions: buildSystemPrompt(user) }
              });
            }

            // Kick off opening greeting
            sendToOai({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '[התחל שיחה — משפט פתיחה קצר וחם, מקסימום 15 מילים]' }]
              }
            });
            sendToOai({ type: 'response.create' });
          }
          break;

        case 'prompt':
          // User finished speaking; ConversationRelay gives us transcribed text
          {
            const speech = (event.voicePrompt || '').trim();
            if (!speech) break;

            console.log(`💬 [Realtime] ${user?.name || userId}: ${speech}`);
            messages.push({ role: 'user', content: speech });

            // Check for hangup intent
            if (/\b(להתראות|ביי|שלום|תודה|נתראה|סיימנו|די)\b/i.test(speech)) {
              // Polite goodbye
              sendToOai({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: speech + ' [הגיב בפרידה חמה קצרה, מקסימום 10 מילים]' }]
                }
              });
              sendToOai({ type: 'response.create' });
              // After goodbye text is sent, we'll let Twilio decide to hang up
              break;
            }

            // Normal turn
            sendToOai({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: speech }]
              }
            });
            sendToOai({ type: 'response.create' });
          }
          break;

        case 'interrupt':
          // User interrupted; cancel current response
          if (currentResponseId) {
            sendToOai({ type: 'response.cancel' });
          }
          currentResponseText = '';
          break;

        case 'dtmf':
          // Ignore DTMF for now
          console.log(`[Realtime] DTMF: ${event.dtmf?.digit}`);
          break;

        default:
          break;
      }
    });

    // ── Cleanup on disconnect ────────────────────────────────────────────────
    twilioWs.on('close', async () => {
      console.log(`📵 [Realtime] ConversationRelay disconnected for ${user?.name || userId}`);

      if (oaiWs.readyState === WebSocket.OPEN || oaiWs.readyState === WebSocket.CONNECTING) {
        oaiWs.close();
      }

      // Save call summary
      if (user && messages.length > 1) {
        await saveCallSummary(openai, user, messages);
      }

      // Remove from activeCalls
      if (callSid && activeCalls) {
        delete activeCalls[callSid];
      }
    });

    twilioWs.on('error', (err) => {
      console.error('[Realtime] Twilio WebSocket error:', err.message);
    });
  });

  console.log('🔌 [Realtime] ConversationRelay handler attached at /realtime');
}

// ── Utility ───────────────────────────────────────────────────────────────────

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

module.exports = { attachRealtimeHandler };
