<script lang="ts">
	import GoNoGo from './GoNoGo.svelte';

	let { onVolver = undefined as (() => void) | undefined } = $props();

	// Fases de la evaluación completa.
	// Cuando se agreguen Secuencia y Stopper, se añaden aquí como nuevas fases.
	type Fase = 'gonogo' | 'fin';

	let fase = $state<Fase>('gonogo');
</script>

{#if fase === 'gonogo'}
	<GoNoGo
		onTerminar={() => { fase = 'fin'; }}
		onVolver={onVolver}
	/>

{:else if fase === 'fin'}
	<div class="fin-container">
		<div class="fin-card">
			<div class="fin-icon">✓</div>
			<h1>Evaluación completada</h1>
			<p>
				El participante ha finalizado todas las actividades disponibles.
				Los resultados pueden descargarse desde cada actividad.
			</p>
			{#if onVolver}
				<button class="btn-volver" onclick={onVolver}>← Volver al menú</button>
			{/if}
		</div>
	</div>
{/if}

<style>
.fin-container {
	display: flex; align-items: center; justify-content: center;
	min-height: 100vh; padding: 24px;
	font-family: Arial, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	background: radial-gradient(circle at top, #f5f7ff, #e2e8f0);
}
.fin-card {
	background: rgba(255,255,255,0.92); border-radius: 20px;
	box-shadow: 0 20px 40px rgba(15,23,42,0.12); padding: 48px 32px;
	max-width: 480px; width: 100%; text-align: center;
}
.fin-icon {
	width: 72px; height: 72px; border-radius: 50%;
	background: linear-gradient(135deg, #16a34a, #15803d);
	color: white; font-size: 2.2rem; line-height: 72px;
	margin: 0 auto 20px;
}
h1  { margin: 0 0 16px; font-size: 1.9rem; color: #0f172a; }
p   { color: rgba(15,23,42,0.65); line-height: 1.6; margin-bottom: 28px; }
.btn-volver {
	padding: 14px 32px; font-size: 1rem; border-radius: 999px;
	border: none; background: linear-gradient(135deg, #1f2937, #0f172a);
	color: white; cursor: pointer;
	box-shadow: 0 10px 18px rgba(15,23,42,0.2);
	transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.btn-volver:hover  { transform: translateY(-1px); box-shadow: 0 14px 24px rgba(15,23,42,0.28); }
.btn-volver:active { transform: translateY(0);    box-shadow: 0 8px 12px rgba(15,23,42,0.2); }
</style>
