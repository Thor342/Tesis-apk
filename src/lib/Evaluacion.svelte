<script lang="ts">
	import GoNoGo    from './GoNoGo.svelte';
	import Secuencia from './Secuencia.svelte';
	import Stopper   from './Stopper.svelte';
	import { supabase } from './supabaseClient';

	let { onVolver = undefined as (() => void) | undefined } = $props();

	// ─── Orden de las pruebas (fundamento científico) ─────────────────────────
	// 1. Go/No-Go   → warmup motor, mide inhibición básica; no contamina tareas posteriores
	// 2. Secuencia  → memoria visoespacial antes de la carga cognitiva máxima
	// 3. Stroop     → tarea más exigente; se beneficia del calentamiento previo
	// Referencia: Lezak et al. (2012). Neuropsychological Assessment, 5th ed.

	type Fase = 'gonogo' | 'secuencia' | 'stroop' | 'fin';

	let fase         = $state<Fase>('gonogo');
	let evaluacionId = $state<number | undefined>(undefined);

	// El registro en 'evaluaciones' se crea SOLO cuando el usuario pulsa
	// "Iniciar Test" en GoNoGo, no al montar el componente.
	// Así se evita saturar la tabla con registros de sesiones abandonadas.
	async function crearRegistroEvaluacion() {
		const { data, error } = await supabase
			.from('evaluaciones')
			.insert({ fecha_inicio: new Date().toISOString() })
			.select('id')
			.single();

		if (error || !data) {
			console.error('Error al crear registro de evaluación:', error);
		} else {
			evaluacionId = data.id;
		}
	}

	// Al finalizar las 3 pruebas, marcar la evaluación como completada en BD.
	async function marcarCompletada() {
		if (evaluacionId !== undefined) {
			await supabase
				.from('evaluaciones')
				.update({ fecha_fin: new Date().toISOString(), completada: true })
				.eq('id', evaluacionId);
		}
		fase = 'fin';
	}
</script>

<!-- ── Cargando ─────────────────────────────────────────────────────────────── -->
<!-- ── Prueba 1: Go/No-Go ───────────────────────────────────────────────────── -->
{#if fase === 'gonogo'}
	<GoNoGo
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onIniciar={crearRegistroEvaluacion}
		onTerminar={() => { fase = 'secuencia'; }}
		onVolver={onVolver}
	/>

<!-- ── Prueba 2: Memoria visoespacial ──────────────────────────────────────── -->
{:else if fase === 'secuencia'}
	<Secuencia
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onTerminar={() => { fase = 'stroop'; }}
		onVolver={onVolver}
	/>

<!-- ── Prueba 3: Stroop ─────────────────────────────────────────────────────── -->
{:else if fase === 'stroop'}
	<Stopper
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onTerminar={marcarCompletada}
		onVolver={onVolver}
	/>

<!-- ── Fin de evaluación ────────────────────────────────────────────────────── -->
{:else if fase === 'fin'}
	<div class="estado-container">
		<div class="estado-card">
			<div class="fin-icon">✓</div>
			<h1>Evaluación completada</h1>
			<p>
				El participante ha finalizado las tres pruebas neuropsicológicas:
				<strong>Go/No-Go</strong>, <strong>Memoria Visoespacial</strong>
				y <strong>Test de Stroop</strong>.
				Los resultados han sido guardados y pueden descargarse desde cada informe.
			</p>
			{#if onVolver}
				<button class="btn-volver" onclick={onVolver}>← Volver al menú</button>
			{/if}
		</div>
	</div>
{/if}

<style>
:global(html), :global(body) { margin: 0; padding: 0; box-sizing: border-box; }

.estado-container {
	display: flex; align-items: center; justify-content: center;
	min-height: 100vh; padding: 24px;
	font-family: Arial, system-ui, -apple-system, "Segoe UI", sans-serif;
	background: radial-gradient(circle at top, #f5f7ff, #e2e8f0);
}
.estado-card {
	background: rgba(255,255,255,0.95); border-radius: 20px;
	box-shadow: 0 20px 40px rgba(15,23,42,0.12); padding: 48px 32px;
	max-width: 480px; width: 100%; text-align: center;
}

/* Íconos */
.fin-icon {
	width: 72px; height: 72px; border-radius: 50%;
	background: linear-gradient(135deg, #16a34a, #15803d);
	color: white; font-size: 2.2rem; line-height: 72px;
	margin: 0 auto 20px;
}

/* Texto */
h1 { margin: 0 0 16px; font-size: 1.9rem; color: #0f172a; }
p  { color: rgba(15,23,42,0.65); line-height: 1.6; margin-bottom: 28px; }

/* Botones */
.btn-volver {
	padding: 14px 32px; font-size: 1rem; border-radius: 999px;
	border: none; background: linear-gradient(135deg, #1f2937, #0f172a);
	color: white; cursor: pointer; width: 100%;
	box-shadow: 0 10px 18px rgba(15,23,42,0.2);
	transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.btn-volver:hover  { transform: translateY(-1px); box-shadow: 0 14px 24px rgba(15,23,42,0.28); }
.btn-volver:active { transform: translateY(0);    box-shadow: 0 8px 12px rgba(15,23,42,0.2); }
</style>
