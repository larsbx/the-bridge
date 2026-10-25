<script>
  import Dashboard from '#lib/components/Dashboard.svelte';
  import Login from '#lib/components/Login.svelte';
  let { data } = $props();
</script>

<svelte:head>
  <title>The Bridge — financial overview</title>
  <meta name="description" content="Private, read-only financial dashboard">
  <meta name="bridge-csrf" content={data.csrf || ''}>
  <link rel="stylesheet" href="/style.css">
  {#if data.authenticated}<script defer src="/bridge.js"></script>{/if}
</svelte:head>
<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark">B</span>The Bridge</a>
  <span class="pill">Private · Read-only</span>
  {#if data.authenticated && data.shipControlURL}
    <a href={data.shipControlURL} rel="noreferrer">Deployments in Ship</a>
  {/if}
</header>
<main class="page" id="bridge-root">
  {#if data.authenticated}
    <Dashboard snapshot={data.snapshot} csrf={data.csrf} filters={data.filters} />
  {:else}
    <Login />
  {/if}
</main>
<footer class="page">
  <span>Direct Plaid connection · Encrypted access tokens</span>
  <p class="muted">Balances are the latest available snapshots. They are not a guarantee of available funds or a complete net worth estimate.</p>
</footer>

