<script>
  import Finance from './Finance.svelte';
  let { snapshot, csrf, filters } = $props();
</script>

<section class="intro">
  <div><p class="eyebrow">Personal finance / Overview</p><h1>See the whole picture.</h1></div>
  <div>
    <form class="inline" method="post" action="/sync">
      <input type="hidden" name="csrf" value={csrf}>
      <button class="subtle">Check updates</button>
    </form>
    <form class="inline" method="post" action="/logout">
      <input type="hidden" name="csrf" value={csrf}>
      <button class="subtle">Sign out</button>
    </form>
    <button class="primary" data-connect="">+ Connect bank</button>
  </div>
</section>
<p id="status" class="status-line" role="status" aria-live="polite"></p>
<noscript>Live updates and connecting a bank need JavaScript. Existing accounts, filters, sign-in and manual refresh work without it.</noscript>
<form class="filters" method="get" action="/">
  <label>Month<input type="month" name="month" value={snapshot.month} required></label>
  <label>Account<select name="account" value={filters.account}>
    <option value="">All accounts</option>
    {#each snapshot.account_filters as account}
      <option value={account.value}>{account.name}{account.active ? '' : ' · historical'}</option>
    {/each}
  </select></label>
  <label>Merchant<input type="search" name="q" maxlength="100" value={filters.q}></label>
  <button>Apply filters</button>
</form>
<Finance data={snapshot} />
