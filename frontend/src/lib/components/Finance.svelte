<script>
  import Bars from './Bars.svelte';
  import { money } from '#lib/format.js';
  let { data } = $props();
  const cards = $derived([
    ['Cash accounts (USD)', data.totals.cash_cents],
    ['Credit balances (USD)', data.totals.card_debt_cents],
    ['Cash less card balances', data.totals.net_liquid_cents],
    ['Net categorized spending', data.totals.spending_cents]
  ]);
</script>

<section id="finance">
  <div class="kpis">
    {#each cards as [name, amount]}
      <article class="kpi"><div class="kpi-label">{name}</div><div class="kpi-value">{money(amount, 'USD')}</div></article>
    {/each}
  </div>
  <p class="muted">USD totals only. Spending excludes pending activity and recognized income, transfers and loan payments; refunds reduce spending. Historical account transactions remain included.</p>
  {#if data.balancesIncomplete}
    <p class="notice">Totals are incomplete: some current balances or currencies are unavailable or non-USD.</p>
  {/if}
  <div class="content-grid">
    <section class="panel span-7"><h2>Spending trend</h2><p>Six months · posted USD · earlier history may be incomplete</p><Bars rows={data.months} label="month" /></section>
    <section class="panel span-5"><h2>Where it goes</h2><Bars rows={data.categories} label="category" /></section>
  </div>
  <section class="panel">
    <h2>Current accounts</h2>
    {#each data.items as item}
      <p>{item.institution} · {item.status}
        {#if item.status === 'needs_relink'}<button data-connect={item.item_id}>Reconnect</button>{/if}
      </p>
    {/each}
    <div class="account-cards">
      {#each data.accounts as account}
        <article class="account-card">
          <h3>{account.name} {account.mask || ''}</h3><p>{account.type}</p>
          <div class="account-balance">{money(account.current_cents, account.currency)}</div>
          <p class="account-updated">Updated {account.updated_at}</p>
        </article>
      {:else}No current accounts returned by Plaid.{/each}
    </div>
  </section>
  <section class="panel">
    <h2>Transaction activity</h2><p>Up to 75 matching rows</p>
    <div class="table-scroll"><table>
      <thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th class="right">Amount</th></tr></thead>
      <tbody>
        {#each data.transactions as transaction}
          <tr>
            <td>{transaction.date}</td>
            <td>{transaction.merchant || transaction.name}{transaction.pending ? ' · pending' : ''}</td>
            <td>{transaction.account_name}{#if transaction.historical} <span class="historical">Historical</span>{/if}</td>
            <td>{transaction.category}</td><td class="right">{money(transaction.amount_cents, transaction.currency)}</td>
          </tr>
        {:else}<tr><td colspan="5">No matching activity.</td></tr>{/each}
      </tbody>
    </table></div>
  </section>
  <p class="muted">Generated {data.generated_at}</p>
</section>
