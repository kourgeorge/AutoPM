'use strict';
const $ = id => document.getElementById(id);
let started = false, strategy, pendingStrategy, status, cursor = 0, refreshing = false, refreshAgain = false, refreshTimer = null;
let commands = [], commandMatches = [], commandIndex = 0, commandDismissed = false;
let stream = null, awaitingReply = 0, view = 'live';
let aiSettingsLoaded = false, aiSettingsSaving = false;
let conversationClearKey = null, conversationClearedThrough = 0;
const pendingOrderDetails = new Set(), lastPrices = new Map();
const messageInput = $('message-text');
const riskFractions = ['positionSizePct','maxDailyLossPct','maxGrossExposurePct'];
const riskNumbers = ['maxPositions','stopLossAtrMult','maxSingleWeightPct','maxSectorWeightPct'];
const riskOptional = ['riskPerTradePct','targetVolatilityPct','minRewardRisk','targetInvestedPct','minInvestedPct','maxEntriesPerDay','lossCooldownHours','trailingStopAtrMult'];
const riskLabels = { positionSizePct:'Maximum position size', maxDailyLossPct:'Daily loss limit', maxGrossExposurePct:'Gross exposure limit',
  maxPositions:'Maximum positions', stopLossAtrMult:'Stop distance (ATR)', maxSingleWeightPct:'Single-name limit', maxSectorWeightPct:'Sector limit',
  riskPerTradePct:'Risk per trade', targetVolatilityPct:'Annualized portfolio volatility target', minRewardRisk:'Minimum reward:risk', targetInvestedPct:'Investment target', minInvestedPct:'Investment floor',
  maxEntriesPerDay:'New entries per day', lossCooldownHours:'Cooldown after a loss', trailingStopAtrMult:'Trailing stop' };
const suggestions = [['Portfolio brief', 'How is my portfolio doing?'], ['Latest decision', 'Why did you make your last trade?'], ['Watchlist', 'What are you watching right now?'], ['Risk check', 'What risks should I know about?']];
const money = n => n == null ? 'Unavailable' : new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(n);
const signedMoney = n => n == null ? '—' : (n > 0 ? '+' : '') + money(n);
const signedPct = n => n == null ? '' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
const direction = n => n > 0 ? 'up' : n < 0 ? 'down' : '';
const clock = at => new Date(at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
const logClock = new Intl.DateTimeFormat([], {hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
const text = (tag, value, cls) => { const e = document.createElement(tag); e.textContent = value; if(cls)e.className=cls; return e; };
let noticeTimer;
/** Errors stay until replaced; confirmations fade after a few seconds. */
const notice = (value, transient = false) => {
  clearTimeout(noticeTimer); $('notice').textContent = value; $('notice').hidden = !value;
  $('notice').classList.toggle('ok', transient);
  if (transient && value) noticeTimer = setTimeout(() => notice(''), 8000);
};
async function api(url, body) {
  const res = await fetch('/api/' + url, {headers: {'Content-Type':'application/json'}, ...(body === undefined ? {} : {method:'POST',body:JSON.stringify(body)})});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function attempt(fn) { return async event => { event?.preventDefault(); try { await fn(event); } catch(e) { notice(e.message); } }; }

// ── Start-up and live updates ──────────────────────────────────────────────
async function start() {
  started = true;
  showView(['activity','broker','strategy','performance','usage','review'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'live', false);
  $('suggestions').replaceChildren(...suggestions.map(([label, question]) => {
    const chip = text('button', label, 'chip'); chip.type = 'button'; chip.title = question;
    chip.onclick = attempt(() => sendMessage(question));
    return chip;
  }));
  for (const button of document.querySelectorAll('[data-question]')) button.onclick = () => askAbout(button.dataset.question);
  const [tail, initialStatus] = await Promise.all([api('feed?tail=150'),api('status')]);
  configureConversationClear(initialStatus);
  addEntries(tail.entries);
  connectStream();
  await Promise.all([refresh(), loadStrategy(), loadAiSettings(), loadCommands(), loadPrompts()]);
}
/**
 * The server pushes every new conversation line and a signal on each account update. The browser
 * reconnects by itself and the server replays anything missed; polling below is only a backstop.
 */
function connectStream() {
  stream?.close();
  stream = new EventSource('/api/stream?after=' + cursor);
  stream.onopen = () => setLive(true);
  stream.onerror = () => {
    setLive(false);
    if (stream.readyState === EventSource.CLOSED) setTimeout(connectStream, 5000);
  };
  stream.addEventListener('feed', event => { addEntries([JSON.parse(event.data)]); scheduleRefresh(); });
  stream.addEventListener('tick', () => scheduleRefresh());
  stream.addEventListener('reset', () => { stream.close(); refresh().finally(connectStream); });
}
function setLive(on) {
  $('live').textContent = on ? 'Live' : 'Reconnecting…';
  $('live').classList.toggle('on', on);
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(e => notice('Could not refresh account: ' + e.message)), 250);
}
async function loadCommands() {
  commands = (await api('commands')).commands;
  updateCommands();
}

// ── Views ──────────────────────────────────────────────────────────────────
function showView(name, load = true) {
  view = name;
  $('view-label').textContent = {live:'Live trading', activity:'Activity history', broker:'Broker orders', strategy:'Settings', performance:'Performance', usage:'AI usage', review:'Review'}[name];
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const selected = tab.dataset.view === name;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
  }
  history.replaceState(null, '', name === 'live' ? location.pathname : '#' + name);
  if (name === 'live') $('live-feed').scrollTop = $('live-feed').scrollHeight;
  if (name === 'live') { renderWelcome(); $('feed').scrollTop = $('welcome').hidden ? $('feed').scrollHeight : 0; }
  if (load && (name === 'review' || name === 'performance')) refresh().catch(e => notice(e.message));
  if (load && name === 'activity') loadHistory();
  if (load && name === 'usage') loadUsage().catch(e => notice(e.message));
  if (load && name === 'broker') { loadBrokerBook().catch(e => notice(e.message)); loadHistory('fills'); }
}
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.onclick = () => showView(tab.dataset.view);
  tab.onkeydown = event => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[role=tab]')], next = tabs[(tabs.indexOf(tab) + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length];
    next.focus(); showView(next.dataset.view);
  };
}

function hideCommands() {
  $('command-menu').hidden = true;
  messageInput.setAttribute('aria-expanded','false');
  messageInput.removeAttribute('aria-activedescendant');
}
function highlightCommand() {
  const options = [...$('command-list').children];
  options.forEach((option,index)=>option.setAttribute('aria-selected',String(index === commandIndex)));
  if(options[commandIndex]) {
    messageInput.setAttribute('aria-activedescendant',options[commandIndex].id);
    options[commandIndex].scrollIntoView({block:'nearest'});
  } else messageInput.removeAttribute('aria-activedescendant');
}
function updateCommands() {
  const match = /^\/([^\s/]*)$/.exec(messageInput.value);
  if(!commands.length || commandDismissed || document.activeElement !== messageInput ||
    !match || messageInput.selectionStart === 0 || messageInput.selectionStart !== messageInput.selectionEnd) return hideCommands();
  const prefix = match[1].toLowerCase();
  commandMatches = commands.filter(command=>[command.name,...command.aliases].some(name=>name.toLowerCase().startsWith(prefix)));
  commandIndex = 0;
  $('command-list').replaceChildren(...commandMatches.map((command,index)=>{
    const option = text('li','');
    option.id = `command-option-${index}`; option.setAttribute('role','option');
    option.append(text('strong',`/${command.name}${command.args?' '+command.args:''}`),text('small',command.help));
    option.onpointerdown = event=>event.preventDefault(); // Keep focus in the input during selection.
    option.onclick = ()=>chooseCommand(index);
    option.onpointermove = event=>{if(event.pointerType === 'mouse'){commandIndex=index;highlightCommand();}};
    return option;
  }));
  $('command-empty').hidden = commandMatches.length > 0;
  $('command-menu').hidden = false;
  messageInput.setAttribute('aria-expanded','true');
  highlightCommand();
}
function chooseCommand(index) {
  const command = commandMatches[index];
  if(!command) return;
  messageInput.value = `/${command.name} `;
  hideCommands();
  messageInput.focus();
  messageInput.setSelectionRange(messageInput.value.length,messageInput.value.length);
}
messageInput.addEventListener('input',()=>{commandDismissed=false;updateCommands();});
messageInput.addEventListener('focus',()=>{commandDismissed=false;updateCommands();});
messageInput.addEventListener('select',updateCommands);
messageInput.addEventListener('click',updateCommands);
messageInput.addEventListener('blur',hideCommands);
messageInput.addEventListener('keydown',event=>{
  if(event.isComposing || event.keyCode === 229) { if(event.key === 'Enter')event.preventDefault(); return; }
  if(event.ctrlKey || event.metaKey || event.altKey) return;
  if($('command-menu').hidden) {
    if(event.key === 'ArrowDown' && /^\/\S*$/.test(messageInput.value)) {commandDismissed=false;updateCommands();if(!$('command-menu').hidden)event.preventDefault();}
    return;
  }
  if(event.key === 'Escape') {event.preventDefault();commandDismissed=true;hideCommands();}
  else if((event.key === 'ArrowDown' || event.key === 'ArrowUp') && commandMatches.length) {
    event.preventDefault();commandIndex=(commandIndex+(event.key==='ArrowDown'?1:-1)+commandMatches.length)%commandMatches.length;highlightCommand();
  } else if((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) && commandMatches.length) {
    event.preventDefault();chooseCommand(commandIndex);
  }
});

// ── Conversation ───────────────────────────────────────────────────────────
const speakers = { operator:'You', assistant:'Assistant', trader:'Trader', researcher:'Research', system:'System' };
const roleLabel = role => ({ assistant:'Assistant', researcher:'Research' })[role] || 'Trader';
// Old research ran as a trader task in 'review_only' mode; new research is its own agent.
const taskMode = r => r.role === 'researcher' ? 'Stock research · no trading tools' : r.mode === 'review_only' ? 'Assessment only · trading tools disabled' : 'Normal agent request';
function entrySource(entry) {
  if (entry.kind === 'operator') return 'operator';
  if (entry.source || entry.tool?.agent) return entry.source || entry.tool.agent;
  // Older history predates explicit source metadata.
  if (/^(?:trader request |\[Trader(?:Tool)?\])/i.test(entry.text)) return 'trader';
  if (entry.kind === 'reply' || entry.kind === 'chart' || /^\[assistant\]/i.test(entry.text)) return 'assistant';
  return 'system';
}
function messageMeta(entry, source) {
  const meta = text('div', '', 'message-meta');
  meta.append(text('span', speakers[source] || source, 'message-author'));
  const kind = entry.kind === 'alert' ? 'Alert' : entry.kind === 'log' ? (entry.level || 'Event')
    : entry.kind === 'chart' ? 'Chart' : source === 'system' ? 'Update' : '';
  if (kind) meta.append(text('span', kind, 'message-type'));
  const time = text('time', clock(entry.at));time.dateTime = entry.at;time.title = new Date(entry.at).toLocaleString();
  meta.append(time);
  return meta;
}
// Build a small, safe Markdown subset with text nodes; model output is never HTML.
function appendInline(parent, value) {
  const fragments = value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const fragment of fragments) {
    if (fragment.startsWith('**') && fragment.endsWith('**')) parent.append(text('strong', fragment.slice(2,-2)));
    else if (fragment.startsWith('`') && fragment.endsWith('`')) parent.append(text('code', fragment.slice(1,-1)));
    else parent.append(document.createTextNode(fragment));
  }
}
function replyBody(value) {
  const body = text('div', '', 'reply-body');
  let paragraph = [], list = null, code = null;
  const flush = () => { if (paragraph.length) { const p = text('p',''); appendInline(p,paragraph.join('\n')); body.append(p); paragraph=[]; } };
  for (const line of value.split('\n')) {
    if (line.trimStart().startsWith('```')) { flush(); list=null; if(code){body.append(text('pre',code.join('\n')));code=null;}else code=[]; continue; }
    if (code !== null) { code.push(line); continue; }
    const heading = /^#{1,6}\s+(.+)/.exec(line), bullet = /^\s*(?:[-*]|\d+[.)])\s+(.+)/.exec(line);
    if (heading) { flush(); list=null; const h=text('h3','');appendInline(h,heading[1]);body.append(h); }
    else if (bullet) { flush(); if(!list){list=text('ul','');body.append(list);} const li=text('li','');appendInline(li,bullet[1]);list.append(li); }
    else if (!line.trim()) { flush(); list=null; }
    else { list=null; paragraph.push(line); }
  }
  flush(); if(code !== null)body.append(text('pre',code.join('\n')));
  return body;
}
function toolCallEntry(entry) {
  const tool = entry.tool;
  const details = text('details', '', 'tool-call');
  const summary = text('summary', '');
  const legacy = /^\[([^\]]+)\]\s+([^\s(]+)\((.*?)\)\s*(?:→|$)/s.exec(entry.text);
  const name = tool?.name || legacy?.[2] || 'Tool call';
  const caller = tool?.agent || legacy?.[1];
  const agent = { assistant: 'Assistant', trader: 'Trader' }[caller] || caller || 'Unknown caller';
  details.dataset.source = caller || 'system';
  const parameters = tool
    ? tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
      ? Object.entries(tool.input).map(([key,value]) => `${key}=${JSON.stringify(value)}`).join(', ')
      : tool.input == null ? '' : JSON.stringify(tool.input)
    : legacy?.[3] ?? 'parameters unavailable';
  const agentBadge = text('span',agent,'badge tool-call-agent');agentBadge.dataset.agent = caller || 'unknown';
  agentBadge.title = `${agent} called this tool`;
  const signature = text('span','','tool-call-signature');signature.title = `${name}(${parameters})`;
  signature.append(text('span',name,'tool-call-name'),text('span',`(${parameters})`,'tool-call-params'));
  summary.append(agentBadge,signature);
  const resultLabel = text('span', 'Tool result', 'tool-call-type');
  if (tool) {
    let failed = tool.failed === true;
    if (tool.output !== undefined) try {
      const result = JSON.parse(tool.output);
      failed = result?.ok === false || !!result?.error || result?.isError === true;
    } catch { /* Plain-text results are shown verbatim when expanded. */ }
    if (failed) { resultLabel.textContent = 'Error';resultLabel.classList.add('tool-call-error'); }
  }
  summary.append(resultLabel);
  const time = text('time', clock(entry.at));time.dateTime = entry.at;time.title = new Date(entry.at).toLocaleString();
  summary.append(time);
  const body = text('div', '', 'tool-call-body');
  // Keep full payloads in memory; build the potentially large detail DOM only on opening.
  details.addEventListener('toggle', async () => {
    if (!details.open || body.hasChildNodes() || details.dataset.loading) return;
    if (!tool) {
      body.append(text('p', 'Full input and output were not saved for this older call.'), text('pre', entry.text));
      return;
    }
    // The feed keeps only the receipt id; the output lives on the saved tool call.
    let output = tool.output;
    if (output === undefined) {
      details.dataset.loading = '1';
      try { output = (await api(`tool-output/${encodeURIComponent(tool.id)}`)).output ?? 'No result was recorded.'; }
      catch (error) { output = `Saved output unavailable: ${error.message}`; }
      finally { delete details.dataset.loading; }
      if (body.hasChildNodes()) return;
    }
    try { output = JSON.stringify(JSON.parse(output), null, 2); } catch { /* Preserve non-JSON output. */ }
    for (const [label, value] of [['Input', JSON.stringify(tool.input, null, 2) ?? 'null'], ['Output', output]]) {
      const section = text('section', '', 'tool-call-payload'), pre = text('pre', value);
      pre.tabIndex = 0;pre.setAttribute('aria-label', `${name} ${label.toLowerCase()}`);
      section.append(text('h3', label), pre);body.append(section);
    }
    const references=text('div','','tool-call-reference review-links');
    if(tool.requestId)references.append(uiButton('Open agent request',()=>openAgentTask(tool.requestId)));
    if(tool.id)references.append(uiButton('Open saved receipt',()=>openSavedRecord('tool',tool.id,0,[],tool.requestId || null)));
    if(references.hasChildNodes())body.append(references);
  });
  details.append(summary, body);
  return details;
}
function renderWelcome() {
  const feed=$('feed');
  const hidden=!!feed.querySelector('.msg.operator, .msg.reply, .msg.chart, .msg.alert, .msg.tool[data-source="assistant"]') || ($('show-log').checked && !!feed.querySelector('.msg.log, .msg.tool'));
  if ($('welcome').hidden !== hidden) $('welcome').hidden=hidden;
}

function removeConversationMessages(through = Infinity) {
  for (const row of $('feed').querySelectorAll('.msg')) {
    if (Number(row.dataset.seq) > through) continue;
    for (const chart of row.querySelectorAll('.chat-series-plot')) chatChartObserver.unobserve(chart);
    row.remove();
  }
  renderWelcome();
}
function configureConversationClear(s) {
  const account = s.health.runtime.accountId;
  if (!account) return;
  const key = 'autotrade.conversationClearedThrough:'+account;
  if (key === conversationClearKey) return;
  conversationClearKey = key;
  try {
    const saved = Number(localStorage.getItem(key));
    conversationClearedThrough = Number.isSafeInteger(saved) && saved >= 0 ? saved : 0;
  } catch { conversationClearedThrough = 0; }
  removeConversationMessages(conversationClearedThrough);
}
$('clear-conversation').onclick = () => {
  conversationClearedThrough = cursor;
  try { if (conversationClearKey) localStorage.setItem(conversationClearKey,String(cursor)); } catch {}
  removeConversationMessages();
  $('feed').scrollTop = 0;
  messageInput.focus();
  notice('Conversation view cleared. Saved history and assistant memory are unchanged.',true);
};

function liveEntry(entry, body) {
  const row=text('div','',`activity-entry ${entry.kind} ${entry.level?.toLowerCase() || ''}`);
  row.dataset.seq=entry.seq;
  const source=entrySource(entry);row.dataset.source=source;
  const time=text('time',logClock.format(new Date(entry.at)));time.dateTime=entry.at;time.title=new Date(entry.at).toLocaleString();
  const entity=text('span',speakers[source] || source,'activity-entity');entity.title=entity.textContent;
  const kind=entry.kind==='log'?(entry.level || 'LOG'):entry.kind==='operator'
    ? (/^\s*(?:\/\S+|(?:approve|reject)\b)/i.test(entry.text) ? 'COMMAND' : 'MESSAGE')
    : ({reply:'REPLY',chart:'CHART',alert:'ALERT'}[entry.kind] || entry.kind.toUpperCase());
  const label=text('span',`[${kind}]`,'activity-kind');
  // A tool call, by any agent, opens to its full input and output, as in the chat.
  const content=entry.kind==='log' && entry.level==='TOOL' ? toolCallEntry(entry) : text('p',body);
  row.append(time,entity,label,content);
  return row;
}
function appendLiveEntries(fragment) {
  if (!fragment.hasChildNodes()) return;
  const feed=$('live-feed'), scrollTop=feed.scrollTop;
  const atBottom=feed.scrollHeight-scrollTop-feed.clientHeight<24;
  $('live-feed-empty').hidden=true;
  feed.append(fragment);
  const rows=feed.querySelectorAll('.activity-entry'), cut=Math.max(0,rows.length-1000);
  // Measure how far the first kept row moves in layout pixels (the units of
  // scrollTop); on-screen rect heights are scaled by the text-size zoom.
  const anchor=rows[cut], anchorTop=anchor.offsetTop;
  for (let index=0; index<cut; index++) rows[index].remove();
  // Preserve the line being read when old scrollback is trimmed.
  feed.scrollTop=atBottom ? feed.scrollHeight : Math.max(0,scrollTop-(anchorTop-anchor.offsetTop));
}
$('open-conversation').onclick=()=>{showView('live');messageInput.focus();};

// While the conversation follows new rows it glides to the bottom instead of jumping a row at a
// time, which flickers during a burst of tool calls. Any scroll by the reader stops the following.
let feedFollowing = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
for (const type of ['wheel','touchstart','keydown','pointerdown']) $('feed').addEventListener(type, () => { feedFollowing = false; }, {passive: true});
function addEntries(entries) {
  const feed = $('feed'), atBottom = feedFollowing || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const liveRows = document.createDocumentFragment();
  if (!entries.some(entry => entry.seq > cursor)) { renderThinking(); return; }
  for (const entry of entries) {
    if (entry.seq <= cursor) continue;
    cursor = entry.seq;
    if (entry.kind === 'reply' || entry.kind === 'chart') awaitingReply = 0;
    // Older stored replies include a request label; keep it out of the conversation too.
    const body = entry.kind === 'reply' ? entry.text.replace(/^(?:assistant|trader) request [A-Za-z0-9:_-]+: /, '') : entry.text;
    liveRows.append(liveEntry(entry, body));
    const source = entrySource(entry);
    const isOperationalInfo = entry.kind === 'log' && entry.level === 'INFO';
    if (source === 'system' || isOperationalInfo || entry.seq <= conversationClearedThrough) continue;
    const isTool = entry.kind === 'log' && entry.level === 'TOOL';
    const row = text('div', '', `msg ${isTool ? 'tool' : entry.kind}${entry.level ? ' level-' + entry.level.toLowerCase() : ''}`);
    row.dataset.seq = entry.seq;
    row.dataset.source = source;
    const meta = messageMeta(entry, source);
    if (isTool) row.append(toolCallEntry(entry));
    else row.append(meta, entry.kind === 'chart' && entry.chart ? chatChart(entry.chart) : entry.kind === 'reply' ? replyBody(body) : text(entry.kind === 'chart' ? 'pre' : 'p', body));
    feed.append(row);
  }
  appendLiveEntries(liveRows);
  while (feed.querySelectorAll('.msg').length > 400) {
    const oldest = feed.querySelector('.msg');
    for (const chart of oldest.querySelectorAll('.chat-series-plot')) chatChartObserver.unobserve(chart);
    oldest.remove();
  }
  renderWelcome();
  if (!$('welcome').hidden) { feedFollowing = false; feed.scrollTop = 0; }
  else if (atBottom || entries.some(e => e.kind === 'operator')) {
    feedFollowing = true;
    feed.scrollTo({top: feed.scrollHeight, behavior: reducedMotion.matches ? 'auto' : 'smooth'});
  }
  renderThinking();
}
$('show-log').onchange = () => {
  $('feed').classList.toggle('hide-log', !$('show-log').checked);
  renderWelcome();
  try { localStorage.setItem('autotrade.showLog', $('show-log').checked ? '1' : '0'); } catch {}
};
try { if (localStorage.getItem('autotrade.showLog') === '1') { $('show-log').checked = true; $('feed').classList.remove('hide-log'); } } catch {}
function renderThinking() {
  const assistant = status?.assistant?.lane?.state === 'thinking';
  // A reply normally arrives well inside two minutes; stop claiming one is coming after that.
  const waiting = awaitingReply && Date.now() - awaitingReply < 120000;
  // Runs every second; only touch the page when something changed so the chat stays still.
  const hidden = !(assistant || waiting), label = assistant ? 'The assistant is thinking…' : 'Waiting for the assistant…';
  if ($('thinking').hidden !== hidden) $('thinking').hidden = hidden;
  if ($('thinking-text').textContent !== label) $('thinking-text').textContent = label;
}
async function sendMessage(value) {
  const slash = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(value);
  if (slash) {
    const result = await api('commands/' + encodeURIComponent(slash[1]), {args: slash[2] || ''});
    if (!result.ok) throw new Error(result.error || 'Command failed');
    notice(`/${slash[1]} completed.`, true);
  } else if (value.trimStart().startsWith('/')) { throw new Error('Choose a command from the list.'); }
  else {
    await api('messages', {text: value});
    awaitingReply = Date.now();
  }
  await refresh();
}
function askAbout(question) {
  showView('live');
  $('activity').scrollIntoView({block:'nearest'});
  messageInput.value = question; messageInput.focus();
  messageInput.setSelectionRange(question.length, question.length);
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function rows(target, list, cells) { $(target).replaceChildren(...list.map(item => { const tr=document.createElement('tr'); for(const value of cells(item)){const td=document.createElement('td'); if(value instanceof Node)td.append(value); else td.textContent=value; tr.append(td);} return tr;})); }
async function refresh() {
  if (!started) return;
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const review = view === 'review', performance = view === 'performance';
    const [s,p,a,e,f,c,l,sc,w] = await Promise.all([api('status'),api('positions'),api('orders?status=all'),api('equity-history'),api(`feed?after=${cursor}&limit=200`),
      review ? api('agent-commands') : null, review ? api('lessons') : null, performance ? api('scorecard' + ($('score-days').value ? '?days=' + $('score-days').value : '')) : null,
      api('watchlist').catch(()=>({watchlist:[],lastTickAt:null,error:'Watchlist unavailable'}))]);
    status = s;
    configureConversationClear(s);
    if ($('notice').textContent.startsWith('Could not refresh')) notice('');
    addEntries(f.entries);
    renderStatus(s);
    renderAiBudget(s.aiBudget);
    renderThinking();
    renderPortfolio(p, s);
    renderWatchlist(w);
    renderChart(e.points, s);
    for (const metric of document.querySelectorAll('.metrics > div')) {
      metric.title = [...metric.children].map(el=>el.textContent).filter(Boolean).join(' · ');
      metric.setAttribute('aria-label', metric.title);
    }
    renderOrders(a.orders);
    if (review) { renderRequests(c.commands); renderLessons(l.lessons); }
    if (performance) renderScorecard(sc);
    if (view === 'activity') await loadHistory();
    if (view === 'usage') await loadUsage();
    if (view === 'broker') { await loadBrokerBook(); await loadHistory('fills'); }
  } finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
  }
}
function renderStatus(s) {
  $('account-id').textContent = s.health.runtime.accountId || 'CONNECTING TO ACCOUNT';
  $('venue').textContent = s.env.venue; $('venue').className = 'badge ' + s.env.venue;
  $('account-mode').textContent = s.env.venue; $('account-mode').className = 'badge ' + s.env.venue;
  setValue('equity', money(s.account?.equity));
  $('chart-value').textContent = money(s.account?.equity);
  $('agent-model').textContent = `${s.env.model ? s.env.model+' · ' : ''}${s.health.runtime.ready ? 'Account connected' : 'Connecting to account…'}`;
  $('agent-model').title = s.env.model ? `Model: ${s.env.model}` : '';
  const marketOpen=s.market.open ?? (s.market.session ? s.market.session==='open' : null);
  $('market-session').textContent = marketOpen===null ? 'Market session unavailable' : marketOpen ? 'Market open' : 'Market closed';
  $('market-session').classList.toggle('open', marketOpen===true);
  $('cash').textContent = money(s.account?.cash);
  $('invested').textContent = s.account?.invested == null ? '' : `${money(s.account.invested)} invested`;
  $('trading').textContent = s.health.paused ? 'Paused' : s.health.ready ? 'Running' : 'Needs attention';
  $('trading').className = s.health.paused ? 'warn' : s.health.ready ? 'up' : 'down';
  $('updated').textContent = s.lastTickAt ? `Updated ${clock(s.lastTickAt)}${s.market.session ? ' · market ' + s.market.session : ''}` : 'Waiting for data';
  $('pause').textContent = s.health.paused ? 'Resume trading' : 'Pause trading';
  const issues = [...s.health.issues];
  if (s.health.paused) issues.unshift('Trading is paused. Existing broker orders remain active, and protection checks continue.');
  if (s.health.dailyLossHalted) issues.push('The daily loss limit is latched. New entries are disabled for this session.');
  $('health').textContent = issues.join('\n');
  const pf = s.portfolio;
  $('exposure').textContent = pf?.grossDeployedPct != null ? `Deployed ${pf.grossDeployedPct.toFixed(1)}% · largest holding ${pf.maxWeightSymbol ?? '—'} ${pf.maxWeightPct?.toFixed(1) ?? '—'}%${pf.maxSectorName && pf.maxSectorWeightPct != null ? ` · top sector ${pf.maxSectorName} ${pf.maxSectorWeightPct.toFixed(1)}%` : ''}${pf.drawdownFromPeakPct != null ? ` · ${pf.drawdownFromPeakPct.toFixed(2)}% below peak` : ''}` : '';
}

/** Briefly highlight a number that changed, so live movement is visible at a glance. */
function setValue(id, value) {
  const el = $(id);
  if (el.textContent !== value && el.textContent !== '—') { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  el.textContent = value;
}

/** How long a holding has been open: "45m", "5h", "3d 4h", "12d". */
function heldFor(ms) {
  const mins = Math.floor(ms / 60000), hours = Math.floor(mins / 60), days = Math.floor(hours / 24);
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  return days < 10 && hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
function renderPortfolio(p, s) {
  const positions = p.positions || [];
  let openPnl = 0, cost = 0, priced = 0;
  rows('positions', positions, v => {
    const pnl = v.price == null ? null : (v.price - v.entryPrice) * v.qty, pct = v.price == null ? null : (v.price / v.entryPrice - 1) * 100;
    if (pnl != null) { openPnl += pnl; cost += v.entryPrice * v.qty; priced++; }
    const symbol=uiButton(v.symbol,()=>openPositionReview(v.symbol));
    symbol.setAttribute('aria-label',`Open ${v.symbol} position details`);symbol.title='Open position details';
    symbol.setAttribute('aria-haspopup','dialog');
    const price = text('span', v.price == null ? 'Unavailable' : money(v.price), v.stale ? 'stale' : '');
    const before = lastPrices.get(v.symbol);
    if (before != null && v.price != null && before !== v.price) price.classList.add(v.price > before ? 'tick-up' : 'tick-down');
    lastPrices.set(v.symbol, v.price);
    const change = text('span', pnl == null ? '—' : `${signedMoney(pnl)} ${signedPct(pct)}`, direction(pnl));
    // Unknown when no opening time is recorded — never shown as "just opened".
    const held = text('span', v.heldForMs == null ? '—' : heldFor(v.heldForMs));
    if (v.heldForMs == null) held.title = 'No opening time is recorded for this holding';
    return [symbol, v.qty, money(v.entryPrice), price, change, held];
  });
  if (!positions.length) { const row=text('tr',''), cell=text('td',p.available?'No open positions. Your next holding will appear here.':'Holdings unavailable. Waiting for broker data.','table-empty');cell.colSpan=6;row.append(cell);$('positions').append(row); }
  $('positions-status').textContent = p.available ? (positions.length ? `${positions.length} holding${positions.length === 1 ? '' : 's'} · select a ticker for details` : 'No open holdings.') : p.error;
  setValue('open-pnl', priced ? signedMoney(openPnl) : '—');
  $('open-pnl').className = direction(openPnl);
  $('open-pnl-pct').textContent = priced && cost ? `${signedPct(openPnl / cost * 100)} on cost` : '';
}
// Match the TUI's equally weighted composite, rounded to three decimals before display.
function watchComposite(signals) {
  const scores=(signals || []).map(signal=>signal.score);
  return scores.length && scores.every(Number.isFinite) ? Number((scores.reduce((sum,score)=>sum+score,0)/scores.length).toFixed(3)) : null;
}
// The search box filters the last watchlist snapshot; Enter opens a ticker even when it is not watched.
let lastWatchlist = {watchlist:[],lastTickAt:null};
const watchFilter = $('watchlist-filter');
const watchQuery = () => watchFilter.value.trim().toUpperCase();
function watchMatches(data) { const q=watchQuery();return (data.watchlist || []).filter(row=>!q || row.symbol.includes(q)); }
watchFilter.addEventListener('input', () => { watchFilter.removeAttribute('aria-invalid');renderWatchlist(lastWatchlist); });
watchFilter.addEventListener('keydown', event => { if(event.key==='Escape' && watchFilter.value){event.preventDefault();watchFilter.value='';renderWatchlist(lastWatchlist);} });
$('watchlist-search').addEventListener('submit', event => {
  event.preventDefault();
  const q=watchQuery(),matches=watchMatches(lastWatchlist);
  const symbol=matches.find(row=>row.symbol===q)?.symbol || (matches.length===1 ? matches[0].symbol : q);
  if(!/^[A-Z0-9][A-Z0-9./-]{0,19}$/.test(symbol)){watchFilter.setAttribute('aria-invalid','true');return;}
  watchFilter.removeAttribute('aria-invalid');void openPositionReview(symbol);
});
function renderWatchlist(data) {
  lastWatchlist=data;
  const outdated=!data.lastTickAt || Date.now()-Date.parse(data.lastTickAt)>180000,q=watchQuery(),total=(data.watchlist || []).length;
  const list=watchMatches(data).map(row=>({...row,trend:watchComposite(row.signals),mr:watchComposite(row.meanReversionSignals)}))
    .sort((a,b)=>(b.trend ?? -Infinity)-(a.trend ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  const scoreCell=(score,signals,summary)=>{
    const strength=score==null || Math.abs(score)<0.15 ? '' : Math.abs(score)>=0.5 ? ' strong' : ' mild';
    const cell=text('span',score==null?'—':`${score>=0?'+':''}${score.toFixed(2)}`,`signal-score${strength && ` ${direction(score)}${strength}`}`);
    cell.title=[summary,...(signals || []).map(signal=>`${signal.name}: ${signal.score} · ${signal.detail}`)].filter(Boolean).join('\n');
    return cell;
  };
  const rsiCell=rsi=>{
    if(!Number.isFinite(rsi)) return '—';
    const zone=rsi>=70?'overbought':rsi<=30?'oversold':'';
    const cell=text('span',rsi.toFixed(0),zone?`rsi-zone ${zone}`:'');cell.title=zone?`RSI ${rsi.toFixed(0)} · ${zone}`:'';
    return cell;
  };
  rows('watchlist-rows',list,row=>{
    const stale=outdated || row.stale || row.price==null;
    const symbol=uiButton(row.symbol,()=>openPositionReview(row.symbol));symbol.setAttribute('aria-label',`Open ${row.symbol} details`);symbol.setAttribute('aria-haspopup','dialog');
    const price=text('span',stale?'—':money(row.price),stale?'stale':'');price.title=stale?(row.staleReason || 'Price unavailable or stale'):'';
    return [symbol,price,text('span',stale||row.dayChangePct==null?'—':signedPct(row.dayChangePct),stale?'stale':direction(row.dayChangePct)),
      scoreCell(row.trend,row.signals,row.signalSummary),scoreCell(row.mr,row.meanReversionSignals,row.meanReversionSummary),rsiCell(row.rsi)];
  });
  $('watchlist-status').textContent=data.error || (!data.lastTickAt?'Waiting for data':`${q?`${list.length} of ${total}`:list.length} symbols${outdated?' · stale snapshot':''}`);
  if(!list.length){
    const empty=q && total ? `No watchlist match · press Enter to open ${q}` : data.error || (!data.lastTickAt?'Waiting for watchlist data.':'No watchlist symbols.');
    const row=text('tr',''),cell=text('td',empty,'table-empty');cell.colSpan=6;row.append(cell);$('watchlist-rows').append(row);
  }
}

function renderChart(points, s) {
  const svg = $('equity-chart'), ns = 'http://www.w3.org/2000/svg';
  const values = points.map(pt => pt.equity);
  $('chart-start').textContent = points.length ? clock(points[0].at) : 'Awaiting history';
  $('chart-end').textContent = points.length ? clock(points.at(-1).at) : 'Now';
  if (values.length < 2) {
    svg.replaceChildren(); svg.classList.add('empty');
    $('chart-note').textContent = 'The chart fills in as the account updates.';
    $('equity-change').textContent = '';
    return;
  }
  svg.classList.remove('empty');
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || Math.max(hi * 0.001, 1);
  const x = i => (i / (values.length - 1)) * 600, y = v => 130 - ((v - lo) / span) * 120;
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const change = values.at(-1) - values[0], trend = change >= 0 ? 'up' : 'down';
  const area = document.createElementNS(ns, 'path'); area.setAttribute('d', `${line}L600,140L0,140Z`); area.setAttribute('class', 'area ' + trend);
  const path = document.createElementNS(ns, 'path'); path.setAttribute('d', line); path.setAttribute('class', 'line ' + trend);
  svg.replaceChildren(area, path);
  svg.setAttribute('aria-label', `Equity from ${money(values[0])} to ${money(values.at(-1))} since ${clock(points[0].at)}`);
  $('chart-note').textContent = `Since ${clock(points[0].at)} · high ${money(hi)} · low ${money(lo)}`;
  $('equity-change').textContent = `${signedMoney(change)} (${signedPct(change / values[0] * 100)}) since ${clock(points[0].at)}`;
  $('equity-change').className = direction(change);
}
// Ticker charts use the same OHLCV collector as the trading tools.
const tickerChart={symbol:'',mode:'candles',data:null,index:0,request:0};
const svgNode=(tag,attrs={},value)=>{const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,val] of Object.entries(attrs))node.setAttribute(key,String(val));if(value!==undefined)node.textContent=value;return node;};
const chatChartSeries = new WeakMap();
const chatChartObserver = new ResizeObserver(entries => {
  for (const {target} of entries) if (target.clientWidth) drawChatSeries(target,chatChartSeries.get(target));
});
function chatChart(data) {
  const container = text('div','','chat-charts');
  const normalize = values => values[0] > 0 ? values.map(value=>(value/values[0]-1)*100) : values.map(()=>0);
  const comparison = data.kind === 'comparison';
  const series = comparison ? [data.a,data.b].map(item=>({...item,values:normalize(item.values)})) : [data];
  const combined = series.flatMap(item=>item.values);
  const range = comparison ? [Math.min(...combined),Math.max(...combined)] : null;
  for (const item of series) {
    if (item.values.length < 2 || !item.values.every(Number.isFinite)) { container.append(text('p','Not enough data to draw this chart.'));continue; }
    const figure = text('figure','','chat-series-chart'),caption = text('figcaption','');
    const first = item.values[0],last = item.values.at(-1),change = comparison ? last : first > 0 ? (last/first-1)*100 : null;
    caption.append(text('strong',item.label),text('span',`${comparison ? signedPct(last) : money(last)}${!comparison && change != null ? ' · '+signedPct(change) : ''}`,direction(last-first)));
    const svg = svgNode('svg',{class:'chat-series-plot',role:'img','aria-label':`${item.label}${comparison ? ' percent change' : ' price history'}: ${item.values.length} observations, from ${first} to ${last}`});
    chatChartSeries.set(svg,{...item,range,percent:comparison});chatChartObserver.observe(svg);
    const dates = item.dates || [],footer = text('div','','chat-series-footer');
    footer.append(text('span',dates[0] || 'Start'),text('span',`${item.values.length} observations${comparison ? ' · % change' : ''}`),text('span',dates.at(-1) || 'Latest'));
    figure.append(caption,svg,footer);container.append(figure);
  }
  return container;
}
function drawChatSeries(svg,series) {
  const width = Math.max(260,svg.clientWidth),height = svg.clientHeight || 220,left = series.percent ? 60 : 82,right = width-10,top = 12,bottom = height-15;
  const low = series.range?.[0] ?? Math.min(...series.values), high = series.range?.[1] ?? Math.max(...series.values);
  const padding = (high-low || Math.max(Math.abs(high)*.01,1))*.08, min = low-padding,max = high+padding;
  const x = i => left+i/(series.values.length-1)*(right-left),y = value => bottom-(value-min)/(max-min)*(bottom-top);
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.replaceChildren();
  for (let i=0;i<5;i++) {
    const value = min+(max-min)*i/4,py = y(value);
    svg.append(svgNode('line',{x1:left,x2:right,y1:py,y2:py,class:'price-grid'}),svgNode('text',{x:left-9,y:py+4,'text-anchor':'end',class:'price-axis'},series.percent ? value.toFixed(1)+'%' : money(value)));
  }
  const path = series.values.map((value,i)=>`${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(value).toFixed(2)}`).join('');
  const trend = series.values.at(-1) >= series.values[0] ? 'up' : 'down';
  svg.append(svgNode('path',{d:`${path}L${right},${bottom}L${left},${bottom}Z`,class:'chat-series-area '+trend}),svgNode('path',{d:path,class:'price-trend '+trend}));
}
async function loadTickerChart() {
  const request=++tickerChart.request;
  tickerChart.data=null;
  $('ticker-chart').replaceChildren();$('ticker-chart').setAttribute('hidden','');
  $('ticker-chart-help').hidden=true;$('ticker-ohlc').replaceChildren();
  $('ticker-chart-status').className='';$('ticker-chart-status').textContent='Loading price history…';
  try {
    const data=await api(`price-history?symbol=${encodeURIComponent(tickerChart.symbol)}&timeframe=${encodeURIComponent($('ticker-interval').value)}`);
    if(request!==tickerChart.request || !$('position-review-dialog').open || $('ticker-chart-panel').hidden)return;
    if(!data.available || !data.bars?.length)throw new Error(data.error || 'No price history is available for this ticker.');
    tickerChart.data=data;tickerChart.index=data.bars.length-1;
    const from=data.bars[0].c,to=data.bars.at(-1).c;
    $('ticker-chart-status').textContent=`${money(to)} last close · ${signedPct((to/from-1)*100)} over ${data.bars.length} bars · ${data.source} · Last bar ${new Date(data.asOf).toLocaleString()}${data.stale?' · Stale data':''}`;
    $('ticker-chart-status').className=data.stale?'warn':'';
    // SVGElement does not reflect the HTML `hidden` property into its attribute.
    $('ticker-chart').removeAttribute('hidden');$('ticker-chart-help').hidden=false;
    drawTickerChart();
  } catch(error) {
    if(request!==tickerChart.request || !$('position-review-dialog').open || $('ticker-chart-panel').hidden)return;
    $('ticker-chart-status').textContent=error.message;$('ticker-chart-status').className='warn';
  }
}
function drawTickerChart() {
  if(!tickerChart.data)return;
  const svg=$('ticker-chart'),bars=tickerChart.data.bars;
  const low=Math.min(...bars.map(b=>b.l)),high=Math.max(...bars.map(b=>b.h));
  const pad=(high-low || high*.01)*.08, min=low-pad,max=high+pad;
  const narrow=svg.clientWidth<600,canvasWidth=Math.max(320,svg.clientWidth || 900),canvasHeight=Math.max(240,svg.clientHeight || 350);
  const left=narrow?78:66,width=canvasWidth-left-16,top=18,bottom=canvasHeight-84,step=width/bars.length;
  tickerChart.layout={left,width,canvasWidth};
  svg.setAttribute('viewBox',`0 0 ${canvasWidth} ${canvasHeight}`);
  svg.classList.toggle('narrow',narrow);
  const x=i=>left+(i+.5)*step,y=value=>bottom-(value-min)/(max-min)*(bottom-top);
  const nodes=[];
  for(let i=0;i<5;i++){
    const value=min+(max-min)*i/4,py=y(value);
    nodes.push(svgNode('line',{x1:left,x2:canvasWidth-16,y1:py,y2:py,class:'price-grid'}),svgNode('text',{x:left-8,y:py+4,'text-anchor':'end',class:'price-axis'},value.toFixed(2)));
  }
  const volume=Math.max(...bars.map(b=>b.v),1);
  bars.forEach((bar,i)=>{
    const cls=bar.c>=bar.o?'up':'down';
    nodes.push(svgNode('rect',{x:x(i)-step*.32,y:canvasHeight-32-bar.v/volume*32,width:Math.max(.8,step*.64),height:bar.v/volume*32,class:`price-volume ${cls}`}));
    if(tickerChart.mode==='candles'){
      const candle=svgNode('g',{class:`price-candle ${cls}`});
      candle.append(svgNode('line',{x1:x(i),x2:x(i),y1:y(bar.h),y2:y(bar.l)}),svgNode('rect',{x:x(i)-step*.32,y:Math.min(y(bar.o),y(bar.c)),width:Math.max(.8,step*.64),height:Math.max(1,Math.abs(y(bar.o)-y(bar.c)))}));
      nodes.push(candle);
    }
  });
  if(tickerChart.mode==='trend')nodes.push(svgNode('path',{d:bars.map((bar,i)=>`${i?'L':'M'}${x(i)},${y(bar.c)}`).join(''),class:`price-trend ${bars.at(-1).c>=bars[0].c?'up':'down'}`}));
  for(const i of [...new Set([0,Math.floor((bars.length-1)/2),bars.length-1])]){
    const date=new Date(bars[i].t);
    const label=tickerChart.data.timeframe==='1Day'||narrow?date.toLocaleDateString([],{month:'short',day:'numeric'}):date.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    nodes.push(svgNode('text',{x:x(i),y:canvasHeight-9,'text-anchor':i===0?'start':i===bars.length-1?'end':'middle',class:'price-axis'},label));
  }
  nodes.push(svgNode('text',{x:left-8,y:canvasHeight-44,'text-anchor':'end',class:'price-axis'},'Vol'),svgNode('line',{id:'price-crosshair',y1:top,y2:canvasHeight-30,class:'price-crosshair'}));
  svg.replaceChildren(...nodes);
  svg.setAttribute('aria-label',`${tickerChart.symbol} ${tickerChart.mode}, ${bars.length} ${tickerChart.data.timeframe} bars. Use left and right arrow keys to inspect prices.`);
  $('chart-candles').setAttribute('aria-pressed',String(tickerChart.mode==='candles'));
  $('chart-trend').setAttribute('aria-pressed',String(tickerChart.mode==='trend'));
  inspectTickerBar(tickerChart.index);
}
function inspectTickerBar(index) {
  if(!tickerChart.data)return;
  const bars=tickerChart.data.bars;
  tickerChart.index=Math.max(0,Math.min(index,bars.length-1));
  const {left,width}=tickerChart.layout,bar=bars[tickerChart.index],x=left+(tickerChart.index+.5)*width/bars.length;
  $('price-crosshair')?.setAttribute('x1',String(x));$('price-crosshair')?.setAttribute('x2',String(x));
  $('ticker-ohlc').replaceChildren(...[['Time',new Date(bar.t).toLocaleString()],['Open',money(bar.o)],['High',money(bar.h)],['Low',money(bar.l)],['Close',money(bar.c)],['Volume',bar.v.toLocaleString()]].map(([label,value])=>{const cell=text('div','');cell.append(text('span',label),text('strong',value));return cell;}));
}
$('ticker-chart').onpointermove=event=>{
  if(!tickerChart.data)return;
  const rect=$('ticker-chart').getBoundingClientRect(),{left,width,canvasWidth}=tickerChart.layout,x=(event.clientX-rect.left)/rect.width*canvasWidth;
  inspectTickerBar(Math.floor((x-left)/width*tickerChart.data.bars.length));
};
$('ticker-chart').onpointerdown=$('ticker-chart').onpointermove;
$('ticker-chart').onkeydown=event=>{
  if(!tickerChart.data || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();inspectTickerBar(event.key==='Home'?0:event.key==='End'?tickerChart.data.bars.length-1:tickerChart.index+(event.key==='ArrowRight'?1:-1));
};
new ResizeObserver(()=>{if($('position-review-dialog').open && !$('ticker-chart-panel').hidden && tickerChart.data)drawTickerChart();}).observe($('ticker-chart'));
$('chart-candles').onclick=()=>{tickerChart.mode='candles';drawTickerChart();};
$('chart-trend').onclick=()=>{tickerChart.mode='trend';drawTickerChart();};
$('ticker-interval').onchange=loadTickerChart;
$('refresh-ticker-chart').onclick=loadTickerChart;

function orderDetails(card, p, includeReason = false) {
  const body = text('div', '', 'action-detail');
  const signal = p.params.signal || p.params, facts = text('dl', '', 'action-facts');
  for (const [label, value] of [
    ['Quantity', historyNumber(p.params.maxQty ?? p.params.qty)], ['Filled', historyNumber(p.result?.filledQty)],
    ['Price', signal.price == null ? 'Market' : historyPrice(signal.price)],
    ['Stop', historyPrice(signal.stopLoss)], ['Target', historyPrice(signal.takeProfit)],
  ]) {
    const field = text('div', '');field.append(text('dt', label), text('dd', value));facts.append(field);
  }
  body.append(facts);
  const references = text('div', '', 'action-references');
  references.append(text('span', p.venue.toUpperCase(), 'badge'), text('span', p.automatic ? 'Automatic' : 'Human review'));
  const created = recordTime(p.createdAt);created.title = `Created: ${historyDate(p.createdAt)}`;
  references.append(created);
  if (p.status === 'pending' || p.status === 'approved') references.append(text('span', `Expires ${historyDate(p.expiresAt)}`));
  const id = text('code', p.id);id.title = 'Order ID';references.append(id);
  body.append(references);
  if (includeReason) body.append(text('p', p.reason, 'action-rationale'));
  const risk = p.params.riskAssessment;
  if (risk) {
    body.append(text('p',`Risk when proposed: ${money(risk.plannedLoss)} (${risk.plannedLossPct.toFixed(2)}% of equity) at the planned stop. Reward:risk ${risk.rewardRisk==null?'unavailable':risk.rewardRisk.toFixed(2)+':1'}.`));
    if (risk.volatilityAfterPct!=null) body.append(text('p',`Estimated portfolio volatility: ${risk.volatilityBeforePct.toFixed(2)}% → ${risk.volatilityAfterPct.toFixed(2)}% per year; target ${risk.targetVolatilityPct}%. ${risk.observations} daily observations through ${risk.asOf}. Rechecked before execution.`));
  }
  if (p.result?.error) body.append(text('p', p.result.error, 'down'));
  card.append(body);
}
function renderOrders(actions) {
  const pending = actions.filter(p => p.status === 'pending'), recent = actions.filter(p => p.status !== 'pending').slice(0, 25);
  $('action-count').textContent = `${pending.length} pending`;
  $('action-count').classList.toggle('has-pending', pending.length > 0);
  const cards = pending.map(p => {
    const card = text('article', '', 'card attention');
    card.append(text('span', 'Needs your decision', 'badge pending'), text('h3', `${p.kind.replaceAll('_',' ')} · ${p.symbol}`), text('p', p.reason));
    orderDetails(card, p);
    const buttons = text('div', '', 'actions');
    for (const decision of ['approve','reject']) {
      const b = text('button', decision === 'approve' ? 'Approve order' : 'Reject', decision === 'approve' ? 'primary' : '');
      b.disabled = p.expiresAt <= Date.now();
      b.onclick = attempt(async () => { await api(`orders/${p.id}/${decision}`, {}); await refresh(); });
      buttons.append(b);
    }
    card.append(buttons);
    return card;
  });
  const timeline = text('ol', '', 'timeline');
  timeline.append(...recent.map(p => {
    const item = document.createElement('li'), details = document.createElement('details'), summary = document.createElement('summary');
    details.open = pendingOrderDetails.has(p.id);
    details.ontoggle = () => details.open ? pendingOrderDetails.add(p.id) : pendingOrderDetails.delete(p.id);
    const reason = text('span', p.reason, 'reason');reason.title = p.reason;
    summary.append(recordTime(p.createdAt), text('span', p.status, 'badge ' + p.status), text('strong', `${p.kind.replaceAll('_',' ')} · ${p.symbol}`), reason);
    details.append(summary);
    orderDetails(details, p, true);
    item.append(details);
    return item;
  }));
  $('actions').replaceChildren(...cards, ...(recent.length ? [timeline] : []));
  if (!actions.length) { const empty=text('div','','empty-state');empty.append(text('strong','Room for the right opportunity'),text('p','New trade proposals will appear here for review.'));$('actions').append(empty); }
}
// Saved decisions and executions remain available across sessions.
let historySearchTimer;
const historyTypes = ['decision','fill','event'];
// Fills live on the Broker page with their own search; decisions and events on Activity.
const historyGroups = { activity:{types:['decision','event'],search:'history-search',status:'history-status',request:0}, fills:{types:['fill'],search:'fill-search',status:'fill-status',request:0} };
const historyGroupOf = type => type === 'fill' ? 'fills' : 'activity';
const historyOffsets = {decision:0, fill:0, event:0}, historySignatures = {};
const historyLimit = 25, openHistoryDetails = new Set();
const historyDate = at => at == null ? 'Not recorded' : new Date(at).toLocaleString([], {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
const historyNumber = value => value == null ? 'Not recorded' : new Intl.NumberFormat('en-US', {maximumFractionDigits:8}).format(value);
const historyPrice = value => value == null ? 'Not recorded' : new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:8}).format(value);
function historyFacts(pairs) {
  const list = text('dl', '', 'history-facts');
  for (const [label, value] of pairs) {
    const field = text('div','');
    field.append(text('dt',label),text('dd',value)); list.append(field);
  }
  return list;
}
function recordedFields(record) {
  const list = text('dl','','recorded-fields');
  for (const [key,value] of Object.entries(record)) {
    const field = text('div','');
    const label = key.replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ');
    field.append(text('dt',label[0].toUpperCase()+label.slice(1)));
    const content = text('dd','');
    if (value && typeof value === 'object') content.append(recordedFields(value));
    else content.textContent = value == null ? 'Not recorded' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : /^(createdAt|expiresAt|decidedAt|at|firedAt|ackedAt|protectionCheckedAt)$/.test(key) ? historyDate(value) : String(value);
    field.append(content);list.append(field);
  }
  return list;
}
function historyDetail(entry) {
  const record = entry.record, fill = entry.type === 'fill', action = entry.action;
  const card = text('div','','history-detail');
  card.append(text('p',entry.reason,'history-reason'));
  if (entry.type === 'event') {
    card.append(historyFacts([
      ['Queue',entry.queued ? 'Queued' : 'Not queued'],['Handling',entry.status],
      ['First detected',historyDate(record.firedAt)],['Closed',historyDate(record.ackedAt)],
      ['Reports',historyNumber(record.wakeCount)],['Handled by',record.handledBy || '—'],
    ]));
    if (record.ackNote) card.append(text('h3','Acknowledgement'),text('p',record.ackNote));
    if (record.evidence && Object.keys(record.evidence).length) card.append(text('h3','Evidence'),recordedFields(record.evidence));
    const related = historyReference(record.id);related.textContent = 'Related decisions';card.append(related);
    const raw = document.createElement('details');raw.className = 'history-record';
    raw.append(text('summary','Event record'),recordedFields(record));card.append(raw);
    return card;
  }
  if (fill) {
    card.append(historyFacts([['Filled quantity',historyNumber(record.qty)],['Fill price',historyPrice(record.price)],['Trade value',money(record.qty*record.price)],['Fees',record.fee == null ? 'Not reported' : money(record.fee)]]));
  } else {
    const filled = record.filledQty ?? action?.result?.filledQty;
    card.append(historyFacts([
      ['Requested quantity',historyNumber(record.requestedQty ?? action?.params?.maxQty ?? action?.params?.qty)],
      ['Filled quantity',historyNumber(filled)],
      ['Fill price',historyPrice(record.fillPrice ?? action?.result?.filledPrice)],
      ['Planned price',historyPrice(record.intendedPrice)],
      ['Stop / target',`${historyPrice(record.intendedStop)} / ${historyPrice(record.intendedTarget)}`],
      ['Actor / approval',[record.actorId || record.actor, action ? action.automatic ? 'Automatic' : 'Human review' : null].filter(Boolean).join(' · ')],
    ]));
    for (const message of [record.vetoRule && `Guard rule: ${record.vetoRule}`, action?.rejectReason, record.venueMessage, action?.result?.error, record.venueStopMissing && `Missing protection: ${record.venueStopMissing}`].filter(Boolean)) card.append(text('p',message,'history-warning'));
  }
  const details = text('div','','history-record');
  if (entry.transitions?.length) {
    details.append(text('h3','Order timeline'));
    const timeline = text('ol','','history-transitions');
    for (const event of entry.transitions) {
      const item = text('li','');
      item.append(text('time',historyDate(event.at)),text('strong',event.transition));
      const { at, transition, orderId, symbol, ...changed } = event;
      if (Object.keys(changed).length) { const step = document.createElement('details'); step.append(text('summary','What changed at this step'),recordedFields(changed)); item.append(step); }
      timeline.append(item);
    }
    details.append(timeline);
  }
  details.append(text('h3',fill ? 'Broker fill' : 'Decision record'),recordedFields(record));
  if (action) details.append(text('h3','Order & risk assessment'),recordedFields(action));
  card.append(details);
  return card;
}
function expandableRows(id, label, cells, renderDetail) {
  const row = text('tr','','history-row'), expanded = text('tr','','history-expanded');
  const toggle = text('button','','history-row-toggle');
  const detailId = `record-detail-${id}`;
  toggle.setAttribute('aria-controls',detailId);
  toggle.setAttribute('aria-label',label);
  const detailCell = text('td','');detailCell.colSpan = cells.length+1;detailCell.id = detailId;
  expanded.append(detailCell);
  const showDetails = open => {
    toggle.textContent = open ? '▾' : '▸';
    toggle.setAttribute('aria-expanded',String(open));expanded.hidden = !open;
    if (open && !detailCell.hasChildNodes()) detailCell.append(renderDetail());
    if (open) openHistoryDetails.add(id); else openHistoryDetails.delete(id);
  };
  showDetails(openHistoryDetails.has(id));
  toggle.onclick = () => showDetails(expanded.hidden);
  row.onclick = event => { if (!event.target.closest('button') && !window.getSelection()?.toString()) toggle.click(); };
  for (const value of [toggle,...cells]) { const cell = text('td','');if (value instanceof Node) cell.append(value);else cell.textContent = value;row.append(cell); }
  return [row,expanded];
}
function historyRows(entry) {
  const record = entry.record, fill = entry.type === 'fill', action = entry.action;
  const time = text('time',new Date(entry.at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}));time.dateTime = entry.at;time.title = historyDate(entry.at);
  const compactNumber = value => value == null ? '—' : historyNumber(value);
  const reason = text('span',entry.reason,'history-row-reason');reason.title = entry.reason;
  if (entry.type === 'event') {
    const cells = [time,entry.symbol || 'Portfolio',entry.kind.replaceAll('_',' '),
      text('span',record.severity,'badge '+record.severity),text('span',entry.queued ? 'Queued' : '—',entry.queued ? 'badge queued' : ''),
      text('span',entry.status,'badge '+entry.status.split(' ')[0]),reason];
    return expandableRows(entry.id,`Details for ${entry.symbol || 'portfolio'} ${entry.kind.replaceAll('_',' ')} event on ${historyDate(entry.at)}`,cells,()=>historyDetail(entry));
  }
  // Event IDs retain kind:symbol:timestamp even after the event leaves the pending queue.
  const eventType = record.triggerEventId?.match(/^([^:]+):[^:]+:/)?.[1];
  const eventLabel = text('span',eventType ? eventType.replaceAll('_',' ') : '—');
  eventLabel.title = record.triggerEventId || '';
  const cells = fill
    ? [time,entry.symbol,entry.kind,compactNumber(record.qty),historyPrice(record.price),money(record.qty*record.price),record.fee == null ? 'Not reported' : money(record.fee)]
    : [time,entry.symbol || 'Portfolio',eventLabel,entry.kind.replaceAll('_',' '),text('span',entry.status,'badge '+entry.status.split(' ')[0]),compactNumber(record.requestedQty ?? action?.params?.maxQty ?? action?.params?.qty),compactNumber(record.filledQty ?? action?.result?.filledQty),reason];
  return expandableRows(entry.id,`Details for ${entry.symbol || 'portfolio'} ${entry.kind} on ${historyDate(entry.at)}`,cells,()=>historyDetail(entry));
}

async function loadHistory(groupName = 'activity') {
  const group = historyGroups[groupName], request = ++group.request, query = $(group.search).value.trim();
  const types = group.types;
  for (const type of types) $(`history-${type}-rows`).setAttribute('aria-busy','true');
  try {
    const responses = await Promise.allSettled(types.map(type => api('activity-history?'+new URLSearchParams({type,q:query,offset:String(historyOffsets[type]),limit:String(historyLimit)}))));
    if (request !== group.request) return;
    const results = responses.map(response => response.status === 'fulfilled' ? response.value : null);
    const errors = responses.map((response,index) => response.status === 'rejected'
      ? types[index] === 'event' && /type must be|no route/.test(response.reason.message)
        ? 'Restart the engine to load saved Events. Decisions remain available.'
        : `Could not load ${types[index]}s. Displayed records may be stale. ${response.reason.message}`
      : '').filter(Boolean);
    let resetPage = false;
    results.forEach((result,index) => {
      const type = types[index];
      if (result && historyOffsets[type] && historyOffsets[type] >= result.total) {
        historyOffsets[type] = Math.max(0,Math.floor((result.total-1)/historyLimit)*historyLimit);resetPage = true;
      }
    });
    if (resetPage) return loadHistory(groupName);
    results.forEach((result,index) => {
      const type = types[index], offset = historyOffsets[type], body = $(`history-${type}-rows`);
      if (!result) {
        if (!body.hasChildNodes()) {
          const row = text('tr',''),cell = text('td',`Could not load ${type}s.`,'table-empty');cell.colSpan = type === 'decision' ? 9 : 8;row.append(cell);body.append(row);
        }
        $(`history-${type}-count`).textContent = 'Unavailable';$(`history-${type}-page`).textContent = '';
        $(`history-${type}-prev`).disabled = true;$(`history-${type}-next`).disabled = true;
        return;
      }
      // Keep focus and expanded sub-sections intact when a background refresh has no changes.
      const signature = JSON.stringify([query,result.entries]);
      if (historySignatures[type] !== signature) {
        body.replaceChildren(...result.entries.flatMap(historyRows));
        if (!result.entries.length) {
          const row = text('tr',''),cell = text('td',query ? 'No records match your search.' : `No ${type}s recorded yet.`,'table-empty');cell.colSpan = type === 'decision' ? 9 : 8;row.append(cell);body.append(row);
        }
        historySignatures[type] = signature;
      }
      $(`history-${type}-count`).textContent = `${result.total.toLocaleString()} records`;
      $(`history-${type}-page`).textContent = result.total ? `${offset+1}–${Math.min(offset+historyLimit,result.total)} of ${result.total}` : '0 records';
      $(`history-${type}-prev`).disabled = offset === 0;
      $(`history-${type}-next`).disabled = offset+historyLimit >= result.total;
    });
    $(group.status).textContent = errors.length ? errors.join(' ') : query && results.every(result=>!result.total) ? 'No records match these filters.' : (groupName === 'fills' ? 'Times shown in your local timezone.' : '');
  } catch (error) {
    if (request === group.request) $(group.status).textContent = error.message.includes('no route') ? 'The running engine needs a restart to load Activity history. Your saved records are intact.' : 'Could not load history. Displayed records may be stale. '+error.message;
  } finally { if (request === group.request) for (const type of types) $(`history-${type}-rows`).setAttribute('aria-busy','false'); }
}
function resetHistory(groupName = 'activity') { for (const type of historyGroups[groupName].types) historyOffsets[type] = 0; loadHistory(groupName); }
for (const [groupName, group] of Object.entries(historyGroups)) $(group.search).oninput = () => { ++group.request; clearTimeout(historySearchTimer); historySearchTimer = setTimeout(() => resetHistory(groupName),250); };
$('history-refresh').onclick = () => loadHistory();
for (const type of historyTypes) {
  $(`history-${type}-prev`).onclick = () => { historyOffsets[type] = Math.max(0,historyOffsets[type]-historyLimit); loadHistory(historyGroupOf(type)); };
  $(`history-${type}-next`).onclick = () => { historyOffsets[type] += historyLimit; loadHistory(historyGroupOf(type)); };
}

const reviewSignatures = {}, dirtyLessons = new Set();
function rowSummary(value) { const cell = text('span',value || '—','history-row-reason');cell.title = value || '';return cell; }
function recordTime(at) {
  const time = text('time',at ? new Date(at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—');
  if (at) { time.dateTime = at;time.title = historyDate(at); }return time;
}
function renderReviewTable(target, list, columnCount, render) {
  const signature = JSON.stringify(list);
  if (reviewSignatures[target] === signature) return;
  $(target).replaceChildren(...list.flatMap(render));
  if (!list.length) { const row = text('tr',''),cell = text('td',target === 'lesson-list' ? 'No lessons recorded yet.' : 'No agent requests yet.','table-empty');cell.colSpan = columnCount;row.append(cell);$(target).append(row); }
  reviewSignatures[target] = signature;
}
function historyReference(id) {
  const button = text('button',id,'link');button.type = 'button';
  button.onclick = () => { $('history-search').value = $('fill-search').value = id;for (const type of historyTypes) historyOffsets[type] = 0;showView('activity'); };
  return button;
}
// Agents write their outcome in Markdown; render it like a chat reply instead of one flat paragraph.
function requestOutcome(result) {
  if(!result)return text('p','No outcome recorded yet.','review-meta');
  const body=replyBody(result);body.classList.add('request-outcome');return body;
}
function renderRequests(list) {
  renderReviewTable('agent-commands',list,7,command=>expandableRows(`request:${command.id}`,`Details for ${roleLabel(command.role)} request: ${command.text}`,
    [recordTime(command.createdAt),roleLabel(command.role),command.actorId,text('span',taskProgress(command.status),'badge '+command.status),rowSummary(command.text),rowSummary(command.result || 'Awaiting outcome')],()=>{
      const detail = text('div','','history-detail request-detail');
      detail.append(historyFacts([['Request',command.text],['Mode',taskMode(command)]]),requestOutcome(command.result));
      detail.append(uiButton('Open request trail: tools, decisions, orders and fills',()=>openAgentTask(command.id)));
      if (command.orderIds?.length) { const links = text('div','','record-links');links.append(text('span','Orders'),...command.orderIds.map(historyReference));detail.append(links); }
      const references = text('div','','request-references');
      references.append(text('span',historyDate(command.createdAt)),text('span',`ID ${command.id}`));
      if (command.parentId) references.append(uiButton(`Parent request ${command.parentId}`,()=>openAgentTask(command.parentId)));
      detail.append(references);return detail;
    }));
}
// ── Broker page ────────────────────────────────────────────────────────────
const brokerRoleLabels = { stop:'Protective stop', target:'Profit target', entry:'Agent entry', exit:'Agent exit', protection:'Agent protection', external:'Placed outside this app' };
const brokerPrice = n => n == null ? '—' : money(n);
async function loadBrokerBook() {
  const book = await api('broker-book');
  $('broker-book-updated').textContent = book.lastTickAt ? `Checked ${clock(book.lastTickAt)} · ${book.broker} ${book.venue}` : 'Waiting for account data';
  if (!book.available) {
    $('broker-book-status').textContent = 'Broker orders could not be read in the latest account check. Nothing below is known to be current.';
    $('broker-book-summary').replaceChildren(); $('broker-book-rows').replaceChildren(); $('broker-coverage-rows').replaceChildren();
    reviewSignatures['broker-book-rows'] = reviewSignatures['broker-coverage-rows'] = null;
    return;
  }
  const sum = book.summary;
  $('broker-book-status').textContent = [!book.positionsAvailable && 'Holdings could not be read, so orders are not matched to positions.',
    sum.unprotected.length && `No full stop at the broker: ${sum.unprotected.join(', ')}.`,
    sum.mismatches.length && `Broker level differs from the saved level: ${sum.mismatches.join(', ')}.`].filter(Boolean).join(' ');
  $('broker-book-summary').replaceChildren(...[['Resting orders',sum.count],['Placed by this app',sum.byThisSystem],['Placed elsewhere',sum.external],['Without a holding',sum.withoutPosition]]
    .map(([label,value]) => { const d = text('div',''); d.append(text('span',label),text('strong',String(value))); return d; }));
  const signature = JSON.stringify(book.orders);
  if (reviewSignatures['broker-book-rows'] !== signature) {
    $('broker-book-rows').replaceChildren(...book.orders.flatMap(o => expandableRows(`broker:${o.id}`, `Details for ${o.symbol} ${o.side} ${o.type} order`,
      [o.symbol, text('span',brokerRoleLabels[o.role],'badge '+(o.role==='external'?'':'executed')), `${o.side} / ${o.rawType}`, String(o.remaining),
       brokerPrice(o.triggerPrice), o.currentPrice == null ? '—' : money(o.currentPrice) + (o.priceStale ? ' (stale)' : ''),
       o.distancePct == null ? '—' : `${Math.abs(o.distancePct).toFixed(2)}% ${o.distancePct > 0 ? 'below' : 'above'}`,
       o.resultIfFilled == null ? '—' : signedMoney(o.resultIfFilled), o.status], () => brokerOrderDetail(o))));
    if (!book.orders.length) { const row = text('tr',''), cell = text('td','No orders are resting at the broker.','table-empty'); cell.colSpan = 11; row.append(cell); $('broker-book-rows').append(row); }
    reviewSignatures['broker-book-rows'] = signature;
  }
  rows('broker-coverage-rows', book.coverage, c => [c.symbol, String(c.qty), c.managed ? 'Yes' : 'No', String(c.stopShares), brokerPrice(c.firstStop),
    `${brokerPrice(c.recordedStop)} / ${brokerPrice(c.recordedTarget)}`,
    text('span', {protected:'Protected', partial:'Partly protected', none:'No broker stop'}[c.status], 'badge '+(c.status==='protected'?'executed':'failed'))]);
  if (!book.coverage.length) { const row = text('tr',''), cell = text('td',book.positionsAvailable ? 'No holdings.' : 'Holdings unavailable.','table-empty'); cell.colSpan = 7; row.append(cell); $('broker-coverage-rows').append(row); }
}
function brokerOrderDetail(o) {
  const detail = text('div','','history-detail');
  detail.append(text('h3','At the broker'), historyFacts([
    ['Order ID', o.id], ['Client order ID', o.clientOrderId || '—'], ['Type', `${o.side} ${o.rawType}`],
    ['Quantity', `${o.qty} (filled ${o.filled}, ${o.remaining} left)`], ['Limit price', brokerPrice(o.limitPrice)], ['Stop price', brokerPrice(o.stopPrice)],
    ...(o.trailPercent != null ? [['Trail', o.trailPercent + '%']] : []), ...(o.trailAmount != null ? [['Trail', money(o.trailAmount)]] : []),
    ['Time in force', o.tif || '—'], ['Broker status', o.status + (o.status === 'held' && o.pairedWith ? ' — normal for the stop half of a stop/target pair; it triggers at its stop price' : '')],
    ['Linked order', o.pairedWith ? `${o.pairedWith.type} at ${brokerPrice(o.pairedWith.price)} — one cancels the other (${o.pairedWith.id})` : 'None']]));
  detail.append(text('h3','What this app knows'));
  const facts = [['Purpose', brokerRoleLabels[o.role]]];
  if (o.recordedLevel != null) facts.push(['Saved level', brokerPrice(o.recordedLevel) + (o.levelMismatch ? ' — differs from the broker; the broker level is the one that fires' : '')]);
  if (o.position) facts.push(['Holding', `${o.position.qty} shares, bought at ${brokerPrice(o.position.entryPrice)}, now ${brokerPrice(o.position.price)}${o.position.pnlPct == null ? '' : ' (' + signedPct(o.position.pnlPct) + ')'}`],
    ['Covers the whole holding', o.position.covers ? 'Yes' : 'No']);
  else facts.push(['Holding', 'No holding in this symbol']);
  if (o.notional != null) facts.push(['Value at trigger', money(o.notional)]);
  if (o.resultIfFilled != null) facts.push(['Gain or loss if filled', signedMoney(o.resultIfFilled) + ' vs. purchase price, before fees']);
  if (o.protectionRequest) facts.push(['Protection request', `${o.protectionRequest.status} · ${historyDate(o.protectionRequest.at)}${o.protectionRequest.error ? ' · ' + o.protectionRequest.error : ''}`]);
  detail.append(historyFacts(facts));
  if (o.agentOrder) {
    detail.append(text('h3','Agent order'), historyFacts([['Kind', o.agentOrder.kind], ['Status', o.agentOrder.status], ['Created', historyDate(o.agentOrder.createdAt)],
      ['Approved by', o.agentOrder.automatic ? 'Automatic' : o.agentOrder.decidedBy || 'Not decided']]), text('p', o.agentOrder.reason));
    const links = text('div','','record-links'); links.append(text('span','Order'), historyReference(o.agentOrder.id)); detail.append(links);
  }
  if (o.entryDecision) {
    detail.append(text('h3','Why the position was opened'), text('p', o.entryDecision.rationale));
    if (o.entryDecision.invalidation) detail.append(text('p', 'Invalidation: ' + o.entryDecision.invalidation, 'review-meta'));
    detail.append(text('p', `Planned stop ${brokerPrice(o.entryDecision.intendedStop)} · planned target ${brokerPrice(o.entryDecision.intendedTarget)} · ${historyDate(o.entryDecision.at)}`, 'review-meta'));
    const links = text('div','','record-links'); links.append(text('span','Decision'), historyReference(o.entryDecision.id)); detail.append(links);
  }
  if (o.managementDecision) {
    detail.append(text('h3','Latest management decision'), text('p', o.managementDecision.rationale));
    const links = text('div','','record-links'); links.append(text('span','Decision'), historyReference(o.managementDecision.id)); detail.append(links);
  }
  if (o.role === 'external') detail.append(text('p','This order was not placed by this app. The agent can see it but does not manage it.','review-warning'));
  return detail;
}
$('broker-book-reconcile').onclick=attempt(async()=>{await api('reconcile',{});notice('Broker outcomes checked.',true);await refresh();});
function renderLessons(list) {
  // Keep unsaved edits intact even if focus moves away during a background refresh.
  if (dirtyLessons.size || $('lesson-list').contains(document.activeElement)) return;
  renderReviewTable('lesson-list',list,6,lesson=>expandableRows(`lesson:${lesson.id}`,`Details for lesson: ${lesson.text}`,
    [recordTime(lesson.at),text('span',lesson.active ? 'Active' : 'Retired','badge '+(lesson.active ? 'executed' : '')),rowSummary(lesson.text),lesson.evidenceIds.length ? `${lesson.evidenceIds.length} decision${lesson.evidenceIds.length === 1 ? '' : 's'}` : 'Operator observation',lesson.actorId || '—'],()=>{
      const detail = text('div','','history-detail');
      detail.append(historyFacts([['Where this lesson applies',lesson.scope || 'Not recorded'],['Supporting decision records',lesson.sampleCount ?? 'Not recorded'],['Confirmed exit records',lesson.completedExitCount ?? 'Not recorded'],['Review date',`${savedTime(lesson.reviewAfter)}${reviewDue(lesson.reviewAfter) ? ' · DUE' : ''}`]]));
      detail.append(text('p','Decision counts are not independent trades or proof that this lesson improves returns.','review-meta'));
      if(lesson.policyHash && strategy?.hash && lesson.policyHash!==strategy.hash)detail.append(text('p','Strategy changed since this lesson was recorded.','review-warning'));
      detail.append(text('h3','Lesson'),text('p',lesson.text),text('h3','Supporting evidence'));
      if (lesson.evidenceIds.length) { const links = text('div','','record-links');links.append(...lesson.evidenceIds.map(historyReference));detail.append(links); }
      else detail.append(text('p','Operator observation; no source decisions are linked.'));
      detail.append(text('h3','Counter evidence'));
      if(lesson.counterEvidenceIds?.length){const links=text('div','','record-links');links.append(...lesson.counterEvidenceIds.map(historyReference));detail.append(links);}
      else detail.append(text('p','No counter evidence linked. This does not mean none exists.'));
      detail.append(text('p',lesson.active ? 'Active — available to guide future reviews.' : 'Retired — kept for reference, excluded from future reviews.'));
      const label = text('label','Edit lesson'),editor = text('textarea',lesson.text);editor.value = lesson.text;editor.maxLength = 2000;
      editor.oninput = () => dirtyLessons.add(lesson.id);label.append(editor);detail.append(label);
      const buttons = text('div','','actions');
      for (const [title,active] of [['Save',lesson.active],[lesson.active ? 'Retire' : 'Activate',!lesson.active]]) {
        const button = text('button',title);
        button.onclick = attempt(async()=>{await api(`lessons/${encodeURIComponent(lesson.id)}`,{text:editor.value,active});dirtyLessons.delete(lesson.id);document.activeElement.blur();await refresh();});buttons.append(button);
      }
      detail.append(buttons);
      const metadata = document.createElement('details');metadata.append(text('summary','Lesson record'),recordedFields(lesson));detail.append(metadata);return detail;
    }));
}
function renderScorecard(sc) {
  const num = (v, digits = 2) => v == null ? '—' : Number(v).toFixed(digits);
  const cells = [
    ['Completed trades', sc.trades], ['Win rate', sc.winRate == null ? '—' : `${num(sc.winRate, 1)}%`],
    ['Net P&L', sc.netPnL == null ? signedMoney(sc.grossPnL) + ' gross' : signedMoney(sc.netPnL)], ['Profit factor', num(sc.profitFactor)],
    ['Average win', sc.avgWin == null ? '—' : money(sc.avgWin)], ['Average loss', sc.avgLoss == null ? '—' : money(sc.avgLoss)],
    ['Expectancy per trade', sc.expectancy == null ? '—' : signedMoney(sc.expectancy)], ['Largest drawdown', money(sc.maxDrawdown)],
  ];
  $('scorecard').replaceChildren(...cells.map(([label, value]) => { const cell = text('div', ''); cell.append(text('span', label), text('strong', String(value))); return cell; }));
  $('score-caveats').replaceChildren(...(sc.caveats || []).map(c => text('li', c)));
}
$('score-days').onchange = attempt(refresh);

// ── AI usage ───────────────────────────────────────────────────────────────
const tokenCount = n => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const tokenCell = n => { const cell = text('span', tokenCount(n)); cell.title = `${n.toLocaleString()} tokens`; return cell; };
const usageRole = role => ({ trader: 'Trader', assistant: 'Assistant', researcher: 'Research', unassigned: 'Unassigned' })[role] || role;
let usageDay = null;
async function loadUsage() {
  const days = $('usage-days').value, u = await api('llm-usage' + (days ? '?days=' + days : ''));
  const total = u.total.inputTokens + u.total.outputTokens, today = new Date().toISOString().slice(0, 10);
  const todayRow = u.days.find(d => d.day === today), limit = u.budget?.settings?.maxRequestsPerDay;
  const cells = [
    ['Total tokens', tokenCount(total)], ['Input tokens', tokenCount(u.total.inputTokens)], ['Output tokens', tokenCount(u.total.outputTokens)],
    ['Model calls', u.total.calls.toLocaleString()], ['Today (UTC)', todayRow ? tokenCount(todayRow.inputTokens + todayRow.outputTokens) : '0'],
    ['Average per day', u.days.length ? tokenCount(Math.round(total / u.days.length)) : '—'], ['Failed calls', u.total.failed.toLocaleString()],
    ['Daily call limit', limit == null ? 'Unlimited' : `${u.budget.usage.requests} / ${limit} used`],
  ];
  $('usage-summary').replaceChildren(...cells.map(([label, value]) => { const cell = text('div', ''); cell.append(text('span', label), text('strong', String(value))); return cell; }));
  $('usage-caveats').replaceChildren(...[...u.caveats, ...Object.keys(u.byModel).length ? [`Models: ${Object.entries(u.byModel).map(([m, t]) => `${m} (${tokenCount(t.inputTokens + t.outputTokens)})`).join(', ')}.`] : []].map(c => text('li', c)));
  const agents = Object.entries(u.byAgent).sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens));
  rows('usage-agents', agents, ([role, t]) => [usageRole(role), t.calls.toLocaleString(), tokenCell(t.inputTokens), tokenCell(t.outputTokens),
    tokenCell(t.inputTokens + t.outputTokens), total ? `${((t.inputTokens + t.outputTokens) / total * 100).toFixed(1)}%` : '—', String(t.failed)]);
  const peak = Math.max(1, ...u.days.map(d => d.inputTokens + d.outputTokens));
  const agentTokens = (d, role) => d.byAgent[role] ? tokenCell(d.byAgent[role].inputTokens + d.byAgent[role].outputTokens) : '—';
  rows('usage-day-list', u.days, d => {
    const bar = text('span', '', 'usage-bar'); bar.style.width = `${(d.inputTokens + d.outputTokens) / peak * 100}%`;
    const pick = uiButton(d.day, () => loadUsageDay(d.day)); pick.setAttribute('aria-pressed', String(d.day === usageDay));
    return [pick, d.calls.toLocaleString(), tokenCell(d.inputTokens), tokenCell(d.outputTokens), tokenCell(d.inputTokens + d.outputTokens),
      agentTokens(d, 'trader'), agentTokens(d, 'researcher'), agentTokens(d, 'assistant'),
      { calls: 'Per call', runs: 'Estimated', mixed: 'Partly estimated' }[d.source], bar];
  });
  if (usageDay && !u.days.some(d => d.day === usageDay)) { usageDay = null; $('usage-day-panel').hidden = true; }
  else if (usageDay) await loadUsageDay(usageDay);
}
async function loadUsageDay(day) {
  usageDay = day;
  for (const b of $('usage-day-list').querySelectorAll('button[aria-pressed]')) b.setAttribute('aria-pressed', String(b.textContent === day));
  const { requests } = await api('llm-usage/day?day=' + day);
  $('usage-day-title').textContent = `Requests on ${day}`;
  $('usage-day-panel').hidden = false;
  rows('usage-requests', requests, r => [new Date(r.firstAt).toLocaleTimeString(), usageRole(r.role), String(r.calls), tokenCell(r.inputTokens), tokenCell(r.outputTokens),
    tokenCell(r.inputTokens + r.outputTokens), rowSummary(r.task || '—'), r.status || '—', r.requestId ? uiButton('Open', () => openAgentTask(r.requestId)) : '—']);
}
$('usage-days').onchange = attempt(loadUsage);
let allowedSymbols = [];
const symbolInput = $('symbol-input');
function symbolFeedback(message = '', invalid = false) {
  $('symbol-feedback').textContent = message;
  $('symbol-feedback').classList.toggle('down',invalid);
  symbolInput.setAttribute('aria-invalid',String(invalid));
}
function renderAllowedSymbols() {
  $('allowed-symbols').replaceChildren(...allowedSymbols.map((symbol,index) => {
    const tag = text('li','','symbol-tag'), remove = text('button','×');
    remove.type = 'button';remove.setAttribute('aria-label',`Remove ${symbol}`);remove.title = `Remove ${symbol}`;
    remove.onclick = () => {
      allowedSymbols = allowedSymbols.filter(value => value !== symbol);
      renderAllowedSymbols();symbolFeedback(`${symbol} removed.`);$('settings-state').textContent = 'Unsaved changes';
      const buttons = $('allowed-symbols').querySelectorAll('button');
      (buttons[Math.min(index,buttons.length-1)] || symbolInput).focus();
    };
    tag.append(text('span',symbol),remove);return tag;
  }));
  if (!allowedSymbols.length) $('allowed-symbols').append(text('li','No symbols added yet.','symbol-empty'));
  $('symbol-count').textContent = `${allowedSymbols.length} symbol${allowedSymbols.length === 1 ? '' : 's'}`;
}
function addAllowedSymbols() {
  const candidates = [...new Set(symbolInput.value.trim().toUpperCase().split(/[\s,]+/).filter(Boolean))];
  if (!candidates.length) { symbolInput.focus();return false; }
  const invalid = candidates.filter(symbol => !/^[A-Z.\-]{1,10}$/.test(symbol));
  if (invalid.length) {
    symbolFeedback(`Invalid symbol: ${invalid.join(', ')}. Use up to 10 letters, dots or hyphens.`,true);symbolInput.focus();return false;
  }
  const additions = candidates.filter(symbol => !allowedSymbols.includes(symbol));
  if (allowedSymbols.length + additions.length > 100) {
    symbolFeedback('The list can contain up to 100 symbols.',true);symbolInput.focus();return false;
  }
  allowedSymbols.push(...additions);symbolInput.value = '';renderAllowedSymbols();
  symbolFeedback(additions.length ? `${additions.join(', ')} added.` : 'Those symbols are already in the list.');
  if (additions.length) $('settings-state').textContent = 'Unsaved changes';
  symbolInput.focus();return true;
}
$('add-symbol').onclick = addAllowedSymbols;
symbolInput.oninput = () => symbolFeedback();
symbolInput.onkeydown = event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault();addAllowedSymbols(); }
};
function renderAiBudget(budget) {
  if (!budget) return;
  const {settings,usage,remaining,assistantLimit,researchLimit,resetsAt} = budget, limit = settings.maxRequestsPerDay;
  $('ai-limit-status').textContent = limit === null ? 'Unlimited' : remaining === 0 ? 'Daily cap reached' : `${limit.toLocaleString()} calls / day`;
  $('ai-usage-calls').textContent = usage.requests.toLocaleString();
  $('ai-usage-remaining').textContent = remaining === null ? 'Unlimited' : remaining.toLocaleString();
  $('ai-usage-tokens').textContent = `${usage.inputTokens.toLocaleString()} / ${usage.outputTokens.toLocaleString()}`;
  $('ai-usage-reset').textContent = `Usage day: ${usage.day} (UTC). Counter restarts ${new Date(resetsAt).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})} (your local time), at midnight UTC.`;
  $('ai-assistant-allowance').textContent = limit === null
    ? 'No daily call cap applies to the trader, chat or research.'
    : `Chat can use up to ${assistantLimit.toLocaleString()} calls per day (40% of the cap) and stock research up to ${(researchLimit ?? 1).toLocaleString()} (30%), each rounded down with a minimum of 1. The trader can use the whole cap. Broker protection continues if the cap is reached.`;
}
function syncAiLimitField() {
  const f = $('ai-settings-form').elements, limited = f.limitMode.value === 'limited';
  $('ai-daily-limit-field').hidden = !limited;
  f.maxRequestsPerDay.disabled = !limited || aiSettingsSaving || !aiSettingsLoaded;
  f.maxRequestsPerDay.required = limited;
}
function fillAiSettings(budget) {
  const f = $('ai-settings-form').elements, limit = budget.settings.maxRequestsPerDay;
  f.limitMode.value = limit === null ? 'unlimited' : 'limited';
  f.maxRequestsPerDay.value = limit === null ? '' : String(limit);
  aiSettingsLoaded = true;
  syncAiLimitField();
  renderAiBudget(budget);
  $('ai-settings-state').textContent = 'Saved';
}
async function loadAiSettings() {
  if (aiSettingsSaving) return;
  $('ai-settings-form').elements.limitMode.disabled = true;
  $('save-ai-settings').disabled = true;
  try { fillAiSettings(await api('settings/ai')); }
  finally {
    $('ai-settings-form').elements.limitMode.disabled = !aiSettingsLoaded;
    $('save-ai-settings').disabled = !aiSettingsLoaded;
    syncAiLimitField();
  }
}
$('ai-settings-form').elements.limitMode.onchange = () => {
  const f = $('ai-settings-form').elements;
  if (f.limitMode.value === 'limited' && !f.maxRequestsPerDay.value) f.maxRequestsPerDay.value = '300';
  syncAiLimitField();
  $('ai-settings-state').textContent = 'Unsaved changes';
};
$('ai-settings-form').oninput = () => { $('ai-settings-state').textContent = 'Unsaved changes'; };
$('reload-ai-settings').onclick = attempt(loadAiSettings);
$('ai-settings-form').onsubmit = attempt(async () => {
  if (!aiSettingsLoaded || aiSettingsSaving) return;
  const f = $('ai-settings-form').elements;
  const limit = f.limitMode.value === 'unlimited' ? null : Number(f.maxRequestsPerDay.value);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 5000)) throw new Error('Choose unlimited or a whole number from 1 to 5000 calls per day.');
  aiSettingsSaving = true;
  f.limitMode.disabled = true;
  $('save-ai-settings').disabled = true;
  syncAiLimitField();
  $('ai-settings-state').textContent = 'Saving…';
  try {
    fillAiSettings(await api('settings/ai', {maxRequestsPerDay:limit}));
    notice('AI settings saved and applied immediately.', true);
  } catch (error) { $('ai-settings-state').textContent = 'Could not save'; throw error; }
  finally {
    aiSettingsSaving = false;
    f.limitMode.disabled = false;
    $('save-ai-settings').disabled = false;
    syncAiLimitField();
  }
});
async function loadStrategy() {
  strategy=await api('strategy');const f=$('settings').elements,p=strategy.policy;
  allowedSymbols = [...p.strategy.watchlist];symbolInput.value = '';symbolFeedback();renderAllowedSymbols();
  fillRiskFields(p.risk);
  updateRiskSummary();
  for(const key of ['entry','exit','stopAdjust','targetAdjust'])f[key].value=p.automation.level[key];
  f.playbook.value=strategy.playbook;$('revision').textContent=`Revision ${p.version} · ${strategy.hash.slice(0,12)}`;$('settings-state').textContent='Saved';
}
function setTheme(theme) {
  document.documentElement.dataset.theme=theme;
  const light=theme==='light';
  $('theme-toggle').setAttribute('aria-label',light?'Switch to dark theme':'Switch to light theme');
  $('theme-toggle').querySelector('span').textContent=light?'Dark appearance':'Light appearance';
  document.querySelector('meta[name="theme-color"]').content=light?'#f4f5ef':'#101310';
}
try { setTheme(localStorage.getItem('autotrade.theme')==='light'?'light':'dark'); } catch { setTheme('dark'); }
$('theme-toggle').onclick=()=>{
  const theme=document.documentElement.dataset.theme==='light'?'dark':'light';setTheme(theme);
  try { localStorage.setItem('autotrade.theme',theme); } catch {}
};
const TEXT_SIZES=[0.9,1,1.1,1.25,1.4,1.6],DEFAULT_TEXT_SIZE=1.1;
function setTextSize(size) {
  const value=TEXT_SIZES.includes(size)?size:DEFAULT_TEXT_SIZE;
  document.documentElement.style.setProperty('--text-zoom',String(value));
  $('text-size-value').textContent=`${Math.round(value*100)}%`;
  $('text-smaller').disabled=value===TEXT_SIZES[0];
  $('text-larger').disabled=value===TEXT_SIZES[TEXT_SIZES.length-1];
  return value;
}
try { setTextSize(Number(localStorage.getItem('autotrade.textSize'))||DEFAULT_TEXT_SIZE); } catch { setTextSize(DEFAULT_TEXT_SIZE); }
function stepTextSize(step) {
  const current=TEXT_SIZES.indexOf(Number(document.documentElement.style.getPropertyValue('--text-zoom'))||DEFAULT_TEXT_SIZE);
  const value=setTextSize(TEXT_SIZES[Math.min(TEXT_SIZES.length-1,Math.max(0,current+step))]);
  try { localStorage.setItem('autotrade.textSize',String(value)); } catch {}
}
$('text-smaller').onclick=()=>stepTextSize(-1);
$('text-larger').onclick=()=>stepTextSize(1);
function fillRiskFields(risk) {
  const f=$('settings').elements;
  for(const [key,value] of Object.entries(risk))if(f[key])f[key].value=value==null?'':riskFractions.includes(key)?Number((value*100).toFixed(4)):value;
}
function readRiskFields() {
  const f=$('settings').elements, risk={...strategy.policy.risk};
  for(const key of riskNumbers)risk[key]=Number(f[key].value);
  for(const key of riskFractions)risk[key]=Number(f[key].value)/100;
  for(const key of riskOptional)risk[key]=f[key].value===''?null:Number(f[key].value);
  return risk;
}
function updateRiskSummary(keepCustom=false) {
  const f=$('settings').elements,risk=readRiskFields();
  if(!keepCustom)f.riskProfile.value=Object.entries(strategy.riskProfiles).find(([,values])=>Object.entries(values).every(([key,value])=>risk[key]===value))?.[0]||'custom';
  const parts=[];
  if(risk.riskPerTradePct!=null)parts.push(`Budget ${risk.riskPerTradePct}% of equity at the stop per trade`);
  if(risk.targetVolatilityPct!=null)parts.push(`aim for portfolio volatility up to ${risk.targetVolatilityPct}% per year`);
  if(risk.minRewardRisk!=null)parts.push(`require at least ${risk.minRewardRisk}:1 planned reward:risk`);
  if(risk.targetInvestedPct!=null)parts.push(`aim to keep ${risk.targetInvestedPct}% of equity invested${risk.minInvestedPct!=null?`, and explain any shortfall below ${risk.minInvestedPct}%`:''}`);
  if(risk.maxEntriesPerDay!=null)parts.push(`open at most ${risk.maxEntriesPerDay} new position${risk.maxEntriesPerDay===1?'':'s'} a day`);
  if(risk.lossCooldownHours!=null)parts.push(`wait ${risk.lossCooldownHours} hours before buying a stock again after a loss on it`);
  if(risk.trailingStopAtrMult!=null)parts.push(`raise stops automatically to ${risk.trailingStopAtrMult} ATR below the high since entry`);
  $('risk-summary').textContent=parts.length?parts.join('; ')+'.':'These optional risk controls are not configured. Choose a preset or enter your own values.';
}
$('settings').elements.riskProfile.onchange=()=>{
  const selected=$('settings').elements.riskProfile.value;
  if(strategy.riskProfiles[selected]){
    const values={...strategy.riskProfiles[selected]},ceilings=strategy.policy.immutable;
    for(const key of riskFractions)values[key]=Math.min(values[key],ceilings[key+'Ceiling']);
    fillRiskFields(values);
  }
  updateRiskSummary(selected==='custom');$('settings-state').textContent='Unsaved changes';
};
$('reload-strategy').onclick=attempt(loadStrategy);
let agentPrompts=null,shownPrompt='trader';
function showPrompt(){
  for(const b of document.querySelectorAll('[data-prompt]'))b.setAttribute('aria-pressed',String(b.dataset.prompt===shownPrompt));
  const p=agentPrompts?.[shownPrompt];
  $('prompt-text').value=!p?'Loading…':p.error?`Could not build this prompt: ${p.error}`:p.text;
  $('prompt-size').textContent=p?.text?`${p.text.split('\n').length} lines · ${p.text.length.toLocaleString()} characters`:'';
}
async function loadPrompts(){agentPrompts=await api('settings/prompts');showPrompt();}
for(const b of document.querySelectorAll('[data-prompt]'))b.onclick=()=>{shownPrompt=b.dataset.prompt;showPrompt();};
$('reload-prompts').onclick=attempt(loadPrompts);
$('settings').oninput=event=>{$('settings-state').textContent='Unsaved changes';if([...riskNumbers,...riskFractions,...riskOptional].includes(event.target.name))updateRiskSummary();};
$('settings').onsubmit=attempt(async()=>{
  if (symbolInput.value.trim() && !addAllowedSymbols()) return;
  if (!allowedSymbols.length) { symbolFeedback('Add at least one allowed symbol before saving.',true);symbolInput.focus();return; }
  const f=$('settings').elements,p=structuredClone(strategy.policy),changes=[];
  p.strategy.watchlist=[...allowedSymbols];
  p.risk=readRiskFields();
  for(const key of ['entry','exit','stopAdjust','targetAdjust'])p.automation.level[key]=f[key].value;
  const formatRisk=(key,value)=>value==null?'Not configured':riskFractions.includes(key)?`${Number((value*100).toFixed(4))}%`:key==='lossCooldownHours'?`${value} hours`:key==='trailingStopAtrMult'?`${value} ATR`:key==='maxEntriesPerDay'?value:[...riskOptional.filter(k=>k!=='minRewardRisk'),'maxSingleWeightPct','maxSectorWeightPct'].includes(key)?`${value}%`:key==='minRewardRisk'?`${value}:1`:value;
  for(const [key,value] of Object.entries(p.risk))if(value!==strategy.policy.risk[key])changes.push(`${riskLabels[key]||key}: ${formatRisk(key,strategy.policy.risk[key])} → ${formatRisk(key,value)}`);
  if(JSON.stringify(p.strategy.watchlist)!==JSON.stringify(strategy.policy.strategy.watchlist))changes.push('Allowed symbols: '+p.strategy.watchlist.join(', '));
  for(const key of ['entry','exit','stopAdjust','targetAdjust'])if(p.automation.level[key]!==strategy.policy.automation.level[key])changes.push(`${key}: ${strategy.policy.automation.level[key]} → ${p.automation.level[key]}`);
  if(f.playbook.value!==strategy.playbook)changes.push('Your playbook changed.');
  if(!changes.length){notice('No changes to save.',true);return;}
  pendingStrategy={policy:p,playbook:f.playbook.value,expectedHash:strategy.hash};$('review-text').textContent=changes.join('\n');$('review').showModal();
});
$('review').onclose=attempt(async()=>{if($('review').returnValue!=='save')return;await api('strategy',pendingStrategy);await loadStrategy();loadPrompts().catch(()=>{});notice('Strategy saved. Older approved orders will require a fresh order.',true);});

$('pause').onclick=attempt(async()=>{await api('commands/'+(status.health.paused?'resume':'pause'),{});await refresh();});
$('message').onsubmit=attempt(async()=>{
  const value=messageInput.value;
  await sendMessage(value);
  if(messageInput.value===value){messageInput.value='';hideCommands();}
});
$('cancel-adopt').onclick=()=>$('adopt').close();
$('adopt-form').onsubmit=attempt(async()=>{const f=$('adopt-form').elements;await api(`positions/${encodeURIComponent(f.symbol.value)}/adopt`,{stop:Number(f.stop.value),...(f.target.value?{target:Number(f.target.value)}:{})});$('adopt').close();await refresh();});
$('protection').onsubmit=attempt(async()=>{const f=$('protection').elements;await api(`positions/${encodeURIComponent(f.symbol.value)}/confirm-protection`,{stopOrderId:f.stopOrderId.value,...(f.targetOrderId.value?{targetOrderId:f.targetOrderId.value}:{})});await refresh();});
// Research comes from saved records. Opening details also loads its price chart.
let reviewSymbol = '', reviewLoad = 0, inspectorLoad = 0, reviewSubmitting = false, reviewLoading = false, positionTab = 'assessment';
const savedTime = at => at != null && at !== '' && Number.isFinite(new Date(at).getTime()) ? historyDate(at) : 'Not recorded';
const reviewDue = at => at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.now();
const taskProgress = value => ({queued:'Queued',running:'Working',waiting:'Waiting for orders',completed:'Finished',failed:'Failed',interrupted:'Interrupted · awaiting retry',cancelled:'Cancelled'})[value] || value;
function uiButton(label, onClick, cls = 'link') {
  const button = text('button',label,cls);button.type='button';button.onclick=onClick;return button;
}
function protectionCell(p) {
  const cell=text('div','','protection-cell');
  const label=!p?.known ? 'Coverage unknown' : !p.managed ? 'No AutoTrade stop link' : p.fullyCovered ? 'Linked stop covers shares' : p.coveredQty > 0 ? 'Linked stop covers some shares' : 'No linked stop in engine tick';
  cell.append(text('span',label,p?.known && p.managed && !p.fullyCovered ? 'down' : ''));
  cell.append(text('small',`Broker stop: ${p?.stopPrice == null ? '—' : money(p.stopPrice)} · target: ${p?.targetPrice == null ? '—' : money(p.targetPrice)}`));
  cell.append(text('small',`Intended: ${p?.intendedStop == null ? '—' : money(p.intendedStop)} / ${p?.intendedTarget == null ? '—' : money(p.intendedTarget)}`));
  cell.title=`Latest engine tick: ${savedTime(p?.checkedAt)}. Only linked AutoTrade orders are counted.`;
  return cell;
}
function reviewSection(parent,title) {
  const section=text('section','','review-section');section.append(text('h3',title));parent.append(section);return section;
}
function positionTabs(data) {
  const parent=$('position-review-content'),tabs=text('div','','position-tablist'),panels={};
  tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Position information');
  const groups=[['assessment','Assessment'],['thesis',data.held===false?'Buy case':'Entry thesis'],['protection','Protection'],['context','Market context'],['research',`Research (${data.researchTotal})`]];
  const buttons=[];
  function select(key,focus=false) {
    positionTab=key;
    for(let i=0;i<groups.length;i++) {
      const active=groups[i][0]===key;buttons[i].setAttribute('aria-selected',String(active));buttons[i].tabIndex=active?0:-1;
      panels[groups[i][0]].hidden=!active;
      if(active && focus)buttons[i].focus();
    }
  }
  for(const [key,label] of groups) {
    const panel=text('div','','position-tabpanel'),button=uiButton(label,()=>select(key),'position-tab');
    button.id=`position-tab-${key}`;button.setAttribute('role','tab');button.setAttribute('aria-controls',`position-panel-${key}`);
    panel.id=`position-panel-${key}`;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);panel.tabIndex=0;
    panel.hidden=true;buttons.push(button);panels[key]=panel;tabs.append(button);
  }
  tabs.onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const index=buttons.indexOf(document.activeElement);if(index<0)return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    select(groups[next][0],true);
  };
  parent.append(tabs,...Object.values(panels));select(positionTab);return panels;
}
function evidenceLinks(parent, ids, label='Saved observations', taskId=null) {
  const unique=[...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return;
  const details=document.createElement('details'),links=text('div','','review-links');details.className='evidence-references';
  details.append(text('summary',`${label} (${unique.length})`));
  unique.forEach((id,index)=>{const button=uiButton(`Observation ${index+1}`,()=>openSavedRecord('evidence',id,0,[],taskId));button.title=id;links.append(button);});
  details.append(links);parent.append(details);
}
function decisionLink(id) {
  const link=historyReference(id),go=link.onclick;
  link.onclick=()=>{ $('record-inspector').close();$('position-review-dialog').close();go(); };return link;
}
function renderReviewThesis(parent,thesis,checks,checkedAt,proposed=false) {
  if(!thesis){parent.append(text('p',proposed?'No proposed buy case recorded yet.':'No structured entry thesis recorded.'));return;}
  parent.append(historyFacts([['Setup',thesis.setup],['Planned holding period',`${thesis.horizonDays} days`],['Catalyst risk accepted',thesis.catalystRiskAccepted ? 'Yes' : 'No']]));
  const premises=text('div','','position-premises');
  for(const premise of thesis.premises || []) {
    const card=text('div','','review-card'),check=(checks || []).find(p=>p.label===premise.label && p.metric===premise.metric);
    card.append(text('h4',premise.label),text('span',check?.status || 'unknown','badge '+(check?.status==='supported'?'executed':'waiting')));
    if(premise.metric!=='qualitative')card.append(text('p',`${premise.metric} ${ {gt:'>',gte:'≥',lt:'<',lte:'≤'}[premise.operator] || '' } ${premise.threshold}`));
    card.append(text('p',check?.reading?.value==null ? 'No numeric verification saved.' : `Saved reading: ${check.reading.value} · as of ${savedTime(check.reading.asOf)}`,'review-meta'));
    evidenceLinks(card,premise.evidenceIds,proposed?'Supporting observations':'Entry observations');premises.append(card);
  }
  parent.append(premises,text('p',`Premise checks use the saved observation at ${savedTime(checkedAt)}. Qualitative premises require source interpretation; these checks do not predict profit.`,'review-meta'));
}
async function openPositionReview(symbol, retainTask=false) {
  const changed=reviewSymbol!==symbol,token=++reviewLoad;reviewSymbol=symbol;reviewLoading=true;
  const dialog=$('position-review-dialog');if(!dialog.open)dialog.showModal();
  $('position-review-title').textContent=symbol;
  $('position-review-status').textContent='Loading saved records…';
  $('position-review-overview').replaceChildren();$('position-review-flags').replaceChildren();$('position-review-controls').replaceChildren();
  $('position-review-content').replaceChildren();
  if(changed || !retainTask){
    positionTab='assessment';tickerChart.symbol=symbol;$('ticker-chart-title').textContent='Price history';
    void loadTickerChart();dialog.querySelector('.position-window-body').scrollTop=0;
  }
  if(changed || !retainTask)$('position-review-task').replaceChildren();
  $('ask-position-review').disabled=true;
  try {
    const data=await api(`positions/${encodeURIComponent(symbol)}/review`);
    if(token!==reviewLoad || !dialog.open)return;
    $('position-review-status').textContent=`${data.held === true ? 'Held position' : data.held === false ? 'Candidate · not held' : 'Current holdings unknown'} · saved view loaded ${savedTime(data.savedAt)}`;
    renderPositionReview(data);
  } catch(error) { if(token===reviewLoad)$('position-review-status').textContent=`Could not load saved review: ${error.message}`; }
  finally { if(token===reviewLoad){reviewLoading=false;$('ask-position-review').disabled=reviewSubmitting;} }
}
function renderPositionReview(data) {
  const panels=positionTabs(data);
  const summary=$('position-review-overview'),holding=data.holding;
  if(holding) {
    const pnl=holding.price==null ? null : (holding.price-holding.entryPrice)*holding.qty;
    const pct=holding.price==null || !holding.entryPrice ? null : (holding.price/holding.entryPrice-1)*100;
    const metrics=historyFacts([['Shares',historyNumber(holding.qty)],['Average cost',historyPrice(holding.entryPrice)],['Latest price',holding.price==null ? 'Unavailable' : historyPrice(holding.price)],['Open P&L',pnl==null ? 'Unavailable' : `${signedMoney(pnl)} ${signedPct(pct)}`]]);
    metrics.classList.add('position-metrics');metrics.lastElementChild.querySelector('dd').className=direction(pnl);summary.append(metrics);
    if(holding.stale)summary.append(text('p','The price in the latest engine tick is stale.','review-warning'));
  } else summary.append(text('p',data.held===false ? 'This symbol is not currently held.' : 'Current shares and prices could not be confirmed from a recent engine tick.','review-meta'));
  const assessment=data.managed ? data.review : data.held === false ? data.candidateReview : null;
  const flags=$('position-review-flags');
  flags.append(text('span',data.managed?'Managed by AutoTrade':data.held===true?'Unmanaged holding':data.held===false?'Candidate':'Holdings unknown','badge'));
  if(assessment)flags.append(text('span',`Saved assessment: ${assessment.decision==='buy'?'BUY CANDIDATE':assessment.decision.toUpperCase()}`,'badge'));
  if(assessment?.policyHash && assessment.policyHash!==data.policyHash)flags.append(text('span','Strategy changed','badge pending'));
  const controls=$('position-review-controls');
  controls.append(uiButton('Discuss with agent',()=>{
    $('position-review-dialog').close();askAbout(`What is your current assessment and plan for ${data.symbol}?`);
  },''));
  if(data.held===true && !data.managed)controls.append(uiButton('Adopt holding',()=>{
    $('position-review-dialog').close();$('adopt-form').elements.symbol.value=data.symbol;$('adopt').showModal();
  },''));
  if(data.managed && !holding)summary.append(text('p','A saved AutoTrade management record exists; current holdings remain unverified.','review-meta'));
  const latest=reviewSection(panels.assessment,'Latest assessment');
  if (assessment) {
    latest.append(text('p',assessment.decision==='buy'?'BUY CANDIDATE':assessment.decision.toUpperCase(),'review-verdict'));
    latest.append(historyFacts([['Recorded',savedTime(assessment.at)]]));
    const assessmentGrid=text('div','','position-assessment-grid'),reason=text('div','','review-card'),unknowns=text('div','','review-card');
    reason.append(text('h4',data.managed?'What changed':'Investment assessment'),text('p',assessment.changedEvidence || assessment.reason));
    unknowns.append(text('h4','Unknowns'));
    if(assessment.unknowns?.length){const list=text('ul','');for(const u of assessment.unknowns)list.append(text('li',u));unknowns.append(list);}
    else unknowns.append(text('p',Array.isArray(assessment.unknowns)?'None listed by the trader.':'No separate unknowns list recorded.'));
    assessmentGrid.append(reason,unknowns);latest.append(assessmentGrid);
    if(data.managed)latest.append(text('p','This is the saved assessment. Orders and fills are tracked separately.','review-meta'));
    else latest.append(text('p','This is a research recommendation. It does not place or approve an order.','review-meta'));
    if(assessment.policyHash && assessment.policyHash!==data.policyHash)latest.append(text('p','Strategy changed since this assessment.','review-warning'));
    if(data.held==null)latest.append(text('p','Current holdings could not be confirmed from a recent tick.','review-warning'));
    evidenceLinks(latest,[assessment.snapshotId,...(assessment.evidenceIds || [])]);
  } else latest.append(text('p','No assessment recorded for this current holding or candidate.'));
  if(data.candidateReview && assessment!==data.candidateReview) {
    const old=document.createElement('details');old.append(text('summary','Historical candidate assessment'),text('p',`${data.candidateReview.decision.toUpperCase()} · ${savedTime(data.candidateReview.at)} · ${data.candidateReview.reason}`));
    evidenceLinks(old,data.candidateReview.evidenceIds);latest.append(old);
  }
  if(data.managed || data.held===true) {
    const entry=reviewSection(panels.thesis,'Why this position was opened');
    if(data.entry){const link=decisionLink(data.entry.id);link.title=data.entry.id;link.textContent='Open entry decision';entry.append(text('p',data.entry.rationale || 'No entry rationale recorded.'),text('p',`Entry decision recorded ${savedTime(data.entry.at)}`,'review-meta'),link);evidenceLinks(entry,data.entry.observationIds);}
    else entry.append(text('p','The original entry decision is not linked. Its rationale is unknown.'));
    renderReviewThesis(entry,data.entry?.thesis,data.observation?.data?.thesisStatus?.premises,data.observation?.recordedAt);
    const protection=reviewSection(panels.protection,'Broker protection and intended levels'),p=data.protection;
    protection.append(protectionCell(p),historyFacts([['Engine tick',savedTime(p.checkedAt)],['Shares covered by linked stop',p.coveredQty==null ? 'Unknown' : `${p.coveredQty} of ${p.holdingQty}`],['Stop order',p.stopOrderId || 'No current linked order verified'],['Target order',p.targetOrderId || 'No current linked order verified']]));
    protection.append(text('p',!p.known ? 'A recent holdings and orders tick is needed to verify coverage.' : 'Only orders linked to AutoTrade are counted. Other broker orders may exist. Intended levels alone do not prove an order is working.','review-meta'));
  } else {
    const proposed=reviewSection(panels.thesis,data.held===false?'Proposed buy case':'Entry thesis');
    if(data.held===false){
      proposed.append(text('p','This is a proposed new investment case, separate from any historical position.','review-meta'));
      renderReviewThesis(proposed,assessment?.thesis,data.candidateThesisStatus?.premises,data.assessmentObservation?.recordedAt,true);
      const plan=data.candidateEntryPlan;
      if(plan){
        const levels=plan.data.proposedLevels || {};proposed.append(text('h4','Proposed entry and measured risk'));
        proposed.append(historyFacts([['Reference entry price',historyPrice(levels.referencePrice)],['Risk checked at entry limit',historyPrice(plan.data.entryPrice)],['Stop',historyPrice(levels.stopLoss)],['Target',historyPrice(levels.takeProfit)],['Reward:risk',plan.data.rewardRisk==null?'Unknown':`${plan.data.rewardRisk.toFixed(2)}:1`],['Maximum whole shares',historyNumber(plan.data.maxQty)],['Risk budget',plan.data.allowed?'Fits saved risk budget':'Does not fit saved risk budget'],['Plan recorded',savedTime(plan.recordedAt)]]));
        if(plan.data.violations?.length){const list=text('ul','');for(const item of plan.data.violations)list.append(text('li',item.message || item.rule));proposed.append(list);}
        proposed.append(text('p','These are researched levels and a saved risk preview, not broker orders. Prices, inputs and the full strategy must be checked again before execution.','review-meta'));evidenceLinks(proposed,[plan.id],'Saved entry plan');
      }else proposed.append(text('p','No entry plan saved. A conditional buy case may still be researched; live sizing and execution readiness remain unknown.','review-meta'));
    }else proposed.append(text('p','An entry thesis cannot be linked while current holdings are unknown.'));
    reviewSection(panels.protection,'Broker protection').append(text('p',data.held===false ? 'No current holding requires position protection.' : 'Current holdings and stop coverage are unknown.'));
  }
  const observation=reviewSection(panels.context,'Latest saved context'),obs=data.observation;
  if(!obs)observation.append(text('p','No saved position/candidate observation found for this lifecycle.'));
  else {
    observation.append(historyFacts([['Recorded',savedTime(obs.recordedAt)],['Source',obs.source || 'Not recorded'],['Market data as of',savedTime(obs.asOf)]]));
    if(!data.managed && data.held!==false)observation.append(text('p','No management record identifies the entry lifecycle. This is a historical observation for the symbol.','review-meta'));
    evidenceLinks(observation,[obs.id],'Open complete saved context');
    const c=obs.data || {};
    if(c.heldDays!=null)observation.append(text('p',`Held ${c.heldDays} days${c.intendedHorizonDays!=null ? ` · planned ${c.intendedHorizonDays} days` : ''}${c.horizonExceeded ? ' · planned period exceeded' : ''}`));
    for(const [key,label] of [['fundamentalChanges','Changes in fundamentals'],['relative','Performance compared with market / sector'],['liquidity','Liquidity and trading costs'],['forward','Return and risk from the saved price']]) {
      if(c[key]!=null){const detail=document.createElement('details');detail.append(text('summary',label),typeof c[key]==='object' ? recordedFields(c[key]) : text('p',String(c[key])));observation.append(detail);}
    }
    if(c.caveats?.length){const list=text('ul','','review-meta');for(const caveat of c.caveats)list.append(text('li',caveat));observation.append(list);}
    if(assessment?.snapshotId && assessment.snapshotId!==obs.id)observation.append(text('p','This observation differs from the one used for the assessment above. Open the assessment’s linked snapshot to see what it used.','review-meta'));
  }
  const research=reviewSection(panels.research,'Saved research');
  if(!data.research.length)research.append(text('p','No research sources saved for this symbol.'));
  else {
    if(data.researchTotal>data.research.length)research.append(text('p',`Showing the ${data.research.length} most recently saved sources.`,'review-meta'));
    for(const source of data.research) {
      const card=document.createElement('details');card.className='review-card research-source';
      const heading=text('summary',''),title=text('span',source.title || 'Untitled source');heading.append(title,text('small',`${source.publisher || source.source} · ${savedTime(source.publishedAt)}`));
      if(source.review)heading.append(text('span',source.review.assessment,'badge'));card.append(heading);
      card.append(historyFacts([['Publisher / provider',source.publisher || source.source],['Published',savedTime(source.publishedAt)],['Event date',savedTime(source.eventAt)],['First saved',savedTime(source.firstSeenAt)]]));
      const links=text('div','','review-links');
      if(source.read)links.append(uiButton('Read saved source text',()=>openSavedRecord('source',source.id)));
      else links.append(text('span','Original text not cached'));
      try { const url=new URL(source.url);if(url.protocol==='https:' && !url.username && !url.password){const link=text('a','Open publisher ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';links.append(link);} }catch{}
      card.append(links);
      if(source.review)card.append(text('p',`${source.review.assessment.toUpperCase()} · ${savedTime(source.review.at)} · ${source.review.affectedPremise || 'No premise named'}`),text('p',source.review.reason));
      else card.append(text('p','No interpretation recorded.','review-meta'));
      research.append(card);
    }
    research.append(text('p','Cached text means it can be retrieved; it does not prove the agent read every page.','review-meta'));
  }
}
function beginInspector(title) {
  const token=++inspectorLoad;$('record-inspector-title').textContent=title;
  $('record-inspector-content').replaceChildren(text('p','Loading saved record…'));
  if(!$('record-inspector').open)$('record-inspector').showModal();return token;
}
async function openSavedRecord(kind,id,offset=0,previous=[],taskId=null) {
  const names={evidence:'Saved observation',tool:'Saved tool receipt',source:'Saved source text'},routes={evidence:'evidence',tool:'tool-receipts',source:'source-text'};
  const token=beginInspector(names[kind]),parent=$('record-inspector-content');
  try {
    const row=await api(`${routes[kind]}/${encodeURIComponent(id)}?offset=${offset}`);
    if(token!==inspectorLoad || !$('record-inspector').open)return;
    parent.replaceChildren();
    if(taskId)parent.append(uiButton('← Back to request',()=>openAgentTask(taskId)));
    parent.append(historyFacts([['Record',id],['Tool / source',row.tool || row.name || names[kind]],['Recorded / started',savedTime(row.recordedAt || row.startedAt || row.fetchedAt)],['Data as of / finished',savedTime(row.asOf || row.finishedAt)]]));
    if(row.input!=null){const inputs=document.createElement('details');inputs.append(text('summary','Tool input'),recordedFields(row.input));parent.append(inputs);}
    if(kind==='tool')parent.append(text('p',row.resultSaved ? 'Saved output below. Check its contents for errors; a saved result alone does not establish success.' : 'No tool output was saved.','review-meta'));
    // JSON output reads as a tree, which needs the whole document rather than one character page.
    if(kind==='tool' && row.resultSaved && !offset){
      const {output}=await api(`tool-output/${encodeURIComponent(id)}`);
      if(token!==inspectorLoad || !$('record-inspector').open)return;
      let parsed;try{parsed=JSON.parse(output);}catch{}
      if(parsed && typeof parsed==='object'){
        const tools=text('div','','json-tools');
        tools.append(uiButton('Expand all',()=>tree.querySelectorAll('details').forEach(d=>d.open=true)),uiButton('Collapse all',()=>tree.querySelectorAll('details').forEach(d=>d.open=false)),
          uiButton('Copy JSON',()=>navigator.clipboard.writeText(JSON.stringify(parsed,null,2)).then(()=>notice('JSON copied',true),()=>notice('Copy failed'))));
        const tree=text('div','','json-tree');tree.append(jsonNode(parsed,null,0));
        parent.append(tools,tree);return;
      }
    }
    parent.append(text('pre',row.text,'saved-record-text'));
    const navigation=text('div','','record-pagination');
    const back=uiButton('Previous',()=>openSavedRecord(kind,id,previous.at(-1),previous.slice(0,-1),taskId),'');back.disabled=!previous.length;
    const next=uiButton('Next',()=>openSavedRecord(kind,id,row.nextOffset,[...previous,row.offset],taskId),'');next.disabled=row.nextOffset==null;
    navigation.append(back,text('span',`${row.totalCharacters ? row.offset+1 : 0}–${row.offset+row.text.length} of ${row.totalCharacters} characters`),next);parent.append(navigation);
  }catch(error){if(token===inspectorLoad){parent.replaceChildren(text('p',`Saved record unavailable: ${error.message}`));if(taskId)parent.append(uiButton('← Back to request',()=>openAgentTask(taskId)));}}
}
// One JSON value as a tree row. Objects and arrays fold; the top two levels start open, and a
// folded object previews its most identifying field so a list of events can be scanned closed.
function jsonNode(value,key,depth) {
  const label=()=>{const k=text('span',typeof key==='number' ? `${key}` : `"${key}"`,typeof key==='number' ? 'json-index' : 'json-key');return [k,text('span',': ','json-punct')];};
  if(value===null || typeof value!=='object'){
    const row=text('div','','json-row');if(key!=null)row.append(...label());
    const kind=value===null ? 'null' : typeof value;
    const shown=text('span',kind==='string' ? JSON.stringify(value) : String(value),`json-${kind}`);
    if(kind==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) && Number.isFinite(Date.parse(value)))shown.title=historyDate(value);
    row.append(shown);return row;
  }
  const array=Array.isArray(value),entries=array ? value.map((v,i)=>[i,v]) : Object.entries(value);
  const node=document.createElement('details');node.className='json-node';node.open=depth<2;
  const summary=document.createElement('summary');if(key!=null)summary.append(...label());
  summary.append(text('span',array ? `[${entries.length} ${entries.length===1 ? 'item' : 'items'}]` : `{${entries.length} ${entries.length===1 ? 'field' : 'fields'}}`,'json-count'));
  const hint=!array && ['headline','title','name','symbol','kind','id'].map(f=>value[f]).find(v=>typeof v==='string' && v);
  if(hint)summary.append(text('span',hint,'json-hint'));
  node.append(summary);
  const body=text('div','','json-children');
  if(!entries.length)body.append(text('div',array ? 'empty list' : 'no fields','json-empty'));
  for(const [k,v] of entries)body.append(jsonNode(v,k,depth+1));
  node.append(body);return node;
}
// The agent's saved conversation, one collapsible block per message. The first message is the
// engine's full briefing, so every block starts closed; tool results open their saved receipt.
function trajectoryView(messages,taskId) {
  const section=document.createElement('details');section.className='trajectory';
  section.append(text('summary',`Conversation (${messages.length} messages)`));
  messages.forEach((m,i)=>{
    const block=document.createElement('details'),blocks=m.content || [];
    const said=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n\n');
    const calls=blocks.filter(b=>b.type==='tool_use'),results=blocks.filter(b=>b.type==='tool_result');
    const who=m.role==='assistant' ? 'Agent' : i===0 ? 'Briefing' : results.length ? 'Tool results' : 'Engine';
    const hint=said ? said.replace(/\s+/g,' ').slice(0,90) : calls.length ? `called ${calls.map(c=>c.name).join(', ')}` : `${results.length} result${results.length===1?'':'s'}`;
    block.append(text('summary',`${i+1}. ${who} · ${hint}`));
    if(said)block.append(text('pre',said));
    for(const c of calls){const d=document.createElement('details');d.append(text('summary',`Called ${c.name}`),text('pre',JSON.stringify(c.input,null,2)));block.append(d);}
    for(const r of results)block.append(r.receiptId ? uiButton(`Open saved result ${r.receiptId}`,()=>openSavedRecord('tool',r.receiptId,0,[],taskId)) : text('pre',r.content));
    section.append(block);
  });
  return section;
}
async function openAgentTask(id) {
  const token=beginInspector('Agent request trail'),parent=$('record-inspector-content');
  try {
    const data=await api(`agent-requests/${encodeURIComponent(id)}`);
    if(token!==inspectorLoad || !$('record-inspector').open)return;
    parent.replaceChildren();const r=data.request;
    parent.append(historyFacts([['Request ID',r.id],['Agent',roleLabel(r.role)],['Started by',r.actorId],['Progress',taskProgress(r.status)],['Created',savedTime(r.createdAt)],['Mode',taskMode(r)]]));
    if(r.parentId)parent.append(uiButton(`Parent request: ${r.parentId}`,()=>openAgentTask(r.parentId)));
    // The outcome is what the operator came for, so it leads; the standing instruction folds away.
    const instruction=document.createElement('details');instruction.className='request-instruction';
    instruction.append(text('summary','Instruction'),text('p',r.text));
    parent.append(text('h3','Outcome'),requestOutcome(r.result),instruction);
    if(data.trajectory)parent.append(historyFacts([['Agent run',data.trajectory.status],['Model rounds',data.trajectory.rounds],['Input / output tokens',`${data.trajectory.inTokens} / ${data.trajectory.outTokens}`]]));
    if(data.trajectory?.error)parent.append(text('p',data.trajectory.error,'review-warning'));
    if(data.trajectory?.messages?.length)parent.append(trajectoryView(data.trajectory.messages,id));
    const tools=reviewSection(parent,`Tool activity (${data.totals.tools})`);
    if(!data.tools.length)tools.append(text('p','No tool attempts recorded.'));
    if(data.totals.tools>data.tools.length)tools.append(text('p',`Showing the latest ${data.tools.length} attempts.`));
    for(const call of data.tools){const card=text('article','','review-card');card.append(text('h4',call.name),text('p',`${savedTime(call.startedAt)} · ${call.resultSaved?'Output saved':'No output saved'}${call.finishedAt ? ` · finished ${savedTime(call.finishedAt)}` : ''}`,'review-meta'),uiButton('Open input and saved output',()=>openSavedRecord('tool',call.id,0,[],id)));tools.append(card);}
    const decisions=reviewSection(parent,`Recorded decisions (${data.totals.decisions})`);
    if(data.totals.decisions>data.decisions.length)decisions.append(text('p',`Showing the latest ${data.decisions.length} decisions.`));
    if(!data.decisions.length)decisions.append(text('p','No journal decisions linked to this request. Candidate assessments can be found in the review tool’s saved output.'));
    for(const d of data.decisions){const card=text('article','','review-card');card.append(text('h4',`${d.symbol || 'Portfolio'} · ${d.kind} · ${d.orderStatus || 'Recorded decision'}`),text('p',savedTime(d.at),'review-meta'),text('p',d.rationale),decisionLink(d.id));evidenceLinks(card,d.observationIds,'Saved observations',id);decisions.append(card);}
    const actions=reviewSection(parent,`Orders (${data.orders.length})`);
    if(!data.orders.length)actions.append(text('p','No orders linked to this request.'));
    for(const a of data.orders){const card=text('article','','review-card');card.append(text('h4',`${a.symbol} · ${a.kind} · ${a.status}`));orderDetails(card,a,true);card.append(decisionLink(a.id));actions.append(card);}
    if(data.transitions?.length){const history=document.createElement('details');history.append(text('summary',`Order progress history (${data.totals.transitions})`));if(data.totals.transitions>data.transitions.length)history.append(text('p',`Showing the latest ${data.transitions.length} transitions.`));for(const event of data.transitions)history.append(text('p',`${savedTime(event.at)} · ${event.symbol} · ${event.transition} · ${event.orderId}`));actions.append(history);}
    const fills=reviewSection(parent,`Confirmed broker fills (${data.totals.fills})`);
    if(data.totals.fills>data.fills.length)fills.append(text('p',`Showing the latest ${data.fills.length} fills.`));
    if(!data.fills.length)fills.append(text('p','No confirmed fills linked to this request’s orders.'));
    for(const f of data.fills)fills.append(historyFacts([['Symbol / side',`${f.symbol} / ${f.side}`],['Executed',savedTime(f.at)],['Shares',historyNumber(f.qty)],['Price',historyPrice(f.price)],['Broker order',f.brokerOrderId],['Execution ID',f.execId]]));
    if(data.children.length){const children=reviewSection(parent,'Related agent requests');for(const child of data.children)children.append(uiButton(`${child.role} · ${taskProgress(child.status)} · ${child.text}`,()=>openAgentTask(child.id)));}
    parent.append(uiButton('Refresh saved request trail',()=>openAgentTask(id),''));
  }catch(error){if(token===inspectorLoad)parent.replaceChildren(text('p',`Request trail unavailable: ${error.message}`));}
}
$('close-position-review').onclick=()=>$('position-review-dialog').close();
$('position-review-dialog').onclose=()=>{reviewLoad++;tickerChart.request++;};
$('refresh-position-review').onclick=()=>openPositionReview(reviewSymbol,true);
$('close-record-inspector').onclick=()=>$('record-inspector').close();
$('record-inspector').onclose=()=>{inspectorLoad++;};
$('ask-position-review').onclick=async()=>{
  if(reviewSubmitting || !reviewSymbol)return;
  const symbol=reviewSymbol;reviewSubmitting=true;$('ask-position-review').disabled=true;
  $('position-review-task').textContent='Starting research…';
  try {
    const result=await api(`positions/${encodeURIComponent(symbol)}/review`,{});
    if(reviewSymbol===symbol){$('position-review-task').replaceChildren(text('span',`${taskProgress(result.status)} · research runs alongside trading, even while trading is paused; it places no orders. `),uiButton('Follow request',()=>openAgentTask(result.requestId)));}
  }catch(error){if(reviewSymbol===symbol)$('position-review-task').textContent=`Could not start research: ${error.message}`;}
  finally{reviewSubmitting=false;$('ask-position-review').disabled=reviewLoading;}
};
// A web process may be opened before its engine. Retry read-only initialization,
// including command discovery and strategy loading; never replay a user submission.
async function connectDashboard() {
  try { await start(); if ($('notice').textContent.startsWith('Waiting for engine:')) notice(''); }
  catch (error) {
    started = false;
    stream?.close();
    setLive(false);
    notice('Waiting for engine: ' + error.message);
    setTimeout(connectDashboard, 3000);
  }
}
void connectDashboard();
// Backstop for anything the stream misses, such as an action expiring with no new activity.
setInterval(()=>{if(started)refresh().catch(e=>notice('Could not refresh account: '+e.message));},10000);
// Countdowns on the agent pills move every second without asking the server.
setInterval(renderThinking,1000);
