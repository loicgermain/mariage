import { saveData, listenData, loadOnce, isConfigured, onAuthChange, signIn, doSignOut } from './firebase.js';
import { CATS, BUDGETS, GROUPES, DEFAULT_DATA } from './data.js';

let data = JSON.parse(JSON.stringify(DEFAULT_DATA));
let currentTab = 'dashboard', depFilter = 'Tout', invFilter = 'Tous', invStatus = 'Tous';
let invExpanded = null, invSearch = '';
let saveTimer = null, isOnline = false;
let privacyMode = false;

const eur  = n => privacyMode ? '•••' : new Intl.NumberFormat('fr-BE', {style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n);
const eur2 = n => privacyMode ? '•••' : new Intl.NumberFormat('fr-BE', {style:'currency',currency:'EUR',minimumFractionDigits:2,maximumFractionDigits:2}).format(n);

// Échappement pour insérer du texte utilisateur dans les attributs / le HTML
const escAttr = s => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const today = () => new Date().toISOString().slice(0,10);

// ── Sync ─────────────────────────────────────────────────────────────────────
function setSyncBadge(state) {
  const b = document.getElementById('sync-badge');
  if (!b) return;
  const cfg = {
    ok:      {cls:'sync-ok',  html:'✓ Synchronisé'},
    saving:  {cls:'sync-spin',html:'↻ Sauvegarde...'},
    offline: {cls:'sync-err', html:'⚠ Hors ligne'},
    loading: {cls:'sync-spin',html:'↻ Chargement...'},
  };
  const c = cfg[state] || cfg.loading;
  b.className = 'sync-badge ' + c.cls;
  b.textContent = c.html;
}

function scheduleSave() {
  setSyncBadge('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await saveData(data); setSyncBadge('ok'); isOnline = true; }
    catch (e) { setSyncBadge('offline'); }
  }, 800);
}

async function startListening() {
  setSyncBadge('loading');
  listenData(remote => {
    data = remote;
    isOnline = true;
    setSyncBadge('ok');
    render();
  });
  if (!isConfigured) { setSyncBadge('ok'); return; }
  // Première connexion : si la base est vide, on l'amorce avec les données
  // initiales pour que tous les appareils partent du même point.
  try {
    const existing = await loadOnce();
    if (existing === null) await saveData(data);
    setSyncBadge('ok');
    isOnline = true;
  } catch (e) {
    setSyncBadge('offline');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function statut(d) {
  if (d.option) return 'Option';
  if (d.offert) return 'Offert';
  if (d.acompte + d.solde >= d.total && d.total > 0) return 'Soldé';
  if (d.acompte > 0) return 'Acompte payé';
  return 'À payer';
}

function badgeDep(s) {
  const m = {Soldé:'ok','Acompte payé':'warn','À payer':'red',Option:'purple',Offert:'gray'};
  return `<span class="badge b-${m[s]||'gray'}">${s}</span>`;
}

function badgeRsvp(r) {
  if (r === 'Confirmé') return `<span class="badge b-ok">Confirmé</span>`;
  if (r === 'Décliné')  return `<span class="badge b-red">Décliné</span>`;
  return `<span class="badge b-gray">En attente</span>`;
}

function initials(n) {
  return n.split(/[\s&,]+/).filter(Boolean).slice(0,2).map(w => w[0].toUpperCase()).join('');
}

// ── Membres d'un foyer ───────────────────────────────────────────────────────
// Chaque membre : { nom, type:'adulte'|'enfant', statut:'attente'|'confirme'|'decline' }
// Migration à la volée des anciens foyers (qui n'avaient que des compteurs).
function ensureMembres(f) {
  if (Array.isArray(f.membres)) return f.membres;
  const m = [];
  const declined = f.rsvp === 'Décliné';
  const ca = f.rsvp === 'Confirmé' ? (f.confAdultes != null ? f.confAdultes : f.adultes) : 0;
  const ce = f.rsvp === 'Confirmé' ? (f.confEnfants != null ? f.confEnfants : f.enfants) : 0;
  for (let i = 0; i < (f.adultes || 0); i++) m.push({ nom: 'Adulte ' + (i+1), type: 'adulte', statut: declined ? 'decline' : (i < ca ? 'confirme' : 'attente') });
  for (let i = 0; i < (f.enfants || 0); i++) m.push({ nom: 'Enfant ' + (i+1), type: 'enfant', statut: declined ? 'decline' : (i < ce ? 'confirme' : 'attente') });
  f.membres = m;
  return m;
}

function foyerStats(f) {
  const m = ensureMembres(f);
  return {
    total:    m.length,
    confirme: m.filter(x => x.statut === 'confirme').length,
    decline:  m.filter(x => x.statut === 'decline').length,
    attente:  m.filter(x => x.statut === 'attente').length
  };
}

// Statut global du foyer, déduit de ses membres
function foyerRsvp(f) {
  const s = foyerStats(f);
  if (s.total > 0 && s.decline === s.total) return 'Décliné';
  if (s.confirme > 0) return 'Confirmé';
  return 'En attente';
}

const STATUT_MAP = { 'Confirmé': 'confirme', 'En attente': 'attente', 'Décliné': 'decline' };

function calcTotals() {
  const act = data.depenses.filter(d => !d.option && !d.offert);
  return {
    engage:     act.reduce((s,d) => s + d.total, 0),
    paye:       act.reduce((s,d) => s + d.acompte + d.solde, 0),
    reste:      act.reduce((s,d) => s + Math.max(0, d.total - d.acompte - d.solde), 0),
    // Seuls les revenus reçus (avec date) comptent comme argent disponible
    totalRev:   data.revenus.filter(r => r.date).reduce((s,r) => s + r.montant, 0),
    revAttente: data.revenus.filter(r => !r.date).reduce((s,r) => s + r.montant, 0),
    budgetTotal:Object.values(BUDGETS).reduce((a,b) => a + b, 0),
    get solde() { return this.totalRev - this.engage; }
  };
}

function prochains() {
  const today = new Date();
  return data.depenses
    .filter(d => !d.option && !d.offert && d.dateLimite && statut(d) !== 'Soldé')
    .map(d => { const lim = new Date(d.dateLimite); if(lim < today) return null; return {...d, diff: Math.round((lim-today)/86400000), lim}; })
    .filter(Boolean).sort((a,b) => a.lim - b.lim).slice(0,3);
}

// ── Render Dashboard ─────────────────────────────────────────────────────────
function renderDashboard() {
  const t = calcTotals();
  const bycat = {};
  CATS.forEach(c => {
    const ds = data.depenses.filter(d => d.cat === c && !d.option && !d.offert);
    bycat[c] = ds.reduce((s,d) => s + d.total, 0);
  });
  const alerts = prochains().map(d => {
    const r = Math.max(0, d.total - d.acompte - d.solde);
    return `<div class="alert"><span class="alert-icon">⏰</span><div class="alert-txt"><strong>${d.desc}</strong> — ${eur2(r)}<br>${d.diff <= 7 ? '⚠️ ' : ''}Échéance dans ${d.diff}j (${d.dateLimite.split('-').reverse().join('/')})</div></div>`;
  }).join('');
  const rows = CATS.map(c => {
    const bud = BUDGETS[c], eng = bycat[c];
    if (bud === 0 && eng === 0) return '';
    const pct = bud > 0 ? Math.min(eng/bud, 1.2) : 0;
    const cls = bud === 0 ? 'bar-ok' : pct > 1 ? 'bar-over' : pct > 0.85 ? 'bar-warn' : 'bar-ok';
    return `<div class="brow"><span class="bcat">${c}</span><div class="bwrap"><div class="bbar ${cls}" style="width:${Math.min(pct*100,100).toFixed(0)}%"></div></div><span class="bamt">${eur(eng)}/${eur(bud)}</span></div>`;
  }).join('');
  return `
    <div class="hero"><div class="hero-lbl">Reste à dépenser</div><div class="hero-val">${eur(t.solde)}</div><div class="hero-sub">Argent dispo ${eur(t.totalRev)} − Total dépenses ${eur(t.engage)}</div>${t.revAttente > 0 ? `<div class="hero-sub">💰 ${eur(t.revAttente)} en attente (non encore reçus)</div>` : ''}</div>
    <div class="mg"><div class="mc"><div class="ml">Argent dispo</div><div class="mv green">${eur(t.totalRev)}</div></div><div class="mc"><div class="ml">Total dépenses</div><div class="mv purple">${eur(t.engage)}</div></div><div class="mc"><div class="ml">Déjà payé</div><div class="mv green">${eur(t.paye)}</div></div><div class="mc"><div class="ml">Reste à payer</div><div class="mv red">${eur(t.reste)}</div></div></div>
    ${alerts ? `<div class="stitle">Prochains paiements</div>${alerts}` : ''}
    <div class="card"><div class="card-title">Budget par catégorie</div>${rows}</div>
    <button class="btn-primary" id="export-btn" style="background:var(--green)" onclick="exportExcel()">📊 Exporter vers Excel</button>`;
}

// ── Render Dépenses ──────────────────────────────────────────────────────────
function renderDepenses() {
  const chips = ['Tout',...CATS].map(c => `<button class="chip${depFilter===c?' active':''}" onclick="setDepFilter('${c}')">${c}</button>`).join('');
  const list = data.depenses.filter(d => depFilter === 'Tout' || d.cat === depFilter);
  const items = list.map(d => {
    const s = statut(d), r = Math.max(0, d.total - d.acompte - d.solde);
    return `<div class="ditem" onclick="openDepModal(${d.id})"><div><div class="dname">${d.desc}</div><div class="dmeta">${d.cat}</div>${badgeDep(s)}</div><div><div class="damt">${eur2(d.total)}</div>${r > 0 ? `<div class="dreste">reste ${eur2(r)}</div>` : ''}</div></div>`;
  }).join('');
  return `<button class="btn-primary" onclick="openDepModal()">+ Nouvelle dépense</button><div class="frow-chips">${chips}</div><div class="card">${items || '<div class="empty">Aucune dépense</div>'}</div>`;
}

// ── Render Revenus ───────────────────────────────────────────────────────────
function renderRevenus() {
  const total = data.revenus.reduce((s,r) => s + r.montant, 0);
  const recu  = data.revenus.filter(r => r.date).reduce((s,r) => s + r.montant, 0);
  const attente = total - recu;
  const items = data.revenus.map(r => `
    <div class="ritem" onclick="openRevModal(${r.id})">
      <div><div class="rname">${r.source}</div><div class="rmeta">${r.type}</div>${r.date ? '<span class="badge b-ok">Reçu</span>' : '<span class="badge b-warn">En attente</span>'}${r.rem ? ` <span class="badge b-gray">${escHtml(r.rem)}</span>` : ''}</div>
      <div class="rright"><div class="ramt">${eur2(r.montant)}</div>${r.date ? `<div class="rdate">${r.date.split('-').reverse().join('/')}</div>` : ''}</div>
    </div>`).join('');
  return `<button class="btn-primary" onclick="openRevModal()">+ Nouveau revenu</button>
    <div class="mg"><div class="mc"><div class="ml">Total prévu</div><div class="mv">${eur(total)}</div></div><div class="mc"><div class="ml">Reçu</div><div class="mv green">${eur(recu)}</div></div><div class="mc"><div class="ml">En attente</div><div class="mv amber">${eur(attente)}</div></div></div>
    <div class="card">${items || '<div class="empty">Aucun revenu</div>'}</div>`;
}

// ── Render Invités ───────────────────────────────────────────────────────────
function renderInvites() {
  const q = invSearch.toLowerCase();
  const statutF = STATUT_MAP[invStatus];
  const filtered = data.foyers.filter(f =>
    (invFilter === 'Tous' || f.groupe === invFilter) &&
    (invStatus === 'Tous' || ensureMembres(f).some(m => m.statut === statutF)) &&
    (!q || f.nom.toLowerCase().includes(q) || (f.adresse||'').toLowerCase().includes(q)
        || ensureMembres(f).some(m => m.nom.toLowerCase().includes(q)))
  );

  // Compte en personnes, à partir des membres
  const sumPax = (sel, pred) => data.foyers.filter(pred).reduce((s,f) => s + sel(foyerStats(f)), 0);
  const totalPax    = sumPax(s => s.total,    () => true);
  const confPax     = sumPax(s => s.confirme, () => true);
  const attentePax  = sumPax(s => s.attente,  () => true);
  const declinePax  = sumPax(s => s.decline,  () => true);
  const journeeInv  = sumPax(s => s.total,    f => f.moment === 'Journée');
  const soireeInv   = sumPax(s => s.total,    f => f.moment === 'Soirée');
  const journeeConf = sumPax(s => s.confirme, f => f.moment === 'Journée');
  const soireeConf  = sumPax(s => s.confirme, f => f.moment === 'Soirée');

  const statCard = (status, label, val, color) =>
    `<div class="mc mc-click${invStatus===status?' mc-active':''}" onclick="setInvStatus('${status}')"><div class="ml">${label}</div><div class="mv ${color}">${val}</div></div>`;

  const chips = ['Tous',...GROUPES].map(g => `<button class="chip${invFilter===g?' active':''}" onclick="setInvFilter('${g}')">${g}</button>`).join('');
  const cards = filtered.map(f => {
    const s = foyerStats(f);
    const breakdown = [s.confirme ? `<span style="color:var(--green)">✓${s.confirme}</span>` : '', s.attente ? `<span style="color:var(--amber)">?${s.attente}</span>` : '', s.decline ? `<span style="color:var(--red)">✗${s.decline}</span>` : ''].filter(Boolean).join(' ');
    return `<div class="fcard">
      <div class="fhdr" onclick="toggleFoyer(${f.id})">
        <div class="avatar">${initials(f.nom)}</div>
        <div class="finfo"><div class="fname">${f.nom}</div><div class="fmeta">${f.groupe} · ${s.total} pers. · ${breakdown}</div></div>
        <div class="fright">${badgeRsvp(foyerRsvp(f))}<span class="badge b-purple">${f.moment}</span></div>
      </div>
      ${invExpanded === f.id ? renderFoyerExpand(f) : ''}
    </div>`;
  }).join('');

  return `<button class="btn-primary" onclick="addFoyer()">+ Nouveau foyer</button>
    <div class="mg">
      ${statCard('Tous','Invités',totalPax,'purple')}
      ${statCard('Confirmé','Confirmés',confPax,'green')}
      ${statCard('En attente','En attente',attentePax,'amber')}
      ${statCard('Décliné','Déclinés',declinePax,'red')}
    </div>
    <div class="card" style="display:flex;gap:12px;text-align:center;align-items:center">
      <div style="flex:1"><div class="ml">☀️ Journée</div><div class="mv">${journeeInv}</div><div style="font-size:11px;color:var(--green)">✓ ${journeeConf} confirmés</div></div>
      <div style="width:1px;align-self:stretch;background:var(--border)"></div>
      <div style="flex:1"><div class="ml">🌙 Soirée</div><div class="mv">${soireeInv}</div><div style="font-size:11px;color:var(--green)">✓ ${soireeConf} confirmés</div></div>
    </div>
    ${invStatus !== 'Tous' ? `<div class="stitle">Filtré : ${invStatus} · <span onclick="setInvStatus('Tous')" style="cursor:pointer;color:var(--purple)">tout afficher</span></div>` : ''}
    <div class="search-wrap"><span class="si">🔍</span><input type="text" placeholder="Rechercher un foyer ou une personne..." value="${escAttr(invSearch)}" oninput="onInvSearch(this.value)"></div>
    <div class="frow-chips">${chips}</div>
    ${cards || '<div class="empty">Aucun foyer trouvé</div>'}`;
}

function renderFoyerExpand(f) {
  const membres = ensureMembres(f);
  const seg = (statut) => `<div class="seg">
      <button type="button" class="seg-b sb-a${statut==='attente'?' on':''}" onclick="setMbr(this,'attente')" title="En attente">?</button>
      <button type="button" class="seg-b sb-c${statut==='confirme'?' on':''}" onclick="setMbr(this,'confirme')" title="Confirmé">✓</button>
      <button type="button" class="seg-b sb-d${statut==='decline'?' on':''}" onclick="setMbr(this,'decline')" title="Décliné">✗</button>
    </div>`;
  const mbrRow = (m) => `<div class="mbr" data-statut="${m.statut}" data-type="${m.type}">
      <input class="mbr-nom" value="${escAttr(m.nom)}" placeholder="${m.type==='enfant'?'Enfant':'Nom'}">
      ${seg(m.statut)}
      <button type="button" class="mbr-del" onclick="delMbr(this)" title="Retirer">🗑</button>
    </div>`;
  return `<div class="expand">
    <div class="slbl">Informations</div>
    <div class="fgrid">
      <div class="fi full"><label>Nom du foyer</label><input id="fn-${f.id}" value="${escAttr(f.nom)}"></div>
      <div class="fi"><label>Groupe</label><select id="fg-${f.id}">${GROUPES.map(g=>`<option${f.groupe===g?' selected':''}>${g}</option>`).join('')}</select></div>
      <div class="fi"><label>Moment</label><select id="fm-${f.id}"><option${f.moment==='Journée'?' selected':''}>Journée</option><option${f.moment==='Soirée'?' selected':''}>Soirée</option></select></div>
    </div>
    <div class="slbl">Membres &amp; présence</div>
    <div id="mlist-${f.id}">${membres.map(mbrRow).join('')}</div>
    <div class="mbr-actions">
      <button type="button" class="btn-sec" onclick="addMbr(${f.id},'adulte')">+ Adulte</button>
      <button type="button" class="btn-sec" onclick="addMbr(${f.id},'enfant')">+ Enfant</button>
      <button type="button" class="btn-sec" onclick="allMbr(${f.id},'confirme')">✓ Tous</button>
      <button type="button" class="btn-sec" onclick="allMbr(${f.id},'decline')">✗ Tous</button>
    </div>
    <div class="slbl">Contact</div>
    <div class="fgrid">
      <div class="fi full"><label>Adresse postale</label><textarea id="fadr-${f.id}" placeholder="Rue, code postal, ville">${escHtml(f.adresse||'')}</textarea></div>
      <div class="fi full"><label>Remarque</label><input id="frem-${f.id}" type="text" value="${escAttr(f.rem||'')}" placeholder="Optionnel..."></div>
    </div>
    <div class="btn-row">
      <button class="btn-del" onclick="deleteFoyer(${f.id})">🗑 Supprimer</button>
      <button class="btn-save" onclick="saveFoyer(${f.id})">Enregistrer</button>
    </div>
  </div>`;
}

// ── Actions ──────────────────────────────────────────────────────────────────
window.setDepFilter = f => { depFilter = f; render(); };
window.setInvFilter = f => { invFilter = f; render(); };
window.setInvStatus = s => { invStatus = (invStatus === s ? 'Tous' : s); render(); };
window.toggleFoyer  = id => { invExpanded = invExpanded === id ? null : id; render(); };

// Recherche : on re-rend puis on restaure le focus + le curseur (sinon on perd
// le focus à chaque frappe et on ne peut taper qu'un seul caractère).
window.onInvSearch = (val) => {
  invSearch = val;
  render();
  const el = document.querySelector('.search-wrap input');
  if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); }
};

// ── Membres d'un foyer (édition DOM, sauvegardée via « Enregistrer ») ─────────
const SEG_CLS = { attente: 'sb-a', confirme: 'sb-c', decline: 'sb-d' };

window.setMbr = (btn, statut) => {
  const row = btn.closest('.mbr');
  row.dataset.statut = statut;
  row.querySelectorAll('.seg-b').forEach(b => b.classList.remove('on'));
  const active = row.querySelector('.' + SEG_CLS[statut]);
  if (active) active.classList.add('on');
};

window.delMbr = (btn) => { btn.closest('.mbr').remove(); };

window.addMbr = (foyerId, type) => {
  const list = document.getElementById('mlist-' + foyerId);
  if (!list) return;
  const n = list.querySelectorAll(`.mbr[data-type="${type}"]`).length + 1;
  const row = document.createElement('div');
  row.className = 'mbr';
  row.dataset.statut = 'attente';
  row.dataset.type = type;
  row.innerHTML = `<input class="mbr-nom" value="${(type === 'enfant' ? 'Enfant ' : 'Adulte ') + n}" placeholder="Nom">
    <div class="seg">
      <button type="button" class="seg-b sb-a on" onclick="setMbr(this,'attente')" title="En attente">?</button>
      <button type="button" class="seg-b sb-c" onclick="setMbr(this,'confirme')" title="Confirmé">✓</button>
      <button type="button" class="seg-b sb-d" onclick="setMbr(this,'decline')" title="Décliné">✗</button>
    </div>
    <button type="button" class="mbr-del" onclick="delMbr(this)" title="Retirer">🗑</button>`;
  list.appendChild(row);
};

window.allMbr = (foyerId, statut) => {
  const list = document.getElementById('mlist-' + foyerId);
  if (!list) return;
  list.querySelectorAll('.mbr').forEach(row => {
    const b = row.querySelector('.' + SEG_CLS[statut]);
    if (b) window.setMbr(b, statut);
  });
};

window.saveFoyer = id => {
  const f = data.foyers.find(x => x.id === id); if (!f) return;
  f.nom    = document.getElementById(`fn-${id}`).value.trim() || f.nom;
  f.groupe = document.getElementById(`fg-${id}`).value;
  f.moment = document.getElementById(`fm-${id}`).value;
  const rows = document.querySelectorAll(`#mlist-${id} .mbr`);
  f.membres = Array.from(rows).map(row => ({
    nom: row.querySelector('.mbr-nom').value.trim() || (row.dataset.type === 'enfant' ? 'Enfant' : 'Adulte'),
    type: row.dataset.type === 'enfant' ? 'enfant' : 'adulte',
    statut: row.dataset.statut || 'attente'
  }));
  // Compteurs dérivés (rétro-compat + export Excel)
  f.adultes     = f.membres.filter(m => m.type === 'adulte').length;
  f.enfants     = f.membres.filter(m => m.type === 'enfant').length;
  f.confAdultes = f.membres.filter(m => m.type === 'adulte' && m.statut === 'confirme').length;
  f.confEnfants = f.membres.filter(m => m.type === 'enfant' && m.statut === 'confirme').length;
  f.rsvp        = foyerRsvp(f);
  f.adresse = document.getElementById(`fadr-${id}`).value;
  f.rem     = document.getElementById(`frem-${id}`).value;
  invExpanded = null; render(); scheduleSave();
};

window.deleteFoyer = id => {
  if (!confirm('Supprimer ce foyer ?')) return;
  data.foyers = data.foyers.filter(f => f.id !== id);
  invExpanded = null; render(); scheduleSave();
};

window.addFoyer = () => {
  const newId = Math.max(0, ...data.foyers.map(f => f.id)) + 1;
  data.foyers.unshift({id:newId,nom:"Nouveau foyer",groupe:"Amis Caro",moment:"Journée",adultes:2,enfants:0,rsvp:"En attente",confAdultes:null,confEnfants:null,adresse:"",rem:"",
    membres:[{nom:"Adulte 1",type:"adulte",statut:"attente"},{nom:"Adulte 2",type:"adulte",statut:"attente"}]});
  invExpanded = newId; invFilter = 'Tous'; invStatus = 'Tous'; invSearch = '';
  render();
  setTimeout(() => { const el = document.getElementById(`fn-${newId}`); if (el) { el.focus(); el.select(); } }, 60);
};

window.closeModal = () => { document.getElementById('modal-root').innerHTML = ''; };

// ── Export Excel ─────────────────────────────────────────────────────────────
window.exportExcel = async () => {
  const btn = document.getElementById('export-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération...'; }
  try {
    const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
    const wb = XLSX.utils.book_new();

    const dep = data.depenses.map(d => ({
      Description: d.desc,
      Catégorie: d.cat,
      'Montant total (€)': d.total,
      'Acompte payé (€)': d.acompte,
      'Solde payé (€)': d.solde,
      'Reste à payer (€)': Math.max(0, d.total - d.acompte - d.solde),
      Statut: statut(d),
      'Date limite': d.dateLimite,
      Remarque: d.rem
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dep), 'Dépenses');

    const rev = data.revenus.map(r => ({
      Source: r.source,
      Type: r.type,
      'Montant (€)': r.montant,
      'Date réception': r.date,
      Reçu: r.date ? 'Oui' : 'Non',
      Remarque: r.rem
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rev), 'Revenus');

    const inv = data.foyers.map(f => {
      const m = ensureMembres(f);
      const st = foyerStats(f);
      return {
        Foyer: f.nom,
        Groupe: f.groupe,
        Moment: f.moment,
        'Personnes invitées': st.total,
        RSVP: foyerRsvp(f),
        Confirmés: st.confirme,
        'En attente': st.attente,
        Déclinés: st.decline,
        Membres: m.map(x => `${x.nom} (${x.statut === 'confirme' ? '✓' : x.statut === 'decline' ? '✗' : '?'})`).join(', '),
        Adresse: f.adresse,
        Remarque: f.rem
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(inv), 'Invités');

    XLSX.writeFile(wb, `mariage-${today()}.xlsx`);
  } catch (e) {
    alert("Échec de l'export. Vérifiez votre connexion internet et réessayez.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📊 Exporter vers Excel'; }
  }
};

window.openDepModal = (id = null) => {
  const d = id !== null ? data.depenses.find(x => x.id === id) : null;
  const cats = CATS.map(c => `<option${d && d.cat === c ? ' selected' : ''}>${c}</option>`).join('');
  document.getElementById('modal-root').innerHTML = `<div class="mbg"><div class="modal">
    <div class="mtitle">${d ? 'Modifier la dépense' : 'Nouvelle dépense'} <button onclick="closeModal()" class="mclose">✕</button></div>
    <div class="mf"><label>Description</label><input id="md" type="text" placeholder="Ex: DJ soirée" value="${d ? escAttr(d.desc) : ''}"></div>
    <div class="mf"><label>Catégorie</label><select id="mc">${cats}</select></div>
    <div class="mf"><label>Montant total (€)</label><input id="mt" type="number" step="0.01" placeholder="0.00" value="${d ? d.total : ''}"></div>
    <div class="mf"><label>Acompte payé (€)</label><input id="ma" type="number" step="0.01" value="${d ? d.acompte : 0}"></div>
    <div class="mf"><label>Solde payé (€)</label><input id="ms" type="number" step="0.01" value="${d ? d.solde : 0}"></div>
    <button type="button" class="btn-sec" style="width:100%;margin-bottom:12px" onclick="markSolde()">✓ Marquer comme entièrement payé</button>
    <div class="mf"><label>Date limite</label><input id="ml" type="date" value="${d ? d.dateLimite : ''}"></div>
    <div class="mf"><label>Remarque</label><textarea id="mr">${d ? escHtml(d.rem) : ''}</textarea></div>
    <div class="mcheck"><label><input type="checkbox" id="mop"${d && d.option ? ' checked' : ''}> Option</label><label><input type="checkbox" id="mof"${d && d.offert ? ' checked' : ''}> Offert</label></div>
    <div class="btn-row">
      ${d ? `<button class="btn-del" onclick="deleteDep(${d.id})">🗑 Supprimer</button>` : `<button class="btn-sec" onclick="closeModal()">Annuler</button>`}
      <button class="btn-save" onclick="saveDep(${d ? d.id : 'null'})">Enregistrer</button>
    </div>
  </div></div>`;
};

window.markSolde = () => {
  const total = parseFloat(document.getElementById('mt').value) || 0;
  const acompte = parseFloat(document.getElementById('ma').value) || 0;
  document.getElementById('ms').value = Math.max(0, +(total - acompte).toFixed(2));
};

window.saveDep = (id) => {
  const desc = document.getElementById('md').value.trim(); if (!desc) return;
  const fields = {
    desc,
    cat: document.getElementById('mc').value,
    option: document.getElementById('mop').checked,
    offert: document.getElementById('mof').checked,
    total: parseFloat(document.getElementById('mt').value) || 0,
    acompte: parseFloat(document.getElementById('ma').value) || 0,
    solde: parseFloat(document.getElementById('ms').value) || 0,
    dateLimite: document.getElementById('ml').value || '',
    rem: document.getElementById('mr').value
  };
  if (id === null) {
    const newId = Math.max(0, ...data.depenses.map(d => d.id)) + 1;
    data.depenses.push({ id: newId, ...fields });
  } else {
    const d = data.depenses.find(x => x.id === id);
    if (d) Object.assign(d, fields);
  }
  closeModal(); render(); scheduleSave();
};

window.deleteDep = (id) => {
  if (!confirm('Supprimer cette dépense ?')) return;
  data.depenses = data.depenses.filter(d => d.id !== id);
  closeModal(); render(); scheduleSave();
};

window.openRevModal = (id = null) => {
  const r = id !== null ? data.revenus.find(x => x.id === id) : null;
  const types = ['Épargne', 'Contribution famille', 'Liste de mariage', 'Autre'];
  const typeOpts = types.map(t => `<option${r && r.type === t ? ' selected' : ''}>${t}</option>`).join('');
  const recu = !!(r && r.date);
  document.getElementById('modal-root').innerHTML = `<div class="mbg"><div class="modal">
    <div class="mtitle">${r ? 'Modifier le revenu' : 'Nouveau revenu'} <button onclick="closeModal()" class="mclose">✕</button></div>
    <div class="mf"><label>Source</label><input id="rs" type="text" placeholder="Ex: Cadeau tante Marie" value="${r ? escAttr(r.source) : ''}"></div>
    <div class="mf"><label>Type</label><select id="rt">${typeOpts}</select></div>
    <div class="mf"><label>Montant (€)</label><input id="rm" type="number" step="0.01" placeholder="0.00" value="${r ? r.montant : ''}"></div>
    <div class="mf"><label>Statut</label><select id="rstatus" onchange="toggleRevDate(this.value)">
      <option${!recu ? ' selected' : ''}>En attente</option>
      <option${recu ? ' selected' : ''}>Reçu</option>
    </select></div>
    <div class="mf" id="rd-row" style="${recu ? '' : 'display:none'}"><label>Date de réception</label><input id="rd" type="date" value="${r ? r.date : ''}"></div>
    <div class="mf"><label>Remarque</label><input id="rr" type="text" placeholder="Optionnel..." value="${r ? escAttr(r.rem) : ''}"></div>
    <div class="btn-row">
      ${r ? `<button class="btn-del" onclick="deleteRev(${r.id})">🗑 Supprimer</button>` : `<button class="btn-sec" onclick="closeModal()">Annuler</button>`}
      <button class="btn-save" onclick="saveRev(${r ? r.id : 'null'})">Enregistrer</button>
    </div>
  </div></div>`;
};

window.toggleRevDate = (val) => {
  const row = document.getElementById('rd-row');
  const rd = document.getElementById('rd');
  if (val === 'Reçu') { row.style.display = ''; if (!rd.value) rd.value = today(); }
  else { row.style.display = 'none'; }
};

window.saveRev = (id) => {
  const src = document.getElementById('rs').value.trim(); if (!src) return;
  const recu = document.getElementById('rstatus').value === 'Reçu';
  let date = document.getElementById('rd').value || '';
  if (!recu) date = '';
  else if (!date) date = today();
  const fields = {
    source: src,
    type: document.getElementById('rt').value,
    montant: parseFloat(document.getElementById('rm').value) || 0,
    date: date,
    rem: document.getElementById('rr').value
  };
  if (id === null) {
    const newId = Math.max(0, ...data.revenus.map(r => r.id)) + 1;
    data.revenus.push({ id: newId, ...fields });
  } else {
    const r = data.revenus.find(x => x.id === id);
    if (r) Object.assign(r, fields);
  }
  closeModal(); render(); scheduleSave();
};

window.deleteRev = (id) => {
  if (!confirm('Supprimer ce revenu ?')) return;
  data.revenus = data.revenus.filter(r => r.id !== id);
  closeModal(); render(); scheduleSave();
};

// ── Authentification UI ──────────────────────────────────────────────────────
function showLogin(msg) {
  document.body.classList.add('locked');
  document.getElementById('content').innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <div class="login-title">💍 Loïc &amp; Caro</div>
        <div class="login-sub">Accès réservé aux mariés</div>
        <div class="mf"><label>Email</label><input id="login-email" type="email" autocomplete="username" inputmode="email"></div>
        <div class="mf"><label>Mot de passe</label><input id="login-pw" type="password" autocomplete="current-password"></div>
        ${msg ? `<div class="login-err">${msg}</div>` : ''}
        <button class="btn-save" style="width:100%;padding:12px" id="login-btn" onclick="doLogin()">Se connecter</button>
      </div>
    </div>`;
  const pw = document.getElementById('login-pw');
  if (pw) pw.addEventListener('keydown', e => { if (e.key === 'Enter') window.doLogin(); });
  setSyncBadge('offline');
}

window.doLogin = async () => {
  const email = document.getElementById('login-email').value.trim();
  const pw = document.getElementById('login-pw').value;
  if (!email || !pw) return;
  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Connexion...'; }
  try {
    await signIn(email, pw);
    // onAuthChange se déclenchera et chargera l'app
  } catch (e) {
    showLogin('Email ou mot de passe incorrect.');
  }
};

window.doLogout = async () => {
  if (!confirm('Se déconnecter ?')) return;
  await doSignOut();
};

window.togglePrivacy = () => {
  privacyMode = !privacyMode;
  const btn = document.getElementById('privacy-btn');
  if (btn) btn.textContent = privacyMode ? '🙈' : '👁';
  render();
};

window.show = tab => {
  currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('nav-' + tab).classList.add('active');
  document.getElementById('topbar-sub').textContent = {dashboard:'Budget mariage',depenses:'Dépenses',revenus:'Revenus & contributions',invites:'Invités'}[tab];
  render();
};

function render() {
  const c = document.getElementById('content');
  if (currentTab === 'dashboard') c.innerHTML = renderDashboard();
  else if (currentTab === 'depenses') c.innerHTML = renderDepenses();
  else if (currentTab === 'revenus') c.innerHTML = renderRevenus();
  else if (currentTab === 'invites') c.innerHTML = renderInvites();
}

// ── Init ─────────────────────────────────────────────────────────────────────
// Service worker + mise à jour automatique : dès qu'une nouvelle version est
// déployée, l'app la récupère et se recharge toute seule (plus besoin de vider
// le cache à la main).
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then(reg => {
    // Vérifie les mises à jour à chaque ouverture et périodiquement
    reg.update();
    setInterval(() => reg.update(), 60 * 60 * 1000);
  });
}

onAuthChange(user => {
  if (user) {
    document.body.classList.remove('locked');
    render();
    startListening();
  } else {
    showLogin();
  }
});
