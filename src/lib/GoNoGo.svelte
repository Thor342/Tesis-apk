<script lang="ts">
	import { tick } from 'svelte';
	import { fly, fade } from 'svelte/transition';
	import { Capacitor } from '@capacitor/core';
	import { Filesystem, Directory } from '@capacitor/filesystem';
	import { Share } from '@capacitor/share';
	import * as XLSX from 'xlsx';
	import { supabase } from './supabaseClient';

	// ─── Props ────────────────────────────────────────────────────────────────
	let {
		onVolver      = undefined as (() => void) | undefined,
		onTerminar    = undefined as (() => void) | undefined,
		evaluacion_id = undefined as number | undefined
	} = $props();

	// ─── Estado de guardado ───────────────────────────────────────────────────
	let guardandoResultados = $state(false);
	let errorGuardado       = $state<string | null>(null);

	// ─── Types ────────────────────────────────────────────────────────────────
	type Stimulus = { type: 'go' | 'no-go'; color: string };

	type Trial = {
		type: 'go' | 'no-go';
		reactionTime?: number;
		correct: boolean;
		anticipationError: boolean;
		block: 1 | 2 | 'practice';
		isi: number;
		clickTimestamp?: number;
		isPractice: boolean;
		errorType: 'omission' | 'commission' | 'anticipation' | null;
	};

	// ─── Constants ────────────────────────────────────────────────────────────
	const TOTAL_TRIALS   = 100;
	const PRACTICE_COUNT = 10;

	// ─── State ────────────────────────────────────────────────────────────────
	let gameState = $state<
		'start' | 'waiting' | 'stimulus' | 'feedback' |
		'practice-complete' | 'paused' | 'results'
	>('start');

	let isPracticePhase  = $state(false);
	let currentStimulus  = $state<Stimulus | null>(null);
	let startTime        = $state(0);
	let currentTrial     = $state<Trial | null>(null);
	let trials           = $state<Trial[]>([]);
	let trialIndex       = $state(0);
	let clicksFuera      = $state(0);

	// ─── Timer handles ────────────────────────────────────────────────────────
	let rafHandle:        number | null = null;
	let stimulusTimeout:  ReturnType<typeof setTimeout> | null = null;
	let feedbackTimeout:  ReturnType<typeof setTimeout> | null = null;

	// ─── Stimulus sequences ───────────────────────────────────────────────────
	let stimuli:         Stimulus[] = [];
	let practiceStimuli: Stimulus[] = [];
	let currentISI = 0;

	// ─── Derived statistics (real trials only) ────────────────────────────────
	const realTrials      = $derived(trials.filter(t => !t.isPractice));
	const goTrials        = $derived(realTrials.filter(t => t.type === 'go'));
	const noGoTrials      = $derived(realTrials.filter(t => t.type === 'no-go'));
	const goCorrect       = $derived(goTrials.filter(t => t.correct).length);
	const noGoCorrect     = $derived(noGoTrials.filter(t => t.correct).length);
	const goReactionTimes = $derived(
		goTrials
			.filter(t => t.correct && typeof t.reactionTime === 'number' && !t.anticipationError)
			.map(t => t.reactionTime!)
	);
	const avgGo           = $derived(
		goReactionTimes.length > 0
			? goReactionTimes.reduce((a, b) => a + b, 0) / goReactionTimes.length
			: null
	);
	const sdGo            = $derived(calculateSD(goReactionTimes));
	const minGo           = $derived(goReactionTimes.length > 0 ? Math.min(...goReactionTimes) : null);
	const maxGo           = $derived(goReactionTimes.length > 0 ? Math.max(...goReactionTimes) : null);
	const omissions       = $derived(goTrials.length - goCorrect);
	const commissions     = $derived(noGoTrials.filter(t => !t.correct).length);
	const anticipationErrors = $derived(realTrials.filter(t => t.anticipationError).length);
	const block1RTs       = $derived(
		realTrials.slice(0, 50)
			.filter(t => t.type === 'go' && t.correct && t.reactionTime && !t.anticipationError)
			.map(t => t.reactionTime!)
	);
	const block2RTs       = $derived(
		realTrials.slice(50, 100)
			.filter(t => t.type === 'go' && t.correct && t.reactionTime && !t.anticipationError)
			.map(t => t.reactionTime!)
	);
	const avgFirst     = $derived(block1RTs.length > 0 ? block1RTs.reduce((a, b) => a + b, 0) / block1RTs.length : null);
	const avgLast      = $derived(block2RTs.length > 0 ? block2RTs.reduce((a, b) => a + b, 0) / block2RTs.length : null);
	const totalCorrect = $derived(goCorrect + noGoCorrect);
	const accuracy     = $derived(totalCorrect / TOTAL_TRIALS * 100);

	// ─── Tab-visibility guard ─────────────────────────────────────────────────
	$effect(() => {
		const handleVisibility = () => {
			if (
				document.visibilityState === 'hidden' &&
				(gameState === 'waiting' || gameState === 'stimulus')
			) {
				clearTimers();
				gameState = 'paused';
			}
		};
		document.addEventListener('visibilitychange', handleVisibility);
		return () => document.removeEventListener('visibilitychange', handleVisibility);
	});

	// ─── Utilities ────────────────────────────────────────────────────────────
	function fmtNumber(value: number | null) {
		if (value === null) return 'N/A';
		return Number.isInteger(value) ? String(value) : value.toFixed(1);
	}

	function calculateSD(values: number[]): number {
		if (values.length < 2) return 0;
		const mean     = values.reduce((a, b) => a + b, 0) / values.length;
		const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (values.length - 1);
		return Math.sqrt(variance);
	}

	function shuffleArray<T>(array: T[]): void {
		for (let i = array.length - 1; i > 0; i--) {
			const buf = new Uint32Array(1);
			crypto.getRandomValues(buf);
			const j = buf[0] % (i + 1);
			[array[i], array[j]] = [array[j], array[i]];
		}
	}

	function noMaxConsecutiveNoGo(arr: Stimulus[], max: number): boolean {
		let count = 0;
		for (const s of arr) {
			count = s.type === 'no-go' ? count + 1 : 0;
			if (count > max) return false;
		}
		return true;
	}

	function generateStimuli(goCount: number, noGoCount: number): Stimulus[] {
		const arr: Stimulus[] = [
			...Array.from({ length: goCount },   () => ({ type: 'go'    as const, color: '#22C55E' })),
			...Array.from({ length: noGoCount }, () => ({ type: 'no-go' as const, color: '#EF4444' }))
		];
		let attempts = 0;
		do {
			shuffleArray(arr);
			attempts++;
		} while (!noMaxConsecutiveNoGo(arr, 4) && attempts < 1000);
		return arr;
	}

	function clearTimers() {
		if (rafHandle !== null)  { cancelAnimationFrame(rafHandle); rafHandle = null; }
		if (stimulusTimeout)     { clearTimeout(stimulusTimeout);   stimulusTimeout = null; }
		if (feedbackTimeout)     { clearTimeout(feedbackTimeout);   feedbackTimeout = null; }
	}

	// ─── Game flow ────────────────────────────────────────────────────────────
	function startGame() {
		clearTimers();
		practiceStimuli = generateStimuli(8, 2);
		trials          = [];
		trialIndex      = 0;
		clicksFuera     = 0;
		isPracticePhase = true;
		scheduleNextTrial();
	}

	function startRealGame() {
		clearTimers();
		stimuli         = generateStimuli(80, 20);
		trialIndex      = 0;
		isPracticePhase = false;
		scheduleNextTrial();
	}

	function scheduleNextTrial() {
		clearTimers();
		const limit = isPracticePhase ? PRACTICE_COUNT : TOTAL_TRIALS;

		if (trialIndex >= limit) {
			gameState = isPracticePhase ? 'practice-complete' : 'results';
			if (!isPracticePhase) guardarResultados();
			return;
		}

		currentStimulus = (isPracticePhase ? practiceStimuli : stimuli)[trialIndex];

		const isiDuration = Math.random() * 1500 + 1000;
		const isiStart    = performance.now();
		gameState = 'waiting';

		function waitLoop() {
			const elapsed = performance.now() - isiStart;
			if (elapsed >= isiDuration) {
				currentISI = elapsed;
				gameState  = 'stimulus';
				tick().then(() => {
					rafHandle = requestAnimationFrame(() => {
						startTime = performance.now();
						const rtLimit = 1000 + Math.random() * 500;
						stimulusTimeout = setTimeout(() => endTrial(false, false, 0), rtLimit);
					});
				});
			} else {
				rafHandle = requestAnimationFrame(waitLoop);
			}
		}
		rafHandle = requestAnimationFrame(waitLoop);
	}

	function handleClick(isGoClick: boolean) {
		if (gameState !== 'stimulus') return;
		clearTimers();
		const clickTimestamp   = Date.now();
		const rt               = performance.now() - startTime;
		const anticipationError = rt < 150;
		endTrial(true, isGoClick, rt, anticipationError, clickTimestamp);
	}

	function handleOutsideClick(event: Event) {
		if (!['waiting', 'stimulus', 'feedback'].includes(gameState)) return;
		if (!(event.target as Element).closest('.stimulus')) clicksFuera++;
	}

	function endTrial(
		clicked: boolean,
		isGoClick: boolean,
		rt: number,
		anticipationError = false,
		clickTimestamp?: number
	) {
		clearTimers();
		const isGoStimulus = currentStimulus?.type === 'go';
		const correct = !clicked
			? !isGoStimulus
			: isGoStimulus && isGoClick && !anticipationError;

		let errorType: Trial['errorType'] = null;
		if (anticipationError)   errorType = 'anticipation';
		else if (!correct)       errorType = isGoStimulus ? 'omission' : 'commission';

		const block: 1 | 2 | 'practice' = isPracticePhase
			? 'practice'
			: trialIndex < 50 ? 1 : 2;

		currentTrial = {
			type: currentStimulus?.type ?? 'go',
			reactionTime: clicked ? rt : undefined,
			correct,
			anticipationError,
			block,
			isi: currentISI,
			clickTimestamp,
			isPractice: isPracticePhase,
			errorType
		};
		trials.push(currentTrial);
		gameState = 'feedback';
		feedbackTimeout = setTimeout(() => { trialIndex++; scheduleNextTrial(); }, 800);
	}

	async function guardarResultados() {
		guardandoResultados = true;
		errorGuardado       = null;

		const { error } = await supabase.from('gonogo').insert({
			evaluacion_id:        evaluacion_id ?? null,
			precision_total:      Math.round(accuracy),
			rt_promedio:          avgGo,
			desviacion_estandar:  sdGo,
			tiempo_minimo:        minGo,
			tiempo_maximo:        maxGo,
			go_correctos:         goCorrect,
			nogo_correctos:       noGoCorrect,
			errores_omision:      omissions,
			errores_comision:     commissions,
			errores_anticipacion: anticipationErrors,
			clicks_fuera:         clicksFuera,
			promedio_bloque1:     avgFirst,
			promedio_bloque2:     avgLast
		});

		if (error) {
			console.error('Error al guardar en Supabase:', error);
			errorGuardado = 'No se pudieron guardar los resultados. Intenta de nuevo.';
		}

		guardandoResultados = false;
	}

	function resetGame() {
		clearTimers();
		trials          = [];
		trialIndex      = 0;
		clicksFuera     = 0;
		isPracticePhase = false;
		gameState       = 'start';
	}

	// ─── Reports ──────────────────────────────────────────────────────────────
	async function downloadReportPdf() {
		if (typeof window === 'undefined') return;
		const { jsPDF }   = await import('jspdf');
		const html2canvas = (await import('html2canvas')).default;
		const resultsElement = document.getElementById('results-section');
		if (!resultsElement) return;

		const canvas     = await html2canvas(resultsElement, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
		const imgData    = canvas.toDataURL('image/png');
		const doc        = new jsPDF({ unit: 'pt', format: 'a4' });
		const pageWidth  = doc.internal.pageSize.getWidth();
		const pageHeight = doc.internal.pageSize.getHeight();

		// ── Página 1: captura visual de resultados ──────────────────────────
		doc.setFontSize(18);
		doc.text('Reporte Go/No-Go', pageWidth / 2, 32, { align: 'center' });

		const imgWidth      = pageWidth - 40;
		const imgHeightFull = (canvas.height * imgWidth) / canvas.width;
		const maxImgH       = pageHeight - 55; // espacio disponible bajo el título

		if (imgHeightFull <= maxImgH) {
			// Cabe en una sola página
			doc.addImage(imgData, 'PNG', 20, 45, imgWidth, imgHeightFull);
		} else {
			// Imagen muy larga: dividirla en franjas de página
			const pxPerPt   = canvas.width / imgWidth;
			const sliceH_pt = pageHeight - 55;
			const sliceH_px = Math.round(sliceH_pt * pxPerPt);
			let   offsetY   = 0;

			while (offsetY < canvas.height) {
				const remaining = canvas.height - offsetY;
				const thisSlice = Math.min(sliceH_px, remaining);

				// Crear canvas temporal con la franja
				const tmp    = document.createElement('canvas');
				tmp.width    = canvas.width;
				tmp.height   = thisSlice;
				tmp.getContext('2d')!.drawImage(canvas, 0, -offsetY);
				const sliceData    = tmp.toDataURL('image/png');
				const sliceH_ptOut = (thisSlice * imgWidth) / canvas.width;

				doc.addImage(sliceData, 'PNG', 20, 45, imgWidth, sliceH_ptOut);
				offsetY += thisSlice;

				if (offsetY < canvas.height) doc.addPage();
			}
		}

		// ── Última página: resumen numérico ──────────────────────────────────
		doc.addPage();
		doc.setFontSize(14);
		doc.text('Resumen de Resultados', 20, 40);
		doc.setFontSize(11);

		const resumen = [
			`Generado el:              ${new Date().toLocaleString()}`,
			`Precisión:                ${fmtNumber(accuracy)} %`,
			`Tiempo Promedio GO:       ${fmtNumber(avgGo)} ms`,
			`Desviación Estándar GO:   ${fmtNumber(sdGo)} ms`,
			`Tiempo Más Rápido:        ${fmtNumber(minGo)} ms`,
			`Tiempo Más Lento:         ${fmtNumber(maxGo)} ms`,
			`GO Correctos:             ${goCorrect} / ${goTrials.length}`,
			`NO GO Correctos:          ${noGoCorrect} / ${noGoTrials.length}`,
			`Errores de Omisión:       ${omissions}`,
			`Errores de Comisión:      ${commissions}`,
			`Errores de Anticipación:  ${anticipationErrors}`,
			`Promedio Bloque 1 (1-50):   ${fmtNumber(avgFirst)} ms`,
			`Promedio Bloque 2 (51-100): ${fmtNumber(avgLast)} ms`,
		];
		resumen.forEach((line, i) => doc.text(line, 20, 68 + i * 22));

		// ── Guardar / compartir ───────────────────────────────────────────────
		if (Capacitor.isNativePlatform()) {
			const base64 = doc.output('datauristring').split(',')[1];
			try {
				// Directory.Cache no requiere permisos de almacenamiento en Android
				const result = await Filesystem.writeFile({
					path:      'reporte-go-no-go.pdf',
					data:      base64,
					directory: Directory.Cache
				});
				await Share.share({
					title:       'Reporte Go/No-Go',
					files:       [result.uri],
					dialogTitle: 'Compartir reporte'
				});
			} catch (err) {
				console.error('Error al compartir PDF:', err);
				alert('No se pudo compartir el PDF. Revisa que la app tenga permisos de almacenamiento.');
			}
		} else {
			doc.save('reporte-go-no-go.pdf');
		}
	}

	async function downloadReportExcel() {
		if (typeof window === 'undefined') return;

		const summaryData = [
			['Métrica', 'Valor'],
			['Fecha de Generación',              new Date().toLocaleString()],
			['Precisión',                         fmtNumber(accuracy)  + '%'],
			['Tiempo Promedio GO',                fmtNumber(avgGo)    + ' ms'],
			['Desviación Estándar GO (muestral)', fmtNumber(sdGo)     + ' ms'],
			['Tiempo Más Rápido',                 fmtNumber(minGo)    + ' ms'],
			['Tiempo Más Lento',                  fmtNumber(maxGo)    + ' ms'],
			['GO Correctos',                      goCorrect  + '/' + goTrials.length],
			['NO GO Correctos',                   noGoCorrect + '/' + noGoTrials.length],
			['Errores de Omisión',                omissions],
			['Errores de Comisión',               commissions],
			['Errores de Anticipación',           anticipationErrors],
			['Clicks Fuera del Estímulo',         clicksFuera],
			['Promedio Bloque 1 (1-50)',           fmtNumber(avgFirst) + ' ms'],
			['Promedio Bloque 2 (51-100)',         fmtNumber(avgLast)  + ' ms']
		];

		const trialsData: string[][] = [[
			'Ensayo', 'Tipo', 'Bloque', 'ISI (ms)', 'Correcto',
			'Tiempo Reacción (ms)', 'Timestamp Click (ms)',
			'Error Anticipación', 'Tipo de Error', 'Es Práctica'
		]];
		trials.forEach((trial, i) => {
			trialsData.push([
				String(i + 1),
				trial.type === 'go' ? 'GO' : 'NO GO',
				String(trial.block),
				trial.isi.toFixed(1),
				trial.correct ? 'Sí' : 'No',
				trial.reactionTime != null ? trial.reactionTime.toFixed(2) : 'N/A',
				trial.clickTimestamp != null ? String(trial.clickTimestamp) : 'N/A',
				trial.anticipationError ? 'Sí' : 'No',
				trial.errorType === 'omission'    ? 'Omisión'
					: trial.errorType === 'commission'  ? 'Comisión'
					: trial.errorType === 'anticipation' ? 'Anticipación'
					: 'Ninguno',
				trial.isPractice ? 'Sí' : 'No'
			]);
		});

		const wb    = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Resumen');
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trialsData),  'Ensayos Detallados');
		const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
		const blob  = new Blob([wbout], { type: 'application/octet-stream' });

		if (Capacitor.isNativePlatform()) {
			const base64 = await blobToBase64(blob);
			try {
				const result = await Filesystem.writeFile({ path: 'reporte-go-no-go.xlsx', data: base64, directory: Directory.Documents });
				await Share.share({ title: 'Reporte Go/No-Go Excel', files: [result.uri], dialogTitle: 'Compartir reporte Excel' });
			} catch (err) {
				console.error('Error al guardar/compartir Excel:', err);
				alert('Error al guardar o compartir el Excel.');
			}
		} else {
			const url = URL.createObjectURL(blob);
			const a   = document.createElement('a');
			a.href    = url;
			a.download = 'reporte-go-no-go.xlsx';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}
	}

	function blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader    = new FileReader();
			reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
			reader.onerror   = reject;
			reader.readAsDataURL(blob);
		});
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main
	class="game-container"
	class:start-theme={gameState === 'start'}
	onpointerdown={handleOutsideClick}
	onkeydown={() => {}}
	role="application"
>

	{#if gameState === 'start'}
		<div class="start-screen">

			<!-- Título -->
			<div class="start-header" in:fly={{ y: -30, duration: 600 }}>
				<h1 class="start-titulo">Test Go/No Go</h1>
				<p class="start-hint">
					<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
					Lee atentamente las instrucciones
				</p>
			</div>

			<!-- Tarjetas GO / NO GO -->
			<div class="start-grid">
				<div class="instr-card" in:fly={{ x: -50, duration: 600, delay: 200 }}>
					<div class="instr-circle circle-go">
						<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>
					</div>
					<h2 class="instr-titulo go-titulo">Círculo Verde (GO)</h2>
					<p class="instr-desc">Haz clic lo más rápido posible</p>
				</div>

				<div class="instr-card" in:fly={{ x: 50, duration: 600, delay: 300 }}>
					<div class="instr-circle circle-nogo">
						<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="1" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>
					</div>
					<h2 class="instr-titulo nogo-titulo">Círculo Rojo (NO GO)</h2>
					<p class="instr-desc">NO hagas clic</p>
				</div>
			</div>

			<!-- Banner práctica -->
			<div class="practica-banner" in:fly={{ y: 20, duration: 600, delay: 400 }}>
				<p>
					Primero realizarás
					<strong class="practica-num">{PRACTICE_COUNT} ensayos de práctica</strong>
					(no se registran).
				</p>
			</div>

			<!-- Botones acción -->
			<div class="start-botones" in:fade={{ duration: 500, delay: 500 }}>
				<button class="btn-volver-start" onclick={onVolver ?? (() => {})}>
					<span class="arrow-left-icon">
						<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
					</span>
					Volver
				</button>
				<button class="btn-iniciar-start" onclick={startGame}>
					Iniciar Test
					<span class="arrow-bounce" aria-hidden="true">→</span>
				</button>
			</div>

		</div>

	{:else if gameState === 'waiting'}
		<div class="game-area">
			<div class="fixation">+</div>
		</div>

	{:else if gameState === 'stimulus'}
		<div class="game-area">
			<div
				class="stimulus"
				style="background-color: {currentStimulus!.color}"
				onpointerdown={(e) => { e.stopPropagation(); handleClick(currentStimulus!.type === 'go'); }}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.stopPropagation();
						handleClick(currentStimulus!.type === 'go');
					}
				}}
				role="button"
				tabindex="0">
			</div>
		</div>

	{:else if gameState === 'feedback'}
		<div class="game-area">
			{#if currentTrial}
				<div class="feedback {currentTrial.correct ? 'feedback--correct' : 'feedback--incorrect'}">
					{currentTrial.correct ? '✓' : '✗'}
				</div>
			{/if}
		</div>

	{:else if gameState === 'practice-complete'}
		<div class="start-card">
			<h2>¡Práctica completada!</h2>
			<p>Realizaste los {PRACTICE_COUNT} ensayos de práctica. Ahora comenzará el test real con <strong>{TOTAL_TRIALS} ensayos</strong>. Los datos serán registrados.</p>
		</div>
		<button class="start-button" onclick={startRealGame}>Comenzar Test Real</button>

	{:else if gameState === 'paused'}
		<div class="start-card">
			<h2>Prueba pausada</h2>
			<p>Saliste de la pestaña durante un ensayo. El ensayo actual se reiniciará al continuar para no contaminar los tiempos de reacción.</p>
		</div>
		<button class="start-button" onclick={scheduleNextTrial}>Continuar</button>

	{:else if gameState === 'results'}
		<div id="results-section">
			<h2>Resultados</h2>
			{#if guardandoResultados}
				<p class="guardado-estado">Guardando resultados…</p>
			{:else if errorGuardado}
				<p class="guardado-error">{errorGuardado}
					<button onclick={guardarResultados}>Reintentar</button>
				</p>
			{:else}
				<p class="guardado-ok">Resultados guardados correctamente.</p>
			{/if}
			<div class="results-grid">
				<div class="card card--precision">
					<h3>Precisión</h3>
					<p class="big">{fmtNumber(accuracy)}%</p>
					<p class="sub">{totalCorrect} de {TOTAL_TRIALS} correctos</p>
				</div>
				<div class="card card--avg">
					<h3>Tiempo Promedio</h3>
					<p class="big">{fmtNumber(avgGo)} ms</p>
					<p class="sub">En estímulos GO correctos</p>
				</div>
				<div class="card card--sd">
					<h3>Desviación Estándar</h3>
					<p class="big">{fmtNumber(sdGo)} ms</p>
					<p class="sub">Consistencia en tiempos GO</p>
				</div>
				<div class="card card--fast">
					<h4>Más Rápida</h4>
					<p class="big">{fmtNumber(minGo)} ms</p>
				</div>
				<div class="card card--slow">
					<h4>Más Lenta</h4>
					<p class="big">{fmtNumber(maxGo)} ms</p>
				</div>
				<div class="card card--go">
					<h4>GO correctos</h4>
					<p class="big">{goCorrect}/{goTrials.length}</p>
				</div>
				<div class="card card--nogo">
					<h4>NO GO correctos</h4>
					<p class="big">{noGoCorrect}/{noGoTrials.length}</p>
				</div>
				<div class="card card--out">
					<h4>Clicks fuera del estímulo</h4>
					<p class="big">{clicksFuera}</p>
					<p class="sub">Clicks fuera del círculo</p>
				</div>
				<div class="card card--anticipation">
					<h4>Errores de Anticipación</h4>
					<p class="big">{anticipationErrors}</p>
					<p class="sub">Clicks en menos de 150 ms</p>
				</div>
			</div>

			<div class="analysis">
				<h3>Análisis de Errores</h3>
				<div class="analysis-row">
					<div class="card card--omit">
						<h4>Errores de Omisión</h4>
						<p class="big">{omissions}</p>
						<p class="sub">No hacer clic en círculos verdes</p>
					</div>
					<div class="card card--comm">
						<h4>Errores de Comisión</h4>
						<p class="big">{commissions}</p>
						<p class="sub">Hacer clic en círculos rojos</p>
					</div>
				</div>
				<h3>Análisis de Fatiga</h3>
				<div class="analysis-row">
					<div class="card card--fatigue">
						<h4>Promedio Bloque 1 (1–50)</h4>
						<p class="big">{fmtNumber(avgFirst)} ms</p>
						<p class="sub">Tiempo promedio primeros 50 ensayos</p>
					</div>
					<div class="card card--fatigue">
						<h4>Promedio Bloque 2 (51–100)</h4>
						<p class="big">{fmtNumber(avgLast)} ms</p>
						<p class="sub">Tiempo promedio últimos 50 ensayos</p>
					</div>
				</div>
			</div>
		</div>

		<div class="report-footer">
			<div class="btn-row">
				<button class="download-button" onclick={downloadReportPdf}>Descargar PDF</button>
				<button class="download-button" onclick={downloadReportExcel}>Descargar Excel</button>
			</div>
			<div class="btn-row">
				<button class="btn-secondary" onclick={resetGame}>Reiniciar</button>
				{#if onVolver}
					<button class="btn-secondary" onclick={onVolver}>← Volver al menú</button>
				{/if}
				{#if onTerminar}
					<button class="start-button" onclick={onTerminar}>Continuar evaluación →</button>
				{/if}
			</div>
		</div>
	{/if}

</main>

<style>
:global(html), :global(body) {
	padding: 0; margin: 0; box-sizing: border-box; overflow-x: hidden;
}
:global(*), :global(*::before), :global(*::after) { box-sizing: inherit; }

.game-container {
	display: flex; flex-direction: column; align-items: center; justify-content: center;
	min-height: 100vh; padding: 40px 16px;
	font-family: Arial, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	background: radial-gradient(circle at top, #f5f7ff, #e2e8f0);
	user-select: none; -webkit-user-select: none;
}

/* ── Tema oscuro solo en pantalla de inicio ────────────────────────────────── */
.start-theme {
	background: linear-gradient(135deg, #059669 0%, #0f766e 50%, #0e7490 100%);
	justify-content: flex-start;
	padding-top: 48px;
}

/* ── Layout de inicio ─────────────────────────────────────────────────────── */
.start-screen {
	display: flex; flex-direction: column; align-items: center;
	gap: 28px; width: 100%; max-width: 720px;
}

.start-header { text-align: center; }

.start-titulo {
	font-size: clamp(2.4rem, 8vw, 4.5rem);
	font-weight: 900;
	color: white;
	margin: 0 0 10px;
	letter-spacing: -0.02em;
	text-shadow: 0 4px 20px rgba(0,0,0,0.25);
}
.start-hint {
	display: inline-flex; align-items: center; gap: 6px;
	color: #d1fae5; font-size: 1rem; margin: 0;
}

/* ── Grid tarjetas instrucciones ──────────────────────────────────────────── */
.start-grid {
	display: grid; grid-template-columns: 1fr 1fr; gap: 16px; width: 100%;
}
@media (max-width: 520px) { .start-grid { grid-template-columns: 1fr; } }

.instr-card {
	background: white; border-radius: 24px; padding: 32px 20px;
	display: flex; flex-direction: column; align-items: center; gap: 14px;
	box-shadow: 0 20px 40px rgba(0,0,0,0.15);
	transition: transform 0.3s ease, box-shadow 0.3s ease;
	cursor: default;
}
.instr-card:hover {
	transform: scale(1.05);
	box-shadow: 0 28px 50px rgba(0,0,0,0.22);
}

.instr-circle {
	width: 112px; height: 112px; border-radius: 50%;
	display: flex; align-items: center; justify-content: center;
	transition: transform 0.5s ease;
}
.instr-card:hover .instr-circle { transform: rotate(360deg) scale(1.2); }

.circle-go   { background: linear-gradient(135deg, #34d399, #16a34a); }
.circle-nogo { background: linear-gradient(135deg, #f87171, #e11d48); }

.instr-titulo {
	font-size: clamp(1.1rem, 3vw, 1.4rem);
	font-weight: 900; margin: 0; text-align: center;
}
.go-titulo   { color: #065f46; }
.nogo-titulo { color: #991b1b; }

.instr-desc {
	font-size: clamp(0.9rem, 2.5vw, 1.1rem);
	color: #475569; margin: 0; text-align: center;
}

/* ── Banner práctica ──────────────────────────────────────────────────────── */
.practica-banner {
	background: rgba(255,255,255,0.95);
	backdrop-filter: blur(8px);
	border-radius: 16px; padding: 22px 28px;
	width: 100%; text-align: center;
	box-shadow: 0 8px 24px rgba(0,0,0,0.12);
}
.practica-banner p {
	margin: 0; font-size: clamp(1rem, 3vw, 1.25rem); color: #334155;
}
.practica-num {
	font-size: clamp(1.1rem, 3.5vw, 1.5rem);
	font-weight: 900; color: #065f46;
}

/* ── Botones inicio ───────────────────────────────────────────────────────── */
.start-botones {
	display: grid; grid-template-columns: 1fr 1fr;
	gap: 14px; width: 100%; max-width: 480px;
}

.btn-volver-start {
	display: flex; align-items: center; justify-content: center; gap: 8px;
	padding: 18px 0; font-size: 1.1rem; font-weight: 700;
	border-radius: 16px; border: 2px solid white;
	background: white; color: #1e293b; cursor: pointer;
	transition: background 0.25s ease, border-color 0.25s ease, transform 0.2s ease;
}
.btn-volver-start:hover {
	background: #f1f5f9; border-color: #cbd5e1; transform: translateX(-2px);
}
.arrow-left-icon { display: flex; transition: transform 0.25s ease; }
.btn-volver-start:hover .arrow-left-icon { transform: translateX(-4px); }

.btn-iniciar-start {
	display: flex; align-items: center; justify-content: center; gap: 10px;
	padding: 18px 0; font-size: 1.1rem; font-weight: 700;
	border-radius: 16px; border: none;
	background: linear-gradient(135deg, #0f172a, #1e293b);
	color: white; cursor: pointer;
	box-shadow: 0 8px 24px rgba(0,0,0,0.3);
	transition: transform 0.25s ease, box-shadow 0.25s ease, background 0.25s ease;
}
.btn-iniciar-start:hover {
	background: linear-gradient(135deg, #000, #0f172a);
	transform: scale(1.05); box-shadow: 0 14px 32px rgba(0,0,0,0.4);
}

.arrow-bounce {
	display: inline-block;
	animation: bounce-x 1.5s ease-in-out infinite;
}
@keyframes bounce-x {
	0%, 100% { transform: translateX(0); }
	50%       { transform: translateX(6px); }
}

/* ── .start-card sigue usándose en pausa y práctica completa ─────────────── */
.start-card {
	background: rgba(255,255,255,0.92); border-radius: 20px;
	box-shadow: 0 20px 40px rgba(15,23,42,0.15); padding: 32px;
	max-width: 520px; width: 100%; text-align: left;
}

.btn-row {
	display: flex; flex-wrap: wrap; gap: 12px;
	justify-content: center; align-items: center; margin-top: 24px;
}

.start-button {
	padding: 14px 32px; font-size: 1.1rem; border-radius: 999px; border: none;
	background: linear-gradient(135deg, #1f2937, #0f172a); color: white;
	cursor: pointer; box-shadow: 0 12px 18px rgba(15,23,42,0.25);
	transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.start-button:hover  { transform: translateY(-1px); box-shadow: 0 16px 24px rgba(15,23,42,0.3); }
.start-button:active { transform: translateY(0);    box-shadow: 0 10px 14px rgba(15,23,42,0.2); }

.btn-secondary {
	padding: 12px 24px; font-size: 1rem; border-radius: 999px;
	border: 2px solid rgba(15,23,42,0.2); background: rgba(255,255,255,0.8);
	cursor: pointer; transition: transform 0.15s ease, background 0.15s ease;
}
.btn-secondary:hover { background: rgba(255,255,255,1); transform: translateY(-1px); }

.download-button {
	padding: 10px 20px; font-size: 1rem; border-radius: 999px; border: none;
	background: linear-gradient(135deg, #2563eb, #4338ca); color: white;
	cursor: pointer; box-shadow: 0 10px 18px rgba(15,23,42,0.2);
	transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.download-button:hover  { transform: translateY(-1px); box-shadow: 0 14px 22px rgba(15,23,42,0.28); }
.download-button:active { transform: translateY(0);    box-shadow: 0 10px 14px rgba(15,23,42,0.2); }

.game-area {
	width: min(400px, 100%); max-width: 100%; height: min(220px, 40vh);
	max-height: 240px; display: flex; justify-content: center; align-items: center;
	padding: 8px; box-sizing: border-box;
}
.fixation { font-size: 3rem; font-weight: 300; color: rgba(15,23,42,0.4); line-height: 1; }
.stimulus {
	width: min(150px, 60vw); height: min(150px, 60vw); border-radius: 50%;
	cursor: pointer; box-shadow: 0 6px 14px rgba(0,0,0,0.2);
	touch-action: manipulation; user-select: none; -webkit-user-select: none;
}
.feedback          { font-size: 3.5rem; line-height: 1; }
.feedback--correct   { color: #16a34a; }
.feedback--incorrect { color: #dc2626; }

.results-grid {
	display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 16px; width: 100%; max-width: 900px; margin: 16px 0;
}
.card {
	padding: 16px; border-radius: 16px; background: rgba(255,255,255,0.9);
	box-shadow: 0 10px 30px rgba(0,0,0,0.08); word-break: break-word; box-sizing: border-box;
}
.card h3, .card h4 { margin: 0 0 8px; font-weight: 600; }
.card .big { font-size: 2.4rem; margin: 0; }
.card .sub { margin: 4px 0 0; color: rgba(0,0,0,0.6); }

.card--precision   { background: linear-gradient(135deg, #DBEAFE, #BFDBFE); }
.card--avg         { background: linear-gradient(135deg, #F3E8FF, #E9D5FF); }
.card--sd          { background: linear-gradient(135deg, #A855F7, #7C3AED); }
.card--fast        { background: linear-gradient(135deg, #DCFCE7, #BBF7D0); }
.card--slow        { background: linear-gradient(135deg, #FEE2E2, #FECACA); }
.card--go          { background: linear-gradient(135deg, #D1FAE5, #A7F3D0); }
.card--nogo        { background: linear-gradient(135deg, #DBEAFE, #BFDBFE); }
.card--out         { background: linear-gradient(135deg, #F1F5F9, #E2E8F0); }
.card--anticipation{ background: linear-gradient(135deg, #F59E0B, #D97706); }
.card--omit        { background: linear-gradient(135deg, #FEF3C7, #FDE68A); }
.card--comm        { background: linear-gradient(135deg, #FEE2E2, #FECACA); }
.card--fatigue     { background: linear-gradient(135deg, #6B7280, #4B5563); }

.analysis { width: 100%; max-width: 900px; margin-top: 24px; }
.analysis-row {
	display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;
}

.report-footer {
	display: flex; flex-direction: column; align-items: center;
	gap: 12px; width: 100%; max-width: 900px; margin-top: 24px;
}

.guardado-estado { color: rgba(15,23,42,0.5); font-size: 0.9rem; margin: 0 0 8px; }
.guardado-ok     { color: #16a34a; font-size: 0.9rem; margin: 0 0 8px; }
.guardado-error  {
	color: #dc2626; font-size: 0.9rem; margin: 0 0 8px;
	display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.guardado-error button {
	padding: 4px 12px; font-size: 0.85rem; border-radius: 999px;
	border: 1px solid #dc2626; background: transparent; color: #dc2626; cursor: pointer;
}

@media (max-width: 768px) {
	.game-container { padding: 20px; }
	.game-area { width: min(340px, 100%); height: min(200px, 35vh); }
	.stimulus  { width: 120px; height: 120px; }
	.fixation, .feedback { font-size: 2.5rem; }
	.results-grid { grid-template-columns: 1fr; max-width: 100%; gap: 12px; }
	.card { padding: 12px; }
	.card .big { font-size: 2rem; }
	.analysis-row { grid-template-columns: 1fr; gap: 12px; }
}
</style>
