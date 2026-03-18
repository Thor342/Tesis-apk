<script lang="ts">
	import { onMount } from 'svelte';
	import { App } from '@capacitor/app';
	import Dashboard  from '$lib/Dashboard.svelte';
	import GoNoGo     from '$lib/GoNoGo.svelte';
	import Secuencia  from '$lib/Secuencia.svelte';
	import Stopper    from '$lib/Stopper.svelte';
	import Evaluacion from '$lib/Evaluacion.svelte';
	import Historial  from '$lib/Historial.svelte';

	type Vista = 'dashboard' | 'gonogo' | 'secuencia' | 'stopper' | 'evaluacion' | 'historial';

	let vistaActual = $state<Vista>('dashboard');
	let mostrarDialogoSalir = $state(false);

	const titulos: Record<Vista, string> = {
		dashboard:  'Dashboard',
		gonogo:     'Go / No-Go',
		secuencia:  'Secuencia de Colores',
		stopper:    'Stroop',
		evaluacion: 'Evaluación Completa',
		historial:  'Historial',
	};

	onMount(() => {
		App.addListener('backButton', () => {
			if (vistaActual === 'dashboard') {
				mostrarDialogoSalir = true;
			} else {
				vistaActual = 'dashboard';
			}
		});
	});

	function confirmarSalir() {
		App.exitApp();
	}
</script>

{#if mostrarDialogoSalir}
	<div class="dialogo-overlay">
		<div class="dialogo">
			<p>¿Deseas salir de la aplicación?</p>
			<div class="dialogo-botones">
				<button class="btn-cancelar" onclick={() => mostrarDialogoSalir = false}>Cancelar</button>
				<button class="btn-salir" onclick={confirmarSalir}>Salir</button>
			</div>
		</div>
	</div>
{/if}

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

<style>
	.dialogo-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
	}
	.dialogo {
		background: white;
		border-radius: 16px;
		padding: 28px 24px 20px;
		width: 280px;
		text-align: center;
		box-shadow: 0 8px 32px rgba(0,0,0,0.2);
	}
	.dialogo p {
		font-size: 1rem;
		font-weight: 600;
		color: #1e293b;
		margin: 0 0 20px;
	}
	.dialogo-botones {
		display: flex;
		gap: 12px;
	}
	.btn-cancelar, .btn-salir {
		flex: 1;
		padding: 10px;
		border-radius: 10px;
		border: none;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
	}
	.btn-cancelar {
		background: #f1f5f9;
		color: #475569;
	}
	.btn-salir {
		background: #ef4444;
		color: white;
	}
</style>
