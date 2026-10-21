import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seal, unseal } from './security.mjs';

const cents = value => value === null || value === undefined ? null : Math.round(Number(value) * 100);
const isoNow = () => new Date().toISOString();
export function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw new Error('Invalid month');
  const [year, mon] = month.split('-').map(Number);
  const after = new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 10);
  return [month + '-01', after];
}
export function previousMonths(month, count = 6) {
  monthBounds(month);
  const [year, mon] = month.split('-').map(Number);
  return Array.from({length: count}, (_, i) =>
    new Date(Date.UTC(year, mon - count + i, 1)).toISOString().slice(0, 7));
}
export class Store {
  constructor(path, key) {
    mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.key = key;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS items (item_id TEXT PRIMARY KEY, encrypted_token TEXT NOT NULL, institution TEXT NOT NULL DEFAULT "Linked institution", cursor TEXT, status TEXT NOT NULL DEFAULT "connected", updated_at TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(item_id), name TEXT NOT NULL, mask TEXT, type TEXT NOT NULL, subtype TEXT, currency TEXT, current_cents INTEGER, available_cents INTEGER, limit_cents INTEGER, updated_at TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS transactions (transaction_id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(item_id), account_id TEXT NOT NULL, date TEXT NOT NULL, name TEXT NOT NULL, merchant TEXT, amount_cents INTEGER NOT NULL, pending INTEGER NOT NULL, category TEXT NOT NULL, detail TEXT, currency TEXT, updated_at TEXT NOT NULL);',
      'CREATE INDEX IF NOT EXISTS tx_date_idx ON transactions(date);',
      'CREATE INDEX IF NOT EXISTS tx_account_idx ON transactions(account_id);',
      'CREATE INDEX IF NOT EXISTS tx_item_idx ON transactions(item_id);'
    ].join('\n'));
  }
  close() { this.db.close(); }
  items() {
    return this.db.prepare('SELECT item_id, institution, cursor, status, updated_at FROM items ORDER BY institution').all();
  }
  item(itemId) {
    const item = this.db.prepare('SELECT * FROM items WHERE item_id=?').get(itemId);
    return item ? {...item, accessToken: unseal(this.key, item.encrypted_token)} : null;
  }
  saveItem(itemId, accessToken, institution) {
    this.db.prepare('INSERT INTO items(item_id, encrypted_token, institution, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(item_id) DO UPDATE SET encrypted_token=excluded.encrypted_token, institution=excluded.institution, status=excluded.status, updated_at=excluded.updated_at')
      .run(itemId, seal(this.key, accessToken), institution || 'Linked institution', isoNow());
  }
  markStatus(itemId, status) {
    this.db.prepare('UPDATE items SET status=?, updated_at=? WHERE item_id=?').run(status, isoNow(), itemId);
  }
  saveAccounts(itemId, accounts) {
    const stmt = this.db.prepare('INSERT INTO accounts (account_id,item_id,name,mask,type,subtype,currency,current_cents,available_cents,limit_cents,updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET name=excluded.name,mask=excluded.mask,type=excluded.type,subtype=excluded.subtype,currency=excluded.currency,current_cents=excluded.current_cents,available_cents=excluded.available_cents,limit_cents=excluded.limit_cents,updated_at=excluded.updated_at');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const a of accounts) {
        stmt.run(a.account_id, itemId, a.name || 'Account', a.mask || null,
          a.type || 'other', a.subtype || null, a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || null,
          cents(a.balances?.current), cents(a.balances?.available), cents(a.balances?.limit), isoNow());
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  commitSync(itemId, pages, cursor) {
    const upsert = this.db.prepare('INSERT INTO transactions (transaction_id,item_id,account_id,date,name,merchant,amount_cents,pending,category,detail,currency,updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(transaction_id) DO UPDATE SET account_id=excluded.account_id,date=excluded.date,name=excluded.name,merchant=excluded.merchant,amount_cents=excluded.amount_cents,pending=excluded.pending,category=excluded.category,detail=excluded.detail,currency=excluded.currency,updated_at=excluded.updated_at');
    const drop = this.db.prepare('DELETE FROM transactions WHERE transaction_id=? AND item_id=?');
    const dropPending = this.db.prepare('DELETE FROM transactions WHERE transaction_id=? AND item_id=? AND pending=1');
    const changedAt = isoNow();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const page of pages) {
        for (const removed of page.removed || []) drop.run(removed.transaction_id, itemId);
        for (const tx of [...(page.added || []), ...(page.modified || [])]) {
          if (tx.pending_transaction_id) dropPending.run(tx.pending_transaction_id, itemId);
          upsert.run(tx.transaction_id, itemId, tx.account_id, tx.date,
            tx.name || 'Transaction', tx.merchant_name || null, cents(tx.amount) || 0,
            tx.pending ? 1 : 0, tx.personal_finance_category?.primary || 'UNCATEGORIZED',
            tx.personal_finance_category?.detailed || null, tx.iso_currency_code || tx.unofficial_currency_code || null, changedAt);
        }
      }
      this.db.prepare('UPDATE items SET cursor=?, status=?, updated_at=? WHERE item_id=?')
        .run(cursor, 'connected', changedAt, itemId);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  snapshot(month, account = '', search = '') {
    const [start, end] = monthBounds(month);
    if (account && (account.length > 200 || !this.db.prepare('SELECT account_id FROM accounts WHERE account_id=?').get(account)))
      throw new Error('Unknown account');
    if (search.length > 100) throw new Error('Search too long');
    const accounts = this.db.prepare('SELECT account_id,item_id,name,mask,type,subtype,currency,current_cents,available_cents,limit_cents,updated_at FROM accounts ORDER BY name').all();
    let clause = ' WHERE date >= ? AND date < ?';
    const values = [start, end];
    if (account) { clause += ' AND account_id = ?'; values.push(account); }
    if (search) { clause += ' AND (name LIKE ? OR merchant LIKE ?)'; values.push('%' + search + '%', '%' + search + '%'); }
    const excluded = "('INCOME','TRANSFER_IN','TRANSFER_OUT','LOAN_PAYMENTS')";
    const groups = this.db.prepare('SELECT category,SUM(amount_cents) AS amount_cents FROM transactions' +
      clause + " AND pending=0 AND (currency IS NULL OR currency='USD') AND category NOT IN " + excluded +
      ' GROUP BY category HAVING SUM(amount_cents) != 0 ORDER BY amount_cents DESC').all(...values);
    const transactions = this.db.prepare('SELECT transaction_id,account_id,date,name,merchant,amount_cents,pending,category,detail,currency FROM transactions' +
      clause + ' ORDER BY date DESC,transaction_id DESC LIMIT 75').all(...values);
    const firstTrend = previousMonths(month, 6)[0] + '-01';
    const trendWhere = " AND (currency IS NULL OR currency='USD')" + (account ? ' AND account_id=?' : '') +
      (search ? ' AND (name LIKE ? OR merchant LIKE ?)' : '');
    const trendArgs = [firstTrend, end, ...(account ? [account] : []),
      ...(search ? ['%' + search + '%', '%' + search + '%'] : [])];
    const trend = this.db.prepare('SELECT substr(date,1,7) AS month, SUM(amount_cents) AS spent FROM transactions ' +
      'WHERE date >= ? AND date < ? AND pending=0 AND category NOT IN ' + excluded +
      trendWhere + ' GROUP BY substr(date,1,7)').all(...trendArgs);
    const byMonth = Object.fromEntries(trend.map(r => [r.month, Math.max(0, r.spent)]));
    const months = previousMonths(month, 6).map(m => ({month: m, amount_cents: byMonth[m] || 0}));
    const cash = accounts.filter(a => a.type === 'depository' && (!a.currency || a.currency === 'USD'));
    const debt = accounts.filter(a => a.type === 'credit' && (!a.currency || a.currency === 'USD'));
    const total = rows => rows.reduce((sum, a) => sum + (a.current_cents || 0), 0);
    return {
      month, items: this.items(), accounts, transactions, categories: groups, months,
      balancesIncomplete: accounts.some(a => a.current_cents === null || (a.currency && a.currency !== 'USD')),
      totals: {cash_cents: total(cash), card_debt_cents: total(debt),
        net_liquid_cents: total(cash) - total(debt),
        spending_cents: groups.reduce((sum, g) => sum + g.amount_cents, 0)},
      filters: {account, search}, generated_at: isoNow()
    };
  }
}
