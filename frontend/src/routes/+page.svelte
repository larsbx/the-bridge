<svelte:head>
  <title>The Bridge — financial overview</title>
  <meta name="description" content="Private, read-only financial dashboard">
  <meta name="bridge-csrf" content="BRIDGE_CSRF">
  <link rel="stylesheet" href="/style.css">
  <script defer src="/bridge.js"></script>
</svelte:head>
<header class="topbar"><a class="brand" href="/"><span class="brand-mark">B</span>The Bridge</a><span class="pill">Private · Read-only</span></header>
<main class="page" id="bridge-root">BRIDGE_CONTENT</main>
<footer class="page"><span>Direct Plaid connection · Encrypted access tokens</span><p class="muted">Balances are the latest available snapshots. They are not a guarantee of available funds or a complete net worth estimate.</p></footer>
