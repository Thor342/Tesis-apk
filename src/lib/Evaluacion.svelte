<script lang="ts">
	import GoNoGo    from './GoNoGo.svelte';
	import Secuencia from './Secuencia.svelte';
	import Stopper   from './Stopper.svelte';
	import { supabase } from './supabaseClient';
	import { Capacitor } from '@capacitor/core';
	import { Filesystem, Directory } from '@capacitor/filesystem';
	import { Share } from '@capacitor/share';
	import * as XLSX from 'xlsx';

	let { onVolver = undefined as (() => void) | undefined } = $props();

	type Fase = 'gonogo' | 'secuencia' | 'stroop' | 'fin';

	let fase         = $state<Fase>('gonogo');
	let evaluacionId = $state<number | undefined>(undefined);

	// ─── Estado de descargas ─────────────────────────────────────────────────
	let generandoPDF   = $state(false);
	let generandoExcel = $state(false);
	let errorReporte   = $state<string | null>(null);

	// ─── Helpers ─────────────────────────────────────────────────────────────
	function fmtN(v: number | null | undefined) {
		if (v === null || v === undefined) return 'N/A';
		return Number.isInteger(v) ? String(v) : Number(v).toFixed(1);
	}

	function blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
			reader.onerror  = reject;
			reader.readAsDataURL(blob);
		});
	}

	async function fetchResultados() {
		const [rg, rs, rt] = await Promise.all([
			supabase.from('gonogo').select('*').eq('evaluacion_id', evaluacionId).single(),
			supabase.from('secuencia').select('*').eq('evaluacion_id', evaluacionId).single(),
			supabase.from('resultados_stroop').select('*').eq('evaluacion_id', evaluacionId).single(),
		]);
		if (rg.error || rs.error || rt.error)
			throw new Error('No se pudieron obtener los resultados.');
		return { g: rg.data, s: rs.data, t: rt.data };
	}

	// ─── Descarga PDF combinado ───────────────────────────────────────────────
	async function descargarPDF() {
		if (!evaluacionId) return;
		generandoPDF = true;
		errorReporte = null;
		try {
			const { g, s, t } = await fetchResultados();
			const { jsPDF } = await import('jspdf');
			const doc  = new jsPDF({ unit: 'pt', format: 'a4' });
			const pageW = doc.internal.pageSize.getWidth();
			const pageH = doc.internal.pageSize.getHeight();
			const margin = 45;
			const maxW   = pageW - margin * 2;
			let y = margin;

			function checkPage(n = 20) {
				if (y + n > pageH - margin) { doc.addPage(); y = margin; }
			}
			function line(txt: string, size: number, bold: boolean, color: [number,number,number], lh: number) {
				doc.setFontSize(size); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setTextColor(...color);
				const lines = doc.splitTextToSize(txt, maxW) as string[];
				for (const l of lines) { checkPage(lh); doc.text(l, margin, y); y += lh; }
			}
			function sectionHeader(title: string, fill: [number,number,number]) {
				checkPage(36);
				y += 8;
				doc.setFillColor(...fill);
				doc.roundedRect(margin - 8, y - 14, maxW + 16, 24, 4, 4, 'F');
				doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(255,255,255);
				doc.text(title, margin, y); y += 20;
			}
			function row(label: string, value: string) {
				checkPage(18);
				doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(71,85,105);
				doc.text(label, margin, y);
				doc.setFont('helvetica', 'normal'); doc.setTextColor(15,23,42);
				doc.text(value, margin + 220, y);
				y += 16;
			}

			// Encabezado
			doc.setFillColor(15,23,42);
			doc.rect(0, 0, pageW, 85, 'F');
			doc.setFontSize(17); doc.setFont('helvetica','bold'); doc.setTextColor(255,255,255);
			doc.text('REPORTE DE EVALUACIÓN NEUROPSICOLÓGICA', pageW/2, 38, { align:'center' });
			doc.setFontSize(10); doc.setFont('helvetica','normal');
			doc.text(new Date().toLocaleString('es-ES'), pageW/2, 57, { align:'center' });
			doc.text(`ID de evaluación: ${evaluacionId}`, pageW/2, 73, { align:'center' });
			y = 105;

			// ── Prueba 1: Go/No-Go ─────────────────────────────
			sectionHeader('1. CONTROL INHIBITORIO — Go/No-Go', [30,64,175]);
			row('Precisión total',        `${fmtN(g.precision_total)} %`);
			row('TR promedio (GO)',        `${fmtN(g.rt_promedio)} ms  (DE: ${fmtN(g.desviacion_estandar)} ms)`);
			row('TR mínimo / máximo',      `${fmtN(g.tiempo_minimo)} ms / ${fmtN(g.tiempo_maximo)} ms`);
			row('GO correctos',            `${fmtN(g.go_correctos)} / 80`);
			row('NO-GO correctos',         `${fmtN(g.nogo_correctos)} / 20`);
			row('Errores de omisión',      fmtN(g.errores_omision));
			row('Errores de comisión',     fmtN(g.errores_comision));
			row('Errores de anticipación', fmtN(g.errores_anticipacion));
			row('TR bloque 1 (1-50)',      `${fmtN(g.promedio_bloque1)} ms`);
			row('TR bloque 2 (51-100)',    `${fmtN(g.promedio_bloque2)} ms`);
			y += 6;

			// ── Prueba 2: Secuencia ────────────────────────────
			sectionHeader('2. MEMORIA VISOESPACIAL — Secuencia de Colores', [5,150,105]);
			row('Span máximo alcanzado',   `${fmtN(s.span_maximo)} elementos`);
			row('Errores totales',         fmtN(s.errores_totales));
			row('FRL promedio',            `${fmtN(s.frl_promedio)} ms  (DE: ${fmtN(s.frl_sd)} ms)`);
			row('IRI promedio',            `${fmtN(s.iri_promedio)} ms  (DE: ${fmtN(s.iri_sd)} ms)`);
			row('Total respuestas',        fmtN(s.total_respuestas));
			y += 6;

			// ── Prueba 3: Stroop ───────────────────────────────
			sectionHeader('3. ATENCIÓN SELECTIVA — Test de Stroop', [124,45,156]);
			row('Aciertos totales',            `${fmtN(t.aciertos_totales)} / 40`);
			row('TR congruente',               `${fmtN(t.media_congruente_ms)} ms  (DE: ${fmtN(t.rt_congruente_sd)} ms)`);
			row('TR incongruente',             `${fmtN(t.media_incongruente_ms)} ms  (DE: ${fmtN(t.rt_incongruente_sd)} ms)`);
			row('Interferencia Stroop',        `${fmtN(t.indice_interferencia_ms)} ms — ${t.estado_interferencia ?? 'N/A'}`);
			row('Aciertos congruentes',        `${fmtN(t.aciertos_congruente)} / 20`);
			row('Aciertos incongruentes',      `${fmtN(t.aciertos_incongruente)} / 20`);
			row('Errores congruentes',         fmtN(t.errores_congruente));
			row('Errores incongruentes',       fmtN(t.errores_incongruente));
			row('Anticipaciones (<200 ms)',    fmtN(t.anticipaciones));
			y += 10;

			line('Este reporte presenta los resultados crudos de la batería neuropsicológica. No constituye diagnóstico clínico.',
				8, false, [148,163,184], 12);

			// Pie de página
			const total = (doc as any).internal.getNumberOfPages();
			for (let p = 1; p <= total; p++) {
				doc.setPage(p); doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(148,163,184);
				doc.text(`Página ${p} de ${total}`, pageW/2, pageH - 18, { align:'center' });
			}

			if (Capacitor.isNativePlatform()) {
				const b64 = doc.output('datauristring').split(',')[1];
				const res = await Filesystem.writeFile({ path:'reporte-evaluacion.pdf', data:b64, directory:Directory.Cache });
				await Share.share({ title:'Reporte Evaluación', files:[res.uri], dialogTitle:'Compartir PDF' });
			} else {
				doc.save('Reporte_Evaluacion.pdf');
			}
		} catch (e: unknown) {
			errorReporte = e instanceof Error ? e.message : 'Error al generar el PDF.';
		} finally {
			generandoPDF = false;
		}
	}

	// ─── Descarga Excel combinado ─────────────────────────────────────────────
	async function descargarExcel() {
		if (!evaluacionId) return;
		generandoExcel = true;
		errorReporte   = null;
		try {
			const { g, s, t } = await fetchResultados();
			const wb = XLSX.utils.book_new();

			XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
				['REPORTE DE EVALUACIÓN NEUROPSICOLÓGICA'],
				['ID Evaluación', evaluacionId],
				['Fecha', new Date().toLocaleString('es-ES')],
				[],
				['── GO/NO-GO ──'],
				['Precisión total (%)',           g.precision_total],
				['TR promedio GO (ms)',           g.rt_promedio],
				['DE TR GO (ms)',                 g.desviacion_estandar],
				['TR mínimo (ms)',                g.tiempo_minimo],
				['TR máximo (ms)',                g.tiempo_maximo],
				['GO correctos',                  g.go_correctos],
				['NO-GO correctos',               g.nogo_correctos],
				['Errores omisión',               g.errores_omision],
				['Errores comisión',              g.errores_comision],
				['Errores anticipación',          g.errores_anticipacion],
				['TR bloque 1 (ms)',              g.promedio_bloque1],
				['TR bloque 2 (ms)',              g.promedio_bloque2],
				[],
				['── MEMORIA VISOESPACIAL ──'],
				['Span máximo',                   s.span_maximo],
				['Errores totales',               s.errores_totales],
				['FRL promedio (ms)',              s.frl_promedio],
				['FRL DE (ms)',                   s.frl_sd],
				['IRI promedio (ms)',              s.iri_promedio],
				['IRI DE (ms)',                   s.iri_sd],
				['Total respuestas',              s.total_respuestas],
				[],
				['── STROOP ──'],
				['Aciertos totales',              t.aciertos_totales],
				['TR congruente (ms)',            t.media_congruente_ms],
				['DE TR congruente (ms)',         t.rt_congruente_sd],
				['TR incongruente (ms)',          t.media_incongruente_ms],
				['DE TR incongruente (ms)',       t.rt_incongruente_sd],
				['Interferencia Stroop (ms)',     t.indice_interferencia_ms],
				['Clasificación interferencia',   t.estado_interferencia],
				['Aciertos congruentes',          t.aciertos_congruente],
				['Aciertos incongruentes',        t.aciertos_incongruente],
				['Errores congruentes',           t.errores_congruente],
				['Errores incongruentes',         t.errores_incongruente],
				['Anticipaciones',                t.anticipaciones],
			]), 'Resultados');

			const wbout = XLSX.write(wb, { bookType:'xlsx', type:'array' });
			const blob  = new Blob([wbout], { type:'application/octet-stream' });

			if (Capacitor.isNativePlatform()) {
				const b64 = await blobToBase64(blob);
				const res = await Filesystem.writeFile({ path:'reporte-evaluacion.xlsx', data:b64, directory:Directory.Cache });
				await Share.share({ title:'Reporte Excel', files:[res.uri], dialogTitle:'Compartir Excel' });
			} else {
				const url = URL.createObjectURL(blob);
				const a   = document.createElement('a');
				a.href = url; a.download = 'Reporte_Evaluacion.xlsx';
				document.body.appendChild(a); a.click();
				document.body.removeChild(a); URL.revokeObjectURL(url);
			}
		} catch (e: unknown) {
			errorReporte = e instanceof Error ? e.message : 'Error al generar el Excel.';
		} finally {
			generandoExcel = false;
		}
	}

	// Registro en BD solo cuando el usuario inicia el primer test.
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

{#if fase === 'gonogo'}
	<GoNoGo
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onIniciar={crearRegistroEvaluacion}
		onTerminar={() => { fase = 'secuencia'; }}
		onVolver={onVolver}
	/>

{:else if fase === 'secuencia'}
	<Secuencia
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onTerminar={() => { fase = 'stroop'; }}
		onVolver={onVolver}
	/>

{:else if fase === 'stroop'}
	<Stopper
		modoEvaluacion={true}
		evaluacion_id={evaluacionId}
		onTerminar={marcarCompletada}
		onVolver={onVolver}
	/>

{:else if fase === 'fin'}
	<div class="estado-container">
		<div class="estado-card">
			<div class="fin-icon">✓</div>
			<h1>Evaluación completada</h1>
			<p>
				El participante ha finalizado las tres pruebas neuropsicológicas:
				<strong>Go/No-Go</strong>, <strong>Memoria Visoespacial</strong>
				y <strong>Test de Stroop</strong>.
				Los resultados han sido guardados.
			</p>

			<div class="btn-stack">
				<div class="download-row">
					<button class="btn-download pdf" onclick={descargarPDF} disabled={generandoPDF}>
						{#if generandoPDF}<span class="spinner dark"></span>{:else}📄{/if}
						PDF
					</button>
					<button class="btn-download excel" onclick={descargarExcel} disabled={generandoExcel}>
						{#if generandoExcel}<span class="spinner dark"></span>{:else}📊{/if}
						Excel
					</button>
				</div>

				{#if errorReporte}
					<p class="error-msg">{errorReporte}</p>
				{/if}

				{#if onVolver}
					<button class="btn-volver" onclick={onVolver}>← Volver al Dashboard</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
:global(html), :global(body) { margin: 0; padding: 0; box-sizing: border-box; }

.estado-container {
	display: flex; align-items: center; justify-content: center;
	min-height: 100vh; padding: 24px;
	font-family: Arial, system-ui, -apple-system, "Segoe UI", sans-serif;
	background: #f0f4f8;
}
.estado-card {
	background: #ffffff; border-radius: 20px;
	box-shadow: 0 20px 40px rgba(15,23,42,0.10); padding: 48px 32px;
	max-width: 480px; width: 100%; text-align: center;
}

.fin-icon {
	width: 72px; height: 72px; border-radius: 50%;
	background: linear-gradient(135deg, #16a34a, #15803d);
	color: white; font-size: 2.2rem; line-height: 72px;
	margin: 0 auto 20px;
}

h1 { margin: 0 0 16px; font-size: 1.9rem; color: #0f172a; }
p  { color: rgba(15,23,42,0.65); line-height: 1.6; margin-bottom: 28px; }

.btn-stack { display: flex; flex-direction: column; gap: 12px; }


.spinner {
	width: 16px; height: 16px; border-radius: 50%;
	border: 2px solid rgba(255,255,255,0.4);
	border-top-color: white;
	animation: spin 0.7s linear infinite;
	flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.error-msg {
	color: #dc2626; font-size: 0.85rem;
	background: #fef2f2; border-radius: 10px;
	padding: 10px 14px; margin: 0;
}

.download-row { display: flex; gap: 10px; }
.btn-download {
	flex: 1; padding: 14px; font-size: 0.95rem; border-radius: 999px;
	border: none; font-weight: 700; cursor: pointer;
	display: flex; align-items: center; justify-content: center; gap: 6px;
	transition: opacity 0.15s;
}
.btn-download:disabled { opacity: 0.65; cursor: not-allowed; }
.btn-download.pdf   { background: #fee2e2; color: #991b1b; }
.btn-download.excel { background: #dcfce7; color: #166534; }

.btn-volver {
	padding: 14px 32px; font-size: 1rem; border-radius: 999px;
	border: 2px solid #e2e8f0; background: transparent;
	color: #475569; cursor: pointer; width: 100%; font-weight: 600;
	transition: background 0.15s ease;
}
.btn-volver:hover { background: #f1f5f9; }

.spinner.dark { border-color: rgba(0,0,0,0.2); border-top-color: currentColor; }
</style>
