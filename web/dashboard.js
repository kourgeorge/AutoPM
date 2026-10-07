'use strict';
const $ = id => document.getElementById(id);
let started = false, strategy, pendingStrategy, status, cursor = 0, refreshing = false;
let commands = [], commandMatches = [], commandIndex = 0, commandDismissed = false;
const messageInput = $('message-text');
const riskFractions = ['positionSizePct','maxDailyLossPct','maxGrossExposurePct'];
const riskNumbers = ['maxPositions','stopLossAtrMult','maxSingleWeightPct','maxSectorWeightPct'];
const riskOptional = ['riskPerTradePct','targetVolatilityPct','minRewardRisk'];
const riskLabels = { positionSizePct:'Maximum position size', maxDailyLossPct:'Daily loss limit', maxGrossExposurePct:'Gross exposure limit',
  maxPositions:'Maximum positions', stopLossAtrMult:'Stop distance (ATR)', maxSingleWeightPct:'Single-name limit', maxSectorWeightPct:'Sector limit',
  riskPerTradePct:'Risk per trade', targetVolatilityPct:'Annualized portfolio volatility target', minRewardRisk:'Minimum reward:risk' };
const money = n => n == null ? 'Unavailable' : new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(n);
const text = (tag, value, cls) => { const e = document.createElement(tag); e.textContent = value; if(cls)e.className=cls; return e; };
const notice = value => { $('notice').textContent = value; $('notice').hidden = !value; };
async function api(url, body) {
  const res = await fetch('/api/' + url, {headers: {'Content-Type':'application/json'}, ...(body === undefined ? {} : {method:'POST',body:JSON.stringify(body)})});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function attempt(fn) { return async event => { event?.preventDefault(); try { await fn(event); } catch(e) { notice(e.message); } }; }
async function start() {
  started = true;
  await Promise.all([refresh(), loadStrategy(), loadCommands()]);
}
async function loadCommands() {
  commands = (await api('commands')).commands;
  updateCommands();
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
function rows(target, list, cells) { $(target).replaceChildren(...list.map(item => { const tr=document.createElement('tr'); for(const value of cells(item)){const td=document.createElement('td'); if(value instanceof Node)td.append(value); else td.textContent=value; tr.append(td);} return tr;})); }
async function refresh() {
  if (!started || refreshing) return; refreshing = true;
  try {
    const [s,p,o,a,f,c,l] = await Promise.all([api('status'),api('positions'),api('orders'),api('actions?status=all'),api(`feed?after=${cursor}&limit=200`),api('agent-commands'),api('lessons')]);
    status=s; $('account-id').textContent=s.health.runtime.accountId || 'CONNECTING TO ACCOUNT';
    $('venue').textContent=s.env.venue; $('venue').className='badge '+s.env.venue;
    $('equity').textContent=money(s.account?.equity); $('cash').textContent=money(s.account?.cash);
    $('trading').textContent=s.health.paused?'Paused':s.health.ready?'Running':'Needs attention';
    $('updated').textContent=s.lastTickAt?new Date(s.lastTickAt).toLocaleString():'Waiting for data';
    $('pause').textContent=s.health.paused?'Resume trading':'Pause trading';
    const issues=[...s.health.issues]; if(s.health.paused)issues.unshift('Trading is paused. Existing broker orders remain active, and protection checks continue.'); if(s.health.dailyLossHalted)issues.push('The daily loss limit is latched. New entries are disabled for this session.');
    $('health').textContent=issues.join('\n');
    $('positions-status').textContent=p.available?(p.positions.length?'Planned stop levels must be checked against the broker orders below.':'No open holdings.'):p.error;
    rows('positions',p.positions||[],v=>{
      let managed=text('span',v.managed?'Managed':'Unmanaged');
      if(!v.managed) {managed=text('button','Adopt holding');managed.onclick=()=>{$('adopt-form').elements.symbol.value=v.symbol;$('adopt').showModal();};}
      return [v.symbol,v.qty,money(v.entryPrice),money(v.price),v.stopLevel==null?'—':money(v.stopLevel),managed];
    });
    $('orders-status').textContent=o.available?(o.orders.length?'Orders reported by the broker.':'No open broker orders.'):'Broker orders are unavailable.';
    rows('orders',o.orders||[],v=>[v.symbol,`${v.side} / ${v.type}`,v.qty,v.filled,v.stopPrice||v.limitPrice||'Market',v.status,v.id]);
    $('actions').replaceChildren(...a.actions.slice(0,30).map(p=>{
      const card=text('article','','card');card.append(text('span',p.status,'badge '+p.status),text('h3',`${p.kind.replaceAll('_',' ')} · ${p.symbol}`),text('p',p.reason));
      const signal=p.params.signal||p.params;
      card.append(text('pre',`Quantity: ${p.params.maxQty??p.params.qty??'—'} · Filled: ${p.result?.filledQty??'—'}\nPrice: ${signal.price??'Market'} · Stop: ${signal.stopLoss??'—'} · Target: ${signal.takeProfit??'—'}\n${p.venue.toUpperCase()} · ${p.automatic?'Automatic':'Human review'}\n${p.status==='pending'||p.status==='approved'?'Expires: '+new Date(p.expiresAt).toLocaleString():p.id}`));
      const risk=p.params.riskAssessment;
      if(risk){
        card.append(text('p',`Risk when proposed: ${money(risk.plannedLoss)} (${risk.plannedLossPct.toFixed(2)}% of equity) at the planned stop. Reward:risk ${risk.rewardRisk==null?'unavailable':risk.rewardRisk.toFixed(2)+':1'}.`));
        if(risk.volatilityAfterPct!=null)card.append(text('p',`Estimated portfolio volatility: ${risk.volatilityBeforePct.toFixed(2)}% → ${risk.volatilityAfterPct.toFixed(2)}% per year; target ${risk.targetVolatilityPct}%. ${risk.observations} daily observations through ${risk.asOf}. Rechecked before execution.`));
      }
      if(p.result?.error)card.append(text('p',p.result.error));
      if(p.status==='pending')for(const decision of ['approve','reject']){const b=text('button',decision==='approve'?'Approve action':'Reject');b.disabled=p.expiresAt<=Date.now();b.onclick=attempt(async()=>{await api(`actions/${p.id}/${decision}`,{});await refresh();});card.append(b);}
      return card;
    }));
    if(!a.actions.length)$('actions').append(text('p','No trading decisions yet.'));
    $('agent-commands').replaceChildren(...c.commands.slice(0,12).map(command=>{
      const card=text('article','','card');card.append(text('span',command.status,'badge'),text('h3',`${command.role} · ${command.actorId}`),text('p',command.text),text('p',command.result||'Waiting to process'),text('small',command.id));return card;
    }));
    // Preserve an in-progress edit during background refreshes.
    if (!$('lesson-list').contains(document.activeElement)) $('lesson-list').replaceChildren(...l.lessons.slice(0,20).map(lesson=>{
      const card=text('article','','card');card.append(text('span',lesson.active?'Active':'Retired','badge'),text('p',`Evidence: ${lesson.evidenceIds.join(', ')||'Operator observation / legacy review required'}`));
      const editor=text('textarea',lesson.text);editor.value=lesson.text;editor.maxLength=2000;editor.setAttribute('aria-label','Lesson text');card.append(editor);
      for(const [label,active] of [['Save',lesson.active],[lesson.active?'Retire':'Activate',!lesson.active]]){const button=text('button',label);button.onclick=attempt(async()=>{await api(`lessons/${encodeURIComponent(lesson.id)}`,{text:editor.value,active});document.activeElement.blur();await refresh();});card.append(button);}
      return card;
    }));
    for(const entry of f.entries){
      // Older stored replies include a request label; keep it out of the conversation too.
      const answer=entry.kind==='reply'?entry.text.replace(/^(?:concierge|trader) request [A-Za-z0-9:_-]+: /,''):entry.text;
      const row=text('div',answer);row.prepend(text('time',`${new Date(entry.at).toLocaleString()} · ${entry.kind}`));$('feed').append(row);cursor=entry.seq;
    }
    while($('feed').children.length>400)$('feed').firstChild.remove();
  } finally { refreshing=false; }
}
async function loadStrategy() {
  strategy=await api('strategy');const f=$('settings').elements,p=strategy.policy;
  f.watchlist.value=p.strategy.watchlist.join(', ');
  fillRiskFields(p.risk);
  updateRiskSummary();
  for(const key of ['entry','exit','stopAdjust','targetAdjust'])f[key].value=p.automation.level[key];
  f.playbook.value=strategy.playbook;$('revision').textContent=`Revision ${p.version} · ${strategy.hash.slice(0,12)}`;$('settings-state').textContent='Saved';
}
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
$('pause').onclick=attempt(async()=>{await api('commands/'+(status.health.paused?'resume':'pause'),{});await refresh();});
$('reconcile').onclick=attempt(async()=>{await api('reconcile',{});await refresh();});
$('reload-strategy').onclick=attempt(loadStrategy);
$('settings').oninput=event=>{$('settings-state').textContent='Unsaved changes';if([...riskNumbers,...riskFractions,...riskOptional].includes(event.target.name))updateRiskSummary();};
$('settings').onsubmit=attempt(async()=>{
  const f=$('settings').elements,p=structuredClone(strategy.policy),changes=[];
  p.strategy.watchlist=f.watchlist.value.split(/[\s,]+/).filter(Boolean).map(s=>s.toUpperCase());
  p.risk=readRiskFields();
  for(const key of ['entry','exit','stopAdjust','targetAdjust'])p.automation.level[key]=f[key].value;
  const formatRisk=(key,value)=>value==null?'Not configured':riskFractions.includes(key)?`${Number((value*100).toFixed(4))}%`:[...riskOptional.filter(k=>k!=='minRewardRisk'),'maxSingleWeightPct','maxSectorWeightPct'].includes(key)?`${value}%`:key==='minRewardRisk'?`${value}:1`:value;
  for(const [key,value] of Object.entries(p.risk))if(value!==strategy.policy.risk[key])changes.push(`${riskLabels[key]||key}: ${formatRisk(key,strategy.policy.risk[key])} → ${formatRisk(key,value)}`);
  if(JSON.stringify(p.strategy.watchlist)!==JSON.stringify(strategy.policy.strategy.watchlist))changes.push('Allowed symbols: '+p.strategy.watchlist.join(', '));
  for(const key of ['entry','exit','stopAdjust','targetAdjust'])if(p.automation.level[key]!==strategy.policy.automation.level[key])changes.push(`${key}: ${strategy.policy.automation.level[key]} → ${p.automation.level[key]}`);
  if(f.playbook.value!==strategy.playbook)changes.push('Account playbook text changed.');
  if(!changes.length){notice('No changes to save.');return;}
  pendingStrategy={policy:p,playbook:f.playbook.value,expectedHash:strategy.hash};$('review-text').textContent=changes.join('\n');$('review').showModal();
});
$('review').onclose=attempt(async()=>{if($('review').returnValue!=='save')return;await api('strategy',pendingStrategy);await loadStrategy();notice('Strategy saved. Older approved actions will require a fresh action.');});
$('message').onsubmit=attempt(async()=>{
  const value=messageInput.value, slash=/^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(value);
  if(slash) {
    const result=await api('commands/'+encodeURIComponent(slash[1]),{args:slash[2]||''});
    if(!result.ok)throw new Error(result.error||'Command failed');
    notice(`/${slash[1]} completed.`);
  } else if(value.trimStart().startsWith('/')) {throw new Error('Choose a command from the list.');}
  else {
    const receipt=await api('messages',{text:value});notice(`Request ${receipt.requestId} ${receipt.status}.`);
  }
  if(messageInput.value===value)messageInput.value='';hideCommands();await refresh();
});
$('cancel-adopt').onclick=()=>$('adopt').close();
$('adopt-form').onsubmit=attempt(async()=>{const f=$('adopt-form').elements;await api(`positions/${encodeURIComponent(f.symbol.value)}/adopt`,{stop:Number(f.stop.value),...(f.target.value?{target:Number(f.target.value)}:{})});$('adopt').close();await refresh();});
$('protection').onsubmit=attempt(async()=>{const f=$('protection').elements;await api(`positions/${encodeURIComponent(f.symbol.value)}/confirm-protection`,{stopOrderId:f.stopOrderId.value,...(f.targetOrderId.value?{targetOrderId:f.targetOrderId.value}:{})});await refresh();});
start().catch(e=>notice(e.message));
setInterval(()=>{if(started)refresh().catch(e=>notice('Could not refresh account: '+e.message));},5000);
