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
async function downloadSession() {
    try {
        console.log("📥 Syncing session from Firebase...");
        const res = await fetch(`${FIREBASE_URL}/bot_session.json`);
        const data = await res.json();
        if (data) {
            if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
            for (const [filename, content] of Object.entries(data)) {
                fs.writeFileSync(path.join(SESSION_PATH, filename), JSON.stringify(content));
            }
            console.log("✅ Session restored from Firebase.");
        } else {
            console.log("ℹ️ No existing session found in Firebase.");
        }
    } catch (e) {
        console.log("⚠️ Session download failed:", e.message);
    }
}

async function uploadSession() {
    try {
        if (!fs.existsSync(SESSION_PATH)) return;
        const files = fs.readdirSync(SESSION_PATH);
        const sessionData = {};
        for (const file of files) {
            if (file.endsWith('.json')) {
                const content = fs.readFileSync(path.join(SESSION_PATH, file), 'utf-8');
                sessionData[file] = JSON.parse(content);
            }
        }
        await fetch(`${FIREBASE_URL}/bot_session.json`, {
            method: 'PUT',
            body: JSON.stringify(sessionData)
        });
        // console.log("📤 Session synced to Firebase.");
    } catch (e) {
        // console.log("⚠️ Session upload failed:", e.message);
    }
}

let orderStates = {};

async function startBot() {
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
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Retrying in 5 seconds...");
                setTimeout(startBot, 5000);
            } else {
                console.log("❌ Logged out. Delete session in Firebase to re-scan.");
            }
        }
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await uploadSession();
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
            if (msg.key.fromMe) return;

            // --- 🔐 DECRYPTION ERROR PROTECTION ---
            if (msg.messageStubType === 114 || msg.messageStubType === 115) {
                return; // Silently skip decryption errors
            }

            const sender = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

            const userKey = msg.key.participant || sender; 
            const customerWaNumber = userKey.split(':')[0].split('@')[0];
            const formattedPhone = "+" + customerWaNumber;
            const rawPushName = msg.pushName || "Guest";
            const pushName = encodeURIComponent(rawPushName);
            
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
                    await fetch(`${FIREBASE_URL}/orders.json`, {
                        method: 'POST',
                        body: JSON.stringify(orderData)
                    });
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

                orderStates[userKey] = { step: 'WAITING_FOR_ADDRESS', item: matched };
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
                const othersNum = state.courses.length + 1;
                
                if (num === othersNum) {
                    await sock.sendMessage(sender, { text: "💡 *Which Course do you need next?*" });
                    orderStates[userKey].step = 'WAITING_FOR_SUGGESTION';
                    return;
                }

                if (num > 0 && num <= state.courses.length) {
                    const sel = state.courses[num-1];
                    const courseParam = `&course=${encodeURIComponent(sel.name)}`;
                    const link = sel.link || `https://www.asacademy.site/index.html`;
                    const finalLink = link.includes('?') ? `${link}&phone=${customerWaNumber}&name=${pushName}${courseParam}` : `${link}?phone=${customerWaNumber}&name=${pushName}${courseParam}`;
                    
                    const cap = `📚 *${sel.name}*\n\n👉 *Get it here:* ${finalLink}`;
                    if (sel.imageUrl) {
                        await sock.sendMessage(sender, { image: { url: sel.imageUrl }, caption: cap });
                    } else {
                        await sock.sendMessage(sender, { text: cap });
                    }
                    delete orderStates[userKey];
                }
            }

            else if (orderStates[userKey] && orderStates[userKey].step === 'WAITING_FOR_SUGGESTION') {
                try {
                    await fetch(`${FIREBASE_URL}/suggested.json`, {
                        method: 'POST',
                        body: JSON.stringify({ name: rawPushName, phone: formattedPhone, suggestion: text, timestamp: new Date().toISOString() })
                    });
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
                let listMsg = "📚 *Available Courses:*\n\n";
                courses.forEach((c, i) => listMsg += `${i+1}️⃣ ${c.name}\n`);
                listMsg += `${courses.length + 1}️⃣ Others (Suggest a course)\n\n👉 Reply with a number`;
                orderStates[userKey] = { step: 'WAITING_FOR_COURSE', courses: courses };
                await sock.sendMessage(sender, { text: listMsg });
            }
            
            else if (text === "1") {
                await sock.sendMessage(sender, { text: "📘 *ASEQP:* Expected Questions Practice for MSBTE Exams." });
            }
            else if (text === "2") {
                await sock.sendMessage(sender, { text: "📊 *Score:* Covers 50+ marks content." });
            }

        } catch (e) {
            console.log("Message Error:", e.message);
        }
    });
}

startBot();