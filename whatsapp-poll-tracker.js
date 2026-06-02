/* =============================================================================
   WhatsApp Poll — Chronological Responder Tracker
   -----------------------------------------------------------------------------
   WHAT IT DOES
     Native WhatsApp polls show WHO voted but never WHEN. This little server
     listens for vote events from a WhatsApp API provider, records the exact
     time each person first responded, and shows everyone in the order they
     replied — live, plus a CSV export.

   THE VOTERS DO NOTHING NEW
     They just tap a normal WhatsApp poll. No links, no apps, no signup.

   HOW TO RUN (one-time, ~5 min)
     1. Install Node.js (nodejs.org) if you don't have it.
     2. In a terminal:   node whatsapp-poll-tracker.js
     3. Open the dashboard it prints (default http://localhost:3000).
        Click "Load demo" to watch it work immediately.

   GOING LIVE (to capture real votes)
     4. Put this server on the public internet so the provider can reach it.
        Easiest: deploy the file to a free host (Render / Railway), OR run a
        tunnel like  `npx localtunnel --port 3000`  to get an https URL.
     5. Sign up with a WhatsApp API provider that emits poll-vote events.
        Recommended for least setup: Whapi.Cloud (free test channel, just scan
        a QR like WhatsApp Web). WAHA, Wassenger and Green-API also work.
     6. In the provider's dashboard, set the WEBHOOK URL to:
            https://YOUR-PUBLIC-URL/webhook
        and enable poll / poll-vote notifications.
     7. Create a normal poll in your WhatsApp group. Responders appear here in
        order, in real time.

   ⚠️ IMPORTANT — ACCOUNT SAFETY
     Providers that connect via QR drive a real WhatsApp account through
     unofficial software, which is against WhatsApp's Terms and can get a
     number banned. Use a spare SIM / secondary number for this, not your
     main personal one.

   This file has ZERO dependencies — plain Node. Data is saved to votes.json
   next to it, so a restart won't lose responses.
============================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'votes.json');

// voterId -> { id, name, option, firstTs, lastTs, changes }
let voters = new Map();
let pollTitle = '';
const clients = new Set(); // live SSE connections

load();

/* ----------------------------- persistence ------------------------------- */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    pollTitle = raw.pollTitle || '';
    (raw.voters || []).forEach(v => voters.set(v.id, v));
  } catch (_) { /* fresh start */ }
}
function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ pollTitle, voters: [...voters.values()] }));
  } catch (e) { console.error('save failed', e.message); }
}

/* --------------------------- vote extraction ------------------------------
   Tolerant of several providers (WAHA / Whapi / Wassenger / Green-API) plus a
   simple manual shape. If your provider sends something unusual, the deep
   search below still tries to find sender / option / timestamp. */
function asArray(x) { return Array.isArray(x) ? x : [x]; }

function normTimestamp(t) {
  const n = Number(t);
  if (!n || Number.isNaN(n)) return Date.now();
  return n > 1e12 ? n : Math.round(n * 1000); // seconds -> ms
}

function cleanId(raw) {
  return String(raw || '').replace(/@.*/, '').replace(/[^0-9a-zA-Z._-]/g, '') || 'unknown';
}

function deepFind(obj, keys) {
  // breadth-first search for the first matching key with a usable value
  const queue = [obj];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    for (const k of Object.keys(cur)) {
      if (keys.includes(k) && cur[k] != null && typeof cur[k] !== 'object') return cur[k];
      if (keys.includes(k) && Array.isArray(cur[k])) return cur[k];
    }
    for (const k of Object.keys(cur)) {
      if (cur[k] && typeof cur[k] === 'object') queue.push(cur[k]);
    }
  }
  return undefined;
}

// Pull individual vote objects out of whatever envelope arrived.
function extractVoteObjects(body) {
  const out = [];
  for (const item of asArray(body)) {
    if (!item || typeof item !== 'object') continue;
    // WAHA: { event:'poll.vote', payload:{ vote:{...} } }
    if (item.payload && item.payload.vote) { out.push(item.payload.vote); continue; }
    // batched updates: { messages_updates:[...] } or { messages:[...] }
    if (Array.isArray(item.messages_updates)) { item.messages_updates.forEach(m => out.push(m)); continue; }
    if (Array.isArray(item.messages)) { item.messages.forEach(m => out.push(m)); continue; }
    out.push(item);
  }
  return out;
}

function parseVote(v) {
  const senderRaw = deepFind(v, ['from', 'author', 'participant', 'voter', 'sender', 'chatId', 'chat_id', 'senderData']);
  const id = cleanId(typeof senderRaw === 'object' ? deepFind(senderRaw, ['from', 'chatId', 'sender']) : senderRaw);
  if (id === 'unknown' && !senderRaw) return null;

  const name = deepFind(v, ['pushName', 'notifyName', 'senderName', 'name', 'displayName', 'from_name', 'chatName']) || null;

  let opt = deepFind(v, ['selectedOptions', 'selected', 'optionName', 'answer', 'choice', 'choices']);
  if (Array.isArray(opt)) opt = opt.map(o => (typeof o === 'object' ? (o.name || o.optionName || JSON.stringify(o)) : o)).join(', ');
  opt = opt != null ? String(opt) : '(vote)';

  const ts = normTimestamp(deepFind(v, ['timestamp', 'messageTimestamp', 'time', 't']));
  return { id, name, option: opt, ts };
}

function recordVote(parsed) {
  if (!parsed) return false;
  const { id, name, option, ts } = parsed;
  const existing = voters.get(id);
  if (existing) {
    existing.changes += 1;
    existing.lastTs = ts;
    existing.option = option; // keep their current pick
    if (name && !existing.name) existing.name = name;
    // firstTs stays — that's when they first responded (the chronological key)
  } else {
    voters.set(id, { id, name, option, firstTs: ts, lastTs: ts, changes: 0 });
  }
  return true;
}

function snapshot() {
  const list = [...voters.values()]
    .sort((a, b) => a.firstTs - b.firstTs)
    .map((v, i) => ({ rank: i + 1, ...v, display: v.name || ('+' + v.id) }));
  return { pollTitle, count: list.length, voters: list };
}

function broadcast() {
  save();
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) { try { res.write(data); } catch (_) {} }
}

/* -------------------------------- server --------------------------------- */
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  // Provider webhook verification (Meta-style) responds to a GET challenge
  if (req.method === 'GET' && u.pathname === '/webhook') {
    const challenge = u.searchParams.get('hub.challenge');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(challenge || 'webhook ok');
  }

  // Incoming votes
  if (req.method === 'POST' && u.pathname === '/webhook') {
    const body = await readBody(req);
    let n = 0;
    for (const v of extractVoteObjects(body)) if (recordVote(parseVote(v))) n++;
    if (n) broadcast();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, recorded: n }));
  }

  // Snapshot (polling fallback)
  if (req.method === 'GET' && u.pathname === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snapshot()));
  }

  // Live updates
  if (req.method === 'GET' && u.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Reset everything
  if (req.method === 'POST' && u.pathname === '/reset') {
    voters = new Map(); pollTitle = '';
    broadcast();
    res.writeHead(200); return res.end('{"ok":true}');
  }

  // Set the poll title (optional, cosmetic)
  if (req.method === 'POST' && u.pathname === '/title') {
    const b = await readBody(req); pollTitle = String(b.title || '');
    broadcast();
    res.writeHead(200); return res.end('{"ok":true}');
  }

  // Dashboard
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  Poll tracker running.\n  Dashboard : http://localhost:${PORT}\n  Webhook   : POST http://localhost:${PORT}/webhook   (point your provider here)\n`);
});

/* ------------------------------ dashboard -------------------------------- */
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Poll Responders — in order</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#f4efe6; --ink:#1c1a17; --muted:#7a7468; --line:#ddd4c5;
    --accent:#c2410c; --accent2:#15803d; --card:#fbf8f2;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--paper);color:var(--ink);font-family:"IBM Plex Mono",monospace;
       min-height:100vh;padding:28px 18px 60px;
       background-image:radial-gradient(circle at 1px 1px,rgba(0,0,0,.04) 1px,transparent 0);
       background-size:22px 22px}
  .wrap{max-width:760px;margin:0 auto}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;
         border-bottom:2px solid var(--ink);padding-bottom:14px;flex-wrap:wrap}
  h1{font-family:"Fraunces",serif;font-weight:900;font-size:clamp(28px,6vw,46px);
     line-height:.95;letter-spacing:-.02em}
  h1 em{font-style:italic;color:var(--accent)}
  .sub{color:var(--muted);font-size:12px;margin-top:6px;letter-spacing:.04em;text-transform:uppercase}
  .live{display:flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--accent2);box-shadow:0 0 0 0 rgba(21,128,61,.6);animation:pulse 1.8s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(21,128,61,.5)}70%{box-shadow:0 0 0 10px rgba(21,128,61,0)}100%{box-shadow:0 0 0 0 rgba(21,128,61,0)}}
  .count{font-family:"Fraunces",serif;font-weight:900;font-size:40px;line-height:1}
  .countwrap{text-align:right}
  .countlbl{font-size:11px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase}
  .bar{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 6px}
  button{font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.05em;
         text-transform:uppercase;padding:9px 14px;border:1.5px solid var(--ink);
         background:transparent;color:var(--ink);cursor:pointer;border-radius:2px;transition:.15s}
  button:hover{background:var(--ink);color:var(--paper)}
  button.warn{border-color:var(--accent);color:var(--accent)}
  button.warn:hover{background:var(--accent);color:var(--paper)}
  ul{list-style:none;margin-top:14px}
  li{display:flex;align-items:center;gap:14px;background:var(--card);border:1px solid var(--line);
     border-left:4px solid var(--accent);padding:12px 14px;margin-bottom:9px;border-radius:3px;
     animation:in .45s ease both;box-shadow:2px 2px 0 rgba(0,0,0,.04)}
  @keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .rank{font-family:"Fraunces",serif;font-weight:900;font-size:22px;min-width:38px;text-align:center;color:var(--accent)}
  .who{flex:1;min-width:0}
  .name{font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pick{display:inline-block;margin-top:4px;font-size:11px;color:var(--accent2);
        border:1px solid var(--accent2);padding:2px 7px;border-radius:99px}
  .changed{margin-left:6px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}
  .when{text-align:right;font-size:13px;color:var(--muted);white-space:nowrap}
  .when b{display:block;color:var(--ink);font-weight:600}
  .empty{text-align:center;color:var(--muted);padding:48px 0;font-size:13px;line-height:1.7}
  .empty strong{color:var(--ink)}
  footer{margin-top:26px;color:var(--muted);font-size:11px;line-height:1.7;border-top:1px solid var(--line);padding-top:14px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Who replied <em>first</em></h1>
      <div class="sub" id="title">Live WhatsApp poll order</div>
    </div>
    <div class="countwrap">
      <div class="live"><span class="dot"></span><span id="status">live</span></div>
      <div class="count" id="count">0</div>
      <div class="countlbl">responders</div>
    </div>
  </header>

  <div class="bar">
    <button onclick="demo()">Load demo</button>
    <button onclick="exportCsv()">Export CSV</button>
    <button class="warn" onclick="reset()">Reset</button>
  </div>

  <ul id="list"></ul>

  <div class="empty" id="empty">
    <strong>No votes yet.</strong><br/>
    Point your WhatsApp provider's webhook at <strong>/webhook</strong>,<br/>
    then open a poll in your group — or hit <strong>Load demo</strong> to preview.
  </div>

  <footer>
    Voters just tap a normal WhatsApp poll — nothing new for them. This board records the
    moment each person first responded (changing a vote keeps the original time).
  </footer>
</div>

<script>
  let current = {voters:[], count:0, pollTitle:''};

  function fmt(ts){
    const d = new Date(ts);
    return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  function render(s){
    current = s;
    document.getElementById('count').textContent = s.count;
    document.getElementById('title').textContent = s.pollTitle || 'Live WhatsApp poll order';
    const list = document.getElementById('list');
    const empty = document.getElementById('empty');
    empty.style.display = s.count ? 'none' : 'block';
    list.innerHTML = s.voters.map(v => \`
      <li>
        <div class="rank">\${v.rank}</div>
        <div class="who">
          <div class="name">\${esc(v.display)}</div>
          <span class="pick">\${esc(v.option)}</span>\${v.changes ? '<span class="changed">changed '+v.changes+'×</span>':''}
        </div>
        <div class="when"><b>\${fmt(v.firstTs)}</b>#\${v.rank}</div>
      </li>\`).join('');
  }
  function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

  // live via SSE, with polling fallback
  function connect(){
    try{
      const es = new EventSource('/events');
      es.onmessage = e => render(JSON.parse(e.data));
      es.onerror = () => { es.close(); document.getElementById('status').textContent='polling'; poll(); };
    }catch(_){ poll(); }
  }
  function poll(){ fetch('/data').then(r=>r.json()).then(render).finally(()=>setTimeout(poll,3000)); }
  connect();

  async function reset(){ if(confirm('Clear all recorded responders?')){ await fetch('/reset',{method:'POST'}); } }

  function exportCsv(){
    const rows = [['rank','name_or_number','choice','first_response_time','changes']];
    current.voters.forEach(v => rows.push([v.rank, v.display, v.option, new Date(v.firstTs).toISOString(), v.changes]));
    const csv = rows.map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = 'poll-responders.csv'; a.click();
  }

  async function demo(){
    await fetch('/title',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Pizza on Friday?'})});
    const names=[['Priya','Yes'],['Marcus','Yes'],['Lena','No'],['Tom','Yes'],['Aïsha','Maybe'],['Dev','Yes'],['Carla','No']];
    let t = Date.now() - 6*60*1000;
    for(const [n,o] of names){
      t += Math.floor(Math.random()*55000)+8000;
      await fetch('/webhook',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({payload:{vote:{from:'demo-'+n+'@c.us',pushName:n,selectedOptions:[o],timestamp:Math.round(t/1000)}}})});
      await new Promise(r=>setTimeout(r,180));
    }
  }
</script>
</body>
</html>`;
