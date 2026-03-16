<script lang="ts">
	import { tick } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import { Filesystem, Directory } from '@capacitor/filesystem';
	import { Share } from '@capacitor/share';

	type Stimulus = { type: 'go' | 'no-go'; color: string };

	let gameState = $state<'start' | 'waiting' | 'stimulus' | 'feedback' | 'results'>('start');

	let currentStimulus = $state<Stimulus | null>(null);

	let startTime = $state(0);
	let reactionTime = $state(0);

	let trials = $state<{
		type: 'go' | 'no-go';
		reactionTime?: number;
		correct: boolean;
		anticipationError: boolean;
		block: 1 | 2;
	}[]>([]);

	let currentTrial = $state<{ type: 'go' | 'no-go'; reactionTime?: number; correct: boolean; anticipationError: boolean; block: 1 | 2 } | null>(null);

	let trialIndex = $state(0);

	let totalTrials = 100;

	let score = $state(0);
	let clicksFuera = $state(0);

	let responseTimeLimit = $state(0);

	let waitingTimeout: ReturnType<typeof setTimeout> | null = null;
	let stimulusTimeout: ReturnType<typeof setTimeout> | null = null;

	function fmtNumber(value: number | null) {
		if (value === null) return 'N/A';
		return Number.isInteger(value) ? String(value) : value.toFixed(1);
	}

	function calculateSD(values: number[]): number {
		if (values.length === 0) return 0;
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
		return Math.sqrt(variance);
	}

	function shuffleArray<T>(array: T[]): void {
		for (let i = array.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[array[i], array[j]] = [array[j], array[i]];
		}
	}

	let stimuli: Stimulus[] = [];

	function startGame() {
		clearTimers();
		// Generar 100 ensayos: 80% Go, 20% No-Go
		const goStimuli = Array.from({ length: 80 }, () => ({ type: 'go' as const, color: '#22C55E' }));
		const noGoStimuli = Array.from({ length: 20 }, () => ({ type: 'no-go' as const, color: '#EF4444' }));
		stimuli = [...goStimuli, ...noGoStimuli];
		shuffleArray(stimuli);
		gameState = 'waiting';
		trials = [];
		trialIndex = 0;
		score = 0;
		clicksFuera = 0;
		nextTrial();
	}

	function clearTimers() {
		if (waitingTimeout) clearTimeout(waitingTimeout);
		if (stimulusTimeout) clearTimeout(stimulusTimeout);
		waitingTimeout = null;
		stimulusTimeout = null;
	}

	function nextTrial() {
		clearTimers();

		if (trialIndex >= totalTrials) {
			gameState = 'results';
			return;
		}

		currentStimulus = stimuli[trialIndex];

		gameState = 'waiting';

		waitingTimeout = setTimeout(() => {
			gameState = 'stimulus';

			// Esperar a que Svelte renderice el cambio de estado
			tick().then(() => {
				// Esperar al siguiente frame para asegurar que el estímulo sea visible
				requestAnimationFrame(() => {
					startTime = performance.now();

					responseTimeLimit = 1500 + Math.random() * 1000;

					stimulusTimeout = setTimeout(() => {
						endTrial(false, false, 0);
					}, responseTimeLimit);
				});
			});
		}, Math.random() * 1500 + 1000);
	}

	function handleClick(isGoClick: boolean) {
		if (gameState !== 'stimulus') return;

		if (stimulusTimeout) clearTimeout(stimulusTimeout);

		reactionTime = performance.now() - startTime;

		const anticipationError = reactionTime < 150;

		endTrial(true, isGoClick, reactionTime, anticipationError);
	}

	function handleOutsideClick(event: Event) {
		if (!['waiting', 'stimulus', 'feedback'].includes(gameState)) return;
		if (!(event.target as Element).closest('.stimulus')) {
			clicksFuera++;
		}
	}

	function endTrial(clicked: boolean, isGoClick: boolean, rt: number, anticipationError: boolean = false) {
		clearTimers();

		const isGoStimulus = currentStimulus?.type === 'go';

		const correct = !clicked ? !isGoStimulus : (isGoStimulus && isGoClick && !anticipationError);

		const block: 1 | 2 = trialIndex < 50 ? 1 : 2;

		currentTrial = {
			type: currentStimulus?.type ?? 'no-go',
			reactionTime: clicked ? rt : undefined,
			correct,
			anticipationError,
			block
		};

		trials.push(currentTrial);

		if (correct) score++;

		gameState = 'feedback';

		setTimeout(() => {
			trialIndex++;
			nextTrial();
		}, 1000);
	}

	function resetGame() {
		clearTimers();
		gameState = 'start';
	}

	async function downloadReportPdf() {
		if (typeof window === 'undefined') return;

		// Calcular métricas
		const goTrials = trials.filter(t => t.type === 'go');
		const noGoTrials = trials.filter(t => t.type === 'no-go');
		const goCorrect = goTrials.filter(t => t.correct).length;
		const goReactionTimes = goTrials
			.filter(t => t.correct && typeof t.reactionTime === 'number' && !t.anticipationError)
			.map(t => t.reactionTime!)
		;
		const avgGo = goReactionTimes.length > 0 ? goReactionTimes.reduce((a, b) => a + b, 0) / goReactionTimes.length : null;
		const sdGo = calculateSD(goReactionTimes);
		const anticipationErrors = trials.filter(t => t.anticipationError).length;
		const first50 = trials.slice(0, 50).filter(t => t.correct && t.reactionTime && !t.anticipationError).map(t => t.reactionTime!);
		const last50 = trials.slice(50, 100).filter(t => t.correct && t.reactionTime && !t.anticipationError).map(t => t.reactionTime!);
		const avgFirst = first50.length > 0 ? first50.reduce((a, b) => a + b, 0) / first50.length : null;
		const avgLast = last50.length > 0 ? last50.reduce((a, b) => a + b, 0) / last50.length : null;

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
		const doc = new jsPDF({ unit: 'pt', format: 'a4' });

		const pageWidth = doc.internal.pageSize.getWidth();
		const pageHeight = doc.internal.pageSize.getHeight();
		const imgWidth = pageWidth - 40; // Margins
		const imgHeight = (canvas.height * imgWidth) / canvas.width;

		if (imgHeight > pageHeight - 60) {
			// If too tall, scale down
			const scale = (pageHeight - 60) / imgHeight;
			doc.addImage(imgData, 'PNG', 20, 40, imgWidth * scale, imgHeight * scale);
		} else {
			doc.addImage(imgData, 'PNG', 20, 40, imgWidth, imgHeight);
		}

		doc.setFontSize(16);
		doc.text('Reporte Go/No-Go', 20, 30);
		doc.setFontSize(10);
		doc.text('Generado el: ' + new Date().toLocaleString(), 20, pageHeight - 20);
		doc.text('Precisión: ' + fmtNumber(score / totalTrials * 100) + '%', 20, pageHeight - 35);
		doc.text('Tiempo Promedio GO: ' + fmtNumber(avgGo) + ' ms', 20, pageHeight - 50);
		doc.text('Desviación Estándar GO: ' + fmtNumber(sdGo) + ' ms', 20, pageHeight - 65);
		doc.text('Errores de Anticipación: ' + anticipationErrors, 20, pageHeight - 80);
		doc.text('Promedio Bloque 1: ' + fmtNumber(avgFirst) + ' ms', 20, pageHeight - 95);
		doc.text('Promedio Bloque 2: ' + fmtNumber(avgLast) + ' ms', 20, pageHeight - 110);

		if (Capacitor.isNativePlatform()) {
			// For mobile (Capacitor), save to filesystem and share
			const pdfData = doc.output('datauristring'); // 'data:application/pdf;base64,BASE64STRING'
			const base64 = pdfData.split(',')[1];
			const fileName = 'reporte-go-no-go.pdf';

			try {
				const result = await Filesystem.writeFile({
					path: fileName,
					data: base64,
					directory: Directory.Documents
				});

				await Share.share({
					title: 'Reporte Go/No-Go',
					files: [result.uri],
					dialogTitle: 'Compartir reporte'
				});
			} catch (error) {
				console.error('Error saving/sharing PDF:', error);
				alert('Error al guardar o compartir el PDF.');
			}
		} else {
			// For web, download directly
			doc.save('reporte-go-no-go.pdf');
		}
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
					<div>
						<strong>Círculo Verde (GO):</strong> Haz clic lo más rápido posible
					</div>
				</div>

				<div class="instruction-item">
					<span class="dot dot--nogo"></span>
					<div>
						<strong>Círculo Rojo (NO GO):</strong> NO hagas clic
					</div>
				</div>

				<hr />
				<p class="instructions-footer">Se medirá tu tiempo de reacción y precisión. Mantén la concentración durante toda la prueba.</p>
			</div>
		</div>

		<button class="start-button" onclick={startGame}>Iniciar Test</button>

	{:else if gameState === 'waiting'}

		<div class="game-area">

			<div class="waiting">Espera...</div>

		</div>

	{:else if gameState === 'stimulus'}

		<div class="game-area">

			<div
				class="stimulus"
				style="background-color: {currentStimulus!.color}"
				onpointerdown={(e) => { e.stopPropagation(); handleClick(currentStimulus!.type === 'go'); }} onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); handleClick(currentStimulus!.type === 'go'); } }} role="button" tabindex="0">
			</div>

		</div>

	{:else if gameState === 'feedback'}

		<div class="game-area">

			{#if currentTrial}

				<div class="feedback">

					{#if currentTrial.correct}

						<p>Correcto</p>

						{#if currentTrial.reactionTime}
							<p>Tiempo de reacción: {currentTrial.reactionTime} ms</p>
						{/if}

					{:else}

						<p>Incorrecto</p>

					{/if}

				</div>

			{/if}

		</div>

	{:else if gameState === 'results'}

		{@const goTrials = trials.filter(t => t.type === 'go')}
		{@const noGoTrials = trials.filter(t => t.type === 'no-go')}
		{@const goCorrect = goTrials.filter(t => t.correct).length}
		{@const noGoCorrect = noGoTrials.filter(t => t.correct).length}
		{@const goReactionTimes = goTrials
			.filter(t => t.correct && typeof t.reactionTime === 'number' && !t.anticipationError)
			.map(t => t.reactionTime!)
		}
		{@const avgGo = goReactionTimes.length > 0 ? goReactionTimes.reduce((a, b) => a + b, 0) / goReactionTimes.length : null}
		{@const minGo = goReactionTimes.length > 0 ? Math.min(...goReactionTimes) : null}
		{@const maxGo = goReactionTimes.length > 0 ? Math.max(...goReactionTimes) : null}
		{@const sdGo = calculateSD(goReactionTimes)}
		{@const omissions = goTrials.length - goCorrect}
		{@const commissions = noGoTrials.filter(t => !t.correct).length}
		{@const anticipationErrors = trials.filter(t => t.anticipationError).length}
		{@const first50 = trials.slice(0, 50).filter(t => t.correct && t.reactionTime && !t.anticipationError).map(t => t.reactionTime!)}
		{@const last50 = trials.slice(50, 100).filter(t => t.correct && t.reactionTime && !t.anticipationError).map(t => t.reactionTime!)}
		{@const avgFirst = first50.length > 0 ? first50.reduce((a, b) => a + b, 0) / first50.length : null}
		{@const avgLast = last50.length > 0 ? last50.reduce((a, b) => a + b, 0) / last50.length : null}

		<div id="results-section">

			<h2>Resultados</h2>

			<div class="results-grid">
				<div class="card card--precision">
					<h3>Precisión</h3>
					<p class="big">{fmtNumber(score / totalTrials * 100)}%</p>
					<p class="sub">{score} de {totalTrials} correctos</p>
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
					<h4>Clicks fuera de los estímulos</h4>
					<p class="big">{clicksFuera}</p>
					<p class="sub">Clicks fuera del círculo</p>
				</div>
				<div class="card card--anticipation">
					<h4>Errores de Anticipación</h4>
					<p class="big">{anticipationErrors}</p>
					<p class="sub">Clicks en menos de 150ms</p>
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
						<h4>Promedio Bloque 1 (1-50)</h4>
						<p class="big">{fmtNumber(avgFirst)} ms</p>
						<p class="sub">Tiempo promedio primeros 50 ensayos</p>
					</div>
					<div class="card card--fatigue">
						<h4>Promedio Bloque 2 (51-100)</h4>
						<p class="big">{fmtNumber(avgLast)} ms</p>
						<p class="sub">Tiempo promedio últimos 50 ensayos</p>
					</div>
				</div>
			</div>

		</div>

		<div class="report-footer">
			<button class="download-button" onclick={downloadReportPdf}>Descargar PDF</button>
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

.game-container{
	display:flex;
	flex-direction:column;
	align-items:center;
	justify-content:center;
	min-height:100vh;
	padding: 40px 16px;
	font-family:Arial, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	background: radial-gradient(circle at top, #f5f7ff, #e2e8f0);
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

.dot--go {
	background: #22C55E;
}

.dot--nogo {
	background: #EF4444;
}

.instructions-footer {
	margin: 16px 0 0;
	color: rgba(15, 23, 42, 0.75);
	line-height: 1.5;
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

.game-area{
	width: min(400px, 100%);
	max-width: 100%;
	height: min(220px, 40vh);
	max-height: 240px;
	display:flex;
	justify-content:center;
	align-items:center;
	padding: 8px;
	box-sizing: border-box;
}

.stimulus{
	width: min(150px, 60vw);
	height: min(150px, 60vw);
	border-radius:50%;
	cursor:pointer;
	box-shadow:0 6px 14px rgba(0,0,0,0.2);
}

.waiting,.feedback{
	font-size:2rem;
}

button{
	padding:10px 20px;
	font-size:1.2rem;
	cursor:pointer;
	border-radius:6px;
	border:1px solid rgba(0,0,0,0.1);
	background:#fff;
}

.results-grid {
	display:grid;
	grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
	gap:16px;
	width:100%;
	max-width:900px;
	margin:16px 0;
}

.card {
	padding:16px;
	border-radius:16px;
	background:rgba(255,255,255,0.9);
	box-shadow:0 10px 30px rgba(0,0,0,0.08);
	word-break: break-word;
	box-sizing: border-box;
}

.card h3,
.card h4 {
	margin:0 0 8px;
	font-weight:600;
}

.card .big {
	font-size:2.4rem;
	margin:0;
}

.card .sub {
	margin:4px 0 0;
	color:rgba(0,0,0,0.6);
}

.card--precision {
	background:linear-gradient(135deg,#DBEAFE,#BFDBFE);
}

.card--avg {
	background:linear-gradient(135deg,#F3E8FF,#E9D5FF);
}

.card--fast {
	background:linear-gradient(135deg,#DCFCE7,#BBF7D0);
}

.card--slow {
	background:linear-gradient(135deg,#FEE2E2,#FECACA);
}

.card--go {
	background:linear-gradient(135deg,#D1FAE5,#A7F3D0);
}

.card--nogo {
	background:linear-gradient(135deg,#DBEAFE,#BFDBFE);
}

.card--sd {
	background:linear-gradient(135deg,#A855F7,#7C3AED);
}

.card--anticipation {
	background:linear-gradient(135deg,#F59E0B,#D97706);
}

.card--fatigue {
	background:linear-gradient(135deg,#6B7280,#4B5563);
}
.analysis {
	width:100%;
	max-width:900px;
	margin-top:24px;
}

.analysis-row {
	display:grid;
	grid-template-columns:repeat(auto-fit,minmax(200px,1fr));
	gap:16px;
}

.report-footer {
	display:flex;
	justify-content:space-between;
	align-items:center;
	width:100%;
	max-width:900px;
	margin-top:24px;
}

@media (max-width: 640px) {
	.report-footer {
		flex-direction:column;
		align-items:flex-start;
		gap:12px;
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

	.waiting, .feedback {
		font-size: 1.5rem;
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