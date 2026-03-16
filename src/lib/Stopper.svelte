<script lang="ts">
	let { onVolver = undefined as (() => void) | undefined } = $props();
</script>

<div class="placeholder-container">
	<div class="placeholder-card">
		<div class="icon">⬛</div>
		<h1>Stopper</h1>
		<p class="badge">Próximamente</p>
		<p class="desc">Esta actividad se encuentra en desarrollo. Pronto podrás evaluar el tiempo de reacción.</p>
		{#if onVolver}
			<button class="btn-volver" onclick={onVolver}>← Volver al menú</button>
		{/if}
	</div>
</div>

<style>
.placeholder-container {
	display: flex; align-items: center; justify-content: center;
	min-height: 100vh; padding: 24px;
	font-family: Arial, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	background: radial-gradient(circle at top, #f5f7ff, #e2e8f0);
}
.placeholder-card {
	background: rgba(255,255,255,0.92); border-radius: 20px;
	box-shadow: 0 20px 40px rgba(15,23,42,0.12); padding: 48px 32px;
	max-width: 420px; width: 100%; text-align: center;
}
.icon   { font-size: 3.5rem; margin-bottom: 12px; color: #b45309; }
h1      { margin: 0 0 16px; font-size: 1.8rem; color: #0f172a; }
.badge  {
	display: inline-block; background: #b45309; color: white;
	padding: 4px 14px; border-radius: 999px; font-size: 0.85rem;
	font-weight: 600; letter-spacing: 0.05em; margin-bottom: 16px;
}
.desc   { color: rgba(15,23,42,0.6); line-height: 1.6; margin-bottom: 28px; }
.btn-volver {
	padding: 12px 28px; font-size: 1rem; border-radius: 999px;
	border: 2px solid rgba(15,23,42,0.2); background: transparent;
	cursor: pointer; transition: background 0.15s ease;
}
.btn-volver:hover { background: rgba(180,83,9,0.08); }
</style>
