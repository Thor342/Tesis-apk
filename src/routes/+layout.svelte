<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/favicon.png?v=3" type="image/png" />
</svelte:head>

{@render children()}
