const $ = id => document.getElementById(id);
const dollar = amount => amount === null || amount === undefined ? 'Unavailable' :
  new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amount / 100);
const number = value => Math.max(0,Number(value) || 0);
let csrf = null;
let stream = null;
let searchTimer = null;
let latestRequest = 0;
let current = null;

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function clear(node) { node.replaceChildren(); }
function message(text) { $('status').textContent = text; }
async function api(path, method='GET', body) {
  const response = await fetch(path, {method,credentials:'same-origin',
    headers:method === 'GET' ? {} : {'Content-Type':'application/json',...(csrf ? {'X-CSRF-Token':csrf}:{})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw new Error(data.error || 'Request failed');
  }
  return data;
}
function showLogin() {
  if (stream) { stream.close();stream=null; }
  csrf=null;
  $('dashboard').hidden=true;
  $('login-view').hidden=false;
}
function streamState(label, live=false) {
  $('stream-state').textContent=label;
  $('stream-state').classList.toggle('live',live);
}
async function load() {
  if (!csrf) return;
  const request = ++latestRequest;
  const params = new URLSearchParams({month:$('month').value});
  if ($('account-filter').value) params.set('account',$('account-filter').value);
  if ($('search').value.trim()) params.set('q',$('search').value.trim());
  try {
    const data=await api('/api/snapshot?'+params.toString());
    if (request !== latestRequest) return;
    current=data;
    render(data);
  } catch(error) {
    if (request === latestRequest) message('Unable to load the latest account view.');
  }
}
function showDashboard() {
  $('login-view').hidden=true;
  $('dashboard').hidden=false;
  $('password').value='';
  if (!stream) {
    stream=new EventSource('/api/events');
    stream.onopen=()=>streamState('Live · connected',true);
    stream.onerror=()=>streamState('Reconnecting…');
    stream.addEventListener('refresh',()=>load());
  }
  load();
}
function render(data) {
  $('empty').hidden = data.items.length > 0;
  $('cash').textContent=dollar(data.totals.cash_cents);
  $('debt').textContent=dollar(data.totals.card_debt_cents);
  $('net').textContent=dollar(data.totals.net_liquid_cents);
  $('spending').textContent=dollar(data.totals.spending_cents);
  $('account-count').textContent=data.accounts.length+' accounts';
  $('updated-at').textContent='View generated '+new Date(data.generated_at).toLocaleString();
  renderAccounts(data);
  renderCategories(data);
  renderTrend(data);
  renderRows(data);
  populateAccounts(data);
  const errors=data.items.filter(item=>item.status !== 'connected');
  if (errors.length) message(errors.length+' linked institution(s) need attention. Reconnect if prompted.');
  else if (data.balancesIncomplete) message('One or more balances are unavailable. Balance totals are partial.');
  else message('Spending uses posted, categorized transactions; recognized transfers are excluded. Historical activity can arrive later.');
}
function populateAccounts(data) {
  const select=$('account-filter');
  const selected=select.value;
  clear(select);
  select.append(element('option','', 'All accounts'));
  select.firstChild.value='';
  for (const account of data.accounts) {
    const option=element('option','',account.name+(account.mask ? ' ••'+account.mask : ''));
    option.value=account.account_id;
    select.append(option);
  }
  select.value=selected;
}
function renderAccounts(data) {
  const target=$('account-cards');
  clear(target);
  if (!data.accounts.length) {
    target.append(element('p','muted','No accounts have been loaded yet.'));
    return;
  }
  for (const account of data.accounts) {
    const card=element('article','account-card');
    card.append(element('div','account-name',account.name+(account.mask ? ' ••'+account.mask : '')));
    card.append(element('div','account-kind',(account.type+' · '+(account.subtype || 'account')).replaceAll('_',' ')));
    card.append(element('div','account-balance',dollar(account.current_cents)));
    card.append(element('div','account-updated','Snapshot updated '+new Date(account.updated_at).toLocaleString()));
    const item=data.items.find(entry=>entry.item_id === account.item_id);
    if (item && item.status === 'needs_relink') {
      card.append(element('p','account-error','Reconnection needed'));
      const relink=element('button','subtle','Reconnect');
      relink.type='button';
      relink.addEventListener('click',()=>connect(item.item_id));
      card.append(relink);
    } else if (item && item.status === 'sync_error') {
      card.append(element('p','account-error','Latest update failed; retry available.'));
    }
    target.append(card);
  }
}
function renderCategories(data) {
  const target=$('categories');
  clear(target);
  if (!data.categories.length) {
    target.append(element('p','muted','No categorized spending for this selection.'));
    return;
  }
  const max=Math.max(1,...data.categories.map(row=>number(row.amount_cents)));
  for (const row of data.categories.slice(0,8)) {
    const outer=element('div','category-row');
    const meta=element('div','category-meta');
    meta.append(element('span','',row.category.replaceAll('_',' ').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase())));
    meta.append(element('span','amount',dollar(row.amount_cents)));
    const track=element('div','progress');
    const fill=element('span');
    fill.style.width=Math.round(100*row.amount_cents/max)+'%';
    track.append(fill);
    outer.append(meta,track);
    target.append(outer);
  }
}
function renderTrend(data) {
  const target=$('trend');
  clear(target);
  const maximum=Math.max(1,...data.months.map(row=>number(row.amount_cents)));
  for (const row of data.months) {
    const col=element('div','trend-col');
    const amount=element('div','trend-amount',row.amount_cents ? dollar(row.amount_cents).replace('.00','') : '—');
    const bar=element('div','trend-bar');
    bar.style.height=(row.amount_cents ? Math.max(3,Math.round(row.amount_cents/maximum*148)) : 3)+'px';
    bar.title=row.month+': '+dollar(row.amount_cents);
    const label=element('div','trend-label',new Date(row.month+'-10T12:00:00').toLocaleString('en-US',{month:'short'}));
    col.append(amount,bar,label);
    target.append(col);
  }
}
function renderRows(data) {
  const target=$('transactions');
  clear(target);
  const names=Object.fromEntries(data.accounts.map(a=>[a.account_id,a.name]));
  if (!data.transactions.length) {
    const row=element('tr');
    const cell=element('td','empty-row','No matching transactions. Try another month or clear the search.');
    cell.colSpan=5;row.append(cell);target.append(row);return;
  }
  for (const tx of data.transactions) {
    const row=element('tr');
    row.append(element('td','',tx.date));
    const desc=element('td');
    desc.append(element('div','strong',tx.merchant || tx.name));
    if (tx.merchant && tx.name !== tx.merchant) desc.append(element('div','secondary',tx.name));
    if (tx.pending) desc.append(element('span','pending','Pending'));
    row.append(desc);
    row.append(element('td','',names[tx.account_id] || 'Linked account'));
    row.append(element('td','',tx.category.replaceAll('_',' ').toLowerCase()));
    row.append(element('td','right '+(tx.amount_cents > 0 ? 'expense':'income'),
      tx.amount_cents > 0 ? '−'+dollar(tx.amount_cents) : '+'+dollar(Math.abs(tx.amount_cents))));
    target.append(row);
  }
}
async function connect(itemId='') {
  const button=$('connect-btn');
  button.disabled=true;
  try {
    if (!window.Plaid) throw new Error('Plaid Link has not loaded. Check connectivity.');
    const result=await api('/api/plaid/link-token','POST',itemId ? {item_id:itemId} : {});
    const handler=window.Plaid.create({
      token:result.link_token,
      onSuccess:async (publicToken,metadata)=>{
        try {
          if (result.update_mode) {
            await api('/api/sync','POST',{});
          } else {
            await api('/api/plaid/exchange','POST',{
              public_token:publicToken,institution:metadata?.institution?.name || 'Linked institution'});
          }
          message('Bank connection accepted. Account data is being updated.');
          await load();
        } catch { message('Bank linked, but the dashboard could not finish updating. Check updates.'); }
      },
      onExit:(error)=>{if(error) message('Bank linking did not complete.');}
    });
    handler.open();
  } catch(error) {message(error.message || 'Could not start Plaid Link.');}
  finally {button.disabled=false;}
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();
  $('login-message').textContent='';
  const password=$('password').value;
  try {
    const result=await api('/api/login','POST',{password});
    csrf=result.csrf;
    showDashboard();
  } catch { $('login-message').textContent='Invalid passphrase or sign-in temporarily limited.'; }
});
$('logout-btn').addEventListener('click',async()=>{
  try {await api('/api/logout','POST',{});} finally {showLogin();}
});
$('sync-btn').addEventListener('click',async()=>{
  const button=$('sync-btn');
  button.disabled=true;message('Checking Plaid for available updates…');
  try {
    const result=await api('/api/sync','POST',{});
    await load();
    message(result.failed ? result.failed+' institution(s) could not be updated.' : 'Latest Plaid data checked.');
  } catch {message('Could not check for updates.');}
  finally {button.disabled=false;}
});
$('connect-btn').addEventListener('click',()=>connect());
$('empty-connect-btn').addEventListener('click',()=>connect());
$('month').addEventListener('change',()=>load());
$('account-filter').addEventListener('change',()=>load());
$('search').addEventListener('input',()=>{
  clearTimeout(searchTimer);searchTimer=setTimeout(load,250);
});
$('month').value=[new Date().getFullYear(),String(new Date().getMonth()+1).padStart(2,'0')].join('-');
api('/api/session').then(result=>{
  if (result.authenticated) {csrf=result.csrf;showDashboard();}
  else showLogin();
}).catch(()=>showLogin());
