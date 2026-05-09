// --- 🔕 SUPPRESS BAD MAC SPAM (must be before any require!) ---
// libsignal uses console.error for Bad MAC and console.warn for closed sessions
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);
const _badMacSeen = new Set();
const _badMacFilter = (...args) => {
    const msg = args.join(' ');
    if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt') || msg.includes('Session error') || msg.includes('closed session')) {
        const contact = (msg.match(/at async (\S+) \[/) || [])[1] || 'decrypt';
        if (!_badMacSeen.has(contact)) {
            _badMacSeen.add(contact);
            _origLog(`⚠️ Bad MAC for ${contact} — old queued messages (will self-clear)`);
        }
        return true; // suppress
    }
    return false;
};
console.error = (...args) => { if (!_badMacFilter(...args)) _origErr(...args); };
console.warn  = (...args) => { if (!_badMacFilter(...args)) _origWarn(...args); };

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- ⚙️ CONFIGURATION ---
const FIREBASE_URL = process.env.FIREBASE_URL;
const SESSION_PATH = './auth_state';

if (!FIREBASE_URL) {
    console.log("❌ ERROR: FIREBASE_URL is missing!");
    process.exit(1);
}

// --- 🔄 FIREBASE SESSION SYNC ---
async function downloadSession(retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`📥 Syncing session from Firebase (attempt ${attempt}/${retries})...`);
            const res = await fetch(`${FIREBASE_URL}/bot_session.json`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data && typeof data === 'object') {
                if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
                for (const [hexName, base64Content] of Object.entries(data)) {
                    // Decode filename from hex, decode content from base64
                    const filename = Buffer.from(hexName, 'hex').toString();
                    const content = Buffer.from(base64Content, 'base64').toString('utf-8');
                    fs.writeFileSync(path.join(SESSION_PATH, filename), content);
                }
                console.log("✅ Session restored from Firebase.");
                return; // success
            } else {
                console.log("ℹ️ No existing session found in Firebase.");
                return; // no session yet — not an error
            }
        } catch (e) {
            console.log(`⚠️ Session download attempt ${attempt} failed:`, e.message);
            if (attempt < retries) await delay(3000); // wait 3s before retry
        }
    }
    console.log("❌ Could not restore session after all attempts. Will need QR scan.");
}

async function uploadSession() {
    try {
        if (!fs.existsSync(SESSION_PATH)) return;
        const files = fs.readdirSync(SESSION_PATH);
        const sessionData = {};
        for (const file of files) {
            if (file.endsWith('.json')) {
                const content = fs.readFileSync(path.join(SESSION_PATH, file), 'utf-8');
                // Key: hex-encoded filename (safe for Firebase)
                // Value: base64-encoded file content (avoids ALL nested key issues)
                const hexName = Buffer.from(file).toString('hex');
                const base64Content = Buffer.from(content).toString('base64');
                sessionData[hexName] = base64Content;
            }
        }
        const res = await fetch(`${FIREBASE_URL}/bot_session.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionData)
        });
        if (res.ok) {
            console.log("📤 Session successfully synced to Firebase!");
        } else {
            const err = await res.text();
            console.log("❌ Firebase Upload Failed:", err);
        }
    } catch (e) {
        console.log("⚠️ Session upload error:", e.message);
    }
}

let orderStates = {};
let uploadDebounce = null;  // module-level: survives reconnects
let isConnecting = false;   // guard against simultaneous startBot calls
const decryptFailCount = {}; // tracks per-contact decrypt failures for auto-heal
let activeSock = null;       // reference to the live socket for graceful shutdown

// --- ⏱️ ORDER STATE TTL: expire stale flows after 30 minutes ---
// Prevents users from being permanently stuck after a bot restart
function pruneOrderStates() {
    const now = Date.now();
    for (const key of Object.keys(orderStates)) {
        if (now - (orderStates[key].ts || 0) > 30 * 60 * 1000) {
            delete orderStates[key];
        }
    }
}
setInterval(pruneOrderStates, 10 * 60 * 1000); // run every 10 minutes

// --- 🛑 GRACEFUL SHUTDOWN (prevents WhatsApp "dirty session" on hourly restart) ---
async function gracefulShutdown(signal) {
    console.log(`\n🛑 ${signal} received — closing bot gracefully...`);
    // Flush any pending debounced upload immediately
    if (uploadDebounce) { clearTimeout(uploadDebounce); uploadDebounce = null; }
    try {
        // Upload latest session BEFORE closing socket
        await uploadSession();
        // Gracefully close the WhatsApp connection (tells WA servers we disconnected cleanly)
        if (activeSock) {
            activeSock.end(undefined);
            await delay(2000); // give it 2s to send the logout frame
        }
    } catch (e) {
        console.log('⚠️ Shutdown error:', e.message);
    }
    console.log('✅ Graceful shutdown complete.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // GitHub Actions kill signal
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));  // Ctrl+C


async function startBot() {
    if (isConnecting) return;
    isConnecting = true;
    // BUG FIX: Reset decrypt fail counts so stale counts from previous run
    // don't cause the auto-heal to delete valid session files immediately.
    Object.keys(decryptFailCount).forEach(k => delete decryptFailCount[k]);
    try {
    await downloadSession();
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    // Fetch latest WhatsApp version for a more stable connection
    const { version } = await (async () => {
        try {
            const { fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
            return await fetchLatestBaileysVersion();
        } catch (e) {
            return { version: [2, 3000, 1015901307] }; // Fallback
        }
    })();

    console.log(`📡 Connecting with WhatsApp v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: require('pino')({ level: 'silent' }),
        // Keep the connection alive with keepalive pings
        keepAliveIntervalMs: 30_000,
        // Retry message sending on temporary failure
        retryRequestDelayMs: 2000,
    });
    activeSock = sock; // expose for graceful shutdown

    // --- 📱 LID → PHONE MAP (resolves WhatsApp privacy IDs to real numbers) ---
    const lidPhoneMap = {};

    // Shared handler — processes any array of contact objects
    function processContacts(contacts = []) {
        contacts.forEach(contact => {
            if (contact.id && contact.id.includes('@s.whatsapp.net')) {
                const phone = contact.id.split('@')[0];
                if (contact.lid) {
                    lidPhoneMap[contact.lid] = phone;
                }
            }
        });
    }

    // 1. Fires on startup with ALL already-known contacts
    sock.ev.on('contacts.upsert', processContacts);

    // 2. Fires when individual contact info updates (e.g. name/lid refresh)
    sock.ev.on('contacts.update', processContacts);

    // 3. Fires when WhatsApp sends bulk history on session restore — includes contacts
    sock.ev.on('messaging-history.set', ({ contacts }) => {
        if (Array.isArray(contacts)) processContacts(contacts);
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('✨ New QR Code received! Please scan:');
            qrcode.generate(qr, { small: true }); 
        }

        if (connection === 'open') {
            console.log('✅ AS ACADEMY AI IS ONLINE!');
            await uploadSession(); // Save successful login
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Connection closed. Reason code: ${reason}`);
            // Flush session immediately so Firebase is never stale on reconnect
            if (uploadDebounce) { clearTimeout(uploadDebounce); uploadDebounce = null; }
            await uploadSession();
            isConnecting = false;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Retrying in 5 seconds...");
                setTimeout(startBot, 5000);
            } else {
                console.log("❌ Logged out. Delete session in Firebase to re-scan.");
            }
        }
    });

    sock.ev.on('creds.update', async () => {
        // Guard: saveCreds can throw ENOENT if the connection is dying during reconnect
        try { await saveCreds(); } catch (e) {
            console.log('⚠️ saveCreds skipped (reconnect race):', e.code);
            return; // Don't upload a broken session
        }
        // Debounce: wait 3s after the last creds change before uploading
        if (uploadDebounce) clearTimeout(uploadDebounce);
        uploadDebounce = setTimeout(async () => {
            await uploadSession();
            uploadDebounce = null;
        }, 3000);
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];

            // --- 🔧 AUTO-HEAL: delete corrupted session file for contacts causing Bad MAC ---
            if (!msg.message) {
                const failJid = msg.key.remoteJid;
                // Extract base ID for filename (handles LID format like 919322638402.0)
                const baseId = failJid.split('@')[0];
                decryptFailCount[baseId] = (decryptFailCount[baseId] || 0) + 1;
                if (decryptFailCount[baseId] >= 3) {
                    const sessionFile = path.join(SESSION_PATH, `session-${baseId}.json`);
                    if (fs.existsSync(sessionFile)) {
                        fs.unlinkSync(sessionFile);
                        console.log(`🔧 Auto-healed: deleted corrupt session for ${baseId}`);
                    }
                    decryptFailCount[baseId] = 0;
                }
                return;
            }
            decryptFailCount[msg.key.remoteJid.split('@')[0]] = 0; // reset on success

            if (msg.key.remoteJid === 'status@broadcast') return;
            if (msg.key.fromMe) return;

            // --- 🔐 DECRYPTION ERROR PROTECTION ---
            if (msg.messageStubType === 114 || msg.messageStubType === 115) {
                return; // Silently skip decryption errors
            }

            const sender = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
            const rawPushName = msg.pushName || "Guest";
            const pushName = encodeURIComponent(rawPushName);

            // --- 📞 BEST-EFFORT PHONE EXTRACTION ---
            // Strategy: LID map → participant → sender → 'unknown'
            function extractPhone(jid) {
                if (!jid) return null;
                // If it's a LID, try to resolve it from our contact map
                if (jid.includes('@lid')) return lidPhoneMap[jid] || null;
                const num = jid.split(':')[0].split('@')[0];
                // LID-style numbers have a dot (e.g. 919322638402.0)
                if (num.includes('.')) return lidPhoneMap[jid] || null;
                if (num.length < 7) return null;
                return num;
            }

            const userKey = msg.key.participant || sender;
            const customerWaNumber =
                extractPhone(msg.key.participant) ||  // group member
                extractPhone(sender) ||               // direct chat
                null;                                 // truly unresolvable LID

            const formattedPhone = customerWaNumber ? "+" + customerWaNumber : 'Unknown';
            const baseParams = `?phone=${customerWaNumber}&name=${pushName}`;

            // --- 🛒 ORDER FLOW ---
            if (orderStates[userKey]?.step === 'WAITING_FOR_ADDRESS') {
                const customerDetails = text;
                const item = orderStates[userKey].item;
                const orderData = {
                    userId: "whatsapp_" + customerWaNumber,
                    userEmail: "whatsapp@asacademy.com",
                    phone: customerWaNumber,
                    address: customerDetails,
                    items:[{ id: item.id, name: item.name, price: parseFloat(item.price), img: item.imageUrl || "", quantity: 1 }],
                    total: (parseFloat(item.price) + 50).toFixed(2),
                    status: "Placed",
                    method: "WhatsApp",
                    timestamp: new Date().toISOString()
                };

                try {
                    const res = await fetch(`${FIREBASE_URL}/orders.json`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(orderData)
                    });
                    if (!res.ok) console.log("❌ Firebase Order Save Error:", await res.text());
                    await sock.sendMessage(sender, { text: `✅ *Order Placed!* \n\nYour order for *${item.name}* is received. \n\n*Total:* ₹${orderData.total}` });
                } catch (e) { console.log(e); }
                delete orderStates[userKey]; 
                return;
            }

            // --- 🌟 COMMANDS ---
            if (text.startsWith("order ")) {
                const res = await fetch(`${FIREBASE_URL}/courses.json`);
                const menu = Object.values(await res.json() || {});
                const product = text.replace("order ", "").trim().toLowerCase();
                const matched = menu.find(i => i.name.toLowerCase().includes(product));

                if (!matched) {
                    await sock.sendMessage(sender, { text: `❌ Course *${product}* not found.` });
                    return;
                }

                orderStates[userKey] = { step: 'WAITING_FOR_ADDRESS', item: matched, ts: Date.now() };
                await sock.sendMessage(sender, { text: `🛒 *Order Started!* \n\nYou selected: *${matched.name}*\n\nPlease reply with your *Full Name & Address*.` });
            }
            
            else if (text.includes("aseqp")) {
                const msg = `📢 Welcome to AS Academy\n1️⃣ What is ASEQP\n2️⃣ Expected Score\n3️⃣ Courses\n4️⃣ How to Buy\n5️⃣ Support\n\n👉 Reply with 1-5`;
                await sock.sendMessage(sender, { text: msg });
                delete orderStates[userKey];
            }

            else if (orderStates[userKey] && orderStates[userKey].step === 'WAITING_FOR_COURSE' && !isNaN(parseInt(text))) {
                const num = parseInt(text);
                const state = orderStates[userKey];

                // 0 = Others (Suggest a course)
                if (num === 0) {
                    if (!customerWaNumber) {
                        // Phone unknown — collect it first
                        await sock.sendMessage(sender, { text: "📞 *Please share your WhatsApp number* so we can follow up:\n\n_(Reply with your 10-digit number)_" });
                        orderStates[userKey].step = 'WAITING_FOR_PHONE';
                    } else {
                        await sock.sendMessage(sender, { text: "💡 *Which Course do you need next?*" });
                        orderStates[userKey].step = 'WAITING_FOR_SUGGESTION';
                    }
                    return;
                }

                // 1 to N = course selection
                if (num >= 1 && num <= state.courses.length) {
                    const sel = state.courses[num - 1];
                    const actualLink = sel.link || `https://www.asacademy.site`;

                    // Route through redirect.html to capture lead before sending to course
                    const safePhone = customerWaNumber || 'Unknown';
                    const trackingLink = `https://aseqp.netlify.app/redirect.html?phone=${safePhone}&name=${pushName}&course=${encodeURIComponent(sel.name)}&url=${encodeURIComponent(actualLink)}`;

                    const cap = `📚 *${sel.name}*\n\n👉 *Get it here:* ${trackingLink}`;
                    if (sel.imageUrl) {
                        await sock.sendMessage(sender, { image: { url: sel.imageUrl }, caption: cap });
                    } else {
                        await sock.sendMessage(sender, { text: cap });
                    }
                    delete orderStates[userKey];
                }
            }

            // --- Collect phone number before suggestion ---
            else if (orderStates[userKey] && orderStates[userKey].step === 'WAITING_FOR_PHONE') {
                const enteredPhone = text.replace(/\D/g, ''); // strip non-digits
                if (enteredPhone.length >= 7) {
                    orderStates[userKey].collectedPhone = enteredPhone;
                    orderStates[userKey].step = 'WAITING_FOR_SUGGESTION';
                    await sock.sendMessage(sender, { text: "💡 *Which Course do you need next?*" });
                } else {
                    await sock.sendMessage(sender, { text: "⚠️ That doesn't look like a valid number. Please reply with your 10-digit WhatsApp number." });
                }
            }

            else if (orderStates[userKey] && orderStates[userKey].step === 'WAITING_FOR_SUGGESTION') {
                // Use collected phone if available, else formattedPhone from LID map
                const finalPhone = orderStates[userKey].collectedPhone
                    ? '+' + orderStates[userKey].collectedPhone
                    : formattedPhone;
                try {
                    const res = await fetch(`${FIREBASE_URL}/suggested.json`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: rawPushName, phone: finalPhone, suggestion: text, timestamp: new Date().toISOString() })
                    });
                    if (!res.ok) console.log("❌ Firebase Suggestion Save Error:", await res.text());
                    await sock.sendMessage(sender, { text: "✅ *Thank you!* Suggestion recorded." });
                } catch (e) { console.log(e); }
                delete orderStates[userKey];
            }

            else if (text === "3") {
                const res = await fetch(`${FIREBASE_URL}/courses.json`);
                const courses = Object.values(await res.json() || {});
                if (courses.length === 0) {
                    await sock.sendMessage(sender, { text: "No courses available." });
                    return;
                }
                // Helper: converts any number to emoji digits (10 → 1️⃣0️⃣)
                const toEmoji = n => String(n).split('').map(d =>
                    ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'][parseInt(d)]
                ).join('');
                let listMsg = "📚 *Available Courses:*\n\n";
                listMsg += `0️⃣ Others (Suggest a course)\n\n`;
                courses.forEach((c, i) => listMsg += `${toEmoji(i + 1)} ${c.name}\n`);
                listMsg += `\n👉 Reply with a number`;
                orderStates[userKey] = { step: 'WAITING_FOR_COURSE', courses: courses, ts: Date.now() };
                await sock.sendMessage(sender, { text: listMsg });
            }
            
            else if (text === "1") {
                const msg1 = `📘 *What is ASEQP?*\nASEQP = As Expected Questions Practice\n\n👉 It is a collection of:\n✔️ Important questions\n✔️ Expected exam concepts\n✔️ Frequently repeated topics\n\n👉 Based on:\nPrevious exam patterns\nImportant chapters\nSmart preparation strategy\n\n💯 Helps you focus only on what matters in exam`;
                await sock.sendMessage(sender, { text: msg1 });
            }
            else if (text === "2") {
                const msg2 = `📊 *Expected Score after ASEQP*\n\n👉 If you prepare properly using ASEQP:\n✔️ You can cover 50+ marks level content\n✔️ Helps in last moment revision\n✔️ Improves confidence in exam\n\n⚠️ Note: Marks depend on your preparation & writing`;
                await sock.sendMessage(sender, { text: msg2 });
            }
            else if (text === "4") {
                const msg4 = `🛒 *How to Buy ASEQP*\n\n1️⃣ Visit: https://www.asacademy.site/courses\n2️⃣ Select your subject\n3️⃣ Click on Buy\n4️⃣ Complete payment\n5️⃣ Get instant access 💯`;
                await sock.sendMessage(sender, { text: msg4 });
            }
            else if (text === "5") {
                const msg5 = `📞 *Need Help?*\n\n👉 If you have any doubt or issue:\n\n📲 Instagram:\nhttps://www.instagram.com/asacademy_india\n\n📞 WhatsApp Support:\n9970087711`;
                await sock.sendMessage(sender, { text: msg5 });
            }

        } catch (e) {
            console.log("Message Error:", e.message);
        }
    });

    } catch (e) {
        // BUG FIX: If startBot() crashes before/during socket setup,
        // isConnecting would stay true forever, blocking all future restarts.
        console.log('❌ startBot() crashed unexpectedly:', e.message);
        isConnecting = false;
        console.log('🔄 Retrying in 10 seconds...');
        setTimeout(startBot, 10000);
    }
}

startBot();