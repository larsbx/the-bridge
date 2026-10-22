<script>
  import { money, magnitude } from '#lib/format.js';
  let { rows, label } = $props();
  const maximum = $derived(rows.reduce((max, row) => magnitude(row.amount_cents) > max ? magnitude(row.amount_cents) : max, 1n));
</script>

<div class="bars">
  {#each rows as row}
    <div class="category-row">
      <div class="category-meta"><span>{row[label]}</span><span>{money(row.amount_cents, 'USD')}</span></div>
      <progress aria-label={`${row[label]} magnitude`} max="1000000" value={Number(magnitude(row.amount_cents) * 1000000n / maximum)}></progress>
    </div>
  {/each}
</div>
