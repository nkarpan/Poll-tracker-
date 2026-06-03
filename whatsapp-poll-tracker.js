/* =============================================================================
   WhatsApp Poll — Chronological Responder Tracker  (v3)
   -----------------------------------------------------------------------------
   WHAT v3 FIXES (based on the real Whapi payloads)
     - A vote arrives as a separate "action" message: the voter is the top-level
       from / from_name, and the choice is an option ID in action.votes. v3 reads
       exactly that, and maps the option ID back to its name using the poll
       definition (the "poll" message that carries results[].id + name).
     - Multiple polls are now separated by the poll's ID (action.target). The
       dashboard has a poll picker; it defaults to the newest poll, so votes from
       older polls never mix in.
     - Real vote timestamps (from each action message) drive the ordering.

   THE VOTERS STILL DO NOTHING NEW — they tap a normal WhatsApp poll.

   UPDATE / DEPLOY NOTE (important!)
     When you download this file, your device may rename it "...-tracker 2.js".
     GitHub treats that as a NEW file and your package.json won't find it.
     FIX: rename the file to exactly  whatsapp-poll-tracker.js  BEFORE uploading
     (in the Files app: long-press -> Rename), then upload to replace the old one.

   Webhook endpoint:  <your-url>/webhook      Raw inspector: <your-url>/raw
   Zero dependencies. State persists to votes.json next to this file.
   ⚠️ Use a SPARE WhatsApp number with any QR-based API — ban risk.
============================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'votes.json');

let polls = new Map();    // pollId -> { id, title, optionsById:{id:name}, createdTs }
let voters = new Map();   // `${pollId}|${voterId}` -> {...}
let rawFeed = [];         // last raw webhook payloads
const clients = new Set();

load();

/* ----------------------------- persistence ------------------------------- */
function load() {
  try {
    const r = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (r.polls || []).forEach(p => polls.set(p.id, p));
    (r.voters || []).forEach(v => voters.set(v.pollId + '|' + v.voterId, v));
    rawFeed = r.rawFeed || [];
  } catch (_) {}
}
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ polls: [...polls.values()], voters: [...voters.values()], rawFeed })); }
  catch (e) { console.error('save failed', e.message); }
}

/* ------------------------------- helpers --------------------------------- */
function asArray(x) { return Array.isArray(x) ? x : [x]; }
function normTs(t) { const n = Number(t); if (!n || Number.isNaN(n)) return null; return n > 1e12 ? n : Math.round(n * 1000); }
function rawIdStr(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return String(v.id || v.from || v.jid || ''); return String(v); }
function cleanId(v) { return rawIdStr(v).replace(/@.*/, '').replace(/[^0-9a-zA-Z._-]/g, '') || 'unknown'; }
function isHidden(v) { return /@lid/i.test(rawIdStr(v)); }

function collectMessages(body) {
  const out = [];
  for (const item of asArray(body)) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.messages)) item.messages.forEach(m => out.push(m));
    else if (Array.isArray(item.messages_updates)) item.messages_updates.forEach(m => out.push(m));
    else out.push(item);
  }
  return out;
}

/* ------------------------------- recording ------------------------------- */
function ensurePoll(pollId, ts) {
  if (!polls.has(pollId)) polls.set(pollId, { id: pollId, title: '(poll)', optionsById: {}, createdTs: ts || Date.now() });
  return polls.get(pollId);
}

function registerPoll(msg, now) {
  if (msg.type !== 'poll' || !msg.poll) return false;
  const id = msg.id || ('poll-' + now);
  const createdTs = normTs(msg.timestamp) || now;
  const optionsById = {};
  (msg.poll.results || []).forEach(r => { if (r && r.id != null) optionsById[r.id] = r.name; });
  // fallback: options array with no ids
  if (!Object.keys(optionsById).length && Array.isArray(msg.poll.options))
    msg.poll.options.forEach(o => { optionsById[o] = o; });
  polls.set(id, { id, title: msg.poll.title || '(poll)', optionsById, createdTs });
  return true;
}

function recordVote(pollId, voterRaw, name, sel, selAreNames, ts) {
  const voterId = cleanId(voterRaw);
  if (voterId === 'unknown' && !name) return false;
  ensurePoll(pollId, ts);
  const key = pollId + '|' + voterId;
  const optsKey = (sel || []).slice().sort().join('|');
  const existing = voters.get(key);
  if (existing) {
    let changed = false;
    if (optsKey !== existing.optsKey) { existing.sel = sel; existing.optsKey = optsKey; existing.changes += 1; changed = true; }
    if (name && !existing.name) { existing.name = name; changed = true; }
    existing.lastTs = ts;
    return changed;
  }
  voters.set(key, { pollId, voterId, name: name || null, hidden: isHidden(voterRaw), sel: sel || [], selAreNames: !!selAreNames, optsKey, firstTs: ts, lastTs: ts, changes: 0 });
  return true;
}

function handleWebhook(body) {
  try { rawFeed.unshift({ at: new Date().toISOString(), body }); rawFeed = rawFeed.slice(0, 10); } catch (_) {}
  const now = Date.now();
  let changes = 0;

  for (const msg of collectMessages(body)) {
    // 1) poll definition
    if (registerPoll(msg, now)) { changes++; continue; }

    // 2) Whapi vote action
    if (msg.type === 'action' && msg.action && msg.action.type === 'vote') {
      const ts = normTs(msg.timestamp) || now;
      const sel = Array.isArray(msg.action.votes) ? msg.action.votes : [];
      if (recordVote(msg.action.target || 'default', msg.from, msg.from_name, sel, false, ts)) changes++;
      continue;
    }
    // (we intentionally ignore action.type === 'delete' so test polls don't vanish)

    // 3) WAHA-style single vote: { payload:{ vote:{ from, selectedOptions, timestamp } } }
    const dv = msg.payload && msg.payload.vote;
    if (dv) {
      const ts = normTs(dv.timestamp) || now;
      const sel = asArray(dv.selectedOptions || dv.selected || []).filter(Boolean);
      if (recordVote(dv.pollId || 'default', dv.from || dv.author, dv.pushName || dv.name, sel, true, ts)) changes++;
      continue;
    }

    // 4) generic single vote with named options
    if (msg.selectedOptions || msg.selected) {
      const ts = normTs(msg.timestamp) || now;
      const sel = asArray(msg.selectedOptions || msg.selected).filter(Boolean);
      if (recordVote(msg.pollId || 'default', msg.from || msg.author, msg.from_name || msg.name, sel, true, ts)) changes++;
    }
  }
  return changes;
}

/* ------------------------------- snapshot -------------------------------- */
function resolveOptions(v) {
  if (v.selAreNames) return v.sel;
  const p = polls.get(v.pollId);
  if (!p) return v.sel.map(() => '(option)');
  return v.sel.map(id => p.optionsById[id] || '(option)');
}
function displayName(v) {
  if (v.name) return v.name;
  if (v.hidden) return 'Hidden member ·' + String(v.voterId).slice(-4);
  return '+' + v.voterId;
}
function snapshot() {
  const byPoll = {};
  for (const v of voters.values()) (byPoll[v.pollId] = byPoll[v.pollId] || []).push(v);
  const out = {};
  for (const pid of Object.keys(byPoll)) {
    out[pid] = byPoll[pid].sort((a, b) => a.firstTs - b.firstTs).map((v, i) => ({
      rank: i + 1, display: displayName(v), option: resolveOptions(v).join(', ') || '(vote)',
      firstTs: v.firstTs, changes: v.changes, hidden: v.hidden,
    }));
  }
  const pollsList = [...polls.values()]
    .map(p => ({ id: p.id, title: p.title, createdTs: p.createdTs, count: (out[p.id] || []).length }))
    .sort((a, b) => b.createdTs - a.createdTs);
  return { polls: pollsList, byPoll: out, defaultPollId: pollsList[0] ? pollsList[0].id : null };
}
function broadcast() {
  save();
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) { try { res.write(data); } catch (_) {} }
}

/* -------------------------------- server --------------------------------- */
function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
}
function escapeHtml(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && u.pathname === '/webhook') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(u.searchParams.get('hub.challenge') || 'webhook ok'); }
  if (req.method === 'POST' && u.pathname === '/webhook') { const b = await readBody(req); handleWebhook(b); broadcast(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.method === 'GET' && u.pathname === '/data') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(snapshot())); }
  if (req.method === 'GET' && u.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (req.method === 'GET' && u.pathname === '/raw') {
    const pretty = rawFeed.map(r => `<h3>${r.at}</h3><pre>${escapeHtml(JSON.stringify(r.body, null, 2))}</pre>`).join('<hr/>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:ui-monospace,monospace;background:#111;color:#eee;padding:14px"><h2>Last ${rawFeed.length} webhook payloads</h2>${pretty || '<p>Nothing yet. Vote, then refresh.</p>'}</body>`);
  }
  if (req.method === 'POST' && u.pathname === '/reset') { polls = new Map(); voters = new Map(); rawFeed = []; broadcast(); res.writeHead(200); return res.end('{"ok":true}'); }
  if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, () => console.log(`\n  Poll tracker v3 running.\n  Dashboard : http://localhost:${PORT}\n  Webhook   : POST http://localhost:${PORT}/webhook\n  Raw feed  : http://localhost:${PORT}/raw\n`));

/* ------------------------------ dashboard -------------------------------- */
const PAGE = `<!DOCTYPE html><html lang="en"><head>
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
  .count{font-family:"Fraunces",serif;font-weight:900;font-size:40px;line-height:1}.countwrap{text-align:right}
  .countlbl{font-size:11px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase}
  .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:18px 0 6px}
  select,button,a.btn{font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.05em;text-transform:uppercase;padding:9px 14px;border:1.5px solid var(--ink);background:transparent;color:var(--ink);cursor:pointer;border-radius:2px;text-decoration:none;display:inline-block}
  button:hover,a.btn:hover{background:var(--ink);color:var(--paper)}
  button.warn{border-color:var(--accent);color:var(--accent)}button.warn:hover{background:var(--accent);color:var(--paper)}
  select{max-width:100%}
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
</style></head><body><div class="wrap">
  <header>
    <div><h1>Who replied <em>first</em></h1><div class="sub" id="title">Live WhatsApp poll order</div></div>
    <div class="countwrap"><div class="live"><span class="dot"></span><span id="status">live</span></div><div class="count" id="count">0</div><div class="countlbl">responders</div></div>
  </header>
  <div class="controls">
    <select id="pollPicker" onchange="onPick()"></select>
    <button onclick="demo()">Load demo</button>
    <button onclick="exportCsv()">Export CSV</button>
    <a class="btn" href="/raw" target="_blank">Raw feed</a>
    <button class="warn" onclick="reset()">Reset</button>
  </div>
  <ul id="list"></ul>
  <div class="empty" id="empty"><strong>No votes for this poll yet.</strong><br/>Open a poll in your group and have people vote — or hit <strong>Load demo</strong>.<br/>Nothing showing? Check <strong>/raw</strong>.</div>
  <footer>Each row is one person, ordered by when they first voted, for the poll selected above. Switch polls with the dropdown. "Hidden member" means WhatsApp's privacy masked that voter's number.</footer>
</div>
<script>
  let state = {polls:[], byPoll:{}, defaultPollId:null};
  let selected = null;
  function fmt(ts){return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});}
  function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
  function onPick(){ selected = document.getElementById('pollPicker').value; render(state, true); }
  function render(s, keepSel){
    state = s;
    if(!keepSel){ if(!selected || !s.polls.some(p=>p.id===selected)) selected = s.defaultPollId; }
    const picker = document.getElementById('pollPicker');
    picker.innerHTML = s.polls.length
      ? s.polls.map(p=>\`<option value="\${esc(p.id)}" \${p.id===selected?'selected':''}>\${esc(p.title)} — \${p.count} (\${fmt(p.createdTs)})</option>\`).join('')
      : '<option>— no polls yet —</option>';
    const rows = (selected && s.byPoll[selected]) ? s.byPoll[selected] : [];
    const pollObj = s.polls.find(p=>p.id===selected);
    document.getElementById('count').textContent = rows.length;
    document.getElementById('title').textContent = pollObj ? pollObj.title : 'Live WhatsApp poll order';
    document.getElementById('empty').style.display = rows.length ? 'none' : 'block';
    document.getElementById('list').innerHTML = rows.map(v=>\`
      <li><div class="rank">\${v.rank}</div>
        <div class="who"><div class="name">\${esc(v.display)}</div>
        <span class="pick">\${esc(v.option)}</span>\${v.changes?'<span class="changed">changed '+v.changes+'×</span>':''}</div>
        <div class="when"><b>\${fmt(v.firstTs)}</b>#\${v.rank}</div></li>\`).join('');
  }
  function connect(){try{const es=new EventSource('/events');es.onmessage=e=>render(JSON.parse(e.data));es.onerror=()=>{es.close();document.getElementById('status').textContent='polling';poll();};}catch(_){poll();}}
  function poll(){fetch('/data').then(r=>r.json()).then(s=>render(s)).finally(()=>setTimeout(poll,3000));}
  connect();
  async function reset(){if(confirm('Clear all polls and responders?')){selected=null;await fetch('/reset',{method:'POST'});}}
  function exportCsv(){
    const rows=(selected&&state.byPoll[selected])?state.byPoll[selected]:[];
    const pollObj=state.polls.find(p=>p.id===selected);
    const out=[['poll','rank','name_or_number','choice','first_response_time','changes','hidden']];
    rows.forEach(v=>out.push([pollObj?pollObj.title:'',v.rank,v.display,v.option,new Date(v.firstTs).toISOString(),v.changes,v.hidden?'yes':'no']));
    const csv=out.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='poll-responders.csv';a.click();
  }
  async function demo(){
    const pollId='demo-'+Date.now();
    await fetch('/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{id:pollId,type:'poll',timestamp:Math.floor(Date.now()/1000),poll:{title:'Pizza on Friday?',options:['Yes','No','Maybe'],results:[{name:'Yes',id:'y'},{name:'No',id:'n'},{name:'Maybe',id:'m'}]}}]})});
    const v=[['Priya','y'],['Marcus','y'],['Lena','n'],['Tom','y'],['Aisha','m'],['Dev','y'],['Carla','n']];
    for(const [n,o] of v){
      await fetch('/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{type:'action',from:'demo-'+n,from_name:n,timestamp:Math.floor(Date.now()/1000),action:{target:pollId,type:'vote',votes:[o]}}]})});
      await new Promise(r=>setTimeout(r,200));
    }
    selected=pollId;
  }
</script></body></html>`;
