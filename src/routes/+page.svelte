<script lang="ts">
	import { tick } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import { Filesystem, Directory } from '@capacitor/filesystem';
	import { Share } from '@capacitor/share';
	import * as XLSX from 'xlsx';

	// ─── Types ────────────────────────────────────────────────────────────────
	type Stimulus = { type: 'go' | 'no-go'; color: string };

	type Trial = {
		type: 'go' | 'no-go';
		reactionTime?: number;
		correct: boolean;
		anticipationError: boolean;
		block: 1 | 2 | 'practice';
		isi: number;              // Actual ISI elapsed (ms)
		clickTimestamp?: number;  // Absolute timestamp: Date.now() at click
		isPractice: boolean;
		errorType: 'omission' | 'commission' | 'anticipation' | null;
	};

	// ─── Constants ────────────────────────────────────────────────────────────
	const TOTAL_TRIALS = 100;
	const PRACTICE_COUNT = 10;

	// ─── Mutable state ────────────────────────────────────────────────────────
let gameState = $state<
		'start' | 'waiting' | 'stimulus' | 'feedback' |
		'practice-complete' | 'paused' | 'results'
	>('start');

	let isPracticePhase = $state(false);
	let currentStimulus = $state<Stimulus | null>(null);
	let startTime = $state(0);       // performance.now() at stimulus onset
	let currentTrial = $state<Trial | null>(null);
	let trials = $state<Trial[]>([]);
	let trialIndex = $state(0);
	let clicksFuera = $state(0);

	// ─── Timer handles ────────────────────────────────────────────────────────
	let rafHandle: number | null = null;
	let stimulusTimeout: ReturnType<typeof setTimeout> | null = null;
	let feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

	// ─── Stimulus sequences ───────────────────────────────────────────────────
	let stimuli: Stimulus[] = [];
	let practiceStimuli: Stimulus[] = [];
	let currentISI = 0; // Actual ISI of the ongoing trial (ms)

	// ─── $derived statistics (real trials only) ───────────────────────────────
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
	const avgFirst        = $derived(block1RTs.length > 0 ? block1RTs.reduce((a, b) => a + b, 0) / block1RTs.length : null);
	const avgLast         = $derived(block2RTs.length > 0 ? block2RTs.reduce((a, b) => a + b, 0) / block2RTs.length : null);
	const totalCorrect    = $derived(goCorrect + noGoCorrect);
	const accuracy        = $derived(totalCorrect / TOTAL_TRIALS * 100);

	// ─── Tab-visibility guard ─────────────────────────────────────────────────
	// Pauses the test when user leaves the tab to avoid contaminating RTs.
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

	// Sample standard deviation (n–1 denominator) for scientific accuracy.
	function calculateSD(values: number[]): number {
		if (values.length < 2) return 0;
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (values.length - 1);
		return Math.sqrt(variance);
	}

	// Fisher-Yates with crypto.getRandomValues for cryptographic-quality randomness.
	function shuffleArray<T>(array: T[]): void {
		for (let i = array.length - 1; i > 0; i--) {
			const buf = new Uint32Array(1);
			crypto.getRandomValues(buf);
			const j = buf[0] % (i + 1);
			[array[i], array[j]] = [array[j], array[i]];
		}
	}

	// Validates that no more than `max` No-Go stimuli appear consecutively.
	function noMaxConsecutiveNoGo(arr: Stimulus[], max: number): boolean {
		let count = 0;
		for (const s of arr) {
			count = s.type === 'no-go' ? count + 1 : 0;
			if (count > max) return false;
		}
		return true;
	}

	// Generates a shuffled sequence with at most 4 consecutive No-Go trials.
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
		if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
		if (stimulusTimeout)   { clearTimeout(stimulusTimeout);  stimulusTimeout = null; }
		if (feedbackTimeout)   { clearTimeout(feedbackTimeout);  feedbackTimeout = null; }
	}

	// ─── Game flow ────────────────────────────────────────────────────────────
	function startGame() {
		clearTimers();
		practiceStimuli = generateStimuli(8, 2);
		trials     = [];
		trialIndex = 0;
		clicksFuera = 0;
		isPracticePhase = true;
		scheduleNextTrial();
	}

	function startRealGame() {
		clearTimers();
		stimuli    = generateStimuli(80, 20);
		trialIndex = 0;
		isPracticePhase = false;
		scheduleNextTrial();
	}

	function scheduleNextTrial() {
		clearTimers();

		const limit = isPracticePhase ? PRACTICE_COUNT : TOTAL_TRIALS;

		if (trialIndex >= limit) {
			gameState = isPracticePhase ? 'practice-complete' : 'results';
			return;
		}

		currentStimulus = (isPracticePhase ? practiceStimuli : stimuli)[trialIndex];

		const isiDuration = Math.random() * 1500 + 1000; // 1 000–2 500 ms
		const isiStart    = performance.now();

		gameState = 'waiting';

		// rAF-based ISI loop: stimulus onset is aligned to display V-Sync,
		// eliminating setTimeout jitter at the critical timing boundary.
		function waitLoop() {
			const elapsed = performance.now() - isiStart;
			if (elapsed >= isiDuration) {
				currentISI = elapsed; // record actual ISI
				gameState  = 'stimulus';
				// Wait for Svelte to render the stimulus, then capture startTime
				// in the very next animation frame (after paint).
				tick().then(() => {
					rafHandle = requestAnimationFrame(() => {
						startTime = performance.now();
						const rtLimit = 1000 + Math.random() * 500; // 1 000–1 500 ms
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

		const clickTimestamp = Date.now(); // absolute wall-clock timestamp
		const rt = performance.now() - startTime;
		const anticipationError = rt < 150;

		endTrial(true, isGoClick, rt, anticipationError, clickTimestamp);
	}

	function handleOutsideClick(event: Event) {
		if (!['waiting', 'stimulus', 'feedback'].includes(gameState)) return;
		if (!(event.target as Element).closest('.stimulus')) {
			clicksFuera++;
		}
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
		if (anticipationError) {
			errorType = 'anticipation';
		} else if (!correct) {
			errorType = isGoStimulus ? 'omission' : 'commission';
		}

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

		feedbackTimeout = setTimeout(() => {
			trialIndex++;
			scheduleNextTrial();
		}, 800);
	}

	function resetGame() {
		clearTimers();
		trials      = [];
		trialIndex  = 0;
		clicksFuera = 0;
		isPracticePhase = false;
		gameState   = 'start';
	}

	// ─── Reports ──────────────────────────────────────────────────────────────
	// Both PDF and Excel consume the same $derived values used in the UI,
	// guaranteeing a single source of truth across all outputs.

	async function downloadReportPdf() {
		if (typeof window === 'undefined') return;

		const { jsPDF } = await import('jspdf');
		const html2canvas = (await import('html2canvas')).default;

		const resultsElement = document.getElementById('results-section');
		if (!resultsElement) return;

		const canvas = await html2canvas(resultsElement, {
			scale: 2,
			useCORS: true,
			backgroundColor: '#ffffff'
		});

		const imgData = canvas.toDataURL('image/png');
		const doc     = new jsPDF({ unit: 'pt', format: 'a4' });

		const pageWidth  = doc.internal.pageSize.getWidth();
		const pageHeight = doc.internal.pageSize.getHeight();
		const imgWidth   = pageWidth - 40;
		const imgHeight  = (canvas.height * imgWidth) / canvas.width;

		if (imgHeight > pageHeight - 60) {
			const scale = (pageHeight - 60) / imgHeight;
			doc.addImage(imgData, 'PNG', 20, 40, imgWidth * scale, imgHeight * scale);
		} else {
			doc.addImage(imgData, 'PNG', 20, 40, imgWidth, imgHeight);
		}

		doc.setFontSize(16);
		doc.text('Reporte Go/No-Go', 20, 30);
		doc.setFontSize(10);
		doc.text('Generado el: ' + new Date().toLocaleString(), 20, pageHeight - 20);
		doc.text('Precisión: '                 + fmtNumber(accuracy)  + '%',  20, pageHeight - 35);
		doc.text('Tiempo Promedio GO: '         + fmtNumber(avgGo)    + ' ms', 20, pageHeight - 50);
		doc.text('Desviación Estándar GO: '     + fmtNumber(sdGo)     + ' ms', 20, pageHeight - 65);
		doc.text('Errores de Anticipación: '    + anticipationErrors,           20, pageHeight - 80);
		doc.text('Promedio Bloque 1: '          + fmtNumber(avgFirst) + ' ms', 20, pageHeight - 95);
		doc.text('Promedio Bloque 2: '          + fmtNumber(avgLast)  + ' ms', 20, pageHeight - 110);

		if (Capacitor.isNativePlatform()) {
			const base64 = doc.output('datauristring').split(',')[1];
			try {
				const result = await Filesystem.writeFile({
					path: 'reporte-go-no-go.pdf',
					data: base64,
					directory: Directory.Documents
				});
				await Share.share({ title: 'Reporte Go/No-Go', files: [result.uri], dialogTitle: 'Compartir reporte' });
			} catch (err) {
				console.error('Error al guardar/compartir PDF:', err);
				alert('Error al guardar o compartir el PDF.');
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

		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Resumen');
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(trialsData),  'Ensayos Detallados');

		const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
		const blob  = new Blob([wbout], { type: 'application/octet-stream' });

		if (Capacitor.isNativePlatform()) {
			const base64 = await blobToBase64(blob);
			try {
				const result = await Filesystem.writeFile({
					path: 'reporte-go-no-go.xlsx',
					data: base64,
					directory: Directory.Documents
				});
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
			const reader = new FileReader();
			reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
			reader.onerror   = reject;
			reader.readAsDataURL(blob);
		});
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main class="game-container" onpointerdown={handleOutsideClick} onkeydown={() => {}} role="application">

	{#if gameState === 'start'}

		<div class="start-card">
			<h1>Test Go/No Go</h1>
			<div class="instructions">
				<h2>Instrucciones:</h2>
				<div class="instruction-item">
					<span class="dot dot--go"></span>
					<div><strong>Círculo Verde (GO):</strong> Haz clic lo más rápido posible</div>
				</div>
				<div class="instruction-item">
					<span class="dot dot--nogo"></span>
					<div><strong>Círculo Rojo (NO GO):</strong> NO hagas clic</div>
				</div>
				<hr />
				<p class="instructions-footer">
					Primero realizarás <strong>{PRACTICE_COUNT} ensayos de práctica</strong> (no se registran),
					seguidos de <strong>{TOTAL_TRIALS} ensayos reales</strong>.
					Mantén la concentración durante toda la prueba.
				</p>
			</div>
		</div>
		<button class="start-button" onclick={startGame}>Iniciar Test</button>

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
			<div style="display: flex; gap: 12px;">
				<button class="download-button" onclick={downloadReportPdf}>Descargar PDF</button>
				<button class="download-button" onclick={downloadReportExcel}>Descargar Excel</button>
			</div>
			<button onclick={resetGame}>Reiniciar</button>
		</div>

	{/if}

</main>

<style>

:global(html), :global(body) {
	padding: 0;
	margin: 0;
	box-sizing: border-box;
	overflow-x: hidden;
}

:global(*), :global(*::before), :global(*::after) {
	box-sizing: inherit;
}

.game-container {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	min-height: 100vh;
	padding: 40px 16px;
	font-family: Arial, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	background: radial-gradient(circle at top, #f5f7ff, #e2e8f0);
	/* Prevent text selection during rapid clicking */
	user-select: none;
	-webkit-user-select: none;
}

.start-card {
	background: rgba(255, 255, 255, 0.92);
	border-radius: 20px;
	box-shadow: 0 20px 40px rgba(15, 23, 42, 0.15);
	padding: 32px;
	max-width: 520px;
	width: 100%;
	text-align: left;
}

.start-card h1 {
	font-size: 2.4rem;
	margin: 0 0 18px;
	text-align: center;
}

.start-card h2 {
	margin: 0 0 12px;
}

.start-card p {
	line-height: 1.6;
	color: rgba(15, 23, 42, 0.8);
}

.instructions {
	margin-top: 8px;
}

.instructions h2 {
	margin: 0 0 16px;
	font-size: 1.25rem;
}

.instruction-item {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	margin-bottom: 12px;
}

.dot {
	width: 18px;
	height: 18px;
	border-radius: 50%;
	flex-shrink: 0;
	margin-top: 4px;
}

.dot--go   { background: #22C55E; }
.dot--nogo { background: #EF4444; }

.instructions-footer {
	margin: 16px 0 0;
	color: rgba(15, 23, 42, 0.75);
	line-height: 1.5;
}

.trial-progress {
	font-size: 0.9rem;
	font-weight: 600;
	letter-spacing: 0.03em;
	color: rgba(15, 23, 42, 0.5);
	margin-bottom: 8px;
	text-align: center;
}

.start-button {
	margin-top: 24px;
	padding: 14px 32px;
	font-size: 1.1rem;
	border-radius: 999px;
	border: none;
	background: linear-gradient(135deg, #1f2937, #0f172a);
	color: white;
	cursor: pointer;
	box-shadow: 0 12px 18px rgba(15, 23, 42, 0.25);
	transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.start-button:hover {
	transform: translateY(-1px);
	box-shadow: 0 16px 24px rgba(15, 23, 42, 0.3);
}

.start-button:active {
	transform: translateY(0);
	box-shadow: 0 10px 14px rgba(15, 23, 42, 0.2);
}

.download-button {
	padding: 10px 20px;
	font-size: 1rem;
	border-radius: 999px;
	border: none;
	background: linear-gradient(135deg, #2563eb, #4338ca);
	color: white;
	cursor: pointer;
	box-shadow: 0 10px 18px rgba(15, 23, 42, 0.2);
	transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.download-button:hover {
	transform: translateY(-1px);
	box-shadow: 0 14px 22px rgba(15, 23, 42, 0.28);
}

.download-button:active {
	transform: translateY(0);
	box-shadow: 0 10px 14px rgba(15, 23, 42, 0.2);
}

.game-area {
	width: min(400px, 100%);
	max-width: 100%;
	height: min(220px, 40vh);
	max-height: 240px;
	display: flex;
	justify-content: center;
	align-items: center;
	padding: 8px;
	box-sizing: border-box;
}

/* Fixation cross shown during ISI */
.fixation {
	font-size: 3rem;
	font-weight: 300;
	color: rgba(15, 23, 42, 0.4);
	line-height: 1;
}

.stimulus {
	width: min(150px, 60vw);
	height: min(150px, 60vw);
	border-radius: 50%;
	cursor: pointer;
	box-shadow: 0 6px 14px rgba(0, 0, 0, 0.2);
	/* Eliminate the 300 ms tap-delay on mobile browsers */
	touch-action: manipulation;
	user-select: none;
	-webkit-user-select: none;
}

.feedback {
	font-size: 3.5rem;
	line-height: 1;
}

.feedback--correct   { color: #16a34a; }
.feedback--incorrect { color: #dc2626; }

button {
	padding: 10px 20px;
	font-size: 1.2rem;
	cursor: pointer;
	border-radius: 6px;
	border: 1px solid rgba(0, 0, 0, 0.1);
	background: #fff;
}

.results-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 16px;
	width: 100%;
	max-width: 900px;
	margin: 16px 0;
}

.card {
	padding: 16px;
	border-radius: 16px;
	background: rgba(255, 255, 255, 0.9);
	box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
	word-break: break-word;
	box-sizing: border-box;
}

.card h3,
.card h4 {
	margin: 0 0 8px;
	font-weight: 600;
}

.card .big {
	font-size: 2.4rem;
	margin: 0;
}

.card .sub {
	margin: 4px 0 0;
	color: rgba(0, 0, 0, 0.6);
}

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

.analysis {
	width: 100%;
	max-width: 900px;
	margin-top: 24px;
}

.analysis-row {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 16px;
}

.report-footer {
	display: flex;
	justify-content: space-between;
	align-items: center;
	width: 100%;
	max-width: 900px;
	margin-top: 24px;
}

@media (max-width: 640px) {
	.report-footer {
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
	}
}

@media (max-width: 768px) {
	.game-container {
		padding: 20px;
		height: auto;
		min-height: 100vh;
	}

	.game-area {
		width: min(340px, 100%);
		height: min(200px, 35vh);
	}

	.stimulus {
		width: 120px;
		height: 120px;
	}

	.fixation, .feedback {
		font-size: 2.5rem;
	}

	button {
		padding: 12px 24px;
		font-size: 1rem;
		min-width: 120px;
	}

	.results-grid {
		grid-template-columns: 1fr;
		max-width: 100%;
		gap: 12px;
	}

	.card {
		padding: 12px;
	}

	.card .big {
		font-size: 2rem;
	}

	.analysis-row {
		grid-template-columns: 1fr;
		gap: 12px;
	}

	.report-footer {
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}
}

</style>
