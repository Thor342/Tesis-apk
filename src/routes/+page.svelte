<script lang="ts">
	import Dashboard  from '$lib/Dashboard.svelte';
	import GoNoGo     from '$lib/GoNoGo.svelte';
	import Secuencia  from '$lib/Secuencia.svelte';
	import Stopper    from '$lib/Stopper.svelte';
	import Evaluacion from '$lib/Evaluacion.svelte';
	import Historial  from '$lib/Historial.svelte';

	type Vista = 'dashboard' | 'gonogo' | 'secuencia' | 'stopper' | 'evaluacion' | 'historial';

	let vistaActual = $state<Vista>('dashboard');

	const titulos: Record<Vista, string> = {
		dashboard:  'Dashboard',
		gonogo:     'Go / No-Go',
		secuencia:  'Secuencia de Colores',
		stopper:    'Stroop',
		evaluacion: 'Evaluación Completa',
		historial:  'Historial',
	};
</script>

<svelte:head>
	<title>{titulos[vistaActual]}</title>
	<meta name="description" content="Plataforma de evaluación neuropsicológica — {titulos[vistaActual]}" />
</svelte:head>

{#if vistaActual === 'dashboard'}
	<Dashboard alNavegar={(vista) => (vistaActual = vista as Vista)} />

{:else if vistaActual === 'gonogo'}
	<GoNoGo
		onVolver={() => (vistaActual = 'dashboard')}
	/>

{:else if vistaActual === 'secuencia'}
	<Secuencia
		onVolver={() => (vistaActual = 'dashboard')}
	/>

{:else if vistaActual === 'stopper'}
	<Stopper
		onVolver={() => (vistaActual = 'dashboard')}
	/>

{:else if vistaActual === 'evaluacion'}
	<Evaluacion
		onVolver={() => (vistaActual = 'dashboard')}
	/>

{:else if vistaActual === 'historial'}
	<Historial
		onVolver={() => (vistaActual = 'dashboard')}
	/>
{/if}
