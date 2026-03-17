<script lang="ts">
	import { supabase }   from './supabaseClient';
	import { Capacitor }  from '@capacitor/core';
	import { Filesystem, Directory } from '@capacitor/filesystem';
	import { Share }      from '@capacitor/share';
	import * as XLSX      from 'xlsx';

	let { onVolver = undefined as (() => void) | undefined } = $props();

	type Tab = 'evaluacion' | 'gonogo' | 'stroop' | 'secuencia';
	let activeTab    = $state<Tab>('evaluacion');
	let loading      = $state(false);
	let errorMsg     = $state<string | null>(null);
	let loadingRow   = $state<{ id: number; action: string } | null>(null);

	let dataEval      = $state<any[]>([]);
	let dataGonogo    = $state<any[]>([]);
	let dataStroop    = $state<any[]>([]);
	let dataSecuencia = $state<any[]>([]);

	const TABLE: Record<Tab, string> = {
		evaluacion: 'evaluaciones',
		gonogo:     'gonogo',
		stroop:     'resultados_stroop',
		secuencia:  'secuencia',
	};

	async function cargar(tab: Tab) {
		loading  = true;
		errorMsg = null;
		try {
			let query = supabase.from(TABLE[tab]).select('*');
			// Pruebas individuales: solo registros SIN evaluacion_id (standalone)
			// Evaluación: usa la tabla evaluaciones directamente
			if (tab !== 'evaluacion') {
				query = query.is('evaluacion_id', null);
			}
			query = query.order('id', { ascending: false });
			const { data, error } = await query;
			if (error) throw error;
			const rows = data ?? [];
			if (tab === 'evaluacion')  dataEval      = rows;
			else if (tab === 'gonogo') dataGonogo    = rows;
			else if (tab === 'stroop') dataStroop    = rows;
			else                       dataSecuencia = rows;
		} catch (e: any) {
			errorMsg = e.message ?? 'Error al cargar datos';
		}
		loading = false;
	}

	function selectTab(tab: string) {
		activeTab = tab as Tab;
		cargar(tab as Tab);
	}

	function fmtFecha(str: string | null | undefined) {
		if (!str) return '-';
		const d = new Date(str);
		if (isNaN(d.getTime())) return '-';
		return d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
	}

	// Obtiene la fecha a mostrar según el tipo de fila
	function getfecha(tab: Tab, row: any): string {
		if (tab === 'evaluacion') return fmtFecha(row.fecha_inicio);
		return fmtFecha(row.created_at); // disponible tras ALTER TABLE
	}

	function fmtN(v: any) {
		if (v === null || v === undefined) return 'N/A';
		const n = Number(v);
		return Number.isInteger(n) ? String(n) : n.toFixed(1);
	}

	// ─── Save helpers ─────────────────────────────────────────────────────────
	function blobToBase64(blob: Blob): Promise<string> {
		return new Promise((res, rej) => {
			const r = new FileReader();
			r.onloadend = () => res((r.result as string).split(',')[1]);
			r.onerror   = rej;
			r.readAsDataURL(blob);
		});
	}

	async function savePDF(doc: any, filename: string) {
		const blob = doc.output('blob') as Blob;
		if (Capacitor.isNativePlatform()) {
			const b64 = await blobToBase64(blob);
			await Filesystem.writeFile({ path: filename, data: b64, directory: Directory.Cache });
			const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
			await Share.share({ title: filename, url: uri });
		} else {
			const url = URL.createObjectURL(blob);
			Object.assign(document.createElement('a'), { href: url, download: filename }).click();
			URL.revokeObjectURL(url);
		}
	}

	async function saveXlsx(wb: XLSX.WorkBook, filename: string) {
		const buf  = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
		const blob = new Blob([buf], { type: 'application/octet-stream' });
		if (Capacitor.isNativePlatform()) {
			const b64 = await blobToBase64(blob);
			await Filesystem.writeFile({ path: filename, data: b64, directory: Directory.Cache });
			const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
			await Share.share({ title: filename, url: uri });
		} else {
			const url = URL.createObjectURL(blob);
			Object.assign(document.createElement('a'), { href: url, download: filename }).click();
			URL.revokeObjectURL(url);
		}
	}

	// ─── PDF builders ─────────────────────────────────────────────────────────
	async function buildPDF(title: string, fecha: string, id: number, campos: [string, string][]) {
		const { jsPDF } = await import('jspdf');
		const doc    = new jsPDF({ unit: 'pt', format: 'a4' });
		const pW     = doc.internal.pageSize.getWidth();
		const margin = 45;
		let y = margin;

		doc.setFillColor(248, 250, 252);
		doc.rect(0, 0, pW, 60, 'F');
		doc.setFontSize(17); doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42);
		doc.text(title, margin, y + 6); y += 30;
		doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 116, 139);
		doc.text(`Fecha: ${fecha}   ·   ID: ${id}`, margin, y); y += 30;
		doc.setLineWidth(0.5); doc.setDrawColor(226, 232, 240);
		doc.line(margin, y, pW - margin, y); y += 18;

		for (const [k, v] of campos) {
			if (y > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
			doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(51, 65, 85);
			doc.text(k + ':', margin, y);
			doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 41, 59);
			doc.text(String(v), margin + 190, y);
			y += 18;
		}
		return doc;
	}

	// ─── GoNoGo ───────────────────────────────────────────────────────────────
	function gonogoRow(r: any) {
		return [
			['Precisión total',          `${fmtN(r.precision_total)} %`],
			['RT promedio (ms)',          fmtN(r.rt_promedio)],
			['Desv. estándar RT',         fmtN(r.desviacion_estandar)],
			['RT mínimo (ms)',            fmtN(r.tiempo_minimo)],
			['RT máximo (ms)',            fmtN(r.tiempo_maximo)],
			['Go correctos',             fmtN(r.go_correctos)],
			['No-Go correctos',          fmtN(r.nogo_correctos)],
			['Errores omisión',          fmtN(r.errores_omision)],
			['Errores comisión',         fmtN(r.errores_comision)],
			['Errores anticipación',     fmtN(r.errores_anticipacion)],
		] as [string, string][];
	}

	async function pdfGonogo(r: any) {
		const doc = await buildPDF('Go / No-Go — Reporte', fmtFecha(r.created_at), r.id, gonogoRow(r));
		await savePDF(doc, `gonogo_${r.id}.pdf`);
	}

	async function excelGonogo(r: any) {
		const ws = XLSX.utils.json_to_sheet([{
			Fecha: fmtFecha(r.created_at), ID: r.id,
			'Precisión (%)': r.precision_total, 'RT Promedio (ms)': r.rt_promedio,
			'Desv. Estándar': r.desviacion_estandar, 'RT Mín': r.tiempo_minimo, 'RT Máx': r.tiempo_maximo,
			'Go Correctos': r.go_correctos, 'NoGo Correctos': r.nogo_correctos,
			'Err. Omisión': r.errores_omision, 'Err. Comisión': r.errores_comision,
			'Err. Anticipación': r.errores_anticipacion,
		}]);
		const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'GoNoGo');
		await saveXlsx(wb, `gonogo_${r.id}.xlsx`);
	}

	// ─── Stroop ───────────────────────────────────────────────────────────────
	function stroopRow(r: any) {
		return [
			['Aciertos totales',           fmtN(r.aciertos_totales)],
			['Total ensayos',              fmtN(r.total_ensayos)],
			['Media congruente (ms)',       fmtN(r.media_congruente_ms)],
			['Media incongruente (ms)',     fmtN(r.media_incongruente_ms)],
			['Índice interferencia (ms)',   fmtN(r.indice_interferencia_ms)],
			['Estado interferencia',        r.estado_interferencia ?? 'N/A'],
			['Aciertos congruente',         fmtN(r.aciertos_congruente)],
			['Aciertos incongruente',       fmtN(r.aciertos_incongruente)],
			['Errores congruente',          fmtN(r.errores_congruente)],
			['Errores incongruente',        fmtN(r.errores_incongruente)],
		] as [string, string][];
	}

	async function pdfStroop(r: any) {
		const doc = await buildPDF('Stroop — Reporte', fmtFecha(r.created_at), r.id, stroopRow(r));
		await savePDF(doc, `stroop_${r.id}.pdf`);
	}

	async function excelStroop(r: any) {
		const ws = XLSX.utils.json_to_sheet([{
			Fecha: fmtFecha(r.created_at), ID: r.id,
			'Aciertos Totales': r.aciertos_totales, 'Total Ensayos': r.total_ensayos,
			'Media Congruente (ms)': r.media_congruente_ms, 'Media Incongruente (ms)': r.media_incongruente_ms,
			'Índice Interferencia (ms)': r.indice_interferencia_ms, 'Estado Interferencia': r.estado_interferencia,
			'Aciertos Congruente': r.aciertos_congruente, 'Aciertos Incongruente': r.aciertos_incongruente,
			'Errores Congruente': r.errores_congruente, 'Errores Incongruente': r.errores_incongruente,
		}]);
		const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Stroop');
		await saveXlsx(wb, `stroop_${r.id}.xlsx`);
	}

	// ─── Secuencia ────────────────────────────────────────────────────────────
	function secuenciaRow(r: any) {
		return [
			['Span máximo',         fmtN(r.span_maximo)],
			['Errores totales',     fmtN(r.errores_totales)],
			['FRL promedio (ms)',   fmtN(r.frl_promedio)],
			['FRL desv. estándar',  fmtN(r.frl_sd)],
			['IRI promedio (ms)',   fmtN(r.iri_promedio)],
			['IRI desv. estándar',  fmtN(r.iri_sd)],
			['Total respuestas',    fmtN(r.total_respuestas)],
		] as [string, string][];
	}

	async function pdfSecuencia(r: any) {
		const doc = await buildPDF('Secuencia de Colores — Reporte', fmtFecha(r.created_at), r.id, secuenciaRow(r));
		await savePDF(doc, `secuencia_${r.id}.pdf`);
	}

	async function excelSecuencia(r: any) {
		const ws = XLSX.utils.json_to_sheet([{
			Fecha: fmtFecha(r.created_at), ID: r.id,
			'Span Máximo': r.span_maximo, 'Errores Totales': r.errores_totales,
			'FRL Promedio (ms)': r.frl_promedio, 'FRL Desv. Estándar': r.frl_sd,
			'IRI Promedio (ms)': r.iri_promedio, 'IRI Desv. Estándar': r.iri_sd,
			'Total Respuestas': r.total_respuestas,
		}]);
		const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Secuencia');
		await saveXlsx(wb, `secuencia_${r.id}.xlsx`);
	}

	// ─── Evaluación (combinado) ───────────────────────────────────────────────
	async function fetchCombinado(evalId: number) {
		const [rg, rs, rt] = await Promise.all([
			supabase.from('gonogo').select('*').eq('evaluacion_id', evalId).single(),
			supabase.from('secuencia').select('*').eq('evaluacion_id', evalId).single(),
			supabase.from('resultados_stroop').select('*').eq('evaluacion_id', evalId).single(),
		]);
		return { g: rg.data, s: rs.data, t: rt.data };
	}

	async function pdfEvaluacion(r: any) {
		const { g, s, t } = await fetchCombinado(r.id);
		const { jsPDF }   = await import('jspdf');
		const doc  = new jsPDF({ unit: 'pt', format: 'a4' });
		const pW   = doc.internal.pageSize.getWidth();
		const pH   = doc.internal.pageSize.getHeight();
		const m    = 45, maxW = pW - m * 2;
		let y = m;

		function chk(n = 20) { if (y + n > pH - m) { doc.addPage(); y = m; } }
		function row(k: string, v: string, kw = 190) {
			chk(18);
			doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(51, 65, 85);
			doc.text(k + ':', m, y);
			doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 41, 59);
			doc.text(v, m + kw, y); y += 18;
		}
		function section(title: string, fill: [number,number,number]) {
			chk(36); y += 10;
			doc.setFillColor(...fill);
			doc.roundedRect(m - 8, y - 14, maxW + 16, 24, 4, 4, 'F');
			doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(255,255,255);
			doc.text(title, m, y); y += 22;
		}

		doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42);
		doc.text('Evaluación Completa — Reporte', m, y); y += 28;
		doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(100,116,139);
		doc.text(`Fecha: ${fmtFecha(r.fecha_inicio)}   ·   ID evaluación: ${r.id}`, m, y); y += 24;
		doc.setLineWidth(0.5); doc.setDrawColor(226,232,240); doc.line(m, y, pW - m, y); y += 16;

		if (g) {
			section('Go / No-Go', [16, 185, 129]);
			for (const [k, v] of gonogoRow(g)) row(k, v);
		}
		if (t) {
			section('Stroop', [244, 63, 94]);
			for (const [k, v] of stroopRow(t)) row(k, v);
		}
		if (s) {
			section('Secuencia de Colores', [14, 165, 233]);
			for (const [k, v] of secuenciaRow(s)) row(k, v);
		}

		await savePDF(doc, `evaluacion_${r.id}.pdf`);
	}

	async function excelEvaluacion(r: any) {
		const { g, s, t } = await fetchCombinado(r.id);
		const ws = XLSX.utils.json_to_sheet([{
			'Fecha': fmtFecha(r.fecha_inicio), 'ID Evaluación': r.id,
			// GoNoGo
			'GNG Precisión (%)': g?.precision_total, 'GNG RT Promedio': g?.rt_promedio,
			'GNG Err. Omisión': g?.errores_omision, 'GNG Err. Comisión': g?.errores_comision,
			// Stroop
			'STR Aciertos': t?.aciertos_totales, 'STR Media Cong.': t?.media_congruente_ms,
			'STR Media Incong.': t?.media_incongruente_ms, 'STR Interferencia': t?.indice_interferencia_ms,
			'STR Estado': t?.estado_interferencia,
			// Secuencia
			'SEC Span Máx.': s?.span_maximo, 'SEC Errores': s?.errores_totales,
			'SEC FRL Prom.': s?.frl_promedio, 'SEC IRI Prom.': s?.iri_promedio,
		}]);
		const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Evaluacion');
		await saveXlsx(wb, `evaluacion_${r.id}.xlsx`);
	}

	// ─── Gemini IA ────────────────────────────────────────────────────────────
	const GEMINI_KEY = import.meta.env.VITE_GEMINI_KEY ?? '';

	const REGLAS = `Actúa como un experto en neuropsicología cognitiva.
REGLAS: NO hagas diagnósticos clínicos. NO afirmes trastornos ni déficits. NO uses lenguaje patologizante. SOLO describe los datos de forma descriptiva. Usa lenguaje técnico pero comprensible. Sin markdown, sin asteriscos. Responde SOLO con el reporte.
Al final incluye siempre: "Este reporte es de carácter descriptivo y no constituye un diagnóstico clínico."`;

	function buildPrompt(tab: Tab, r: any, g?: any, s?: any, t?: any): string {
		if (tab === 'evaluacion') {
			return `${REGLAS}

Genera un reporte con estas secciones: 1. RESUMEN GENERAL, 2. RESULTADOS POR PRUEBA (Go/No-Go, Stroop, Memoria Visoespacial), 3. OBSERVACIONES DESCRIPTIVAS, 4. NOTA FINAL.

GO/NO-GO:
- Precisión: ${fmtN(g?.precision_total)}% | TR promedio: ${fmtN(g?.rt_promedio)}ms (DE: ${fmtN(g?.desviacion_estandar)})
- TR mín: ${fmtN(g?.tiempo_minimo)}ms | TR máx: ${fmtN(g?.tiempo_maximo)}ms
- GO correctos: ${fmtN(g?.go_correctos)}/80 | NO-GO correctos: ${fmtN(g?.nogo_correctos)}/20
- Errores omisión: ${fmtN(g?.errores_omision)} | Errores comisión: ${fmtN(g?.errores_comision)} | Anticipaciones: ${fmtN(g?.errores_anticipacion)}
- TR bloque 1: ${fmtN(g?.promedio_bloque1)}ms | TR bloque 2: ${fmtN(g?.promedio_bloque2)}ms

STROOP:
- Aciertos: ${fmtN(t?.aciertos_totales)}/40 | TR congruente: ${fmtN(t?.media_congruente_ms)}ms (DE: ${fmtN(t?.rt_congruente_sd)}) | TR incongruente: ${fmtN(t?.media_incongruente_ms)}ms (DE: ${fmtN(t?.rt_incongruente_sd)})
- Índice interferencia: ${fmtN(t?.indice_interferencia_ms)}ms | Clasificación: ${t?.estado_interferencia ?? 'N/A'}
- Aciertos congruentes: ${fmtN(t?.aciertos_congruente)}/20 | Aciertos incongruentes: ${fmtN(t?.aciertos_incongruente)}/20

MEMORIA VISOESPACIAL:
- Span máximo: ${fmtN(s?.span_maximo)} elementos | Errores: ${fmtN(s?.errores_totales)}
- FRL promedio: ${fmtN(s?.frl_promedio)}ms (DE: ${fmtN(s?.frl_sd)}) | IRI promedio: ${fmtN(s?.iri_promedio)}ms (DE: ${fmtN(s?.iri_sd)})`;
		}
		if (tab === 'gonogo') {
			return `${REGLAS}

Genera un reporte descriptivo de la prueba Go/No-Go con: 1. RESUMEN, 2. RESULTADOS (tiempos de reacción, errores), 3. OBSERVACIONES, 4. NOTA FINAL.

Datos:
- Precisión: ${fmtN(r.precision_total)}% | TR promedio: ${fmtN(r.rt_promedio)}ms (DE: ${fmtN(r.desviacion_estandar)})
- TR mín: ${fmtN(r.tiempo_minimo)}ms | TR máx: ${fmtN(r.tiempo_maximo)}ms
- GO correctos: ${fmtN(r.go_correctos)}/80 | NO-GO correctos: ${fmtN(r.nogo_correctos)}/20
- Errores omisión: ${fmtN(r.errores_omision)} | Errores comisión: ${fmtN(r.errores_comision)} | Anticipaciones: ${fmtN(r.errores_anticipacion)}`;
		}
		if (tab === 'stroop') {
			return `${REGLAS}

Genera un reporte descriptivo de la prueba Stroop con: 1. RESUMEN, 2. RESULTADOS (tiempos, interferencia, errores), 3. OBSERVACIONES, 4. NOTA FINAL.

Datos:
- Aciertos: ${fmtN(r.aciertos_totales)}/${fmtN(r.total_ensayos)}
- TR congruente: ${fmtN(r.media_congruente_ms)}ms (DE: ${fmtN(r.rt_congruente_sd)}) | TR incongruente: ${fmtN(r.media_incongruente_ms)}ms (DE: ${fmtN(r.rt_incongruente_sd)})
- Índice interferencia: ${fmtN(r.indice_interferencia_ms)}ms | Clasificación: ${r.estado_interferencia ?? 'N/A'}
- Aciertos congruentes: ${fmtN(r.aciertos_congruente)}/20 | Aciertos incongruentes: ${fmtN(r.aciertos_incongruente)}/20
- Errores congruentes: ${fmtN(r.errores_congruente)} | Errores incongruentes: ${fmtN(r.errores_incongruente)} | Anticipaciones: ${fmtN(r.anticipaciones)}`;
		}
		return `${REGLAS}

Genera un reporte descriptivo de la prueba de Memoria Visoespacial Secuencial con: 1. RESUMEN, 2. RESULTADOS (span, latencias), 3. OBSERVACIONES, 4. NOTA FINAL.

Datos:
- Span máximo: ${fmtN(r.span_maximo)} elementos | Errores totales: ${fmtN(r.errores_totales)}
- FRL promedio: ${fmtN(r.frl_promedio)}ms (DE: ${fmtN(r.frl_sd)}) | IRI promedio: ${fmtN(r.iri_promedio)}ms (DE: ${fmtN(r.iri_sd)})
- Total respuestas: ${fmtN(r.total_respuestas)}`;
	}

	async function exportarPDFIA(texto: string, tab: Tab, id: number, fecha: string) {
		const { jsPDF } = await import('jspdf');
		const doc    = new jsPDF({ unit: 'pt', format: 'a4' });
		const pW     = doc.internal.pageSize.getWidth();
		const pH     = doc.internal.pageSize.getHeight();
		const m      = 45, maxW = pW - m * 2;
		let y = m;

		function chk(n = 14) { if (y + n > pH - m) { doc.addPage(); y = m; } }

		doc.setFillColor(124, 58, 237);
		doc.rect(0, 0, pW, 60, 'F');
		doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(255,255,255);
		doc.text('Reporte con Inteligencia Artificial', m, m + 4); y += 28;
		doc.setFontSize(9); doc.setFont('helvetica', 'normal');
		doc.text(`Fecha: ${fecha}   ·   ID: ${id}   ·   Modelo: Gemini 2.0 Flash`, m, y); y += 30;

		doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 41, 59);
		const lines = texto.split('\n');
		for (const line of lines) {
			const isTitle = /^#{1,3}\s/.test(line) || /^\*\*/.test(line);
			const clean   = line.replace(/^#{1,3}\s*/, '').replace(/\*\*/g, '').trim();
			if (!clean) { y += 6; continue; }
			doc.setFont('helvetica', isTitle ? 'bold' : 'normal');
			doc.setFontSize(isTitle ? 11 : 10);
			const wrapped = doc.splitTextToSize(clean, maxW) as string[];
			for (const l of wrapped) { chk(); doc.text(l, m, y); y += isTitle ? 16 : 14; }
		}
		await savePDF(doc, `ia_${tab}_${id}.pdf`);
	}

	async function reporteIA(tab: Tab, r: any) {
		loadingRow = { id: r.id, action: 'ia' };
		try {
			let prompt = '';
			if (tab === 'evaluacion') {
				const { g, s, t } = await fetchCombinado(r.id);
				prompt = buildPrompt(tab, r, g, s, t);
			} else {
				prompt = buildPrompt(tab, r);
			}
			const resp = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_KEY}`,
				{ method: 'POST', headers: { 'Content-Type': 'application/json' },
				  body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
			);
			const json  = await resp.json();
			if (!resp.ok) {
				const msg = json?.error?.message ?? resp.status;
				throw new Error(`Error Gemini (${resp.status}): ${msg}`);
			}
			const texto = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
			if (!texto) throw new Error('Sin respuesta de la IA');
			await exportarPDFIA(texto, tab, r.id, getfecha(tab, r));
		} catch (e: any) {
			alert('Error IA: ' + (e.message ?? 'Error desconocido'));
		}
		loadingRow = null;
	}

	async function accionRow(tab: Tab, r: any, action: 'pdf' | 'excel' | 'ia') {
		loadingRow = { id: r.id, action };
		try {
			if (action === 'pdf') {
				if (tab === 'evaluacion')  await pdfEvaluacion(r);
				else if (tab === 'gonogo') await pdfGonogo(r);
				else if (tab === 'stroop') await pdfStroop(r);
				else                       await pdfSecuencia(r);
			} else if (action === 'excel') {
				if (tab === 'evaluacion')  await excelEvaluacion(r);
				else if (tab === 'gonogo') await excelGonogo(r);
				else if (tab === 'stroop') await excelStroop(r);
				else                       await excelSecuencia(r);
			} else {
				await reporteIA(tab, r);
				return; // reporteIA manages loadingRow itself
			}
		} catch (e: any) {
			alert('Error: ' + (e.message ?? 'Error desconocido'));
		}
		loadingRow = null;
	}

	// ─── Descargar todas ──────────────────────────────────────────────────────
	async function descargarTodas(tab: Tab) {
		const dataMap: Record<Tab, any[]> = {
			evaluacion: dataEval, gonogo: dataGonogo,
			stroop: dataStroop,   secuencia: dataSecuencia,
		};
		const rows = dataMap[tab];
		if (!rows.length) return;

		let sheetRows: any[] = [];
		if (tab === 'gonogo') {
			sheetRows = rows.map(r => ({
				Fecha: fmtFecha(r.created_at), ID: r.id,
				'Precisión (%)': r.precision_total, 'RT Promedio (ms)': r.rt_promedio,
				'Desv. Estándar': r.desviacion_estandar, 'RT Mín': r.tiempo_minimo, 'RT Máx': r.tiempo_maximo,
				'Go Correctos': r.go_correctos, 'NoGo Correctos': r.nogo_correctos,
				'Err. Omisión': r.errores_omision, 'Err. Comisión': r.errores_comision,
				'Err. Anticipación': r.errores_anticipacion,
			}));
		} else if (tab === 'stroop') {
			sheetRows = rows.map(r => ({
				Fecha: fmtFecha(r.created_at), ID: r.id,
				'Aciertos Totales': r.aciertos_totales, 'Total Ensayos': r.total_ensayos,
				'Media Congruente (ms)': r.media_congruente_ms, 'Media Incongruente (ms)': r.media_incongruente_ms,
				'Índice Interferencia (ms)': r.indice_interferencia_ms, 'Estado': r.estado_interferencia,
				'Aciertos Cong.': r.aciertos_congruente, 'Aciertos Incong.': r.aciertos_incongruente,
				'Errores Cong.': r.errores_congruente, 'Errores Incong.': r.errores_incongruente,
			}));
		} else if (tab === 'secuencia') {
			sheetRows = rows.map(r => ({
				Fecha: fmtFecha(r.created_at), ID: r.id,
				'Span Máximo': r.span_maximo, 'Errores Totales': r.errores_totales,
				'FRL Promedio (ms)': r.frl_promedio, 'FRL Desv.': r.frl_sd,
				'IRI Promedio (ms)': r.iri_promedio, 'IRI Desv.': r.iri_sd,
				'Total Respuestas': r.total_respuestas,
			}));
		} else {
			sheetRows = rows.map(r => ({ Fecha: fmtFecha(r.fecha_inicio), 'ID Evaluación': r.id }));
		}

		const ws = XLSX.utils.json_to_sheet(sheetRows);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, tab);
		await saveXlsx(wb, `historial_${tab}.xlsx`);
	}

	// ─── Computed rows ────────────────────────────────────────────────────────
	function activeData(): any[] {
		if (activeTab === 'evaluacion') return dataEval;
		if (activeTab === 'gonogo')     return dataGonogo;
		if (activeTab === 'stroop')     return dataStroop;
		return dataSecuencia;
	}

	// Initial load
	cargar('evaluacion');
</script>

<div class="page">
	<!-- Header -->
	<header class="header">
		<button class="btn-back" onclick={() => onVolver?.()}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
				stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
			Volver
		</button>
		<h1 class="titulo">Historial de Evaluaciones</h1>
	</header>

	<!-- Tabs -->
	<nav class="tabs">
		{#each [['evaluacion','Evaluación'],['gonogo','Go / No-Go'],['stroop','Stroop'],['secuencia','Secuencia']] as [tabId, label]}
			<button
				class="tab"
				class:active={activeTab === tabId}
				onclick={() => selectTab(tabId)}
			>{label}</button>
		{/each}
	</nav>

	<!-- Panel -->
	<div class="panel">
		{#if loading}
			<div class="empty">Cargando...</div>
		{:else if errorMsg}
			<div class="empty error">{errorMsg}</div>
		{:else if activeData().length === 0}
			<div class="empty">No hay registros todavía.</div>
		{:else}
			<!-- Descargar todas -->
			<div class="toolbar">
				<button class="btn-todas" onclick={() => descargarTodas(activeTab)}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
						stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
					Descargar todas (Excel)
				</button>
			</div>

			<!-- Tabla -->
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>ID</th>
							<th>Fecha</th>
							{#if activeTab === 'evaluacion'}<th>Estado</th>{/if}
							<th>Acciones</th>
						</tr>
					</thead>
					<tbody>
						{#each activeData() as row (row.id)}
							<tr>
								<td class="cell-id">#{row.id}</td>
								<td class="cell-fecha">{getfecha(activeTab, row)}</td>
								{#if activeTab === 'evaluacion'}
									<td>
										{#if row.completada}
											<span class="badge ok">Completada</span>
										{:else}
											<span class="badge pend">Incompleta</span>
										{/if}
									</td>
								{/if}
								<td class="cell-actions">
									<button
										class="btn-action pdf"
										disabled={loadingRow?.id === row.id}
										onclick={() => accionRow(activeTab, row, 'pdf')}
									>
										{#if loadingRow?.id === row.id && loadingRow?.action === 'pdf'}
											<span class="spinner"></span>
										{:else}
											PDF
										{/if}
									</button>
									<button
										class="btn-action excel"
										disabled={loadingRow?.id === row.id}
										onclick={() => accionRow(activeTab, row, 'excel')}
									>
										{#if loadingRow?.id === row.id && loadingRow?.action === 'excel'}
											<span class="spinner"></span>
										{:else}
											Excel
										{/if}
									</button>
{#if activeTab === 'evaluacion'}
									<button
										class="btn-action ia"
										disabled={loadingRow?.id === row.id}
										onclick={() => accionRow(activeTab, row, 'ia')}
									>
										{#if loadingRow?.id === row.id && loadingRow?.action === 'ia'}
											<span class="spinner"></span>
										{:else}
											✦ IA
										{/if}
									</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>

<style>
.page {
	min-height: 100vh;
	background: #f0f4f8;
	font-family: Arial, system-ui, -apple-system, 'Segoe UI', sans-serif;
	display: flex;
	flex-direction: column;
	padding: 0 0 40px;
}

/* Header */
.header {
	background: #fff;
	border-bottom: 1px solid #e2e8f0;
	padding: 16px 24px;
	display: flex;
	align-items: center;
	gap: 16px;
}
.btn-back {
	display: flex;
	align-items: center;
	gap: 6px;
	background: none;
	border: 1px solid #e2e8f0;
	border-radius: 8px;
	padding: 7px 14px;
	font-size: 0.875rem;
	color: #475569;
	cursor: pointer;
	transition: background 0.15s, color 0.15s;
}
.btn-back:hover { background: #f1f5f9; color: #0f172a; }
.titulo {
	margin: 0;
	font-size: 1.25rem;
	font-weight: 700;
	color: #0f172a;
}

/* Tabs */
.tabs {
	background: #fff;
	border-bottom: 1px solid #e2e8f0;
	display: flex;
	gap: 0;
	padding: 0 24px;
}
.tab {
	background: none;
	border: none;
	border-bottom: 3px solid transparent;
	padding: 14px 20px;
	font-size: 0.9rem;
	font-weight: 600;
	color: #64748b;
	cursor: pointer;
	transition: color 0.15s, border-color 0.15s;
}
.tab:hover { color: #0f172a; }
.tab.active { color: #6366f1; border-bottom-color: #6366f1; }

/* Panel */
.panel {
	flex: 1;
	padding: 24px;
	max-width: 900px;
	width: 100%;
	margin: 0 auto;
}

.empty {
	text-align: center;
	padding: 60px 20px;
	color: #94a3b8;
	font-size: 0.95rem;
}
.empty.error { color: #ef4444; }

/* Toolbar */
.toolbar {
	display: flex;
	justify-content: flex-end;
	margin-bottom: 16px;
}
.btn-todas {
	display: flex;
	align-items: center;
	gap: 7px;
	background: #fff;
	border: 1.5px solid #22c55e;
	border-radius: 10px;
	padding: 9px 18px;
	font-size: 0.875rem;
	font-weight: 600;
	color: #16a34a;
	cursor: pointer;
	transition: background 0.15s, box-shadow 0.15s;
}
.btn-todas:hover { background: #f0fdf4; box-shadow: 0 2px 8px rgba(34,197,94,0.2); }

/* Table */
.table-wrap {
	background: #fff;
	border-radius: 14px;
	border: 1px solid #e2e8f0;
	overflow: hidden;
	overflow-x: auto;
}
table {
	width: 100%;
	border-collapse: collapse;
}
thead {
	background: #f8fafc;
}
th {
	padding: 13px 16px;
	font-size: 0.8rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: #64748b;
	text-align: left;
	border-bottom: 1px solid #e2e8f0;
}
tr + tr td { border-top: 1px solid #f1f5f9; }
td {
	padding: 12px 16px;
	font-size: 0.9rem;
	color: #334155;
	vertical-align: middle;
}
.cell-id {
	font-weight: 700;
	color: #6366f1;
	white-space: nowrap;
}
.cell-fecha {
	color: #64748b;
	white-space: nowrap;
}
.cell-actions {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}

/* Action buttons */
.btn-action {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 58px;
	padding: 6px 14px;
	border: none;
	border-radius: 8px;
	font-size: 0.8rem;
	font-weight: 700;
	cursor: pointer;
	transition: opacity 0.15s, transform 0.1s;
}
.btn-action:disabled { opacity: 0.55; cursor: not-allowed; }
.btn-action:not(:disabled):active { transform: scale(0.95); }

.btn-action.pdf   { background: #fee2e2; color: #dc2626; }
.btn-action.excel { background: #dcfce7; color: #16a34a; }
.btn-action.ia    { background: #ede9fe; color: #7c3aed; }

.btn-action.pdf:not(:disabled):hover   { background: #fecaca; }
.btn-action.excel:not(:disabled):hover { background: #bbf7d0; }
.btn-action.ia:not(:disabled):hover    { background: #ddd6fe; }

/* Spinner */
.spinner {
	display: inline-block;
	width: 12px;
	height: 12px;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.badge {
	display: inline-block;
	padding: 3px 10px;
	border-radius: 999px;
	font-size: 0.75rem;
	font-weight: 700;
}
.badge.ok   { background: #dcfce7; color: #16a34a; }
.badge.pend { background: #fef9c3; color: #854d0e; }
</style>
