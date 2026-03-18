<script lang="ts">
	import { fly, fade } from 'svelte/transition';

	let { alNavegar } = $props<{ alNavegar: (vista: string) => void }>();

	// ── SVG inline icons ──────────────────────────────────────────────────────
	// Zap
	const iconZap = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
	// Target
	const iconTarget = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`;
	// Palette
	const iconPalette = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`;
	// StopCircle
	const iconStop = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6"/></svg>`;
	// ChevronRight
	const iconArrow = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
	// Brain (decorativo fondo)
	const iconBrain = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.96-3 2.5 2.5 0 0 1-1.32-4.24 3 3 0 0 1 .34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.96-3 2.5 2.5 0 0 0 1.32-4.24 3 3 0 0 0-.34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>`;

	const tarjetas = [
		{
			id: 'gonogo',
			titulo: 'Go / No Go',
			subtitulo: 'Control inhibitorio',
			icon: iconTarget,
			gradiente: 'linear-gradient(135deg, #10b981, #0d9488)',
			glow: 'rgba(16,185,129,0.45)'
		},
		{
			id: 'secuencia',
			titulo: 'Secuencia de Colores',
			subtitulo: 'Memoria de trabajo',
			icon: iconPalette,
			gradiente: 'linear-gradient(135deg, #0ea5e9, #2563eb)',
			glow: 'rgba(14,165,233,0.45)'
		},
		{
			id: 'stopper',
			titulo: 'Stroop',
			subtitulo: 'Control cognitivo',
			icon: iconStop,
			gradiente: 'linear-gradient(135deg, #f43f5e, #ec4899)',
			glow: 'rgba(244,63,94,0.45)'
		}
	];
</script>

<div class="page" in:fade={{ duration: 300 }}>

	<!-- Header -->
	<header class="header">
		<div class="brain-bg" aria-hidden="true">{@html iconBrain}</div>
		<h1 class="titulo">
			Sistema de <span class="grad-text">Evaluación</span>
		</h1>
		<p class="subtitulo">Plataforma cognitiva de evaluación neuropsicológica</p>
	</header>

	<!-- Grid principal -->
	<div class="grid">

		<!-- Botón principal izquierda -->
		<button
			class="btn-principal"
			onclick={() => alNavegar('evaluacion')}
			in:fly={{ x: -40, duration: 450, delay: 100 }}
		>
			<!-- Círculos decorativos -->
			<span class="circulo c1" aria-hidden="true"></span>
			<span class="circulo c2" aria-hidden="true"></span>
			<span class="circulo c3" aria-hidden="true"></span>

			<!-- Brillo overlay -->
			<span class="brillo" aria-hidden="true"></span>

			<div class="btn-principal-inner">
				<div class="zap-wrap">
					{@html iconZap}
				</div>
				<strong class="btn-principal-titulo">Iniciar Evaluación Completa</strong>
				<p class="btn-principal-sub">
					Ejecuta todas las actividades de evaluación en secuencia automática
				</p>
			</div>
		</button>

		<!-- Tarjetas derecha -->
		<div class="tarjetas" in:fly={{ x: 40, duration: 450, delay: 150 }}>
			{#each tarjetas as t}
				<button
					class="tarjeta"
					style="--grad: {t.gradiente}; --glow: {t.glow};"
					onclick={() => alNavegar(t.id)}
				>
					<div class="tarjeta-icono">
						{@html t.icon}
					</div>
					<div class="tarjeta-texto">
						<span class="tarjeta-titulo">{t.titulo}</span>
						<span class="tarjeta-sub">{t.subtitulo}</span>
					</div>
					<div class="tarjeta-arrow" aria-hidden="true">
						{@html iconArrow}
					</div>
				</button>
			{/each}
		</div>

	</div>

	<!-- Historial -->
	<button
		class="btn-historial"
		onclick={() => alNavegar('historial')}
		in:fly={{ y: 20, duration: 350, delay: 300 }}
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
		Ver Historial de Evaluaciones
	</button>

</div>

<style>
/* ── Historial button ──────────────────────────────────────────────────────── */
.btn-historial {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	background: #fff;
	border: 1.5px solid #e2e8f0;
	border-radius: 999px;
	padding: 11px 28px;
	font-size: 0.9rem;
	font-weight: 600;
	color: #475569;
	cursor: pointer;
	transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
	align-self: center;
}
.btn-historial:hover { background: #f8fafc; border-color: #6366f1; color: #6366f1; box-shadow: 0 2px 12px rgba(99,102,241,0.15); }

/* ── Reset & base ──────────────────────────────────────────────────────────── */
:global(html), :global(body) {
	margin: 0; padding: 0; box-sizing: border-box; overflow-x: hidden;
}
:global(*, *::before, *::after) { box-sizing: inherit; }

/* ── Page ──────────────────────────────────────────────────────────────────── */
.page {
	min-height: 100vh;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 40px;
	padding: 40px 20px;
	background: radial-gradient(ellipse at 20% 10%, #f0f4ff 0%, #ffffff 40%, #f8faff 100%);
	font-family: Arial, system-ui, -apple-system, "Segoe UI", sans-serif;
	user-select: none;
	-webkit-user-select: none;
}

/* ── Header ────────────────────────────────────────────────────────────────── */
.header {
	position: relative;
	text-align: center;
	padding: 0 16px;
}
.brain-bg {
	position: absolute;
	top: 50%;  left: 50%;
	transform: translate(-50%, -50%);
	opacity: 0.04;
	pointer-events: none;
	color: #6366f1;
}
.titulo {
	font-size: clamp(1.8rem, 5vw, 2.8rem);
	font-weight: 800;
	margin: 0 0 10px;
	color: #0f172a;
	letter-spacing: -0.02em;
	position: relative;
}
.grad-text {
	background: linear-gradient(90deg, #22d3ee, #3b82f6);
	-webkit-background-clip: text;
	-webkit-text-fill-color: transparent;
	background-clip: text;
}
.subtitulo {
	margin: 0;
	color: rgba(15,23,42,0.5);
	font-size: clamp(0.85rem, 2.5vw, 1rem);
	position: relative;
}

/* ── Grid 2 columnas ───────────────────────────────────────────────────────── */
.grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 20px;
	width: 100%;
	max-width: 820px;
	align-items: stretch;
}
@media (max-width: 640px) {
	.grid { grid-template-columns: 1fr; }
}

/* ── Botón principal ───────────────────────────────────────────────────────── */
.btn-principal {
	position: relative;
	overflow: hidden;
	border: none;
	border-radius: 24px;
	background: linear-gradient(135deg, #7c3aed, #9333ea, #c026d3);
	color: white;
	cursor: pointer;
	padding: 0;
	min-height: 280px;
	display: flex;
	align-items: center;
	justify-content: center;
	box-shadow: 0 20px 50px rgba(124,58,237,0.35);
	transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.btn-principal:hover {
	transform: scale(1.025);
	box-shadow: 0 28px 60px rgba(124,58,237,0.5);
}

/* Círculos decorativos */
.circulo {
	position: absolute;
	border-radius: 50%;
	background: rgba(255,255,255,0.12);
	filter: blur(2px);
	transition: transform 0.4s ease, opacity 0.4s ease;
	pointer-events: none;
}
.c1 { width: 120px; height: 120px; top: -30px; right: -30px; }
.c2 { width: 80px;  height: 80px;  bottom: 20px; left: -20px; opacity: 0.7; }
.c3 { width: 50px;  height: 50px;  top: 40%;  right: 15%; opacity: 0.5; }

.btn-principal:hover .c1 { transform: scale(1.4); }
.btn-principal:hover .c2 { transform: scale(1.5); }
.btn-principal:hover .c3 { transform: scale(1.8); }

/* Brillo */
.brillo {
	position: absolute;
	inset: 0;
	background: linear-gradient(135deg, rgba(255,255,255,0.15) 0%, transparent 60%);
	opacity: 0;
	transition: opacity 0.3s ease;
	pointer-events: none;
}
.btn-principal:hover .brillo { opacity: 1; }

/* Contenido interior */
.btn-principal-inner {
	position: relative;
	z-index: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 16px;
	padding: 32px 24px;
	text-align: center;
}
.zap-wrap {
	width: 60px; height: 60px;
	border-radius: 16px;
	background: rgba(255,255,255,0.18);
	backdrop-filter: blur(8px);
	display: flex; align-items: center; justify-content: center;
	transition: transform 0.3s ease;
}
.btn-principal:hover .zap-wrap {
	transform: rotate(12deg) scale(1.1);
}
.btn-principal-titulo {
	font-size: clamp(1rem, 3vw, 1.25rem);
	font-weight: 700;
	line-height: 1.2;
	display: block;
}
.btn-principal-sub {
	font-size: 0.85rem;
	opacity: 0.85;
	line-height: 1.5;
	margin: 0;
}

/* ── Tarjetas ──────────────────────────────────────────────────────────────── */
.tarjetas {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.tarjeta {
	display: flex;
	align-items: center;
	gap: 16px;
	padding: 18px 20px;
	border: none;
	border-radius: 18px;
	background: var(--grad);
	color: white;
	cursor: pointer;
	text-align: left;
	box-shadow: 0 8px 24px rgba(0,0,0,0.12);
	transition: transform 0.22s ease, box-shadow 0.22s ease;
	position: relative;
	overflow: hidden;
}
.tarjeta:hover {
	transform: translateX(-4px) scale(1.03);
	box-shadow: 0 16px 40px var(--glow);
}

.tarjeta-icono {
	flex-shrink: 0;
	width: 48px; height: 48px;
	border-radius: 12px;
	background: rgba(255,255,255,0.2);
	display: flex; align-items: center; justify-content: center;
	transition: transform 0.25s ease;
}
.tarjeta:hover .tarjeta-icono {
	transform: rotate(12deg) scale(1.1);
}

.tarjeta-texto {
	flex: 1;
	display: flex;
	flex-direction: column;
	gap: 3px;
}
.tarjeta-titulo {
	font-size: 1rem;
	font-weight: 700;
	line-height: 1.2;
}
.tarjeta-sub {
	font-size: 0.8rem;
	opacity: 0.85;
}

.tarjeta-arrow {
	flex-shrink: 0;
	opacity: 0;
	transform: translateX(-6px);
	transition: opacity 0.2s ease, transform 0.2s ease;
}
.tarjeta:hover .tarjeta-arrow {
	opacity: 1;
	transform: translateX(0);
}
</style>
