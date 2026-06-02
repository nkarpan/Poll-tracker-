/* =============================================================================
   WhatsApp Poll — Chronological Responder Tracker  (v2)
   -----------------------------------------------------------------------------
   WHAT CHANGED IN v2
     v1 mistakenly read the poll's CREATOR on every vote, so all votes looked
     like "you, changing your vote." v2 reads each individual voter out of the
     poll's results list, so every person shows up separately, in the order
     they first voted. It also handles WhatsApp's newer "hidden number" (LID)
     privacy, and adds a /raw page to inspect exactly what your provider sends.

   THE VOTERS STILL DO NOTHING NEW
     They tap a normal WhatsApp poll. No links, no apps, no signup.

   RUN LOCALLY (optional sanity check)
     node whatsapp-poll-tracker.js   ->  open the printed URL  ->  Load demo

   LIVE SETUP (recap)
     - Deploy this file (Render, Node). Webhook is:  <your-url>/webhook
     - In Whapi: webhook URL = <your-url>/webhook, and under events make sure
       "messages" is enabled in BOTH default (POST) and updates (PATCH) modes —
       poll votes arrive as message UPDATES.
     - The poll must be created by the connected number (it already is if your
       own vote decodes), so its votes can be decrypted.

   DEBUG
     If anyone is missing or mislabeled, open  <your-url>/raw  to see the last
     few raw payloads, screenshot it, and the exact field names can be matched.

   Zero dependencies. Data + raw feed persist to votes.json next to this file.
   ⚠️ Use a SPARE WhatsApp number with any QR-based API — ban risk.
============================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'votes.json');

// voterId -> { id, name, hidden, option, firstTs, lastTs, changes }
let voters = new Map();
let pollTitle = '';
let rawFeed = [];                 // last raw webhook payloads (for /raw)
const clients = new Set();        // live SSE connections

load();

/* ----------------------------- persistence ------------------------------- */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    pollTitle = raw.pollTitle || '';
    rawFeed = raw.rawFeed || [];
    (raw.voters || []).forEach(v => voters.set(v.id, v));
  } catch (_) {}
}
function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ pollTitle, rawFeed, voters: [...voters.values()] }));
  } catch (e) { console.error('save failed', e.message); }
}

/* ------------------------------- helpers --------------------------------- */
function asArray(x) { return Array.isArray(x) ? x : [x]; }

function normTimestamp(t) {
  const n = Number(t);
  if (!n || Number.isNaN(n)) return null;
  return n > 1e12 ? n : Math.round(n * 1000);
}

function rawIdString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return String(v.id || v.from || v.jid || v.wid || v.contact_id || v.lid || '');
  return String(v);
}
function isHidden(raw) { return /@lid/i.test(raw) || /lid/i.test(raw) && !/@/.test(raw) === false ? /@lid/i.test(raw) : false; }
function cleanId(raw) {
  const s = rawIdString(raw);
  return s.replace(/@.*/, '').replace(/[^0-9a-zA-Z._-]/g, '') || 'unknown';
}
function voterName(v) {
  if (v && typeof v === 'object') return v.name || v.pushname || v.pushName || v.notify || v.notifyName || null;
  return null;
}
function voterTs(v) {
  if (v && typeof v === 'object') return normTimestamp(v.timestamp || v.time || v.t);
  return null;
}

/* --------------------------- record one voter ---------------------------- */
function upsert(rawId, name, option, ts) {
  const id = cleanId(rawId);
  if (id === 'unknown') return false;
  const hidden = /@lid/i.test(rawIdString(rawId));
  const existing = voters.get(id);
  if (existing) {
    let changed = false;
    if (option && option !== existing.option) { existing.option = option; existing.changes += 1; changed = true; }
    if (name && !existing.name) { existing.name = name; changed = true; }
    existing.lastTs = ts;
    return changed;
  }
  voters.set(id, { id, name: name || null, hidden, option: option || '(vote)', firstTs: ts, lastTs: ts, changes: 0 });
  return true;
}

/* --------------------------- payload extraction --------------------------
   Handles three shapes:
   A) Single vote event  (WAHA / our demo): { payload:{ vote:{ from, selectedOptions, timestamp } } }
   B) Poll results snapshot (Whapi):       message with poll.results[]={ name, voters[], count }
   C) Generic single vote:                 { from, selectedOptions } */
function collectItems(body) {
  const out = [];
  for (const item of asArray(body)) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.messages)) item.messages.forEach(m => out.push(m));
    else if (Array.isArray(item.messages_updates)) item.messages_updates.forEach(m => out.push(m));
    else out.push(item);
  }
  return out;
}

function findPollResults(node) {
  // prefer the post-update state if present
  const root = (node && (node.after_update || node.message || node)) || node;
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (cur.results && Array.isArray(cur.results)) {
      // results that carry voters look like poll results
      if (cur.results.some(r => r && (Array.isArray(r.voters) || typeof r.count === 'number')))
        return { results: cur.results, title: cur.title || cur.name || null };
    }
    if (cur.poll && cur.poll.results && Array.isArray(cur.poll.results))
      return { results: cur.poll.results, title: cur.poll.title || cur.poll.name || null };
    for (const k of Object.keys(cur)) {
      if (k === 'before_update') continue;            // ignore stale state
      if (cur[k] && typeof cur[k] === 'object') queue.push(cur[k]);
    }
  }
  return null;
}

function handleWebhook(body) {
  // keep a raw copy for /raw
  try {
    rawFeed.unshift({ at: new Date().toISOString(), body });
    rawFeed = rawFeed.slice(0, 10);
  } catch (_) {}

  const now = Date.now();
  let changes = 0;

  for (const item of collectItems(body)) {
    // A) explicit single vote
    const directVote = (item.payload && item.payload.vote) ? item.payload.vote : null;
    if (directVote) {
      const opt = asArray(directVote.selectedOptions || directVote.selected || directVote.options || []).join(', ') || '(vote)';
      const ts = voterTs(directVote) || now;
      if (upsert(directVote.from || directVote.author || directVote.voter, voterName(directVote), opt, ts)) changes++;
      continue;
    }

    // B) poll results snapshot (the common Whapi group case)
    const pr = findPollResults(item);
    if (pr) {
      if (pr.title && !pollTitle) pollTitle = pr.title;
      for (const opt of pr.results) {
        const label = opt.name || opt.title || opt.optionName || '(option)';
        const list = Array.isArray(opt.voters) ? opt.voters : [];
        for (const voter of list) {
          const ts = voterTs(voter) || now;      // per-voter time if given, else arrival time
          if (upsert(voter, voterName(voter), label, ts)) changes++;
        }
      }
      continue;
    }

    // C) generic single vote fallback
    if (item.selectedOptions || item.selected) {
      const opt = asArray(item.selectedOptions || item.selected).join(', ') || '(vote)';
      const ts = voterTs(item) || now;
      if (upsert(item.from || item.author || item.participant, voterName(item), opt, ts)) changes++;
    }
  }
  return changes;
}

/* ------------------------------ snapshot --------------------------------- */
function display(v) {
  if (v.name) return v.name;
  if (v.hidden) return 'Hidden member ·' + String(v.id).slice(-4);
  return '+' + v.id;
}
function snapshot() {
  const list = [...voters.values()]
    .sort((a, b) => a.firstTs - b.firstTs)
    .map((v, i) => ({ rank: i + 1, ...v, display: display(v) }));
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

  if (req.method === 'GET' && u.pathname === '/webhook') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(u.searchParams.get('hub.challenge') || 'webhook ok');
  }

  if (req.method === 'POST' && u.pathname === '/webhook') {
    const body = await readBody(req);
    const n = handleWebhook(body);
    broadcast();                       // save raw feed even if 0 parsed changes
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, changes: n }));
  }

  if (req.method === 'GET' && u.pathname === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snapshot()));
  }

  if (req.method === 'GET' && u.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Raw payload inspector
  if (req.method === 'GET' && u.pathname === '/raw') {
    const pretty = rawFeed.map(r => `<h3>${r.at}</h3><pre>${escapeHtml(JSON.stringify(r.body, null, 2))}</pre>`).join('<hr/>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:ui-monospace,monospace;background:#111;color:#eee;padding:14px"><h2>Last ${rawFeed.length} webhook payloads</h2>${pretty || '<p>Nothing received yet. Cast a vote, then refresh.</p>'}</body>`);
  }

  if (req.method === 'POST' && u.pathname === '/reset') {
    voters = new Map(); pollTitle = ''; rawFeed = [];
    broadcast();
    res.writeHead(200); return res.end('{"ok":true}');
  }

  if (req.method === 'POST' && u.pathname === '/title') {
    const b = await readBody(req); pollTitle = String(b.title || '');
    broadcast();
    res.writeHead(200); return res.end('{"ok":true}');
  }

  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  Poll tracker v2 running.\n  Dashboard : http://localhost:${PORT}\n  Webhook   : POST http://localhost:${PORT}/webhook\n  Raw feed  : http://localhost:${PORT}/raw\n`);
});

function escapeHtml(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

/* ------------------------------ dashboard -------------------------------- */
const PAGE = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Poll Responders — in order</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--paper:#f4efe6;--ink:#1c1a17;--muted:#7a7468;--line:#ddd4c5;--accent:#c2410c;--accent2:#15803d;--card:#fbf8f2;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--paper);color:var(--ink);font-family:"IBM Plex Mono",monospace;min-height:100vh;padding:28px 18px 60px;background-image:radial-gradient(circle at 1px 1px,rgba(0,0,0,.04) 1px,transparent 0);background-size:22px 22px}
  .wrap{max-width:760px;margin:0 auto}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:14px;flex-wrap:wrap}
  h1{font-family:"Fraunces",serif;font-weight:900;font-size:clamp(28px,6vw,46px);line-height:.95;letter-spacing:-.02em}
  h1 em{font-style:italic;color:var(--accent)}
  .sub{color:var(--muted);font-size:12px;margin-top:6px;letter-spacing:.04em;text-transform:uppercase}
  .live{display:flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--accent2);animation:pulse 1.8s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(21,128,61,.5)}70%{box-shadow:0 0 0 10px rgba(21,128,61,0)}100%{box-shadow:0 0 0 0 rgba(21,128,61,0)}}
  .count{font-family:"Fraunces",serif;font-weight:900;font-size:40px;line-height:1}
  .countwrap{text-align:right}.countlbl{font-size:11px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase}
  .bar{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 6px}
  button,a.btn{font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.05em;text-transform:uppercase;padding:9px 14px;border:1.5px solid var(--ink);background:transparent;color:var(--ink);cursor:pointer;border-radius:2px;transition:.15s;text-decoration:none;display:inline-block}
  button:hover,a.btn:hover{background:var(--ink);color:var(--paper)}
  button.warn{border-color:var(--accent);color:var(--accent)}button.warn:hover{background:var(--accent);color:var(--paper)}
  ul{list-style:none;margin-top:14px}
  li{display:flex;align-items:center;gap:14px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);padding:12px 14px;margin-bottom:9px;border-radius:3px;animation:in .45s ease both;box-shadow:2px 2px 0 rgba(0,0,0,.04)}
  @keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .rank{font-family:"Fraunces",serif;font-weight:900;font-size:22px;min-width:38px;text-align:center;color:var(--accent)}
  .who{flex:1;min-width:0}.name{font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pick{display:inline-block;margin-top:4px;font-size:11px;color:var(--accent2);border:1px solid var(--accent2);padding:2px 7px;border-radius:99px}
  .changed{margin-left:6px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}
  .when{text-align:right;font-size:13px;color:var(--muted);white-space:nowrap}.when b{display:block;color:var(--ink);font-weight:600}
  .empty{text-align:center;color:var(--muted);padding:48px 0;font-size:13px;line-height:1.7}.empty strong{color:var(--ink)}
  footer{margin-top:26px;color:var(--muted);font-size:11px;line-height:1.7;border-top:1px solid var(--line);padding-top:14px}
</style></head>
<body><div class="wrap">
  <header>
    <div><h1>Who replied <em>first</em></h1><div class="sub" id="title">Live WhatsApp poll order</div></div>
    <div class="countwrap"><div class="live"><span class="dot"></span><span id="status">live</span></div><div class="count" id="count">0</div><div class="countlbl">responders</div></div>
  </header>
  <div class="bar">
    <button onclick="demo()">Load demo</button>
    <button onclick="exportCsv()">Export CSV</button>
    <a class="btn" href="/raw" target="_blank">Raw feed</a>
    <button class="warn" onclick="reset()">Reset</button>
  </div>
  <ul id="list"></ul>
  <div class="empty" id="empty"><strong>No votes yet.</strong><br/>Webhook endpoint is <strong>/webhook</strong>. Open a poll in your group — or hit <strong>Load demo</strong>.<br/>Something missing? Check <strong>/raw</strong>.</div>
  <footer>Each row is one person, ordered by when they first voted. "Hidden member" means WhatsApp's privacy hid that voter's number (nothing we can change).</footer>
</div>
<script>
  let current = {voters:[], count:0, pollTitle:''};
  function fmt(ts){return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});}
  function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
  function render(s){
    current = s;
    document.getElementById('count').textContent = s.count;
    document.getElementById('title').textContent = s.pollTitle || 'Live WhatsApp poll order';
    document.getElementById('empty').style.display = s.count ? 'none' : 'block';
    document.getElementById('list').innerHTML = s.voters.map(v => \`
      <li><div class="rank">\${v.rank}</div>
        <div class="who"><div class="name">\${esc(v.display)}</div>
        <span class="pick">\${esc(v.option)}</span>\${v.changes ? '<span class="changed">changed '+v.changes+'×</span>':''}</div>
        <div class="when"><b>\${fmt(v.firstTs)}</b>#\${v.rank}</div></li>\`).join('');
  }
  function connect(){try{const es=new EventSource('/events');es.onmessage=e=>render(JSON.parse(e.data));es.onerror=()=>{es.close();document.getElementById('status').textContent='polling';poll();};}catch(_){poll();}}
  function poll(){fetch('/data').then(r=>r.json()).then(render).finally(()=>setTimeout(poll,3000));}
  connect();
  async function reset(){if(confirm('Clear all recorded responders?')){await fetch('/reset',{method:'POST'});}}
  function exportCsv(){
    const rows=[['rank','name_or_number','choice','first_response_time','changes','hidden']];
    current.voters.forEach(v=>rows.push([v.rank,v.display,v.option,new Date(v.firstTs).toISOString(),v.changes,v.hidden?'yes':'no']));
    const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='poll-responders.csv';a.click();
  }
  async function demo(){
    await fetch('/title',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Pizza on Friday?'})});
    const names=[['Priya','Yes'],['Marcus','Yes'],['Lena','No'],['Tom','Yes'],['Aisha','Maybe'],['Dev','Yes'],['Carla','No']];
    for(const [n,o] of names){
      await fetch('/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:{vote:{from:'demo-'+n+'@c.us',pushName:n,selectedOptions:[o]}}})});
      await new Promise(r=>setTimeout(r,220));
    }
  }
</script></body></html>`;
