import { saveData, listenData, loadOnce, isConfigured, onAuthChange, signIn, doSignOut } from './firebase.js';
import { CATS, BUDGETS, GROUPES, REGIMES, ALLERGENES, DEFAULT_DATA } from './data.js';

let data = JSON.parse(JSON.stringify(DEFAULT_DATA));
// Onglets valides. Sert aussi à restaurer l'onglet actif après un rafraîchissement
// (pull-to-refresh) : sans ça l'app revenait toujours au dashboard au rechargement.
const TABS = ['dashboard', 'depenses', 'echeancier', 'revenus', 'invites'];
let currentTab = 'dashboard', depFilter = 'Tout', invFilter = 'Tous', invStatus = 'Tous';
try { const t = localStorage.getItem('currentTab'); if (TABS.includes(t)) currentTab = t; } catch {}
let invExpanded = null, invSearch = '';
let depSort = 'echeance', revSort = 'date';
let epVirExpanded = false;   // carte virement auto
let epSoldeExpanded = null;  // null = auto : déplié tant que le solde n'est pas saisi
let dashPaiementsExpanded = false;  // dashboard : « Prochains paiements » replié par défaut
let cashChartExpanded = true;  // échéancier : courbe de trésorerie dépliée par défaut
let cashChartData = null;  // points précalculés du dernier render, pour l'interaction tactile/souris
let planningView = 'paiements';  // échéancier : bascule Paiements / Tâches
let allergieModalRow = null;  // ligne .mbr en cours d'édition dans la modale allergies/régime
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
    saveTimer = null;
    try { await saveData(data); setSyncBadge('ok'); isOnline = true; }
    catch (e) { setSyncBadge('offline'); }
  }, 800);
}

// Applique une mise à jour distante, sauf si on a des modifications locales en
// cours : une sauvegarde en attente (saveTimer) ou un foyer ouvert en édition.
// Sans ce garde, le snapshot temps réel écraserait la saisie de l'utilisateur.
function applyRemote(remote) {
  if (saveTimer || invExpanded !== null) return;
  data = remote;
  isOnline = true;
  setSyncBadge('ok');
  render();
}

async function startListening() {
  setSyncBadge('loading');
  listenData(applyRemote);
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
  if (d.caution) return 'Caution';
  if (d.acompte + d.solde >= d.total && d.total > 0) return 'Soldé';
  if (d.acompte > 0) return 'Acompte payé';
  return 'À payer';
}

function badgeDep(s) {
  const m = {Soldé:'ok','Acompte payé':'warn','À payer':'red',Option:'purple',Offert:'gray',Caution:'amber'};
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
// Découpe le nom d'un foyer en prénoms : "Laura, Gaëtan & Lise" → [Laura, Gaëtan, Lise]
function nameTokens(nom) {
  return String(nom || '').split(/\s*[,&]\s*/).map(s => s.trim()).filter(Boolean);
}
const isGenericName = n => !n || /^Adulte \d+$/.test(n) || /^Enfant \d+$/.test(n);

function ensureMembres(f) {
  if (!Array.isArray(f.membres)) {
    const declined = f.rsvp === 'Décliné';
    const ca = f.rsvp === 'Confirmé' ? (f.confAdultes != null ? f.confAdultes : f.adultes) : 0;
    const ce = f.rsvp === 'Confirmé' ? (f.confEnfants != null ? f.confEnfants : f.enfants) : 0;
    const m = [];
    for (let i = 0; i < (f.adultes || 0); i++) m.push({ nom: '', type: 'adulte', statut: declined ? 'decline' : (i < ca ? 'confirme' : 'attente') });
    for (let i = 0; i < (f.enfants || 0); i++) m.push({ nom: '', type: 'enfant', statut: declined ? 'decline' : (i < ce ? 'confirme' : 'attente') });
    f.membres = m;
  }
  // Déduit les prénoms à partir du nom du foyer pour les membres encore génériques
  // (on ne touche pas au foyer placeholder ni aux noms déjà personnalisés).
  if (f.nom && f.nom !== 'Nouveau foyer') {
    const names = nameTokens(f.nom);
    let ai = 0, ei = 0;
    f.membres.forEach((mb, i) => {
      const ord = mb.type === 'enfant' ? ++ei : ++ai;
      if (isGenericName(mb.nom)) mb.nom = names[i] || (mb.type === 'enfant' ? 'Enfant ' + ord : 'Adulte ' + ord);
    });
  } else {
    // Foyer placeholder : garde des libellés génériques lisibles
    let ai = 0, ei = 0;
    f.membres.forEach(mb => {
      const ord = mb.type === 'enfant' ? ++ei : ++ai;
      if (!mb.nom) mb.nom = mb.type === 'enfant' ? 'Enfant ' + ord : 'Adulte ' + ord;
    });
  }
  return f.membres;
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

// ── Épargne ────────────────────────────────────────────────────────────────
// L'épargne est le SOLDE RÉEL du compte mariage (acomptes déjà payés déjà
// déduits) + une projection des mensualités à venir jusqu'au mariage. Elle est
// gérée à part des revenus (cadeaux/contributions), qui restent dans data.revenus.
function ensureEpargne() {
  if (!data.epargne || typeof data.epargne !== 'object')
    data.epargne = { solde: 0, mensuel: 300, actif: true, dateDebut: '', dateMariage: '2027-07-10' };
  if (data.epargne.actif === undefined) data.epargne.actif = true;
  if (data.epargne.dateDebut === undefined) data.epargne.dateDebut = '';
  return data.epargne;
}

function nextMonthStr() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Nombre de mensualités restantes entre aujourd'hui et la date du mariage.
function moisRestants(dateMariage) {
  if (!dateMariage) return 0;
  const w = new Date(dateMariage), n = new Date();
  let m = (w.getFullYear() - n.getFullYear()) * 12 + (w.getMonth() - n.getMonth());
  if (w.getDate() < n.getDate()) m -= 1; // mois entamé non compté
  return Math.max(0, m);
}

function calcTotals() {
  const e = ensureEpargne();
  const act = data.depenses.filter(d => !d.option && !d.offert && !d.caution);
  const engage = act.reduce((s,d) => s + d.total, 0);
  const paye   = act.reduce((s,d) => s + d.acompte + d.solde, 0);
  const reste  = act.reduce((s,d) => s + Math.max(0, d.total - d.acompte - d.solde), 0);
  // Dons/contributions : tout sauf l'ancien type « Épargne » (désormais géré à part)
  const dons = data.revenus.filter(r => r.type !== 'Épargne');
  const donsRecus  = dons.filter(r => r.date).reduce((s,r) => s + r.montant, 0);
  const donsAVenir = dons.filter(r => !r.date).reduce((s,r) => s + r.montant, 0);
  const mois = moisRestants(e.dateMariage);
  const epargneAVenir = (e.actif !== false) ? (e.mensuel || 0) * mois : 0;
  const dispo  = (e.solde || 0) + donsRecus;     // argent disponible aujourd'hui
  const aVenir = epargneAVenir + donsAVenir;      // entrées à venir d'ici le mariage
  return {
    engage, paye, reste,
    compte: e.solde || 0, donsRecus, donsAVenir, epargneAVenir,
    mois, mensuel: e.mensuel || 0,
    dispo, aVenir,
    soldeJourJ: dispo + aVenir - reste,           // ce qu'il restera le jour J
    budgetTotal: Object.values(BUDGETS).reduce((a,b) => a + b, 0)
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
    const ds = data.depenses.filter(d => d.cat === c && !d.option && !d.offert && !d.caution);
    bycat[c] = ds.reduce((s,d) => s + d.total, 0);
  });
  const prox = prochains();
  const proxTotal = prox.reduce((s,d) => s + Math.max(0, d.total - d.acompte - d.solde), 0);
  const alertsList = prox.map(d => {
    const r = Math.max(0, d.total - d.acompte - d.solde);
    return `<div class="alert"><span class="alert-icon">⏰</span><div class="alert-txt"><strong>${d.desc}</strong> — ${eur2(r)}<br>${d.diff <= 7 ? '⚠️ ' : ''}Échéance dans ${d.diff}j (${d.dateLimite.split('-').reverse().join('/')})</div></div>`;
  }).join('');
  const paiements = !prox.length ? '' : (dashPaiementsExpanded
    ? `<div class="stitle mc-click" onclick="toggleDashPaiements()" style="display:flex;justify-content:space-between;align-items:baseline;cursor:pointer"><span>Prochains paiements</span><span style="color:var(--purple-dark);font-weight:600;text-transform:none;letter-spacing:0">Replier ▲</span></div>${alertsList}`
    : (() => {
        const n = prox[0];
        const nDate = n.dateLimite.split('-').reverse().join('/');
        return `<div class="card mc-click" style="display:flex;align-items:center;gap:10px" onclick="toggleDashPaiements()"><span style="font-size:16px">⏰</span><div style="flex:1;min-width:0"><div style="font-size:13px"><strong>Prochains paiements</strong> <span style="color:var(--text-sec)">· ${prox.length}</span></div><div style="font-size:11px;color:var(--text-sec)">${n.diff <= 7 ? '⚠️ ' : ''}Prochain le ${nDate} (dans ${n.diff}j)</div></div><div style="font-size:13px;color:var(--purple-dark);font-weight:600;flex-shrink:0">${eur(proxTotal)} ▾</div></div>`;
      })());
  const rows = CATS.map(c => {
    const bud = BUDGETS[c], eng = bycat[c];
    if (bud === 0 && eng === 0) return '';
    const pct = bud > 0 ? Math.min(eng/bud, 1.2) : 0;
    const cls = bud === 0 ? 'bar-ok' : pct > 1 ? 'bar-over' : pct > 0.85 ? 'bar-warn' : 'bar-ok';
    return `<div class="brow"><span class="bcat">${c}</span><div class="bwrap"><div class="bbar ${cls}" style="width:${Math.min(pct*100,100).toFixed(0)}%"></div></div><span class="bamt">${eur(eng)}/${eur(bud)}</span></div>`;
  }).join('');
  return `
    <div class="mg"><div class="mc"><div class="ml">Économies actuelles</div><div class="mv green">${eur(t.compte)}</div></div><div class="mc"><div class="ml">Déjà payé</div><div class="mv purple">${eur(t.paye)}</div></div><div class="mc"><div class="ml">Coût total actuel</div><div class="mv">${eur(t.engage)}</div></div><div class="mc"><div class="ml">Reste à payer</div><div class="mv red">${eur(t.reste)}</div></div></div>
    ${paiements}
    <div class="card"><div class="card-title">Budget par catégorie</div>${rows}</div>
    <button class="btn-primary" id="export-finances-btn" style="background:var(--green)" onclick="exportFinances()">📊 Exporter finances</button>`;
}

// ── Tri ──────────────────────────────────────────────────────────────────────
const reste = d => Math.max(0, d.total - d.acompte - d.solde);

function sortDepenses(list) {
  const arr = [...list];
  if (depSort === 'montant')   arr.sort((a, b) => b.total - a.total);
  else if (depSort === 'reste')arr.sort((a, b) => reste(b) - reste(a));
  else if (depSort === 'cat')  arr.sort((a, b) => CATS.indexOf(a.cat) - CATS.indexOf(b.cat));
  else arr.sort((a, b) => (a.dateLimite || '9999-99-99').localeCompare(b.dateLimite || '9999-99-99')); // échéance
  return arr;
}

function sortRevenus(list) {
  const arr = [...list];
  if (revSort === 'montant')      arr.sort((a, b) => b.montant - a.montant);
  else if (revSort === 'statut')  arr.sort((a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1));
  else arr.sort((a, b) => (b.date || '').localeCompare(a.date || '')); // date : reçus récents puis en attente
  return arr;
}

const sortSelect = (id, val, opts) =>
  `<div class="sortbar"><label>Trier&nbsp;:</label><select onchange="${id}(this.value)">${
    opts.map(([v, lbl]) => `<option value="${v}"${val === v ? ' selected' : ''}>${lbl}</option>`).join('')
  }</select></div>`;

// ── Render Dépenses ──────────────────────────────────────────────────────────
function renderDepenses() {
  const chips = ['Tout',...CATS].map(c => `<button class="chip${depFilter===c?' active':''}" onclick="setDepFilter('${c}')">${c}</button>`).join('');
  const list = sortDepenses(data.depenses.filter(d => depFilter === 'Tout' || d.cat === depFilter));
  const items = list.map(d => {
    const s = statut(d), r = reste(d);
    return `<div class="ditem" onclick="openDepModal(${d.id})"><div><div class="dname">${d.desc}</div><div class="dmeta">${d.cat}</div>${badgeDep(s)}</div><div><div class="damt">${eur2(d.total)}</div>${r > 0 ? `<div class="dreste">reste ${eur2(r)}</div>` : ''}</div></div>`;
  }).join('');
  const sort = sortSelect('setDepSort', depSort, [['echeance','Échéance la plus proche'],['montant','Montant (décroissant)'],['reste','Reste à payer (décroissant)'],['cat','Catégorie']]);
  return `<button class="btn-primary" onclick="openDepModal()">+ Nouvelle dépense</button><div class="frow-chips">${chips}</div>${sort}<div class="card">${items || '<div class="empty">Aucune dépense</div>'}</div>`;
}

// ── Render Échéancier ────────────────────────────────────────────────────────
const MOIS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const MOIS_ABR = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
function moisLabel(ym) {
  const [y, m] = ym.split('-');
  return `${MOIS_FR[+m - 1]} ${y}`.replace(/^./, c => c.toUpperCase());
}
function moisLabelShort(ym) {
  const [y, m] = ym.split('-');
  return `${MOIS_ABR[+m - 1]} ${y.slice(2)}`;
}

// Liste de `count+1` mois (YYYY-MM) en partant de `startYM` inclus.
function monthsFrom(startYM, count) {
  const [y0, m0] = startYM.split('-').map(Number);
  const out = [];
  for (let i = 0; i <= count; i++) {
    const d = new Date(y0, m0 - 1 + i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// Projection du solde disponible mois par mois jusqu'au mariage : solde du
// compte + dons déjà reçus au départ, puis chaque mois +virement auto (si actif)
// -dépenses dues ce mois-là ; dons à venir et dépenses sans date lissés au
// dernier mois. Le dernier point égale toujours calcTotals().soldeJourJ.
function cashProjection() {
  const e = ensureEpargne();
  const mois = moisRestants(e.dateMariage);
  if (!e.dateMariage || mois < 1) return null;

  const curYM = today().slice(0, 7);
  const months = monthsFrom(curYM, mois);
  const actif = e.actif !== false;
  const mensuel = e.mensuel || 0;

  const dons = data.revenus.filter(r => r.type !== 'Épargne');
  const donsRecus  = dons.filter(r => r.date).reduce((s, r) => s + r.montant, 0);
  const donsAVenir = dons.filter(r => !r.date).reduce((s, r) => s + r.montant, 0);

  const actDep = data.depenses.filter(d => !d.option && !d.offert && !d.caution && reste(d) > 0);
  const parMois = {};
  let sansDateTotal = 0;
  actDep.forEach(d => {
    if (d.dateLimite) { const ym = d.dateLimite.slice(0, 7); parMois[ym] = (parMois[ym] || 0) + reste(d); }
    else sansDateTotal += reste(d);
  });
  const depDejaDuesOuEnRetard = Object.keys(parMois).filter(ym => ym <= curYM).reduce((s, ym) => s + parMois[ym], 0);

  const values = [(e.solde || 0) + donsRecus - depDejaDuesOuEnRetard];
  for (let i = 1; i <= mois; i++) {
    let v = values[i - 1] + (actif ? mensuel : 0) - (parMois[months[i]] || 0);
    if (i === mois) v += donsAVenir - sansDateTotal;
    values.push(v);
  }
  return { months, values };
}

function renderCashChart(proj) {
  if (!proj) return '';
  const { months, values } = proj;
  const hasNegativeQuick = Math.min(0, ...values) < 0;

  if (!cashChartExpanded) {
    const last = values[values.length - 1];
    const sub = hasNegativeQuick
      ? '⚠️ Risque de découvert avant le jour J'
      : `Aujourd'hui ${eur(values[0])} → Jour J`;
    return `<div class="card mc-click" style="display:flex;align-items:center;gap:10px" onclick="toggleCashChart()">
      <span style="font-size:16px">📈</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px"><strong>Projection de trésorerie</strong></div>
        <div style="font-size:11px;color:${hasNegativeQuick ? 'var(--red-text)' : 'var(--text-sec)'}">${sub}</div>
      </div>
      <div style="font-size:13px;color:var(--purple-dark);font-weight:600;flex-shrink:0">${eur(last)} ▾</div>
    </div>`;
  }

  const W = 320, H = 150, padL = 40, padR = 8, padT = 14, padB = 22;
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const span = (max - min) || 1;
  const x = i => padL + (i / (values.length - 1)) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / span) * (H - padT - padB);

  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const areaPts = `${x(0).toFixed(1)},${y(0).toFixed(1)} ${pts} ${x(values.length - 1).toFixed(1)},${y(0).toFixed(1)}`;

  const hasNegative = min < 0;
  const lineColor = hasNegative ? 'var(--red)' : 'var(--purple)';
  const fillColor = hasNegative ? 'var(--red-light)' : 'var(--purple-light)';
  const zeroLine = (min < 0 && max > 0)
    ? `<line x1="${padL}" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}" stroke="var(--border-med)" stroke-dasharray="3,3"/>`
    : '';

  // Échelle Y : montant max en haut, montant min en bas, « 0 € » si la ligne
  // zéro est distincte des deux (courbe qui passe du positif au négatif).
  const yLabels = `
    <text x="${(padL - 6).toFixed(1)}" y="${(padT + 4).toFixed(1)}" font-size="9" fill="var(--text-sec)" text-anchor="end">${eur(max)}</text>
    <text x="${(padL - 6).toFixed(1)}" y="${(H - padB).toFixed(1)}" font-size="9" fill="var(--text-sec)" text-anchor="end">${eur(min)}</text>
    ${(min < 0 && max > 0) ? `<text x="${(padL - 6).toFixed(1)}" y="${(y(0) + 3).toFixed(1)}" font-size="9" fill="var(--text-sec)" text-anchor="end">0 €</text>` : ''}`;

  const step = values.length > 8 ? Math.ceil((values.length - 1) / 4) : 1;
  const xLabels = months.map((ym, i) => (i === 0 || i === values.length - 1 || i % step === 0)
    ? `<text x="${x(i).toFixed(1)}" y="${H - 4}" font-size="9" fill="var(--text-sec)" text-anchor="${i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle'}">${moisLabelShort(ym)}</text>`
    : '').join('');

  const minIdx = values.indexOf(Math.min(...values));
  const dots = values.map((v, i) => (i === 0 || i === values.length - 1 || i === minIdx)
    ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${i === minIdx && hasNegative ? 'var(--red)' : 'var(--purple-dark)'}"/>`
    : '').join('');

  const alertBadge = hasNegative
    ? `<div style="font-size:11px;color:var(--red-text);margin-top:4px">⚠️ Risque de découvert : ${eur(Math.min(...values))} en ${moisLabel(months[minIdx])}</div>`
    : '';

  // Stocké pour l'interaction tactile/souris (cashChartMove ci-dessous), qui
  // recalcule le point le plus proche sans avoir à tout re-render.
  cashChartData = { W, points: values.map((v, i) => ({ x: x(i), y: y(v), v, ym: months[i] })) };

  return `<div class="card">
    <div class="card-title mc-click" onclick="toggleCashChart()" style="display:flex;justify-content:space-between;align-items:baseline;cursor:pointer">
      <span>📈 Projection de trésorerie</span>
      <span style="font-size:11px;color:var(--purple-dark);font-weight:600;text-transform:none;letter-spacing:0">Replier ▲</span>
    </div>
    <div id="cash-readout" style="text-align:center;padding:2px 0 8px;min-height:36px">${cashReadoutDefault()}</div>
    <svg id="cash-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none">
      ${zeroLine}
      <polygon points="${areaPts}" fill="${fillColor}" opacity="0.5"/>
      <polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="2"/>
      ${dots}
      ${yLabels}
      ${xLabels}
      <line id="cash-guide-line" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="var(--text-sec)" stroke-dasharray="2,2" style="visibility:hidden"/>
      <circle id="cash-guide-dot" r="3.5" fill="var(--purple-dark)" stroke="var(--card)" stroke-width="1.5" style="visibility:hidden"/>
      <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" pointer-events="all"
        style="touch-action:none;cursor:crosshair;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none"
        onpointerdown="cashChartMove(event)" onpointermove="cashChartMove(event)"
        onpointerup="cashChartLeave()" onpointerleave="cashChartLeave()" onpointercancel="cashChartLeave()"
        ontouchstart="event.preventDefault()" ontouchmove="event.preventDefault()"
        oncontextmenu="return false" onselectstart="return false"></rect>
    </svg>
    ${alertBadge}
  </div>`;
}

function cashReadoutDefault() {
  if (!cashChartData) return '';
  const pts = cashChartData.points;
  return `<span style="font-size:11px;color:var(--text-sec)">Aujourd'hui&nbsp;: <strong style="font-size:13px;color:var(--text)">${eur(pts[0].v)}</strong> &nbsp;→&nbsp; Jour J&nbsp;: <strong style="font-size:13px;color:var(--text)">${eur(pts[pts.length - 1].v)}</strong></span>`;
}

window.cashChartMove = (e) => {
  if (!cashChartData) return;
  if (e.cancelable) e.preventDefault();
  const svg = document.getElementById('cash-svg');
  const rect = svg && svg.getBoundingClientRect();
  if (!rect || !rect.width) return;
  const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const vx = fx * cashChartData.W;
  let idx = 0, best = Infinity;
  cashChartData.points.forEach((p, i) => { const d = Math.abs(p.x - vx); if (d < best) { best = d; idx = i; } });
  const p = cashChartData.points[idx];

  const line = document.getElementById('cash-guide-line');
  const dot = document.getElementById('cash-guide-dot');
  if (line) { line.setAttribute('x1', p.x); line.setAttribute('x2', p.x); line.style.visibility = 'visible'; }
  if (dot) {
    dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
    dot.setAttribute('fill', p.v < 0 ? 'var(--red)' : 'var(--purple-dark)');
    dot.style.visibility = 'visible';
  }
  const ro = document.getElementById('cash-readout');
  if (ro) ro.innerHTML = `<div style="font-size:12px;color:var(--text-sec)">${moisLabel(p.ym)}</div><div style="font-size:20px;font-weight:700;color:${p.v < 0 ? 'var(--red-text)' : 'var(--purple-dark)'}">${eur(p.v)}</div>`;
};

window.cashChartLeave = () => {
  const line = document.getElementById('cash-guide-line');
  const dot = document.getElementById('cash-guide-dot');
  if (line) line.style.visibility = 'hidden';
  if (dot) dot.style.visibility = 'hidden';
  const ro = document.getElementById('cash-readout');
  if (ro) ro.innerHTML = cashReadoutDefault();
};

window.setPlanningView = v => { planningView = v; render(); };

function renderEcheancier() {
  const switcher = `<div class="frow-chips">
    <button class="chip${planningView === 'paiements' ? ' active' : ''}" onclick="setPlanningView('paiements')">💰 Paiements</button>
    <button class="chip${planningView === 'taches' ? ' active' : ''}" onclick="setPlanningView('taches')">✅ Tâches</button>
  </div>`;
  if (planningView === 'taches') return switcher + renderTaches();

  const chart = renderCashChart(cashProjection());

  // Dépenses réellement à payer : on exclut options, offerts et cautions
  // (comme le calcul du budget), et tout ce qui n'a plus de reste.
  const aPayer = data.depenses.filter(d => !d.option && !d.offert && !d.caution && reste(d) > 0);
  if (!aPayer.length) return `${switcher}${chart}<div class="empty">🎉 Plus rien à payer, tout est soldé !</div>`;

  const totalReste = aPayer.reduce((s, d) => s + reste(d), 0);

  // Avec date limite : regroupées par mois (YYYY-MM) ; sinon « à planifier ».
  const parMois = {}, sansDate = [];
  aPayer.forEach(d => {
    if (d.dateLimite) (parMois[d.dateLimite.slice(0, 7)] ||= []).push(d);
    else sansDate.push(d);
  });

  const curYM = today().slice(0, 7);
  let cumul = 0;
  const blocs = Object.keys(parMois).sort().map(ym => {
    const items = parMois[ym].sort((a, b) => a.dateLimite.localeCompare(b.dateLimite));
    const sousTotal = items.reduce((s, d) => s + reste(d), 0);
    cumul += sousTotal;
    const past = ym < curYM;
    const rows = items.map(d => {
      const jour = d.dateLimite.split('-').reverse().join('/');
      const retard = d.dateLimite < today();
      return `<div class="ditem" onclick="openDepModal(${d.id})">
        <div><div class="dname">${escHtml(d.desc)}</div><div class="dmeta">${d.cat} · ${jour}${retard ? ' · <span style="color:var(--red)">en retard</span>' : ''}</div></div>
        <div><div class="damt">${eur2(reste(d))}</div></div>
      </div>`;
    }).join('');
    return `<div class="stitle" style="display:flex;justify-content:space-between;align-items:baseline${past ? ';color:var(--red)' : ''}">
        <span>${past ? '⚠️ ' : ''}${moisLabel(ym)}</span><span style="font-weight:600">${eur2(sousTotal)}</span>
      </div>
      <div class="card" style="margin-bottom:4px">${rows}</div>
      <div style="text-align:right;font-size:11px;color:var(--text-sec);margin:0 2px 12px">Cumul : ${eur2(cumul)}</div>`;
  }).join('');

  const sansDateBloc = sansDate.length ? `
    <div class="stitle">À planifier (sans date limite)</div>
    <div class="card">${sansDate.sort((a, b) => reste(b) - reste(a)).map(d => `
      <div class="ditem" onclick="openDepModal(${d.id})">
        <div><div class="dname">${escHtml(d.desc)}</div><div class="dmeta">${d.cat}</div></div>
        <div><div class="damt">${eur2(reste(d))}</div></div>
      </div>`).join('')}</div>` : '';

  return `${switcher}${chart}<div class="hero">
      <div class="hero-lbl">Reste à payer au total</div>
      <div class="hero-val">${eur(totalReste)}</div>
      <div class="hero-sub">${aPayer.length} paiement${aPayer.length > 1 ? 's' : ''}${sansDate.length ? ` · ${sansDate.length} sans date` : ''}</div>
    </div>
    ${blocs}${sansDateBloc}`;
}

// ── Render Tâches ────────────────────────────────────────────────────────────
function renderTaches() {
  const taches = data.taches || [];
  const restantes = taches.filter(t => !t.fait).length;
  const sorted = [...taches].sort((a, b) => {
    if (!!a.fait !== !!b.fait) return a.fait ? 1 : -1;
    return (a.dateLimite || '9999-99-99').localeCompare(b.dateLimite || '9999-99-99');
  });

  const items = sorted.map(t => {
    const retard = !t.fait && t.dateLimite && t.dateLimite < today();
    const jour = t.dateLimite ? t.dateLimite.split('-').reverse().join('/') : '';
    return `<div class="ditem" style="align-items:center">
      <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0" onclick="openTacheModal(${t.id})">
        <input type="checkbox" ${t.fait ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleTache(${t.id})" style="width:18px;height:18px;flex-shrink:0">
        <div style="min-width:0">
          <div class="dname" style="${t.fait ? 'text-decoration:line-through;color:var(--text-sec)' : ''}">${escHtml(t.texte)}</div>
          ${jour ? `<div class="dmeta">${jour}${retard ? ' · <span style="color:var(--red)">en retard</span>' : ''}</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  return `<button class="btn-primary" onclick="openTacheModal()">+ Nouvelle tâche</button>
    <div class="hero">
      <div class="hero-lbl">Tâches restantes</div>
      <div class="hero-val">${restantes}</div>
      <div class="hero-sub">${taches.length} tâche${taches.length > 1 ? 's' : ''} au total</div>
    </div>
    <div class="card">${items || '<div class="empty">Aucune tâche pour l’instant</div>'}</div>`;
}

window.openTacheModal = (id = null) => {
  const t = id !== null ? (data.taches || []).find(x => x.id === id) : null;
  document.getElementById('modal-root').innerHTML = `<div class="mbg"><div class="modal">
    <div class="mtitle">${t ? 'Modifier la tâche' : 'Nouvelle tâche'} <button onclick="closeModal()" class="mclose" aria-label="Fermer">✕</button></div>
    <div class="mf"><label>Tâche</label><input id="tt" type="text" placeholder="Ex: Envoyer les faire-part" value="${t ? escAttr(t.texte) : ''}"></div>
    <div class="mf"><label>Date limite (optionnelle)</label><input id="td" type="date" value="${t ? (t.dateLimite || '') : ''}"></div>
    <div class="mf"><label>Remarque</label><textarea id="tr">${t ? escHtml(t.rem || '') : ''}</textarea></div>
    <div class="btn-row">
      ${t ? `<button class="btn-del" onclick="deleteTache(${t.id})">🗑 Supprimer</button>` : `<button class="btn-sec" onclick="closeModal()">Annuler</button>`}
      <button class="btn-save" onclick="saveTache(${t ? t.id : 'null'})">Enregistrer</button>
    </div>
  </div></div>`;
  setTimeout(() => document.getElementById('tt').focus(), 60);
};

window.saveTache = (id) => {
  const texte = document.getElementById('tt').value.trim();
  if (!texte) return;
  const fields = { texte, dateLimite: document.getElementById('td').value || '', rem: document.getElementById('tr').value };
  if (!Array.isArray(data.taches)) data.taches = [];
  if (id === null) {
    const newId = Math.max(0, ...data.taches.map(t => t.id)) + 1;
    data.taches.push({ id: newId, fait: false, ...fields });
  } else {
    const t = data.taches.find(x => x.id === id);
    if (t) Object.assign(t, fields);
  }
  closeModal(); render(); scheduleSave();
};

window.deleteTache = async (id) => {
  if (!await confirmModal('Supprimer cette tâche ?')) return;
  data.taches = data.taches.filter(t => t.id !== id);
  closeModal(); render(); scheduleSave();
};

window.toggleTache = (id) => {
  const t = (data.taches || []).find(x => x.id === id);
  if (t) { t.fait = !t.fait; render(); scheduleSave(); }
};

// ── Carte 1 : Virement automatique ──────────────────────────────────────────
function renderVirementAutoCard() {
  const e = ensureEpargne();
  const actif = e.actif !== false;
  const mois = moisRestants(e.dateMariage);
  const aVenir = actif ? (e.mensuel || 0) * mois : 0;

  if (!epVirExpanded) {
    const label = actif ? `${eur2(e.mensuel || 0)}/mois · Actif` : 'En pause';
    return `<div class="card mc-click" style="display:flex;align-items:center;gap:10px" onclick="toggleVirAuto()">
      <div style="font-size:14px;font-weight:600">🔄 Virement auto</div>
      <div style="flex:1;min-width:0;font-size:12px;color:var(--text-sec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
      <div style="font-size:13px;color:var(--purple-dark);font-weight:600;flex-shrink:0">Modifier ✏️</div>
    </div>`;
  }

  const recap = actif && e.dateMariage
    ? `<div style="margin-top:12px;font-size:13px;color:var(--text-sec);line-height:1.7">
        <div>Projection : ${eur2(e.mensuel || 0)}/mois × ${mois} mois = <strong style="color:var(--purple-dark)">${eur2(aVenir)}</strong></div>
      </div>`
    : '';
  const startVal = e.dateDebut || nextMonthStr();
  return `<div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">🔄 Virement mensuel auto <button onclick="toggleVirAuto()" class="mclose" aria-label="Replier" style="font-size:13px">Replier ▲</button></div>
    <div class="fgrid">
      <div class="fi"><label>Montant mensuel (€)</label><input id="vir-mensuel" type="number" step="0.01" placeholder="300" value="${e.mensuel || ''}"></div>
      <div class="fi"><label>À partir du</label><input id="vir-dateDebut" type="month" value="${startVal}"></div>
    </div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:10px">
      <button onclick="toggleVirActif()" style="flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:13px;background:${actif ? 'var(--green)' : 'var(--text-sec)'};color:#fff">${actif ? '✅ Activé — cliquer pour mettre en pause' : '⏸️ En pause — cliquer pour activer'}</button>
    </div>
    <button class="btn-save" style="width:100%;margin-top:8px" onclick="saveVirAuto()">Enregistrer</button>
    ${recap}
  </div>`;
}

// ── Carte 2 : Statut du compte épargne ──────────────────────────────────────
function renderSoldeCompteCard() {
  const e = ensureEpargne();
  const mois = moisRestants(e.dateMariage);
  const aVenir = (e.actif !== false) ? (e.mensuel || 0) * mois : 0;
  const totalJJ = (e.solde || 0) + aVenir;
  const expanded = epSoldeExpanded === null ? !(e.solde > 0) : epSoldeExpanded;

  if (!expanded) {
    return `<div class="card mc-click" style="display:flex;align-items:center;gap:10px" onclick="toggleSoldeCompte()">
      <div style="font-size:14px;font-weight:600">💰 Compte épargne</div>
      <div style="flex:1;min-width:0;font-size:12px;color:var(--text-sec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${eur2(e.solde || 0)} · jour J ${eur2(totalJJ)}</div>
      <div style="font-size:13px;color:var(--purple-dark);font-weight:600;flex-shrink:0">Modifier ✏️</div>
    </div>`;
  }

  const recap = `<div style="margin-top:12px;font-size:13px;color:var(--text-sec);line-height:1.7">
    <div>Sur le compte aujourd'hui : <strong style="color:var(--text)">${eur2(e.solde || 0)}</strong></div>
    ${aVenir > 0 ? `<div>+ Virements auto à venir : <strong style="color:var(--purple-dark)">${eur2(aVenir)}</strong></div>` : ''}
    ${e.dateMariage
      ? `<div>= Total le jour J : <strong style="color:var(--green)">${eur2(totalJJ)}</strong></div>`
      : `<div style="color:var(--amber)">➕ Renseigne la date du mariage pour projeter le total.</div>`}
  </div>`;
  return `<div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">💰 Compte épargne <button onclick="toggleSoldeCompte()" class="mclose" aria-label="Replier" style="font-size:13px">Replier ▲</button></div>
    <div class="fgrid">
      <div class="fi"><label>Solde actuel du compte (€)</label><input id="ep-solde" type="number" step="0.01" placeholder="0.00" value="${e.solde || ''}"></div>
      <div class="fi full"><label>Date du mariage</label><input id="ep-date" type="date" value="${e.dateMariage || ''}"></div>
    </div>
    <button class="btn-save" style="width:100%;margin-top:10px" onclick="saveSoldeCompte()">Enregistrer le solde</button>
    ${recap}
  </div>`;
}

// ── Render Revenus ───────────────────────────────────────────────────────────
function renderRevenus() {
  const dons = data.revenus.filter(r => r.type !== 'Épargne');
  const total = dons.reduce((s,r) => s + r.montant, 0);
  const recu  = dons.filter(r => r.date).reduce((s,r) => s + r.montant, 0);
  const attente = total - recu;
  const items = sortRevenus(dons).map(r => `
    <div class="ritem" onclick="openRevModal(${r.id})">
      <div><div class="rname">${r.source}</div><div class="rmeta">${r.type}</div>${r.date ? '<span class="badge b-ok">Reçu</span>' : '<span class="badge b-warn">En attente</span>'}${r.rem ? ` <span class="badge b-gray">${escHtml(r.rem)}</span>` : ''}</div>
      <div class="rright"><div class="ramt">${eur2(r.montant)}</div>${r.date ? `<div class="rdate">${r.date.split('-').reverse().join('/')}</div>` : ''}</div>
    </div>`).join('');
  const sort = sortSelect('setRevSort', revSort, [['date','Date de réception'],['montant','Montant (décroissant)'],['statut','Reçus puis en attente']]);
  return `${renderVirementAutoCard()}
    ${renderSoldeCompteCard()}
    <div class="stitle">Cadeaux & contributions</div>
    <button class="btn-primary" onclick="openRevModal()">+ Nouveau revenu</button>
    <div class="mg"><div class="mc"><div class="ml">Total prévu</div><div class="mv">${eur(total)}</div></div><div class="mc"><div class="ml">Reçu</div><div class="mv green">${eur(recu)}</div></div><div class="mc"><div class="ml">En attente</div><div class="mv amber">${eur(attente)}</div></div></div>
    ${sort}<div class="card">${items || '<div class="empty">Aucun cadeau / contribution</div>'}</div>`;
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

  return `<div class="btn-row">
      <button class="btn-primary" style="width:auto;flex:1" onclick="addFoyer()">+ Nouveau foyer</button>
      <button class="btn-primary" id="export-invites-btn" style="width:auto;flex:1;background:var(--green)" onclick="exportInvites()">📋 Exporter invités</button>
    </div>
    <div class="mg mg-4">
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
  const hasFoodInfo = m => (m.regime && m.regime !== 'Standard') || (m.allergies && m.allergies.length) || m.allergieAutre;
  const mbrRow = (m) => `<div class="mbr" data-statut="${m.statut}" data-type="${m.type}" data-regime="${escAttr(m.regime || 'Standard')}" data-allergies="${escAttr((m.allergies || []).join(','))}" data-allergie-autre="${escAttr(m.allergieAutre || '')}">
      <input class="mbr-nom" value="${escAttr(m.nom)}" placeholder="${m.type==='enfant'?'Enfant':'Nom'}">
      ${seg(m.statut)}
      <button type="button" class="mbr-food${hasFoodInfo(m) ? ' has-data' : ''}" onclick="openAllergieModal(this)" title="Allergies / régime" aria-label="Allergies et régime">🍽️</button>
      <button type="button" class="mbr-del" onclick="delMbr(this)" title="Retirer" aria-label="Retirer ce membre">🗑</button>
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
window.toggleDashPaiements = () => { dashPaiementsExpanded = !dashPaiementsExpanded; render(); };
window.toggleCashChart = () => { cashChartExpanded = !cashChartExpanded; render(); };
window.setDepFilter = f => { depFilter = f; render(); };
window.setDepSort   = s => { depSort = s; render(); };
window.setRevSort   = s => { revSort = s; render(); };

function commitVirFromDOM() {
  const mEl = document.getElementById('vir-mensuel');
  if (!mEl) return false;
  const e = ensureEpargne();
  e.mensuel   = parseFloat(mEl.value) || 0;
  e.dateDebut = document.getElementById('vir-dateDebut').value || '';
  return true;
}

function commitSoldeFromDOM() {
  const sEl = document.getElementById('ep-solde');
  if (!sEl) return false;
  const e = ensureEpargne();
  e.solde       = parseFloat(sEl.value) || 0;
  e.dateMariage = document.getElementById('ep-date').value || '';
  return true;
}

window.toggleVirAuto = () => {
  if (epVirExpanded) { commitVirFromDOM(); scheduleSave(); }
  epVirExpanded = !epVirExpanded;
  render();
};

window.toggleVirActif = () => {
  commitVirFromDOM();
  const e = ensureEpargne();
  e.actif = !(e.actif !== false);
  render(); scheduleSave();
};

window.saveVirAuto = () => {
  commitVirFromDOM();
  epVirExpanded = false;
  render(); scheduleSave();
};

window.toggleSoldeCompte = () => {
  const e = ensureEpargne();
  const expanded = epSoldeExpanded === null ? !(e.solde > 0) : epSoldeExpanded;
  if (expanded) { commitSoldeFromDOM(); scheduleSave(); }
  epSoldeExpanded = !expanded;
  render();
};

window.saveSoldeCompte = () => {
  commitSoldeFromDOM();
  epSoldeExpanded = false;
  render(); scheduleSave();
};


window.setInvFilter = f => { invFilter = f; render(); };
window.setInvStatus = s => { invStatus = (invStatus === s ? 'Tous' : s); render(); };
// Replier ou changer de foyer enregistre d'abord la saisie en cours (sinon les
// modifications faites dans le formulaire déplié seraient perdues).
window.toggleFoyer = id => {
  if (invExpanded !== null && invExpanded !== id) commitOpenFoyer();
  invExpanded = invExpanded === id ? (commitOpenFoyer(), null) : id;
  render();
};

// Lit le formulaire déplié dans le DOM et le réinjecte dans data, puis planifie
// une sauvegarde. Sans effet si aucun foyer n'est ouvert / présent dans le DOM.
function commitOpenFoyer() {
  if (invExpanded === null) return;
  if (readFoyerFromDOM(invExpanded)) scheduleSave();
}

function readFoyerFromDOM(id) {
  const f = data.foyers.find(x => x.id === id);
  const fn = document.getElementById(`fn-${id}`);
  if (!f || !fn) return false; // foyer absent ou formulaire pas dans le DOM
  f.nom    = fn.value.trim() || f.nom;
  f.groupe = document.getElementById(`fg-${id}`).value;
  f.moment = document.getElementById(`fm-${id}`).value;
  const rows = document.querySelectorAll(`#mlist-${id} .mbr`);
  f.membres = Array.from(rows).map(row => {
    const m = {
      nom: row.querySelector('.mbr-nom').value.trim() || (row.dataset.type === 'enfant' ? 'Enfant' : 'Adulte'),
      type: row.dataset.type === 'enfant' ? 'enfant' : 'adulte',
      statut: row.dataset.statut || 'attente'
    };
    if (row.dataset.regime && row.dataset.regime !== 'Standard') m.regime = row.dataset.regime;
    const allergies = (row.dataset.allergies || '').split(',').filter(Boolean);
    if (allergies.length) m.allergies = allergies;
    const autre = (row.dataset.allergieAutre || '').trim();
    if (autre) m.allergieAutre = autre;
    return m;
  });
  // Compteurs dérivés (rétro-compat + export Excel)
  f.adultes     = f.membres.filter(m => m.type === 'adulte').length;
  f.enfants     = f.membres.filter(m => m.type === 'enfant').length;
  f.confAdultes = f.membres.filter(m => m.type === 'adulte' && m.statut === 'confirme').length;
  f.confEnfants = f.membres.filter(m => m.type === 'enfant' && m.statut === 'confirme').length;
  f.rsvp        = foyerRsvp(f);
  f.adresse = document.getElementById(`fadr-${id}`).value;
  f.rem     = document.getElementById(`frem-${id}`).value;
  return true;
}

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

// ── Allergies / régime alimentaire d'un membre ────────────────────────────────
// Stockées comme attributs data-* sur la ligne .mbr (comme statut/type), pour
// que readFoyerFromDOM() les retrouve sans avoir à les recroiser par index avec
// l'ancien tableau membres (qui se décale dès qu'un membre est ajouté/retiré).
window.openAllergieModal = (btn) => {
  const row = btn.closest('.mbr');
  allergieModalRow = row;
  const regime = row.dataset.regime || 'Standard';
  const allergies = (row.dataset.allergies || '').split(',').filter(Boolean);
  const autre = row.dataset.allergieAutre || '';
  const nom = row.querySelector('.mbr-nom').value.trim() || 'cet invité';
  const regimeOpts = REGIMES.map(r => `<option${r === regime ? ' selected' : ''}>${r}</option>`).join('');
  const allergieChecks = ALLERGENES.map(a =>
    `<label><input type="checkbox" value="${escAttr(a)}"${allergies.includes(a) ? ' checked' : ''}> ${a}</label>`
  ).join('');
  document.getElementById('modal-root').innerHTML = `<div class="mbg"><div class="modal">
    <div class="mtitle">🍽️ ${escHtml(nom)} <button onclick="closeAllergieModal()" class="mclose" aria-label="Fermer">✕</button></div>
    <div class="mf"><label>Régime alimentaire</label><select id="am-regime">${regimeOpts}</select></div>
    <div class="mf"><label>Allergies</label><div class="mcheck-grid" id="am-allergies">${allergieChecks}</div></div>
    <div class="mf"><label>Autre allergie / précision</label><input id="am-autre" type="text" placeholder="Ex: kiwi" value="${escAttr(autre)}"></div>
    <div class="btn-row">
      <button class="btn-sec" onclick="closeAllergieModal()">Annuler</button>
      <button class="btn-save" onclick="saveAllergieModal()">Enregistrer</button>
    </div>
  </div></div>`;
};

window.saveAllergieModal = () => {
  if (!allergieModalRow) return;
  const regime = document.getElementById('am-regime').value;
  const checked = Array.from(document.querySelectorAll('#am-allergies input:checked')).map(i => i.value);
  const autre = document.getElementById('am-autre').value.trim();
  allergieModalRow.dataset.regime = regime;
  allergieModalRow.dataset.allergies = checked.join(',');
  allergieModalRow.dataset.allergieAutre = autre;
  const btn = allergieModalRow.querySelector('.mbr-food');
  if (btn) btn.classList.toggle('has-data', (regime !== 'Standard') || checked.length > 0 || !!autre);
  closeAllergieModal();
};

window.closeAllergieModal = () => { allergieModalRow = null; closeModal(); };

window.addMbr = (foyerId, type) => {
  const list = document.getElementById('mlist-' + foyerId);
  if (!list) return;
  const n = list.querySelectorAll(`.mbr[data-type="${type}"]`).length + 1;
  const row = document.createElement('div');
  row.className = 'mbr';
  row.dataset.statut = 'attente';
  row.dataset.type = type;
  row.dataset.regime = 'Standard';
  row.dataset.allergies = '';
  row.dataset.allergieAutre = '';
  row.innerHTML = `<input class="mbr-nom" value="${(type === 'enfant' ? 'Enfant ' : 'Adulte ') + n}" placeholder="Nom">
    <div class="seg">
      <button type="button" class="seg-b sb-a on" onclick="setMbr(this,'attente')" title="En attente">?</button>
      <button type="button" class="seg-b sb-c" onclick="setMbr(this,'confirme')" title="Confirmé">✓</button>
      <button type="button" class="seg-b sb-d" onclick="setMbr(this,'decline')" title="Décliné">✗</button>
    </div>
    <button type="button" class="mbr-food" onclick="openAllergieModal(this)" title="Allergies / régime" aria-label="Allergies et régime">🍽️</button>
    <button type="button" class="mbr-del" onclick="delMbr(this)" title="Retirer" aria-label="Retirer ce membre">🗑</button>`;
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
  if (!readFoyerFromDOM(id)) return;
  invExpanded = null; render(); scheduleSave();
};

window.deleteFoyer = async id => {
  if (!await confirmModal('Supprimer ce foyer et tous ses membres ?')) return;
  data.foyers = data.foyers.filter(f => f.id !== id);
  invExpanded = null; render(); scheduleSave();
};

window.addFoyer = () => {
  commitOpenFoyer();
  const newId = Math.max(0, ...data.foyers.map(f => f.id)) + 1;
  data.foyers.unshift({id:newId,nom:"Nouveau foyer",groupe:"Amis Caro",moment:"Journée",adultes:2,enfants:0,rsvp:"En attente",confAdultes:null,confEnfants:null,adresse:"",rem:"",
    membres:[{nom:"Adulte 1",type:"adulte",statut:"attente"},{nom:"Adulte 2",type:"adulte",statut:"attente"}]});
  invExpanded = newId; invFilter = 'Tous'; invStatus = 'Tous'; invSearch = '';
  render();
  setTimeout(() => { const el = document.getElementById(`fn-${newId}`); if (el) { el.focus(); el.select(); } }, 60);
};

window.closeModal = () => { document.getElementById('modal-root').innerHTML = ''; };

// Modale de confirmation (remplace confirm() natif, peu fiable en PWA iOS).
// S'empile au-dessus d'une éventuelle modale ouverte sans la détruire.
function confirmModal(message, { okLabel = 'Supprimer', danger = true } = {}) {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'mbg';
    el.style.zIndex = '300';
    el.innerHTML = `<div class="modal" style="max-width:340px">
      <div class="mtitle">Confirmation</div>
      <div style="font-size:14px;color:var(--text);line-height:1.5;margin-bottom:18px">${escHtml(message)}</div>
      <div class="btn-row">
        <button class="btn-sec" id="cm-no" style="flex:1">Annuler</button>
        <button class="${danger ? 'btn-del' : 'btn-save'}" id="cm-yes" style="flex:1">${escHtml(okLabel)}</button>
      </div>
    </div>`;
    document.getElementById('modal-root').appendChild(el);
    const close = val => { el.remove(); resolve(val); };
    el.querySelector('#cm-no').onclick = () => close(false);
    el.querySelector('#cm-yes').onclick = () => close(true);
    el.addEventListener('click', e => { if (e.target === el) close(false); });
  });
}

// ── Export Excel ─────────────────────────────────────────────────────────────
// Génère le contenu CSV (séparateur « ; » pour Excel fr) d'un tableau d'objets.
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [headers.join(';'), ...rows.map(r => headers.map(h => esc(r[h])).join(';'))].join('\r\n');
}

// Télécharge un texte en fichier (BOM UTF-8 pour qu'Excel lise les accents).
function downloadText(text, filename, mime) {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.exportFinances = async () => {
  const btn = document.getElementById('export-finances-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération...'; }

  // Données préparées en amont : réutilisées pour le repli CSV hors ligne.
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
  const rev = data.revenus.filter(r => r.type !== 'Épargne').map(r => ({
    Source: r.source,
    Type: r.type,
    'Montant (€)': r.montant,
    'Date réception': r.date,
    Reçu: r.date ? 'Oui' : 'Non',
    Remarque: r.rem
  }));
  const e = ensureEpargne();
  const moisR = moisRestants(e.dateMariage);
  const epArgneAVenir = (e.actif !== false) ? (e.mensuel || 0) * moisR : 0;
  const ep = [{
    'Solde actuel du compte (€)': e.solde || 0,
    'Date du mariage': e.dateMariage || '',
    'Mois restants': moisR,
    'Virement auto actif': e.actif !== false ? 'Oui' : 'Non',
    'Montant mensuel (€)': e.mensuel || 0,
    'À partir du': e.dateDebut || '',
    'Épargne auto à venir (€)': epArgneAVenir,
    'Total le jour J (€)': (e.solde || 0) + epArgneAVenir
  }];

  try {
    const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ep), 'Épargne');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dep), 'Dépenses');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rev), 'Revenus');
    XLSX.writeFile(wb, `mariage-finances-${today()}.xlsx`);
  } catch (err) {
    // Hors ligne ou CDN injoignable : repli sur un CSV (sans dépendance).
    try {
      const csv = ['=== ÉPARGNE ===', toCSV(ep), '', '=== DÉPENSES ===', toCSV(dep), '', '=== REVENUS ===', toCSV(rev)].join('\r\n');
      downloadText(csv, `mariage-finances-${today()}.csv`, 'text/csv;charset=utf-8;');
    } catch (e2) {
      alert("Échec de l'export.");
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📊 Exporter finances'; }
  }
};

window.exportInvites = async () => {
  const btn = document.getElementById('export-invites-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération...'; }

  // 1 ligne par foyer, avec une colonne par invité pour permettre un publipostage
  // (fusion sur "Adresse" pour l'enveloppe, "Invité 1"/"Invité 2"... pour la lettre).
  const maxMembres = data.foyers.reduce((m, f) => Math.max(m, ensureMembres(f).length), 0);
  const inv = data.foyers.map(f => {
    const m = ensureMembres(f);
    const st = foyerStats(f);
    const row = {
      Foyer: f.nom,
      Adresse: f.adresse,
      Groupe: f.groupe,
      Moment: f.moment,
      'Statut RSVP': foyerRsvp(f),
      'Nb personnes': st.total,
      Confirmés: st.confirme,
      'En attente': st.attente,
      Déclinés: st.decline
    };
    for (let i = 0; i < maxMembres; i++) {
      const x = m[i];
      row[`Invité ${i + 1}`] = x ? `${x.nom} (${x.statut === 'confirme' ? 'Confirmé' : x.statut === 'decline' ? 'Décliné' : 'En attente'})` : '';
      row[`Invité ${i + 1} - Régime`] = x ? (x.regime || 'Standard') : '';
      row[`Invité ${i + 1} - Allergies`] = x ? [...(x.allergies || []), x.allergieAutre].filter(Boolean).join(', ') : '';
    }
    row.Remarque = f.rem;
    return row;
  });

  try {
    const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(inv), 'Invités');
    XLSX.writeFile(wb, `mariage-invites-${today()}.xlsx`);
  } catch (err) {
    // Hors ligne ou CDN injoignable : repli sur un CSV (sans dépendance).
    try {
      downloadText(toCSV(inv), `mariage-invites-${today()}.csv`, 'text/csv;charset=utf-8;');
    } catch (e2) {
      alert("Échec de l'export.");
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📋 Exporter invités'; }
  }
};

window.openDepModal = (id = null) => {
  const d = id !== null ? data.depenses.find(x => x.id === id) : null;
  const cats = CATS.map(c => `<option${d && d.cat === c ? ' selected' : ''}>${c}</option>`).join('');
  document.getElementById('modal-root').innerHTML = `<div class="mbg"><div class="modal">
    <div class="mtitle">${d ? 'Modifier la dépense' : 'Nouvelle dépense'} <button onclick="closeModal()" class="mclose" aria-label="Fermer">✕</button></div>
    <div class="mf"><label>Description</label><input id="md" type="text" placeholder="Ex: DJ soirée" value="${d ? escAttr(d.desc) : ''}"></div>
    <div class="mf"><label>Catégorie</label><select id="mc">${cats}</select></div>
    <div class="mf"><label>Montant total (€)</label><input id="mt" type="number" step="0.01" placeholder="0.00" value="${d ? d.total : ''}"></div>
    <div class="mf"><label>Acompte payé (€)</label><input id="ma" type="number" step="0.01" value="${d ? d.acompte : 0}"></div>
    <div class="mf"><label>Solde payé (€)</label><input id="ms" type="number" step="0.01" value="${d ? d.solde : 0}"></div>
    <button type="button" class="btn-sec" style="width:100%;margin-bottom:12px" onclick="markSolde()">✓ Marquer comme entièrement payé</button>
    <div class="mf"><label>Date limite</label><input id="ml" type="date" value="${d ? d.dateLimite : ''}"></div>
    <div class="mf"><label>Remarque</label><textarea id="mr">${d ? escHtml(d.rem) : ''}</textarea></div>
    <div class="mcheck"><label><input type="checkbox" id="mop"${d && d.option ? ' checked' : ''}> Option</label><label><input type="checkbox" id="mof"${d && d.offert ? ' checked' : ''}> Offert</label><label><input type="checkbox" id="mca"${d && d.caution ? ' checked' : ''}> Caution</label></div>
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
    caution: document.getElementById('mca').checked,
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

window.deleteDep = async (id) => {
  if (!await confirmModal('Supprimer cette dépense ?')) return;
  data.depenses = data.depenses.filter(d => d.id !== id);
  closeModal(); render(); scheduleSave();
};

window.openRevModal = (id = null) => {
  const r = id !== null ? data.revenus.find(x => x.id === id) : null;
  const types = ['Contribution famille', 'Liste de mariage', 'Cadeau', 'Autre'];
  const typeOpts = types.map(t => `<option${r && r.type === t ? ' selected' : ''}>${t}</option>`).join('');
  const recu = !!(r && r.date);
  document.getElementById('modal-root').innerHTML = `<div class="mbg"><div class="modal">
    <div class="mtitle">${r ? 'Modifier le revenu' : 'Nouveau revenu'} <button onclick="closeModal()" class="mclose" aria-label="Fermer">✕</button></div>
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

window.deleteRev = async (id) => {
  if (!await confirmModal('Supprimer ce revenu ?')) return;
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
  if (!await confirmModal('Se déconnecter ?', { okLabel: 'Se déconnecter', danger: false })) return;
  await doSignOut();
};

window.togglePrivacy = () => {
  privacyMode = !privacyMode;
  const btn = document.getElementById('privacy-btn');
  if (btn) btn.textContent = privacyMode ? '🙈' : '👁';
  render();
};

window.show = tab => {
  // Quitter l'onglet Invités enregistre le foyer ouvert et le referme.
  if (invExpanded !== null) { commitOpenFoyer(); invExpanded = null; }
  currentTab = tab;
  try { localStorage.setItem('currentTab', tab); } catch {}
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('nav-' + tab).classList.add('active');
  document.getElementById('topbar-sub').textContent = {dashboard:'Budget mariage',depenses:'Dépenses',echeancier:'Planning : paiements & tâches',revenus:'Revenus & contributions',invites:'Invités'}[tab];
  render();
};

function render() {
  const c = document.getElementById('content');
  if (currentTab === 'dashboard') c.innerHTML = renderDashboard();
  else if (currentTab === 'depenses') c.innerHTML = renderDepenses();
  else if (currentTab === 'echeancier') c.innerHTML = renderEcheancier();
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
    window.show(currentTab);   // restaure l'onglet actif (survit au pull-to-refresh)
    startListening();
  } else {
    showLogin();
  }
});
